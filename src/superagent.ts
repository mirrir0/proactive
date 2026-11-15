/**
 * SuperAgent — top-level composition.
 *
 * Wires together:
 *   - Channels (terminal, HTTP webhook, file queue) — event sources + response tools
 *   - Router layer (long-lived, replies via channel tools, dispatches tasks)
 *   - Worker layer (one pm2 process per task, ADR 0001)
 *   - Trigger system (two-stage filtering, threads, pass-through fan-out)
 *   - Durable state (trigger log + tasks + workers + threads + recall objects)
 *   - Control channel (daemon↔worker IPC)
 *   - Watchdog (independent control loop with its own agent session)
 *   - Telemetry (structured logs + Prometheus metrics)
 */

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SuperAgentConfig, Trigger } from "./types.ts";
import { DEFAULT_CONFIG } from "./types.ts";
import type { Channel, ChannelEvent, ChannelKind } from "./channels/types.ts";
import { ContextManager } from "./context.ts";
import { ThreadManager } from "./thread.ts";
import { TriggerSystem, resolvePolicies } from "./trigger.ts";
import { RouterLayer } from "./router.ts";
import { Watchdog } from "./watchdog.ts";
import { ControlServer } from "./ipc.ts";
import { ProcessManager, type WorkerSpawner } from "./process-manager.ts";
import { McpConfigWatcher } from "./mcp-watcher.ts";
import type { McpConfig } from "./mcp.ts";
import {
	formatMcpChangedText,
	type McpCatalogEntry,
	type McpDiff,
	type McpServerReport,
} from "./mcp-catalog.ts";
import { MirStore, type StoredEvent } from "./store.ts";
import { LlmSemanticJudge, ADMIT_ALL_JUDGE, type SemanticJudge } from "./policy.ts";
import type { SessionFactory } from "./session.ts";
import { metrics, log, startMetricsServer, type MetricsServerHandle } from "./telemetry.ts";
import { secrets, redactSecrets } from "./security.ts";
import { HandsHub } from "./hands/hub.ts";
import { HandsServer } from "./hands/server.ts";
import { LocalHand } from "./hands/local.ts";
import { HandExecutor } from "./hands/executor.ts";
import { createSrtSandbox, type SandboxWrapper } from "./hands/sandbox.ts";
import { BrainServer } from "./api/server.ts";
import { AnomalousChannel } from "./channels/anomalous.ts";
import type { BrainHost } from "./api/protocol.ts";
import { ThreadLog, newThreadId } from "./threadlog.ts";
import type { HandStatus } from "./hands/protocol.ts";

export interface SuperAgentDeps {
	channels: Channel[];
	processManager?: WorkerSpawner;
	onTurnComplete?: () => void;
	/** Injectable session factory (tests). */
	sessionFactory?: SessionFactory;
	/** Injectable model runtime + model (tests). When given, no provider is contacted. */
	modelRuntime?: any;
	model?: any;
}

