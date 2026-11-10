/**
 * SuperAgent — top-level composition.
 *
 * Wires together:
 *   - Channels (terminal, HTTP webhook, file queue) — event sources + response tools
 *   - Router layer (long-lived, replies via channel tools, dispatches tasks)
 *   - Worker layer (one pm2 process per task, ADR 0001)
 *   - Trigger system (two-stage filtering, threads, pass-through)
 *   - Control channel (daemon↔worker IPC)
 *   - Watchdog (external control loop)
 */

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SuperAgentConfig, Trigger } from "./types.ts";
import { DEFAULT_CONFIG } from "./types.ts";
import type { Channel, ChannelEvent, ChannelKind } from "./channels/types.ts";
import { ContextManager } from "./context.ts";
import { ThreadManager } from "./thread.ts";
import { TriggerSystem } from "./trigger.ts";
import { RouterLayer } from "./router.ts";
import { Watchdog, DEFAULT_WATCHDOG_OPTIONS } from "./watchdog.ts";
import { ControlServer } from "./ipc.ts";
import { ProcessManager } from "./process-manager.ts";

export interface SuperAgentDeps {
	channels: Channel[];
	processManager?: ProcessManager;
	onTurnComplete?: () => void;
}

export class SuperAgent {
	private readonly deps: SuperAgentDeps;
	private modelRuntime!: ModelRuntime;
	private readonly config: SuperAgentConfig;
	private readonly context = new ContextManager();
	private readonly threads = new ThreadManager();
	private readonly triggerSystem: TriggerSystem;
	private readonly processManager: ProcessManager;
	private router: RouterLayer | null = null;
	private watchdog: Watchdog | null = null;
	private control: ControlServer | null = null;
	private model: any = null;
	private started = false;
	private _onTurnComplete: (() => void) | null;

	constructor(config: Partial<SuperAgentConfig> = {}, deps: SuperAgentDeps) {
		this.deps = deps;
		this.config = {
			...DEFAULT_CONFIG,
			...config,
			sessionDir: config.sessionDir ?? join(homedir(), ".local", "share", "mir", "router.session"),
			queueDir: config.queueDir ?? join(homedir(), ".local", "share", "mir", "queue"),
			socketPath: config.socketPath ?? join(homedir(), ".local", "share", "mir", "daemon.sock"),
		};
		this.triggerSystem = new TriggerSystem(this.threads, undefined);
		this.processManager = deps.processManager ?? new ProcessManager();
		this._onTurnComplete = deps.onTurnComplete ?? null;
	}

	getConfig(): SuperAgentConfig {
		return this.config;
	}

	async init(): Promise<void> {
		const apiKey = process.env.OPENROUTER_API_KEY;
		if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
		this.modelRuntime = await ModelRuntime.create();
		await this.modelRuntime.setRuntimeApiKey("openrouter", apiKey);
		await this.modelRuntime.getAvailable("openrouter");
		// Cap max_tokens: pi otherwise sends none, and OpenRouter reserves the
		// model's whole context window, which 402s on a small balance.
		const originalStream = (this.modelRuntime as any).streamSimple.bind(this.modelRuntime);
		(this.modelRuntime as any).streamSimple = (model: any, ctx: any, opts: any) =>
			originalStream(model, ctx, { ...opts, maxTokens: this.config.maxTokens });

		this.model = this.modelRuntime.getModel("openrouter", this.config.modelId);
		if (!this.model) throw new Error(`model not found: ${this.config.modelId}`);
		this.applyProviderRouting(this.model);
	}

	private applyProviderRouting(model: any): void {
		if (!this.config.providerRouting || !model) return;
		model.compat = { ...(model.compat ?? {}), openRouterRouting: this.config.providerRouting };
	}

	providerRoutingLabel(): string {
		const r = this.config.providerRouting;
		if (!r) return "default";
		const parts: string[] = [];
		if (r.only) parts.push(`only=${r.only.join(",")}`);
		if (r.quantizations) parts.push(`quant=${r.quantizations.join(",")}`);
		if (r.allow_fallbacks === false) parts.push("no-fallbacks");
		return parts.join(" ") || "default";
	}

	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;

