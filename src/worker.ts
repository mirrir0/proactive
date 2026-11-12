/**
 * Worker runtime (Section 2.2).
 *
 * Runs inside a dedicated `mir-worker-<taskId>` pm2 process (ADR 0001). Each
 * Worker is a context-isolated agent session dedicated to one Task. Workers:
 *   - have the execution toolset their capabilities grant and the model they
 *     were dispatched with;
 *   - never talk to humans directly — they report `status`/`conclusion` to the
 *     Router over the control channel, and the Router replies via a Channel;
 *   - receive follow-up events on their subscribed Threads. Those events are
 *     **queued**, never dropped: a Worker that is mid-turn accepts them and
 *     drains them in order, which is what makes pass-through lossless.
 *
 * Durable state: task metadata goes to a shared SQLite database
 * (`<stateDir>/workers.sqlite`, WAL) and every Worker keeps its own
 * pi-coding-agent session file (`<stateDir>/sessions/worker-<taskId>.jsonl`),
 * so a restarted Worker can resume its own conversation.
 */

import { SessionManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type CodemodeTool } from "@earendil-works/pi-codemode";
import { DatabaseSync } from "node:sqlite";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { type WorkerCapabilities, DEFAULT_WORKER_CAPABILITIES } from "./security.ts";
import { createPiSession, type AgentSessionLike, type SessionFactory } from "./session.ts";
import { metrics, log } from "./telemetry.ts";

/** How a Worker reports to the Router (implemented over the IPC control channel). */
export interface WorkerReporter {
	status(status: "idle" | "busy" | "done" | "failed", progress?: string): void;
	delta(text: string): void;
	/** Liveness, independent of turn progress. */
	heartbeat?(status: "idle" | "busy" | "done" | "failed", progress?: string): void;
	/** "This event is not mine" — hand it back to the Router. */
	release?(eventId: string, reason?: string): void;
	/** "Stop sending me this thread." */
	unsubscribe?(threadId: string, reason?: string): void;
}

export interface WorkerRuntimeOptions {
	taskId: string;
	modelRuntime: any;
	model: any;
	reporter: WorkerReporter;
	thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	/** Directory for durable worker state (shared SQLite + per-worker session files). */
	sessionDir: string;
	/** MCP tools as CodemodeTool[] for codemode sandbox globals. */
	mcpTools?: CodemodeTool[];
	/** Custom tools (MCP tool definitions + codemode tool) for the model to call. */
	customTools?: any[];
	/** What the Worker may reach. */
	capabilities?: WorkerCapabilities;
	/** Heartbeat interval; 0 disables. */
	heartbeatMs?: number;
	/** Injectable session factory (tests use a scripted session). */
	sessionFactory?: SessionFactory;
}

/**
 * Shared SQLite-backed task state store. All workers open the SAME file, so
 * task metadata is durable across worker process restarts.
 */
export class WorkerStateStore {
	private db: DatabaseSync;
	private readonly dbPath: string;

	private constructor(db: DatabaseSync, dbPath: string) {
		this.db = db;
		this.dbPath = dbPath;
		this.initSchema();
	}

