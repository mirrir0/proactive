/**
 * Router Layer (Section 2.1).
 *
 * Long-lived global routing layer. It receives every Event (via Channels) and
 * every Worker conclusion. It does NOT execute tasks and it does NOT write raw
 * text to any channel: it answers by calling a Channel's response tool
 * (`respond_<channel>`) and dispatches by calling `dispatch_task`.
 *
 * Because the Router's only outward path is a tool call, there is no need to
 * scrape or filter streamed text — the old text-delta filtering is gone.
 */

import {
	createAgentSession,
	SessionManager,
	type ModelRuntime,
	type ToolDefinition,
	defineTool,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { SuperAgentConfig, Task, TaskStatus, Trigger, WorkerInfo } from "./types.ts";
import type { Channel, ChannelEvent } from "./channels/types.ts";
import { ContextManager } from "./context.ts";
import { ThreadManager } from "./thread.ts";
import type { ProcessManager } from "./process-manager.ts";
import { channelActivity } from "./channels/tool.ts";

export interface RouterDependencies {
	modelRuntime: ModelRuntime;
	model: any;
	config: SuperAgentConfig;
	context: ContextManager;
	threads: ThreadManager;
	channels: Channel[];
	processManager: ProcessManager;
	onTurnComplete: () => void;
}

export interface TaskInput {
	title: string;
	description: string;
	threadId?: string;
	channelId?: string;
	replyTo?: string;
	id?: string;
}

interface WorkerRecord {
	workerId: string;
	taskId: string;
	status: WorkerInfo["status"];
	threadIds: string[];
	channelId?: string;
	replyTo?: string;
	lastHeartbeat: number;
	progress?: string;
}

export class RouterLayer {
	private session!: Awaited<ReturnType<typeof createAgentSession>>["session"];
	private readonly deps: RouterDependencies;
	private readonly config: SuperAgentConfig;
	private readonly tasks = new Map<string, Task>();
	private readonly workers = new Map<string, WorkerRecord>();
	private triggerQueue: Trigger[] = [];
	private flushTimer: NodeJS.Timeout | null = null;
	private disposed = false;
	/** Assistant text captured this turn, used for the no-tool-call fallback. */
	private captured = "";
	/** Actions the Router took this turn (dispatch/respond), to decide fallback. */
	private acted = 0;

	private constructor(deps: RouterDependencies) {
		this.deps = deps;
		this.config = deps.config;
	}

	static async create(deps: RouterDependencies): Promise<RouterLayer> {
		const router = new RouterLayer(deps);
		const customTools: ToolDefinition[] = [
			...deps.channels.map((c) => c.responseTool()),
			router.buildDispatchTool(),
			router.buildListWorkersTool(),
		];
		const result = await createAgentSession({
			model: deps.model,
			modelRuntime: deps.modelRuntime,
			sessionManager: (() => {
				try {
					return deps.config.sessionDir
						? SessionManager.open(deps.config.sessionDir)
						: SessionManager.inMemory();
				} catch {
					return SessionManager.inMemory();
				}
			})(),
			thinkingLevel: deps.config.thinkingLevel,
			noTools: "builtin",
			customTools,
		});
		router.session = result.session as any;
		router.session.subscribe((event: any) => {
			if (process.env.MIR_DEBUG) {
				const t = event.type === "message_update" ? `update:${event.assistantMessageEvent?.type}` : event.type;
				if (t && !t.startsWith("update:thinking")) console.error(`[dbg] event ${t}`, event.assistantMessageEvent?.delta?.slice?.(0,60) ?? "");
			}
			if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
				router.captured += event.assistantMessageEvent.delta ?? "";
			}
		});
		return router;
	}

	// ----- Tools the Router uses to act -----

	private buildDispatchTool(): ToolDefinition {
		const router = this;
		return defineTool({
			name: "dispatch_task",
			label: "Dispatch task to a Worker",
			description:
				"Dispatch an isolated background Worker (its own pm2 process) to carry out a task. Use for any work that takes more than a quick reply. The Worker will report a conclusion back to you.",
			parameters: Type.Object({
				title: Type.String({ description: "Short task title." }),
				description: Type.String({ description: "What the Worker should do, self-contained." }),
				channel: Type.Optional(Type.String({ description: "Channel id the task originated from." })),
				thread: Type.Optional(Type.String({ description: "Thread id the task belongs to." })),
				reply_to: Type.Optional(Type.String({ description: "Event id to reply to when done." })),
			}),
			async execute(_id, params) {
				router.acted++;
				const task = await router.dispatchTask({
					title: params.title,
					description: params.description,
					threadId: params.thread,
					channelId: params.channel,
					replyTo: params.reply_to,
				});
				return {
					content: [{ type: "text", text: `dispatched task ${task.id} (worker ${task.workerId})` }],
					details: { taskId: task.id, workerId: task.workerId },
				};
			},
		});
	}

	private buildListWorkersTool(): ToolDefinition {
		const router = this;
		return defineTool({
			name: "list_workers",
			label: "List Workers",
			description: "List the currently tracked Workers and their status.",
			parameters: Type.Object({}),
			async execute() {
				const info = router.listWorkers();
				return {
					content: [{ type: "text", text: JSON.stringify(info, null, 2) }],
					details: { count: info.length },
				};
			},
		});
	}

	// ----- Inbound triggers (batched) -----

	submitTrigger(trigger: Trigger): void {
		this.triggerQueue.push(trigger);
		if (this.flushTimer) clearTimeout(this.flushTimer);
		this.flushTimer = setTimeout(() => void this.flush(), this.config.batchWindowMs);
		this.flushTimer.unref();
	}

	private async flush(): Promise<void> {
		this.flushTimer = null;
		const batch = this.triggerQueue.splice(0, this.triggerQueue.length);
		if (batch.length === 0) return;
		const prompt = this.buildBatchPrompt(batch);
		if (process.env.MIR_DEBUG) console.error(`[dbg] flush batch=${batch.length} channels=${this.deps.channels.map(c=>c.id)}`);
		const deliveriesBefore = channelActivity.deliveries;
		this.captured = "";
		this.acted = 0;
		try {
			await this.session.prompt(prompt, { streamingBehavior: "followUp" });
		} catch (err) {
			console.error(`[router] turn error: ${(err as Error).message}`);
		}
		await this.ensureReply(batch[batch.length - 1], deliveriesBefore);
		this.onTurnDone();
	}

	/**
	 * Safety net: if the model answered as plain text instead of calling a
	 * response tool, deliver that text to the originating channel so the human
	 * still gets a reply. Suppressed when the Router already acted.
	 */
	private async ensureReply(origin: Trigger | undefined, deliveriesBefore: number): Promise<void> {
		const text = this.captured.trim();
		const responded = channelActivity.deliveries > deliveriesBefore;
		if (!origin || responded || this.acted > 0 || text.length === 0) return;
		const channel =
			this.deps.channels.find((c) => c.id === origin.channelId) ?? this.deps.channels[0];
		if (!channel) return;
		try {
			await channel.respond(text, { eventId: origin.id, threadId: origin.threadId });
			channelActivity.deliveries++;
		} catch (err) {
			console.error(`[router] fallback delivery failed: ${(err as Error).message}`);
		}
	}

	private buildBatchPrompt(triggers: Trigger[]): string {
		const lines: string[] = ["=== Inbound events (Router turn) ===", ""];
		for (const t of triggers) {
			const thread = t.threadId ? this.deps.threads.getThread(t.threadId) : undefined;
			const related = thread ? [...thread.subscriberWorkerIds] : [];
			lines.push(
				this.deps.context.inline({
					id: t.id,
					type: "trigger",
					summary: `channel=${t.channelId} thread=${t.threadId ?? "(new)"} from=${t.metadata?.["user"] ?? "unknown"} :: ${t.text}`,
					relatedIds: related,
				}),
			);
			lines.push("");
		}
		const channelTools = this.deps.channels.map((c) => `respond_${c.id}`).join(", ");
		lines.push(
			`Your available tools are EXACTLY: ${channelTools} (reply on each channel), dispatch_task (spawn a Worker), list_workers (track Workers).`,
			"You do NOT have bash, read, write, edit, or any execution tool — never run tasks yourself.",
			"Decide for each event and ACT with tools — do not just describe:",
			"- reply to a human → call the matching respond_<channel> tool (pass reply_to = the event id).",
			"- a real task → call dispatch_task, then optionally tell the user you started it.",
			"- pure noise → do nothing.",
			"",
			`Available channels: ${this.deps.channels.map((c) => c.id).join(", ")}.`,
			"Never write the reply as plain assistant text; it must go through a response tool.",
		);
		return lines.join("\n");
	}

	// ----- Worker lifecycle -----

	/** Spawn a Worker process for a Task. */
	async dispatchTask(task: TaskInput): Promise<Task> {
		if (this.workers.size >= this.config.maxConcurrentWorkers) {
			throw new Error("max concurrent workers reached");
		}
		const now = Date.now();
		const id = task.id ?? `task-${crypto.randomUUID().slice(0, 8)}`;
		const workerId = `worker-${id.slice(5, 13)}`;
		const full: Task = {
			id,
			title: task.title,
			description: task.description,
			threadId: task.threadId,
			channelId: task.channelId,
			replyTo: task.replyTo,
			status: "running",
			workerId,
			createdAt: now,
			updatedAt: now,
		};
		this.tasks.set(id, full);
		this.workers.set(workerId, {
			workerId,
			taskId: id,
			status: "busy",
			threadIds: task.threadId ? [task.threadId] : [],
			channelId: task.channelId,
			replyTo: task.replyTo,
			lastHeartbeat: now,
			progress: "spawning",
		});
		if (task.threadId) this.deps.threads.subscribe(workerId, task.threadId);

		await this.deps.processManager.spawnWorker({
			workerId,
			taskId: id,
			title: task.title,
			description: task.description,
			threadId: task.threadId,
			channelId: task.channelId,
			replyTo: task.replyTo,
			modelId: this.config.modelId,
			providerRouting: this.config.providerRouting,
			thinkingLevel: this.config.thinkingLevel,
			socketPath: this.config.socketPath,
			idleExitMs: this.config.workerIdleExitMs,
			maxTokens: this.config.maxTokens,
		});
		return full;
	}

	/** A Worker sent a status/heartbeat update over the control channel. */
	handleWorkerStatus(workerId: string, status: string, progress?: string): void {
		const rec = this.workers.get(workerId);
		if (!rec) return;
		rec.status = status as WorkerInfo["status"];
		rec.lastHeartbeat = Date.now();
		if (progress !== undefined) rec.progress = progress;
	}

	/** A Worker connected to the control channel. */
	handleWorkerHello(workerId: string): void {
		const rec = this.workers.get(workerId);
		if (!rec) return;
		rec.status = "busy";
		rec.lastHeartbeat = Date.now();
		rec.progress = "connected";
	}

	/** A Worker reported a conclusion. Route it back into the Router to reply. */
	async handleWorkerConclusion(workerId: string, text: string): Promise<void> {
		const rec = this.workers.get(workerId);
		if (!rec) return;
		rec.status = "done";
		rec.lastHeartbeat = Date.now();
		const task = this.tasks.get(rec.taskId);
		if (task) {
			task.status = "done";
			task.result = text;
			task.updatedAt = Date.now();
		}
		const channel = rec.channelId ?? this.deps.channels[0]?.id ?? "terminal";
		const deliveriesBefore = channelActivity.deliveries;
		this.captured = "";
		this.acted = 0;
		const prompt = [
			`Worker ${workerId} finished task ${rec.taskId}.`,
			`Origin channel: ${channel}${rec.threadIds[0] ? ` thread ${rec.threadIds[0]}` : ""}.`,
			`Conclusion:\n${text}`,
			"",
			`Reply to the human via respond_${channel} (reply_to = the originating event), then optionally dispatch follow-up work. Do not print plain text.`,
		].join("\n");
		try {
			await this.session.prompt(prompt, { streamingBehavior: "followUp" });
		} catch (err) {
			console.error(`[router] conclusion error: ${(err as Error).message}`);
		}
		const responded = channelActivity.deliveries > deliveriesBefore;
		if (!responded && this.acted === 0) {
			const ch = this.deps.channels.find((c) => c.id === channel);
			await ch?.respond(text, { eventId: rec.replyTo, threadId: rec.threadIds[0] }).catch(() => {});
		}
		this.onTurnDone();
	}

	/** Deliver a follow-up Event to a subscribed Worker over the control channel. */
	deliverToWorker(workerId: string, event: ChannelEvent, send: (w: string, e: ChannelEvent) => boolean): boolean {
		return send(workerId, event);
	}

	/** A Worker's control connection dropped (process exited/crashed). */
	handleWorkerDisconnect(workerId: string): string | undefined {
		const rec = this.workers.get(workerId);
		if (!rec) return undefined;
		rec.status = "idle";
		rec.lastHeartbeat = Date.now();
		const task = this.tasks.get(rec.taskId);
		if (task && task.status === "running") {
			task.status = "failed";
			task.updatedAt = Date.now();
		}
		this.workers.delete(workerId);
		return rec.taskId;
	}

	private onTurnDone(): void {
		this.deps.onTurnComplete();
	}

	listTasks(): Task[] {
		return Array.from(this.tasks.values());
	}
	listWorkers(): WorkerInfo[] {
		return Array.from(this.workers.values(), (w) => ({
			id: w.workerId,
			taskId: w.taskId,
			status: w.status,
			threadIds: w.threadIds,
			lastHeartbeat: w.lastHeartbeat,
			progress: w.progress,
		}));
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		if (this.flushTimer) clearTimeout(this.flushTimer);
		await this.session.dispose();
	}
}