		// Control channel: workers connect here and report back.
		this.control = new ControlServer(this.config.socketPath, {
			onWorkerMessage: (workerId, msg) => {
				if (msg.type === "hello") this.router?.handleWorkerHello(workerId);
				if (msg.type === "status") this.router?.handleWorkerStatus(workerId, msg.status, msg.progress);
				if (msg.type === "conclusion") void this.router?.handleWorkerConclusion(workerId, msg.text);
				if (msg.type === "delta") {
					// Workers never talk to users directly; keep deltas in the log only.
				}
			},
			onWorkerDisconnect: (workerId) => {
				const taskId = this.router?.handleWorkerDisconnect(workerId);
				if (taskId) void this.processManager.killWorker(taskId).catch(() => {});
			},
		});
		await this.control.start();

		this.router = await RouterLayer.create({
			modelRuntime: this.modelRuntime,
			model: this.model,
			config: this.config,
			context: this.context,
			threads: this.threads,
			channels: this.deps.channels,
			processManager: this.processManager,
			onTurnComplete: this._onTurnComplete ?? (() => {}),
		});

		this.watchdog = new Watchdog(this.router, DEFAULT_WATCHDOG_OPTIONS);
		this.watchdog.start();

		console.log(`[daemon] online. model=${this.config.modelId} routing=${this.providerRoutingLabel()}`);
		console.log(`[daemon] channels: ${this.deps.channels.map((c) => c.id).join(", ")}`);
	}

	private kindOf(channelId: string): ChannelKind {
		return this.deps.channels.find((c) => c.id === channelId)?.kind ?? "http";
	}

	/** An Event arrived on a Channel. Filter and route it. */
	async submitEvent(event: ChannelEvent): Promise<void> {
		if (process.env.MIR_DEBUG) console.error(`[dbg] submitEvent ${event.channelId} ${event.id}: ${event.text.slice(0,40)}`);
		if (!this.router) return;
		const trigger: Trigger = {
			id: event.id,
			channelId: event.channelId,
			kind: this.kindOf(event.channelId),
			text: event.text,
			payload: event.payload,
			receivedAt: event.receivedAt,
			threadId: event.threadId,
			replyTo: event.replyTo,
			metadata: event.metadata,
		};

		const route = await this.triggerSystem.process(trigger, (threadId) =>
			this.threads.getSubscribers(threadId),
		);

		if (process.env.MIR_DEBUG) console.error(`[dbg] route -> ${route.target} (${route.reason ?? ""})`);
		if (route.target === "ignore") return;

		if (route.target.startsWith("worker:")) {
			const workerId = route.target.slice("worker:".length);
			const ok = this.control?.sendEvent(workerId, event) ?? false;
			if (ok) return; // fast-path pass-through
			// Worker gone → fall back to the Router.
		}

		this.router.submitTrigger(trigger);
	}

	/** Public Task dispatch (CLI / Router tool). */
	async dispatchTask(title: string, description: string, threadId?: string): Promise<string> {
		if (!this.router) throw new Error("SuperAgent not started");
		const task = await this.router.dispatchTask({ title, description, threadId });
		return task.id;
	}

	getRouter(): RouterLayer | null {
		return this.router;
	}
	getWatchdog(): Watchdog | null {
		return this.watchdog;
	}
	currentModel(): string {
		return this.config.modelId;
	}
	set onTurnComplete(cb: (() => void) | null) {
		this._onTurnComplete = cb;
	}
	listTasks() {
		return this.router?.listTasks() ?? [];
	}
	listWorkers() {
		return this.router?.listWorkers() ?? [];
	}
	getProcessManager(): ProcessManager {
		return this.processManager;
	}

	async stop(): Promise<void> {
		this.watchdog?.stop();
		await this.router?.dispose();
		await this.control?.stop();
		await this.processManager.disconnect();
		this.started = false;
	}
}