export class SuperAgent {
	private readonly deps: SuperAgentDeps;
	private modelRuntime!: ModelRuntime;
	private readonly config: SuperAgentConfig;
	private readonly store: MirStore;
	private readonly context: ContextManager;
	private readonly threads: ThreadManager;
	private triggerSystem!: TriggerSystem;
	private readonly processManager: WorkerSpawner;
	private router: RouterLayer | null = null;
	private watchdog: Watchdog | null = null;
	private control: ControlServer | null = null;
	private mcpWatcher: McpConfigWatcher | null = null;
	/** Unsubscribes this brain from the stack's MCP answers, when that is the source. */
	private stopMcpServers: (() => void) | null = null;
	private metricsServer: MetricsServerHandle | null = null;
	private handsHub: HandsHub | null = null;
	private handsServer: HandsServer | null = null;
	private localHand: LocalHand | null = null;
	private localSandbox: SandboxWrapper | null = null;
	private apiServer: BrainServer | null = null;
	/**
	 * The product's own channel, when the client API is on. It is how a reply
	 * reaches a chat: the Router answers through it, and its `deliver` writes the
	 * answer into that chat's thread.
	 */
	private anomalousChannel: AnomalousChannel | null = null;
	private readonly threadLog: ThreadLog;
	private housekeepingTimer: NodeJS.Timeout | null = null;
	/** Daemon-side MCP tool catalog (merged from worker `mcp_catalog` reports). */
	private readonly mcpCatalog = new Map<string, McpCatalogEntry>();
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
			workerSessionDir:
				config.workerSessionDir ?? join(homedir(), ".local", "share", "mir", "worker-state"),
			stateDir: config.stateDir ?? join(homedir(), ".local", "share", "mir", "state"),
		};
		this.store = MirStore.open(this.config.stateDir);
		this.threadLog = new ThreadLog({ store: this.store, log });
		this.threads = new ThreadManager(this.store);
		this.context = new ContextManager({
			store: this.store,
			retention: this.config.objectRetention,
		});
		this.triggerSystem = new TriggerSystem(this.threads, {
			policies: resolvePolicies(this.config.triggerPolicies),
		});
		this.processManager =
			deps.processManager ?? new ProcessManager(join(this.config.stateDir, "specs"));
		this._onTurnComplete = deps.onTurnComplete ?? null;
	}

	getConfig(): SuperAgentConfig {
		return this.config;
	}

	async init(): Promise<void> {
		secrets.addFromEnv();

		if (this.deps.modelRuntime) {
			// Injected runtime (tests): no provider is contacted.
			this.modelRuntime = this.deps.modelRuntime;
			this.model = this.deps.model ?? {};
		} else {
			const apiKey = process.env.OPENROUTER_API_KEY;
			if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
			secrets.add("OPENROUTER_API_KEY", apiKey);
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
		}
		this.applyProviderRouting(this.model);

		// Semantic admission (slow path).
		let judge: SemanticJudge = ADMIT_ALL_JUDGE;
		if (this.config.semanticFilter.enabled) {
			const judgeModelId = this.config.semanticFilter.modelId ?? this.config.fastModelId;
			const judgeModel = this.modelRuntime.getModel("openrouter", judgeModelId) ?? this.model;
			this.applyProviderRouting(judgeModel);
			judge = new LlmSemanticJudge({
				modelRuntime: this.modelRuntime,
				model: judgeModel,
				maxTokens: 200,
				maxPerMinute: this.config.semanticFilter.maxJudgementsPerMinute,
			});
		}
		this.triggerSystem = new TriggerSystem(this.threads, {
			policies: resolvePolicies(this.config.triggerPolicies),
			judge,
			semanticPolicies: this.config.semanticFilter.policies,
			semanticEnabled: this.config.semanticFilter.enabled,
		});
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
				switch (msg.type) {
					case "hello":
						this.router?.handleWorkerHello(workerId);
						break;
					case "status":
					case "heartbeat":
						this.router?.handleWorkerStatus(workerId, msg.status, msg.progress);
						break;
					case "conclusion":
						this.router?.handleWorkerConclusion(workerId, msg.text);
						break;
					case "release":
						this.router?.handleWorkerRelease(workerId, msg.eventId, msg.reason);
						break;
					case "unsubscribe":
						this.router?.handleWorkerUnsubscribe(workerId, msg.threadId, msg.reason);
						break;
					case "mcp_catalog":
						this.mergeMcpCatalog(msg);
						break;
					case "delta":
						// A worker never talks to a user directly — but its thread does, so
						// its output is the thread's log, coalesced (handleWorkerDelta).
						this.router?.handleWorkerDelta(workerId, redactSecrets(msg.text));
						break;
				}
			},
			onWorkerDisconnect: (workerId) => {
				this.router?.handleWorkerDisconnect(workerId);
			},
		});
		await this.control.start();

		// Hands: the execution environments tasks run on. Registered before the
		// Router so the first dispatch already sees them.
		if (this.config.hands.enabled) {
			const handsLog = log.child({ component: "hands" });
			this.handsHub = new HandsHub({
				store: this.store,
				log: handsLog,
				heartbeatMs: this.config.hands.heartbeatMs,
				offlineGraceMs: this.config.hands.offlineGraceMs,
				requestTimeoutMs: this.config.hands.requestTimeoutMs,
			});
			this.handsHub.start();
			if (this.config.hands.local) {
				// The local hand enforces the same boundary as a remote one; a
				// failure here is fatal rather than a quiet downgrade.
				if (this.config.hands.localPolicy.sandbox === "srt") {
					this.localSandbox = await createSrtSandbox(this.config.hands.localPolicy, handsLog);
				}
				const executor = new HandExecutor({
					policy: this.config.hands.localPolicy,
					capabilities: this.config.hands.localCapabilities,
					secrets,
					log: handsLog,
					sandbox: this.localSandbox ?? undefined,
				});
				this.localHand = new LocalHand(
					executor,
					(message) => this.handsHub?.handleEndpointMessage("local", message),
					{
						name: "daemon-local",
						meta: { platform: process.platform, arch: process.arch },
					},
				);
				this.handsHub.registerEndpoint(this.localHand);
			}
			this.handsServer = new HandsServer({
				hub: this.handsHub,
				store: this.store,
				log: handsLog,
				host: this.config.hands.host,
				port: this.config.hands.port,
				enabled: this.config.hands.port > 0,
				tls:
					this.config.hands.tlsCert && this.config.hands.tlsKey
						? { cert: this.config.hands.tlsCert, key: this.config.hands.tlsKey }
						: undefined,
				socketPath: this.handsSocketPath(),
			});
			await this.handsServer.start();
		}

		// The door a display connects to. Started once the hands are up, so its
		// first `ready` frame can say what this brain can reach.
		if (this.config.api.socketPath !== "") {
			if (this.config.api.token === "") {
				throw new Error(
					"MIR_API_SOCKET is set but MIR_API_TOKEN is not: a brain that serves threads to anyone who can open a socket is not one to start",
				);
			}
			this.apiServer = new BrainServer({
				socketPath: this.config.api.socketPath,
				token: this.config.api.token,
				host: this.brainHost(),
				log,
			});
			await this.apiServer.start();
		}

		// MCP changes, from whichever source this brain has. With a stack, the
		// member's connected services are fetched and polled (mcp-servers.ts) and
		// the file is not read at all; without one, the file watcher is the source.
		if (this.config.mcpServers !== undefined) {
			// Ask before the Router exists: the first Worker spawned is given this
			// answer, and a Worker that booted with nothing would keep nothing.
			await this.config.mcpServers.refresh();
			this.stopMcpServers = this.config.mcpServers.onChange((diff, config) =>
				this.handleMcpConfigChanged(diff, config),
			);
			this.config.mcpServers.start();
		} else {
			this.mcpWatcher = new McpConfigWatcher(this.config.mcpConfigPath, (diff) =>
				this.handleMcpConfigChanged(diff),
			);
			this.mcpWatcher.start();
		}

		// The product's channel comes before the Router, because the Router builds
		// its `respond_anomalous` tool from it. Its delivery writes into the thread
		// log, which is what a watching client reads — no reverse socket needed.
		if (this.config.api.socketPath !== "") {
			this.anomalousChannel = new AnomalousChannel({
				deliver: (target, text) => {
					// A reply to a thread goes where the thread is; one to a chat goes to
					// the thread that chat shows. Both end as the same entry.
					const threadId =
						target.threadId ?? (target.chatId === undefined ? undefined : this.threadLog.chatThread(target.chatId));
					if (threadId === undefined) return;
					const entry = this.threadLog.append(threadId, { kind: "text", role: "assistant", text });
					this.apiServer?.publish(threadId, entry);
				},
			});
			await this.anomalousChannel.start((event) => {
				this.router?.submitTrigger({
					id: event.id,
					channelId: event.channelId,
					kind: "anomalous",
					text: event.text,
					receivedAt: event.receivedAt,
					threadId: event.threadId,
					replyTo: event.replyTo,
					...(event.from === undefined ? {} : { metadata: { user: event.from } }),
				});
			});
		}

		this.router = await RouterLayer.create({
			modelRuntime: this.modelRuntime,
			model: this.model,
			config: this.config,
			context: this.context,
			threads: this.threads,
			channels: this.channels(),
			processManager: this.processManager,
			store: this.store,
			onTurnComplete: this._onTurnComplete ?? (() => {}),
			getMcpCatalog: () => [...this.mcpCatalog.values()],
			control: {
				abort: (workerId, reason) => this.control?.abort(workerId, reason) ?? false,
				isConnected: (workerId) => this.control?.isConnected(workerId) ?? false,
			},
			sendEventToWorker: (workerId, event) => this.control?.sendEvent(workerId, event) ?? false,
			mcpServers: this.config.mcpServers,
			hands: this.handsHub
				? {
						socketPath: this.handsSocketPath(),
						listHands: () => this.handsHub?.listHands() ?? [],
					}
				: undefined,
			threadLog: this.threadLog,
			publishEntry: (threadId, entry) => this.apiServer?.publish(threadId, entry),
			onOrphanedWorker: (workerId, taskId) => {
				log.warn("orphaned worker from previous daemon generation", { worker: workerId, task: taskId });
				void this.processManager.killWorker(taskId).catch(() => {});
			},
			sessionFactory: this.deps.sessionFactory,
		});

		this.watchdog = await Watchdog.create({
			modelRuntime: this.modelRuntime,
			model: this.model,
			config: this.config,
			router: this.router,
			store: this.store,
			triggerSystem: this.triggerSystem,
			sessionFactory: this.deps.sessionFactory,
		});
		this.watchdog.start();

		if (this.config.metricsPort > 0) {
			this.metricsServer = await startMetricsServer(this.config.metricsPort, this.config.metricsHost);
			log.info("metrics endpoint listening", { port: this.metricsServer.port, host: this.config.metricsHost });
		}

		this.housekeepingTimer = setInterval(() => this.housekeeping(), 60 * 60_000);
		this.housekeepingTimer.unref();

		// Replay anything the previous generation had not finished.
		await this.replayPendingEvents();
		this.refreshGauges();

		log.info("daemon online", {
			model: this.config.modelId,
			fastModel: this.config.fastModelId,
			routing: this.providerRoutingLabel(),
			channels: this.channels().map((c) => c.id),
			semanticFilter: this.config.semanticFilter.enabled,
			stateDir: this.config.stateDir,
		});
	}

	private refreshGauges(): void {
		const counts = this.store.counts();
		for (const [name, value] of Object.entries(counts)) metrics.gauge(`mir_store_${name}`, value);
		if (this.control) metrics.gauge("mir_worker_connections", this.control.connectionCount());
		if (this.router) {
			const status = this.router.status();
			metrics.gauge("mir_router_queue_depth", status.queueDepth);
			metrics.gauge("mir_tasks_dispatch_queue", status.dispatchQueue);
		}
	}

	private housekeeping(): void {
		try {
			const prunedEvents = this.store.pruneEvents(this.config.eventRetentionMs);
			const prunedObjects = this.store.pruneObjects(this.config.objectRetention);
			const prunedTasks = this.router?.pruneTasks(500) ?? 0;
			if (prunedEvents || prunedObjects || prunedTasks) {
				log.info("housekeeping pruned state", {
					events: prunedEvents,
					objects: prunedObjects,
					tasksInMemory: prunedTasks,
				});
			}
			this.refreshGauges();
		} catch (err) {
			log.error("housekeeping failed", { error: (err as Error).message });
		}
	}

	/**
	 * Merge one worker's MCP catalog report into the daemon cache. Each report is
	 * authoritative for the servers it covers: stale entries for those servers are
	 * dropped first, then the reported tools are inserted. Servers not present in
	 * the report are left untouched (the watcher prunes removed/changed servers).
	 */
	private mergeMcpCatalog(report: { servers: McpServerReport[]; tools: McpCatalogEntry[] }): void {
		for (const s of report.servers) {
			for (const [name, entry] of this.mcpCatalog) {
				if (entry.server === s.name) this.mcpCatalog.delete(name);
			}
		}
		for (const tool of report.tools) this.mcpCatalog.set(tool.name, tool);
		const ok = report.servers.filter((s) => s.ok).length;
		log.debug("mcp catalog report", {
			tools: report.tools.length,
			servers: `${ok}/${report.servers.length}`,
			cache: this.mcpCatalog.size,
		});
	}

	/** Watcher callback: prune stale cache entries and signal all workers to hot-reload. */
	private handleMcpConfigChanged(diff: McpDiff, config?: McpConfig): void {
		for (const server of new Set([...diff.removed, ...diff.changed, ...diff.failed])) {
			for (const [name, entry] of this.mcpCatalog) {
				if (entry.server === server) this.mcpCatalog.delete(name);
			}
		}
		const text = formatMcpChangedText(diff);
		const sent =
			this.control?.broadcast({
				type: "system",
				kind: "mcp_changed",
				text,
				added: diff.added,
				removed: diff.removed,
				changed: diff.changed,
				failed: diff.failed,
				...(config === undefined ? {} : { config }),
			}) ?? 0;
		log.info("mcp config change broadcast", {
			workers: sent,
			added: diff.added,
			removed: diff.removed,
			changed: diff.changed,
			failed: diff.failed,
		});
	}

	private kindOf(channelId: string): ChannelKind {
		return this.channels().find((c) => c.id === channelId)?.kind ?? "http";
	}

	private channelFor(channelId: string): Channel | undefined {
		return this.channels().find((c) => c.id === channelId);
	}

	/** An Event arrived on a Channel. Authenticate, dedupe, filter, route. */
	async submitEvent(event: ChannelEvent): Promise<void> {
		try {
			if (!this.router) return;
			const channel = this.channelFor(event.channelId);

			// Transport-level admission (bad signature, foreign owner, …).
			const verdict = channel?.verify?.(event);
			if (verdict && !verdict.ok) {
				metrics.counter("mir_events_rejected_total", 1, { channel: event.channelId });
				log.warn("rejected event", { channel: event.channelId, reason: verdict.reason });
				return;
			}

			const inserted = this.store.insertEvent({
				id: event.id,
				channelId: event.channelId,
				threadId: event.threadId,
				from: event.from,
				text: event.text,
				payload: event.payload,
				replyTo: event.replyTo,
				receivedAt: event.receivedAt,
				status: "pending",
				attempts: 0,
			});
			let attempts = 0;
			if (!inserted) {
				const existing = this.store.getEvent(event.id);
				// A duplicate that already reached a terminal state is dropped; one that
				// is still pending is a replay after a crash and must be processed.
				if (!existing || existing.status !== "pending") {
					metrics.counter("mir_events_duplicate_total", 1, { channel: event.channelId });
					log.debug("duplicate event dropped", { event: event.id });
					return;
				}
				attempts = existing.attempts;
			}
			metrics.counter("mir_events_received_total", 1, { channel: event.channelId });

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
				attempts,
			};

			const route = await this.triggerSystem.process(trigger);

			if (route.targets.length === 0) {
				this.store.markEvent(event.id, "ignored", route.reason);
				metrics.counter("mir_events_ignored_total", 1, { stage: route.stage });
				log.debug("event ignored", { event: event.id, reason: route.reason, stage: route.stage });
				return;
			}

			// Fast path: fan out to EVERY subscribed worker.
			const workerTargets = route.targets.filter((t) => t.startsWith("worker:"));
			if (workerTargets.length > 0) {
				let delivered = 0;
				for (const target of workerTargets) {
					const workerId = target.slice("worker:".length);
					if (this.control?.sendEvent(workerId, event)) {
						delivered++;
					} else {
						// Worker is gone: drop the stale subscription so the next event
						// cold-starts at the Router instead of vanishing.
						log.warn("subscribed worker unreachable; unsubscribing", {
							worker: workerId,
							thread: route.thread.id,
						});
						this.threads.unsubscribe(workerId, route.thread.id);
					}
				}
				if (delivered > 0) {
					this.store.markEvent(event.id, "delivered");
					metrics.counter("mir_events_passthrough_total", 1, { workers: String(delivered) });
					return;
				}
				// Every subscriber was stale: fall through to the Router.
			}

			this.store.markEvent(event.id, "routed");
			this.router.submitTrigger(trigger);
		} catch (err) {
			log.error("submitEvent failed", { event: event.id, error: (err as Error).message });
			metrics.counter("mir_events_failed_total");
		}
	}

	/** Re-process events that a previous daemon generation left pending. */
	async replayPendingEvents(): Promise<number> {
		const pending = this.store.listPendingEvents(200);
		if (pending.length === 0) return 0;
		log.warn("replaying events left pending by a previous run", { count: pending.length });
		metrics.counter("mir_events_replayed_total", pending.length);
		for (const stored of pending) {
			await this.submitEvent(eventFromStored(stored));
		}
		return pending.length;
	}

	/** Public Task dispatch (CLI / tests). */
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
	getStore(): MirStore {
		return this.store;
	}
	getTriggerSystem(): TriggerSystem {
		return this.triggerSystem;
	}
	getContext(): ContextManager {
		return this.context;
	}
	getThreads(): ThreadManager {
		return this.threads;
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
	getProcessManager(): WorkerSpawner {
		return this.processManager;
	}

	/** Unix socket brains use to reach the hands hub. */
	handsSocketPath(): string {
		return this.config.hands.socketPath || join(this.config.stateDir, "hands.sock");
	}

	/** Live hands (execution environments), for `mir hands` and the Router. */
	listHands(): HandStatus[] {
		return this.handsHub?.listHands() ?? [];
	}

	getHandsHub(): HandsHub | null {
		return this.handsHub;
	}

	/**
	 * What the client API can see and do.
	 *
	 * `say` is the only write a client has: it becomes a Trigger on the thread,
	 * exactly as a message from any other channel would, so the Router cannot
	 * tell a person in the product from a person in a terminal — which is the
	 * property that makes the product one more place to talk to the same agent.
	 */
	/** Every channel this daemon drives, the product's included when its API is on. */
	private channels(): Channel[] {
		return this.anomalousChannel === null ? this.deps.channels : [...this.deps.channels, this.anomalousChannel];
	}

	private brainHost(): BrainHost {
		return {
			listThreads: (filter) => {
				const summaries = this.threadLog.summaries(filter?.limit ?? 100);
				return filter?.status === undefined
					? summaries
					: summaries.filter((thread) => thread.status === filter.status);
			},
			chatThread: (chatId, title) => this.threadLog.chatThread(chatId, title),
			entries: (threadId, since) => this.threadLog.entries(threadId, since),
			status: (threadId) => this.threadLog.status(threadId),
			say: (threadId, content) => {
				const eventId = `api-${crypto.randomUUID()}`;
				// A thread that shows a chat answers into that chat; the channel is
				// what knows how. A thread with no chat is a work thread, and its
				// message is a plain trigger.
				const chatId = this.threadLog.chatOf(threadId);
				if (this.anomalousChannel !== null && chatId !== undefined) {
					this.anomalousChannel.submit({ chatId, threadId, text: content, eventId });
					return;
				}
				this.router?.submitTrigger({
					id: eventId,
					channelId: "anomalous",
					kind: "anomalous",
					text: content,
					receivedAt: Date.now(),
					threadId,
				});
			},
			stop: (threadId) => {
				// A stop is a request, not a fact: the reply frame says the brain
				// accepted it, and what it stopped lands in the log as entries.
				void this.router
					?.stopThread(threadId, "stopped by a client")
					.catch((err: unknown) => log.warn("could not stop a thread", { thread: threadId, error: (err as Error).message }));
			},
			hands: () => this.handsHub?.listHands() ?? [],
		};
	}

	/** A thread id a client can use as an entity id (ULID), for a thread it is opening. */
	newThreadId(): string {
		return newThreadId();
	}

	async stop(): Promise<void> {
		if (this.housekeepingTimer) {
			clearInterval(this.housekeepingTimer);
			this.housekeepingTimer = null;
		}
		await this.anomalousChannel?.stop().catch(() => {});
		this.anomalousChannel = null;
		await this.apiServer?.stop().catch(() => {});
		this.apiServer = null;
		await this.watchdog?.dispose();
		await this.handsServer?.stop();
		this.handsHub?.dispose();
		this.handsServer = null;
		this.handsHub = null;
		this.localHand = null;
		await this.localSandbox?.dispose().catch(() => {});
		this.localSandbox = null;
		this.mcpWatcher?.stop();
		this.mcpWatcher = null;
		this.stopMcpServers?.();
		this.stopMcpServers = null;
		this.config.mcpServers?.stop();
		await this.router?.dispose();
		await this.control?.stop();
		await this.processManager.disconnect();
		await this.metricsServer?.close();
		this.metricsServer = null;
		this.store.close();
		this.started = false;
	}
}

function eventFromStored(stored: StoredEvent): ChannelEvent {
	return {
		id: stored.id,
		channelId: stored.channelId,
		threadId: stored.threadId,
		from: stored.from,
		text: stored.text,
		payload: stored.payload,
		replyTo: stored.replyTo,
		receivedAt: stored.receivedAt,
	};
}