	private initSchema(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS task_state (
				task_id   TEXT PRIMARY KEY,
				status    TEXT NOT NULL DEFAULT 'busy',
				progress  TEXT,
				result    TEXT,
				error     TEXT,
				updated_at REAL NOT NULL
			);
		`);
	}

	/** Open (or create) the shared workers database. All workers share one file. */
	static open(stateDir: string): WorkerStateStore {
		mkdirSync(stateDir, { recursive: true });
		const dbPath = join(stateDir, "workers.sqlite");
		const db = new DatabaseSync(dbPath);
		// Several worker processes hold this file: WAL + a busy timeout.
		db.exec("PRAGMA journal_mode = WAL");
		db.exec("PRAGMA synchronous = NORMAL");
		db.exec("PRAGMA busy_timeout = 5000");
		return new WorkerStateStore(db, dbPath);
	}

	get path(): string {
		return this.dbPath;
	}

	/** Record task metadata durably. Called on status changes and conclusion. */
	setTaskStatus(
		taskId: string,
		fields: { status?: string; progress?: string; result?: string; error?: string },
	): void {
		const now = Date.now();
		this.db
			.prepare(
				`INSERT INTO task_state (task_id, status, progress, result, error, updated_at)
				 VALUES (@taskId, @status, @progress, @result, @error, @updatedAt)
				 ON CONFLICT(task_id) DO UPDATE SET
					status   = COALESCE(@status, status),
					progress = COALESCE(@progress, progress),
					result   = COALESCE(@result, result),
					error    = COALESCE(@error, error),
					updated_at = @updatedAt`,
			)
			.run({
				taskId,
				status: fields.status ?? null,
				progress: fields.progress ?? null,
				result: fields.result ?? null,
				error: fields.error ?? null,
				updatedAt: now,
			});
	}

	getTaskState(taskId: string):
		| { status?: string; progress?: string; result?: string; error?: string }
		| undefined {
		const row = this.db
			.prepare(`SELECT status, progress, result, error FROM task_state WHERE task_id = ?`)
			.get(taskId) as
			| { status?: string; progress?: string; result?: string; error?: string }
			| undefined;
		return row;
	}

	listTaskStates(): Array<{
		taskId: string;
		status?: string;
		progress?: string;
		result?: string;
		error?: string;
	}> {
		return this.db
			.prepare(`SELECT task_id as taskId, status, progress, result, error FROM task_state`)
			.all() as Array<{
			taskId: string;
			status?: string;
			progress?: string;
			result?: string;
			error?: string;
		}>;
	}

	async close(): Promise<void> {
		try {
			this.db.close();
		} catch {
			/* already closed */
		}
	}
}

export class WorkerRuntime {
	private session!: AgentSessionLike;
	private disposed = false;
	private busy = false;
	private draining = false;
	private readonly options: WorkerRuntimeOptions;
	private state!: WorkerStateStore;
	private readonly followUps: Array<{ prompt: string; eventId?: string }> = [];
	private currentEventId: string | undefined;
	private currentStatus: "idle" | "busy" | "done" | "failed" = "idle";
	private currentProgress: string | undefined;
	private heartbeatTimer: NodeJS.Timeout | null = null;

	private constructor(options: WorkerRuntimeOptions) {
		this.options = options;
	}

	static async create(options: WorkerRuntimeOptions): Promise<WorkerRuntime> {
		const worker = new WorkerRuntime(options);
		const capabilities = options.capabilities ?? DEFAULT_WORKER_CAPABILITIES;

		// Open the shared durable state store (one SQLite file for all workers).
		worker.state = WorkerStateStore.open(options.sessionDir);

		const sessionDir = join(options.sessionDir, "sessions");
		mkdirSync(sessionDir, { recursive: true });
		const sessionFile = join(sessionDir, `worker-${options.taskId}.jsonl`);
		// `SessionManager.open` creates the file when it does not exist yet. The
		// previous `existsSync ? open : inMemory()` branch made every task's first
		// run ephemeral, so history was silently lost.
		const sessionManager = SessionManager.open(sessionFile);

		const factory = options.sessionFactory ?? createPiSession;
		worker.session = await factory({
			model: options.model,
			modelRuntime: options.modelRuntime,
			sessionManager,
			thinkingLevel: options.thinkingLevel ?? "high",
			customTools: options.customTools ?? [],
		});
		worker.session.subscribe((event: any) => {
			if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
				const delta = event.assistantMessageEvent.delta;
				if (delta) options.reporter.delta(String(delta));
			}
		});

		worker.state.setTaskStatus(options.taskId, { status: "busy", progress: "running" });

		// Heartbeat is independent of turn progress: a long tool call must still
		// look alive to the Watchdog.
		const heartbeatMs = options.heartbeatMs ?? 0;
		if (heartbeatMs > 0 && options.reporter.heartbeat) {
			worker.heartbeatTimer = setInterval(() => {
				options.reporter.heartbeat?.(worker.currentStatus, worker.currentProgress);
			}, heartbeatMs);
			worker.heartbeatTimer.unref();
		}

		log.info("worker runtime ready", {
			task: options.taskId,
			session: sessionFile,
			state: worker.state.path,
			caps: capabilities,
		});
		return worker;
	}

	get isBusy(): boolean {
		return this.busy;
	}

	/** Number of follow-up events waiting for the current turn to finish. */
	get queuedFollowUps(): number {
		return this.followUps.length;
	}

	/** Append tools to the live session (takes effect on the next turn). */
	addTools(defs: ToolDefinition[]): void {
		const s = this.session as any;
		const current: any[] = Array.isArray(s?._customTools) ? s._customTools : [];
		const names = new Set(current.map((d) => String(d?.name ?? "")));
		const additions = defs.filter((d) => !names.has(String((d as any)?.name ?? "")));
		s._customTools = [...current, ...additions];
		if (typeof s?._refreshToolRegistry === "function") s._refreshToolRegistry();
	}

	/**
	 * Hot-replace the MCP tool definitions (`mcp__*`) in this session after an
	 * MCP config change — e.g. tools from added servers, without touching
	 * codemode / mcp_query / other custom tools. Rebuilds the tool registry and
	 * the declared tool set; takes effect on the next turn.
	 */
	replaceMcpTools(defs: ToolDefinition[]): void {
		const s = this.session as any;
		const current: any[] = Array.isArray(s?._customTools) ? s._customTools : [];
		const kept = current.filter((d) => !String(d?.name ?? "").startsWith("mcp__"));
		s._customTools = [...defs, ...kept];
		if (typeof s?._refreshToolRegistry === "function") s._refreshToolRegistry();
	}

	/**
	 * Inject a system signal message into the session (custom message with
	 * customType "system"). It lands in the model's context on its next turn
	 * without forcing a turn now — used to announce MCP add/remove.
	 */
	async injectSystemMessage(text: string, details?: unknown): Promise<void> {
		const s = this.session as any;
		if (typeof s?.sendCustomMessage !== "function") return;
		await s.sendCustomMessage(
			{ customType: "system", content: text, display: true, details },
			{ deliverAs: "nextTurn" },
		);
	}

	/**
	 * Queue a follow-up event and drain it in order.
	 *
	 * Never throws when a turn is already running — that was the old bug that
	 * silently dropped pass-through events.
	 */
	enqueueFollowUp(prompt: string, eventId?: string): void {
		this.followUps.push({ prompt, eventId });
		metrics.gauge("mir_worker_followups_queued", this.followUps.length, { task: this.options.taskId });
		void this.drainFollowUps();
	}

	private async drainFollowUps(): Promise<void> {
		// A turn is already running: it will kick the drain when it finishes.
		// Consuming the queue here would make runTurn throw and drop the events.
		if (this.busy || this.draining || this.disposed) return;
		this.draining = true;
		try {
			while (this.followUps.length > 0 && !this.disposed) {
				const next = this.followUps.shift()!;
				this.currentEventId = next.eventId;
				try {
					await this.runTurn(next.prompt);
				} catch (err) {
					this.report("failed", (err as Error).message);
					log.error("worker follow-up turn failed", {
						task: this.options.taskId,
						event: next.eventId,
						error: (err as Error).message,
					});
				} finally {
					this.currentEventId = undefined;
				}
			}
		} finally {
			this.draining = false;
			metrics.gauge("mir_worker_followups_queued", this.followUps.length, { task: this.options.taskId });
		}
	}

	/** Run the initial task prompt to completion. Deltas stream to the reporter. */
	async run(prompt: string): Promise<string> {
		return this.runTurn(prompt);
	}

	private async runTurn(prompt: string): Promise<string> {
		if (this.busy) throw new Error("worker already running a turn");
		if (this.disposed) throw new Error("worker disposed");
		this.busy = true;
		this.report("busy", this.currentEventId ? "handling follow-up" : "running task");
		let result = "";
		const sink = (event: any) => {
			if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
				result += event.assistantMessageEvent.delta ?? "";
			}
		};
		const unsub = this.session.subscribe(sink);
		try {
			await this.session.prompt(prompt);
			await this.session.waitForIdle?.();
		} finally {
			unsub();
			this.busy = false;
		}
		// Pick up anything that arrived while this turn was running.
		void this.drainFollowUps();
		return result;
	}

	private report(status: "idle" | "busy" | "done" | "failed", progress?: string): void {
		this.currentStatus = status;
		this.currentProgress = progress;
		this.options.reporter.status(status, progress);
	}

	/** Hand the current follow-up event back to the Router. */
	releaseCurrentEvent(reason: string): boolean {
		if (!this.currentEventId) return false;
		this.options.reporter.release?.(this.currentEventId, reason);
		return true;
	}

	/** Ask the Router to stop routing a thread here. */
	unsubscribeThread(threadId: string, reason?: string): void {
		this.options.reporter.unsubscribe?.(threadId, reason);
	}

	/** Persist the task conclusion durably to the shared SQLite DB. */
	async conclude(taskId: string, text: string, error?: string): Promise<void> {
		this.state.setTaskStatus(taskId, {
			status: error ? "failed" : "done",
			result: error ? undefined : text,
			error: error ?? undefined,
		});
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
		await this.state.close().catch(() => {});
		await this.session.dispose().catch(() => {});
	}
}

/**
 * Control tools that let a Worker manage its own subscriptions.
 *
 * §3.2 requires that a Worker can unsubscribe, or hand an event back to the
 * Router, when a follow-up turns out not to be its business. Without this the
 * only escape is for the Worker to answer something it should not.
 */
export function createWorkerControlTools(runtime: WorkerRuntime, threadIds: string[]): ToolDefinition[] {
	return [
		defineTool({
			name: "release_event",
			label: "Hand this event back",
			description:
				"Hand the follow-up event you are currently handling back to the Router because it is not part of your task. " +
				"Use this instead of answering something outside your task.",
			parameters: Type.Object({
				reason: Type.String({ description: "Why this event is not yours." }),
			}),
			exposure: "direct",
			async execute(_id, params) {
				const ok = runtime.releaseCurrentEvent(params.reason);
				return {
					content: [
						{
							type: "text",
							text: ok
								? "released: the Router will decide what to do with it"
								: "nothing to release (this turn is not a follow-up event)",
						},
					],
					details: { released: ok },
				};
			},
		}),
		defineTool({
			name: "unsubscribe_thread",
			label: "Stop following a thread",
			description:
				"Stop receiving follow-up events from one of your threads. Use when the thread has moved on from your task.",
			parameters: Type.Object({
				thread: Type.String({ description: "Thread id to stop following." }),
				reason: Type.Optional(Type.String({ description: "Why." })),
			}),
			exposure: "direct",
			async execute(_id, params) {
				const known = threadIds.includes(params.thread);
				runtime.unsubscribeThread(params.thread, params.reason);
				return {
					content: [
						{
							type: "text",
							text: known
								? `unsubscribed from ${params.thread}`
								: `asked the Router to unsubscribe from ${params.thread} (not one of my known threads)`,
						},
					],
					details: { thread: params.thread, known },
				};
			},
		}),
	];
}
