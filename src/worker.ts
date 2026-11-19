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
import { brainResourceLoader, useSkillTool } from "./skills.ts";
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
	/**
	 * A tool this worker called, and what came back.
	 *
	 * Reported, because a task's thread is where its work is written down: without
	 * this the thread holds the worker's prose and none of what it *did*, which is
	 * the part a member opens a dispatch card to see.
	 */
	toolCall?(call: { id: string; name: string; args: unknown }): void;
	toolResult?(result: { id: string; isError: boolean; result: unknown }): void;
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
	/** Where pi reads global config and extensions from. Isolated for a Worker. */
	agentDir?: string;
	/** What the Worker may reach. */
	capabilities?: WorkerCapabilities;
	/** Heartbeat interval; 0 disables. */
	heartbeatMs?: number;
	/** Injectable session factory (tests use a scripted session). */
	sessionFactory?: SessionFactory;
	/**
	 * The folder this Worker's tools work in, and the one pi names in its prompt.
	 *
	 * The hand's root, when the task has a hand. Omitted, pi falls back to
	 * `process.cwd()` — the brain's own — and a Worker asked about "this space" answers
	 * with a directory nobody asked about.
	 */
	cwd?: string;
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
	/**
	 * Aborted when the daemon stops this task.
	 *
	 * A turn stuck inside a tool call is not something `dispose()` can wait out:
	 * the tool may be a shell command on a hand, and the hand holds the process.
	 * This signal is what the hand tools watch, so the stop reaches the command
	 * that is actually running.
	 */
	private readonly aborter = new AbortController();

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
		const agentDir = options.agentDir ?? join(options.sessionDir, "agent");
		// The same skills the Router has. A Worker's working directory is the
		// member's space, and its loader is allow-listed to the brain's roots, so a
		// `SKILL.md` in that folder is not instructions it follows.
		// The folder this Worker may actually read. pi names a working directory in its
		// prompt, and left to `process.cwd()` that is whatever started the brain — so a
		// Worker asked about "this space" answered with the brain's own source tree.
		const workerCwd = options.cwd ?? process.cwd();
		const resourceLoader = await brainResourceLoader({ cwd: workerCwd, agentDir });
		worker.session = await factory({
			cwd: workerCwd,
			model: options.model,
			modelRuntime: options.modelRuntime,
			sessionManager,
			thinkingLevel: options.thinkingLevel ?? "high",
			// Exactly the tools this runtime hands it — its hand's, and the
			// assistant's — and nothing else:
			//
			//   - `noTools: "all"` starts from an empty set. `"builtin"` was not
			//     enough: it leaves *extension* tools on, so a machine with pi
			//     extensions installed gave every Worker `subagent`, `todo` and
			//     `AskClaude` — tools the assistant never had.
			//   - `tools` names the ones that survive, so even an extension that
			//     loads cannot add a tool to a Worker that was not given it.
			//   - `agentDir` keeps the Worker away from the machine's own pi config.
			noTools: "all",
			tools: (options.customTools ?? []).map((tool) => String(tool.name)),
			agentDir,
			resourceLoader,
			customTools: [...(options.customTools ?? []), useSkillTool()],
		});
		worker.session.subscribe((event: any) => {
			if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
				const delta = event.assistantMessageEvent.delta;
				if (delta) options.reporter.delta(String(delta));
				return;
			}
			// What the worker did, not only what it said: the task's thread carries
			// both, and a display draws a tool call as a tool call.
			if (event.type === "tool_execution_start" && typeof event.toolName === "string") {
				options.reporter.toolCall?.({
					id: String(event.toolCallId ?? ""),
					name: event.toolName,
					args: event.args ?? {},
				});
				return;
			}
			if (event.type === "tool_execution_end" && typeof event.toolCallId === "string") {
				options.reporter.toolResult?.({
					id: event.toolCallId,
					isError: event.isError === true,
					result: event.result ?? null,
				});
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
		// The conclusion is the text of the **last** assistant message, not everything
		// the model said. A Worker narrates as it works ("let me find the file…",
		// "now I'll write it…") and those sentences are the work's commentary; the
		// answer is what it says once it has stopped calling tools. Accumulating
		// across tool calls produced a monologue delivered to a person as the result.
		let result = "";
		let sinceToolCall = "";
		const sink = (event: any) => {
			if (event.type === "tool_execution_start") {
				// A new tool call ends the previous message: what follows is a new one.
				sinceToolCall = "";
				return;
			}
			if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
				const delta = String(event.assistantMessageEvent.delta ?? "");
				result += delta;
				sinceToolCall += delta;
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
		// The last message after the last tool call; if the model stopped without
		// saying anything new, its whole turn is better than nothing.
		return sinceToolCall.trim() === "" ? result : sinceToolCall;
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

	/**
	 * Stop the work now: abort the turn and everything it is waiting on.
	 *
	 * Called on the daemon's `abort` frame. It does not wait for the session —
	 * a tool call that ignores the signal would make the stop a hang.
	 */
	async abort(reason = "stopped"): Promise<void> {
		this.aborter.abort(new Error(reason));
		await this.session.abort?.().catch(() => {});
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.aborter.abort(new Error("disposed"));
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

/**
 * What a Worker may do to *other agents*: dispatch one, or talk to one.
 *
 * A Worker used to be a leaf. It is not: a task big enough to need three
 * independent checks should run them in parallel rather than serialise them
 * through one context, and a Worker is the only thing that can see its own task
 * clearly enough to split it. So a top-level Worker gets `dispatch_task`, and
 * the daemon runs the child and returns its conclusion as this call's result.
 *
 * A subagent gets neither. Depth stops at one level, and it stops here — as a
 * list of tools, not as an instruction the model could reason its way around.
 */
export interface AgentChannel {
	dispatchChild(
		requestId: string,
		title: string,
		description: string,
		instructions?: string,
	): Promise<{ text: string; ok: boolean }>;
	message(to: string, text: string): void;
	/** Stop a check this Worker dispatched. The daemon checks that it is theirs. */
	stopTask(taskId: string): Promise<{ ok: boolean; error?: string }>;
}

export function createAgentTools(
	channel: AgentChannel,
	options: { readonly taskId: string; readonly canDispatch: boolean; readonly parentTaskId?: string },
): ToolDefinition[] {
	const tools: ToolDefinition[] = [
		defineTool({
			name: "message",
			label: "Message another agent",
			description: [
				"A note to the agent that dispatched you (`to: \"parent\"`) or to a check you dispatched (its task id).",
				"It is read at the other agent's next turn boundary, never mid-turn, so it is for what they should know — not a way to interrupt them.",
				"Use it when the answer changes what they should do: the check is failing for a reason outside its brief, or the parent's instruction no longer matches what you found.",
			].join("\n"),
			parameters: Type.Object({
				to: Type.String({ description: "\"parent\", or a task id of a check you dispatched." }),
				text: Type.String({ description: "What they should know, in one or two sentences." }),
			}),
			exposure: "direct",
			async execute(_id, params) {
				channel.message(params.to, params.text);
				return {
					content: [{ type: "text", text: `sent to ${params.to}` }],
					details: { to: params.to },
				};
			},
		}),
	];

	if (!options.canDispatch) return tools;

	tools.unshift(
		defineTool({
			name: "stop_task",
			label: "Stop a check you dispatched",
			description: [
				"Stop one of your own checks — the ones `dispatch_task` returned a task id for.",
				"Use it when a check is clearly going the wrong way, or has been running long enough that its answer will arrive too late to matter. You cannot stop anything you did not dispatch.",
			].join("\n"),
			parameters: Type.Object({
				task_id: Type.String({ description: "The task id of the check to stop." }),
			}),
			exposure: "direct",
			async execute(_id, params) {
				const result = await channel.stopTask(params.task_id);
				return {
					content: [{ type: "text", text: result.ok ? `stopped ${params.task_id}` : `could not stop it: ${result.error ?? "unknown"}` }],
					details: { taskId: params.task_id, ok: result.ok },
					...(result.ok ? {} : { isError: true }),
				};
			},
		}),
	);

	tools.unshift(
		defineTool({
			name: "dispatch_task",
			label: "Dispatch a check",
			description: [
				"Run one independent check in a subagent and wait for its conclusion.",
				"The `subagents` skill says when the work divides and how to write the brief — read it before you split anything.",
				"The result is that subagent's conclusion, written for you rather than for a person.",
			].join("\n"),
			parameters: Type.Object({
				title: Type.String({ description: "Short title: what this check is." }),
				description: Type.String({ description: "What this check is for, in one sentence." }),
				instructions: Type.Optional(
					Type.String({
						description:
							"The brief the check is told: which files, what to decide, what to report. Omit when the description says everything.",
					}),
				),
			}),
			exposure: "direct",
			async execute(_id, params) {
				const requestId = crypto.randomUUID();
				const result = await channel.dispatchChild(requestId, params.title, params.description, params.instructions);
				return {
					content: [{ type: "text", text: result.text }],
					details: { title: params.title, ok: result.ok },
					...(result.ok ? {} : { isError: true }),
				};
			},
		}),
	);

	return tools;
}
