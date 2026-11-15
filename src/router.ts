/**
 * Router Layer (Section 2.1).
 *
 * Long-lived global routing layer. It receives every Event (via Channels) and
 * every Worker conclusion. It does NOT execute tasks and it does NOT write raw
 * text to any channel: it answers by calling a Channel's response tool
 * (`respond_<channel>`) and dispatches by calling `dispatch_task`.
 *
 * Scheduling model (this is where the correctness of the layer lives):
 *
 *   - One **serialized inbox**. Triggers, worker conclusions, worker exits,
 *     recovery notices and system signals all enter the same queue, and exactly
 *     one turn runs at a time. That removes the old "prompt while streaming
 *     returns immediately, so the reply check runs against a half-finished
 *     turn" bug: a turn's reply attribution is only evaluated after
 *     `waitForIdle()`.
 *   - **Batching as a consequence of a busy turn** (§2.1), not a trailing
 *     debounce. When idle, a fixed `batchWindowMs` coalesces the first arrivals;
 *     the timer is never reset by later arrivals, so a steady event stream
 *     cannot starve the Router. While a turn runs, everything that piles up is
 *     folded into the next turn.
 *   - **Durable** task/worker/thread state and a durable trigger log, so a
 *     restart does not erase what the agent was doing (item 2).
 *   - **Chain of Recall**: long payloads are spilled to the store and inlined as
 *     summaries plus ids, with a `recall` tool to hop back to them (item 4).
 */

import {
	SessionManager,
	defineTool,
	type AgentToolResult,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { RouterStatus, SuperAgentConfig, Task, TaskStatus, Trigger, WorkerInfo } from "./types.ts";
import type { Channel, ChannelEvent, ReplyContext, ReplyRecorder } from "./channels/types.ts";
import { ContextManager, createRecallTool } from "./context.ts";
import { ThreadManager } from "./thread.ts";
import type { WorkerSpawner } from "./process-manager.ts";
import type { HandStatus } from "./hands/protocol.ts";
import type { McpCatalogEntry } from "./mcp-catalog.ts";
import type { McpConfig } from "./mcp.ts";
import type { MirStore } from "./store.ts";
import { metrics, log } from "./telemetry.ts";
import { redactSecrets } from "./security.ts";
import { createPiSession, settleSession, type AgentSessionLike, type SessionFactory } from "./session.ts";
import type { NewThreadEntry, ThreadEntry, ThreadLog } from "./threadlog.ts";

/**
 * How long a worker's output is buffered before it becomes a log entry.
 *
 * Short enough that a person watching a work thread sees it move; long enough
 * that a streaming reply is a paragraph, not a line per token.
 */
const DELTA_FLUSH_MS = 750;

export interface RouterControl {
	abort(workerId: string, reason?: string): boolean;
	isConnected(workerId: string): boolean;
}

export interface RouterDependencies {
	modelRuntime: any;
	model: any;
	config: SuperAgentConfig;
	context: ContextManager;
	threads: ThreadManager;
	channels: Channel[];
	processManager: WorkerSpawner;
	store: MirStore;
	onTurnComplete: () => void;
	getMcpCatalog?: () => McpCatalogEntry[];
	/** Control-channel handle (abort / liveness). */
	control?: RouterControl;
	/** Deliver a follow-up event to a worker (fast-path pass-through). */
	sendEventToWorker?: (workerId: string, event: ChannelEvent) => boolean;
	/** Called when a persisted worker is found dead at boot, so pm2 can clean it up. */
	onOrphanedWorker?: (workerId: string, taskId: string) => void;
	/** Injectable session factory (tests use a scripted session). */
	sessionFactory?: SessionFactory;
	/** Hands: where execution happens, and the socket a Worker uses to reach it. */
	hands?: { socketPath: string; listHands: () => HandStatus[] };
	/**
	 * The MCP servers this member may reach, as the stack serves them. A Worker
	 * spawned now is given the current answer; a change reaches the Workers
	 * already running through the daemon's `mcp_changed` broadcast.
	 */
	mcpServers?: { current: () => McpConfig };
	/**
	 * The durable thread log. Optional so a test or a minimal deployment can run
	 * the Router without one; every append is skipped when it is absent.
	 */
	threadLog?: ThreadLog;
	/** Called with each entry after it is stored, so a watching client sees it live. */
	publishEntry?: (threadId: string, entry: ThreadEntry) => void;
}

export interface TaskInput {
	title: string;
	/** What the task is for: a line for the person, shown on the card and in the thread. */
	description: string;
	/** The brief the Worker is told, when it is more than the description. */
	instructions?: string;
	threadId?: string;
	channelId?: string;
	replyTo?: string;
	id?: string;
	/** Fast task → Worker uses the lightweight model instead of the Router's main model. */
	fast?: boolean;
	/** Pin the task to one hand; omitted = the hub picks the least-loaded capable one. */
	endpointId?: string;
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

/** One unit of Router input. A batch is a slice of these. */
type InboxItem =
	| { kind: "trigger"; trigger: Trigger; attempts: number }
	| {
			kind: "conclusion";
			attempts?: number;
			workerId: string;
			taskId: string;
			text: string;
			channelId?: string;
			replyTo?: string;
			threadId?: string;
			failed?: boolean;
	  }
	| { kind: "worker-exit"; workerId: string; taskId: string; reason: string; attempts?: number }
	| {
			kind: "recovery";
			text: string;
			channelId?: string;
			replyTo?: string;
			threadId?: string;
			attempts?: number;
	  }
	| { kind: "signal"; text: string; attempts?: number };

interface TurnReply {
	channelId: string;
	text: string;
	ctx: ReplyContext;
	at: number;
}

interface TurnState {
	startedAt: number;
	replies: TurnReply[];
	dispatches: string[];
	/** Stops asked for during this turn (the `stop_task` tool counts one). */
	stops: number;
	/**
	 * Threads the person stopped while this turn was running. A turn mid-flight
	 * can still dispatch a moment later; a stop is "do not do this", not only
	 * "end the turn".
	 */
	stoppedThreads: Set<string>;
	captured: string;
	/**
	 * The thread this turn is answering, when its batch is about one.
	 *
	 * A reply tool may name a thread, and usually does not: a chat's turn has one
	 * thread in front of it. This is the fallback, so the log records the reply
	 * on the thread it answered rather than nowhere.
	 */
	originThreadId?: string;
}

function emptyTurn(originThreadId?: string): TurnState {
	return {
		startedAt: Date.now(),
		replies: [],
		dispatches: [],
		stops: 0,
		stoppedThreads: new Set<string>(),
		captured: "",
		originThreadId,
	};
}

/**
 * Whether a task is small enough for the lightweight model.
 *
 * The Router used to be asked this, which made a cost decision one more thing to
 * get right before dispatching. It is a cost knob, not a correctness one: a
 * wrong guess spends tokens, it does not change the answer, so a plain rule is
 * better than another judgement call in the turn.
 */
function isTrivial(description: string): boolean {
	return (
		description.length <= 240 &&
		!/\b(refactor|migrat|audit|review|debug|implement|investigat|design|rewrite|test suite)\b/i.test(description)
	);
}

/**
 * Whether a chat is still called what the stack mints it as.
 *
 * A new chat's row says "Chat" and its thread is named after its id, so a member's
 * list is a column of identical rows they cannot tell apart. The agent is told to
 * name its chat and does; this is what the Router checks, so "named" is a fact
 * about the chat rather than a hope about the model.
 */
function isPlaceholderChatName(name: string | undefined, chatId: string): boolean {
	const trimmed = (name ?? "").trim();
	return trimmed === "" || trimmed === chatId || trimmed.toLowerCase() === "chat";
}

/** How long a derived name may be: a title someone can scan in a list, not a sentence. */
const DERIVED_TITLE_MAX = 48;

/**
 * A chat's name taken from what the turn did, when the agent left the placeholder.
 *
 * Not a summary: the first words of a title the agent already wrote for the work
 * ("List active Linear projects"), or, failing that, the person's own opening
 * words. Cut at a word boundary, because a title broken mid-word reads as a bug.
 */
function derivedChatTitle(source: string): string | undefined {
	const flat = source.replace(/\s+/g, " ").trim();
	if (flat === "") return undefined;
	let cut = flat;
	if (cut.length > DERIVED_TITLE_MAX) {
		const at = cut.lastIndexOf(" ", DERIVED_TITLE_MAX);
		cut = cut.slice(0, at > 12 ? at : DERIVED_TITLE_MAX);
	}
	cut = cut.replace(/[\s.,;:!?\-–—]+$/u, "").trim();
	if (cut === "") return undefined;
	return cut[0]!.toUpperCase() + cut.slice(1);
}

/** Small helper so retry backoff does not block the event loop tests use. */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

/**
 * The channels a person types into. Their words are conversation, so they belong
 * in the thread's log; a tool's or the watchdog's trigger is machinery, and the
 * log is what a person reads.
 */
const PERSON_CHANNELS: ReadonlySet<string> = new Set<string>(["anomalous", "terminal"]);

export class RouterLayer {
	private session!: AgentSessionLike;
	private readonly deps: RouterDependencies;
	private readonly config: SuperAgentConfig;
	private readonly tasks = new Map<string, Task>();
	private readonly workers = new Map<string, WorkerRecord>();
	private readonly dispatchQueue: Array<{ taskId: string; input: TaskInput }> = [];
	/** Per-worker output waiting to be written into its thread. */
	private readonly deltaBuffers = new Map<string, { text: string; timer: NodeJS.Timeout }>();
	private readonly inbox: InboxItem[] = [];
	private turn: TurnState = emptyTurn();
	private drainTimer: NodeJS.Timeout | null = null;
	private draining = false;
	private pendingSpawns = 0;
	private disposed = false;
	private lastTurnAt = 0;
	private turnInFlightSince = 0;
	private turnCount = 0;

	private readonly recorder: ReplyRecorder = {
		record: (channelId, text, ctx) => {
			this.turn.replies.push({ channelId, text, ctx, at: Date.now() });
			metrics.counter("mir_router_replies_total", 1, { channel: channelId });
			// The product's channel writes its reply into the chat's thread itself
			// (channels/anomalous.ts `deliver`), so recording it here as well would
			// post every answer twice. Every other channel has no such write, and is
			// logged here — where every delivery passes, so no reply can reach a
			// person without reaching the log a panel reads.
			if (channelId === "anomalous") return;
			// A reply that names no thread belongs to the one the turn is answering.
			this.record(ctx.threadId ?? this.turn.originThreadId, { kind: "text", role: "assistant", text });
		},
	};

	/**
	 * Record the assistant's own tool call on the conversation's thread.
	 *
	 * The chat draws what the assistant *did* from its thread, not from prose: a
	 * dispatch becomes a card that links to the work, because the call and its
	 * result are entries there like everything else.
	 */
	private recordTurnTool(call: { id: string; name: string; args: unknown }): void {
		this.record(this.turn.originThreadId, {
			kind: "tool_call",
			toolCallId: call.id,
			toolName: call.name,
			args: call.args,
		});
	}

	/** What that call answered, on the same thread. */
	private recordTurnToolResult(callId: string, result: unknown, isError = false): void {
		this.record(this.turn.originThreadId, { kind: "tool_result", toolCallId: callId, isError, result });
	}

	/** Append to a thread's log and tell whoever is watching. Absent log = no-op. */
	private record(threadId: string | undefined, entry: NewThreadEntry): void {
		const threadLog = this.deps.threadLog;
		if (threadLog === undefined || threadId === undefined || threadId === "") return;
		try {
			// A status entry moves the thread's own state as well as the log, so the
			// column a list reads and the entries a panel reads cannot disagree.
			const stored =
				entry.kind === "status" ? threadLog.setStatus(threadId, entry.status, entry.note) : threadLog.append(threadId, entry);
			this.deps.publishEntry?.(threadId, stored);
		} catch (err) {
			// A log failure must never cost the turn: the reply is already delivered.
			log.warn("thread log append failed", { thread: threadId, kind: entry.kind, error: (err as Error).message });
		}
	}

	private constructor(deps: RouterDependencies) {
		this.deps = deps;
		this.config = deps.config;
	}

	static async create(deps: RouterDependencies): Promise<RouterLayer> {
		const router = new RouterLayer(deps);
		const customTools = router.buildTools();
		const factory = deps.sessionFactory ?? createPiSession;
		const sessionManager = (() => {
			try {
				return deps.config.sessionDir
					? SessionManager.open(deps.config.sessionDir)
					: SessionManager.inMemory();
			} catch (err) {
				log.warn("router session file unreadable; starting in memory", {
					path: deps.config.sessionDir,
					error: (err as Error).message,
				});
				return SessionManager.inMemory();
			}
		})();
		router.session = await factory({
			model: deps.model,
			modelRuntime: deps.modelRuntime,
			sessionManager,
			thinkingLevel: deps.config.thinkingLevel,
			noTools: "builtin",
			customTools,
		});
		router.session.subscribe((event: any) => {
			if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
				router.turn.captured += event.assistantMessageEvent.delta ?? "";
			}
			if (event.type === "auto_retry_end" && event.success === false) {
				log.warn("router model retry exhausted", { error: event.finalError });
			}
		});
		router.restore();
		return router;
	}

	// ----- Tools the Router uses to act -----

	private buildTools(): ToolDefinition[] {
		return [
			...this.deps.channels.map((c) => c.responseTool(this.recorder)),
			this.buildDispatchTool(),
			this.buildStopTaskTool(),
			this.buildListWorkersTool(),
			this.buildListTasksTool(),
			this.buildListHandsTool(),
			this.buildChatTitleTool(),
			createRecallTool(this.deps.context),
		];
	}

	private buildDispatchTool(): ToolDefinition {
		const router = this;
		return defineTool({
			name: "dispatch_task",
			label: "Dispatch task to a Worker",
			description: [
				"The only way work gets done. Dispatch an isolated background Worker (its own OS process) to carry out one job.",
				"Anything not in the five exceptions in \"How to act\" is this call — a question about their repo, their files, their machine, their accounts or their connected services included. If you are unsure whether it is a quick reply, it is not.",
				"The Worker reports a conclusion back to you, which arrives as a new turn. This call returns immediately, so say one short line first.",
			].join("\n"),
			parameters: Type.Object({
				title: Type.String({ description: "Short task title: what this is, in a few words." }),
				description: Type.String({
					description:
						"What this is for, in one sentence, as you would say it to the person: the card and the thread show this, and it is all they read.",
				}),
				instructions: Type.Optional(
					Type.String({
						description:
							"The brief the Worker is told: paths, constraints, what a good answer looks like. Write it for an agent doing the work, not for the person reading the card. Omit when the description already says everything.",
					}),
				),
				channel: Type.Optional(Type.String({ description: "Channel id the task originated from." })),
				thread: Type.Optional(Type.String({ description: "Thread id the task belongs to." })),
				reply_to: Type.Optional(Type.String({ description: "Event id to reply to when done." })),
				endpoint: Type.Optional(
					Type.String({
						description:
							"Hand (execution environment) id to run on. Omit to let the hub pick the least-loaded capable hand. Call list_hands to see them.",
					}),
				),
			}),
			async execute(callId, params): Promise<AgentToolResult<any>> {
				// The call is in the conversation's log before the task exists, so a
				// display shows the card (and its spinner) from the first instant.
				router.recordTurnTool({
					id: callId,
					name: "dispatch_task",
					args: {
						title: params.title,
						description: params.description,
						...(params.instructions === undefined ? {} : { instructions: params.instructions }),
						...(params.endpoint === undefined ? {} : { endpoint: params.endpoint }),
					},
				});
				try {
					const task = await router.dispatchTask({
						title: params.title,
						description: params.description,
						threadId: params.thread,
						channelId: params.channel,
						replyTo: params.reply_to,
						fast: isTrivial(params.description),
						endpointId: params.endpoint,
					});
					router.turn.dispatches.push(task.id);
					// The card reads `details.threadId`: the task's own thread, which is
					// where its work is written and what a click opens.
					router.recordTurnToolResult(callId, {
						details: { taskId: task.id, workerId: task.workerId, status: task.status, threadId: task.threadId },
					});
					return {
						content: [
							{
								type: "text",
								text:
									task.status === "queued"
										? `task ${task.id} queued (worker capacity full; it starts when a slot frees)`
										: `dispatched task ${task.id} (worker ${task.workerId})`,
							},
						],
						details: { taskId: task.id, workerId: task.workerId, status: task.status },
					};
				} catch (err) {
					router.recordTurnToolResult(callId, { error: (err as Error).message }, true);
					return {
						content: [{ type: "text", text: `dispatch failed: ${(err as Error).message}` }],
						details: { error: (err as Error).message },
						isError: true,
					};
				}
			},
		});
	}

	private buildStopTaskTool(): ToolDefinition {
		const router = this;
		return defineTool({
			name: "stop_task",
			label: "Stop a running task",
			description:
				"Abort a running Worker and mark its task cancelled. Use when the user cancels, or when a task is clearly going the wrong way.",
			parameters: Type.Object({
				task_id: Type.String({ description: "Task id to stop." }),
				reason: Type.Optional(Type.String({ description: "Why it was stopped (recorded on the task)." })),
			}),
			async execute(callId, params): Promise<AgentToolResult<any>> {
				try {
					const task = await router.stopTask(params.task_id, params.reason);
					router.turn.dispatches.push(task.id);
					// The card reads `details.threadId`: the task's own thread, which is
					// where its work is written and what a click opens.
					router.recordTurnToolResult(callId, {
						details: { taskId: task.id, workerId: task.workerId, status: task.status, threadId: task.threadId },
					});
					return {
						content: [{ type: "text", text: `stopped task ${task.id}` }],
						details: { taskId: task.id, status: task.status },
					};
				} catch (err) {
					return {
						content: [{ type: "text", text: `stop failed: ${(err as Error).message}` }],
						details: { error: (err as Error).message },
						isError: true,
					};
				}
			},
		});
	}

	/**
	 * Name the chat this turn is answering.
	 *
	 * A chat is a conversation, and its name is the one thing about it a person
	 * sees before they open it — so it is worth the agent's judgement once the
	 * subject is clear, and worth nothing as a running commentary. Called with no
	 * title it answers with what the chat is called now, which is how the agent
	 * can tell a placeholder ("Chat") from a name someone chose.
	 */
	private buildChatTitleTool(): ToolDefinition {
		const router = this;
		return defineTool({
			name: "chat_title",
			label: "Name this chat",
			description: [
				"Read or set the name of the chat you are talking in.",
				"With no `title`: answers what this chat is called now.",
				"With a `title`: renames it — four or five words in the person's own language, naming what this conversation is about (\"Linear projects in flight\", \"Fixing the login redirect\"). Name it once you know what they are after, especially while it is still called \"Chat\"; rename it later only when the subject genuinely changes. Not every turn, and never as a summary of a single request.",
				"A title is not a reply: renaming says nothing to the person, so say your line as usual.",
			].join("\n"),
			parameters: Type.Object({
				title: Type.Optional(
					Type.String({ description: "The chat's new name, or omitted to read the current one." }),
				),
			}),
			async execute(_id, params): Promise<AgentToolResult<any>> {
				const threadId = router.turn.originThreadId;
				const log = router.deps.threadLog;
				if (threadId === undefined || log === undefined) {
					return {
						content: [{ type: "text", text: "this turn answers no chat, so it has no name to change" }],
						details: { renamed: false },
					};
				}
				const title = params.title?.trim();
				if (title === undefined || title === "") {
					const current = log.name(threadId) ?? "(unnamed)";
					return {
						content: [{ type: "text", text: `this chat is called "${current}"` }],
						details: { title: current },
					};
				}
				const entry = log.rename(threadId, title);
				router.deps.publishEntry?.(threadId, entry);
				metrics.counter("mir_router_chat_renamed_total");
				return {
					content: [{ type: "text", text: `renamed this chat to "${title}"` }],
					details: { title, renamed: true },
				};
			},
		});
	}

	private buildListWorkersTool(): ToolDefinition {
		const router = this;
		return defineTool({
			name: "list_workers",
			label: "List Workers",
			description: "List the currently tracked Workers, their tasks and status.",
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

	private buildListTasksTool(): ToolDefinition {
		const router = this;
		return defineTool({
			name: "list_tasks",
			label: "List tasks",
			description:
				"List tasks the agent has dispatched, newest last. Use `recall` with a task id to read its full description or result.",
			parameters: Type.Object({
				status: Type.Optional(
					Type.String({ description: "Filter: queued|running|blocked|done|failed|cancelled" }),
				),
				limit: Type.Optional(Type.Number({ description: "Max tasks to list (default 20)." })),
			}),
			async execute(_id, params): Promise<AgentToolResult<any>> {
				const limit = Math.max(1, Math.min(100, Math.floor(params.limit ?? 20)));
				let all = router.listTasks();
				if (params.status) all = all.filter((t) => t.status === params.status);
				const slice = all.slice(-limit);
				const lines = slice.map(
					(t) =>
						`${t.id} [${t.status}]${t.fast ? " (fast)" : ""} — ${t.title}${t.workerId ? ` (worker ${t.workerId})` : ""}`,
				);
				return {
					content: [{ type: "text", text: lines.length ? lines.join("\n") : "no tasks" }],
					details: { count: slice.length, total: all.length },
				};
			},
		});
	}

	private buildListHandsTool(): ToolDefinition {
		const router = this;
		return defineTool({
			name: "list_hands",
			label: "List hands (execution environments)",
			description:
				"List the execution environments this agent can dispatch work to, with their capabilities, roots and load. " +
				"Workers run on a hand; pass its id to dispatch_task to pin a task there.",
			parameters: Type.Object({}),
			async execute(): Promise<AgentToolResult<any>> {
				const hands = router.deps.hands?.listHands() ?? [];
				const text = hands.length
					? hands
							.map(
								(h) =>
									`${h.endpointId} (${h.kind}${h.connected ? "" : ", offline"}) — exec=${h.capabilities.exec} shell=${h.capabilities.shell} fs=${h.capabilities.fs} git=${h.capabilities.git} running=${h.running}/${h.policy.maxConcurrent}\n  roots: ${h.policy.roots.join(", ") || "(none)"}`,
							)
							.join("\n")
					: "no hands are connected";
				return { content: [{ type: "text", text }], details: { count: hands.length, hands } };
			},
		});
	}

	// ----- Inbound queue (serialized, batched) -----

	submitTrigger(trigger: Trigger): void {
		// What a person said is part of the thread, not only what the agent
		// answered: a chat is a projection of its thread, and a projection cannot
		// show words that were never written down. Recorded at admission, once, so
		// a retried trigger does not say the same thing twice.
		const said = trigger.text.trim();
		if (said !== "" && PERSON_CHANNELS.has(trigger.channelId) && trigger.threadId !== undefined) {
			this.record(trigger.threadId, { kind: "text", role: "user", text: said });
		}
		this.push({ kind: "trigger", trigger, attempts: trigger.attempts ?? 0 });
	}

	private push(item: InboxItem): void {
		if (this.disposed) return;
		this.inbox.push(item);
		metrics.gauge("mir_router_queue_depth", this.inbox.length);
		this.scheduleDrain();
	}

	/**
	 * Coalesce only when idle, with a fixed window from the first arrival.
	 * The timer is never reset, so a steady stream cannot postpone the turn.
	 */
	private scheduleDrain(): void {
		if (this.disposed || this.draining || this.drainTimer) return;
		const delay = this.inbox.length === 1 ? Math.max(0, this.config.batchWindowMs) : 0;
		if (delay === 0) {
			void this.drain();
			return;
		}
		this.drainTimer = setTimeout(() => {
			this.drainTimer = null;
			void this.drain();
		}, delay);
		this.drainTimer.unref();
	}

	private async drain(): Promise<void> {
		if (this.draining || this.disposed) return;
		this.draining = true;
		try {
			while (!this.disposed && this.inbox.length > 0) {
				const batch = this.inbox.splice(0, Math.max(1, this.config.maxBatchSize));
				await this.runTurn(batch);
			}
		} finally {
			this.draining = false;
			metrics.gauge("mir_router_queue_depth", this.inbox.length);
			if (!this.disposed && this.inbox.length > 0) this.scheduleDrain();
		}
	}

	private async runTurn(batch: InboxItem[]): Promise<void> {
		if (batch.length === 0) return;
		this.turn = emptyTurn(this.originOf(batch)?.threadId);
		this.turnInFlightSince = Date.now();
		metrics.gauge("mir_router_turn_in_flight", 1);
		const prompt = this.buildPrompt(batch);
		const triggerCount = batch.filter((i) => i.kind === "trigger").length;
		log.info("router turn start", {
			items: batch.length,
			triggers: triggerCount,
			queue: this.inbox.length,
		});
		try {
			await this.promptWithTimeout(prompt);
			// The turn (including any queued follow-ups) must be settled before we
			// judge whether the model replied — otherwise attribution races the model.
			await settleSession(this.session);
			await this.ensureReply(batch);
			const duration = Date.now() - this.turn.startedAt;
			metrics.observe("mir_router_turn_ms", duration);
			metrics.observe("mir_router_batch_size", batch.length);
			metrics.counter("mir_router_turns_total");
			metrics.counter("mir_router_dispatches_total", this.turn.dispatches.length);
			log.info("router turn end", {
				ms: duration,
				replies: this.turn.replies.length,
				dispatches: this.turn.dispatches.length,
			});
			this.turnCount++;
			this.lastTurnAt = Date.now();
		} catch (err) {
			await this.handleTurnFailure(batch, err as Error);
		} finally {
			this.turnInFlightSince = 0;
			metrics.gauge("mir_router_turn_in_flight", 0);
			// A stopped turn says nothing, and a name is not what the person stopped:
			// leave it as it is. Any other turn ends with the chat named.
			if (this.turn.stoppedThreads.size === 0) this.nameChatIfPlaceholder(batch);
			this.onTurnDone();
		}
	}

	/**
	 * Name the chat, when the agent did not.
	 *
	 * The prompt asks for a name on the first real request and again whenever the
	 * subject moves, and a model that skips it leaves the member with a chat called
	 * "Chat" that they cannot find again. Advice is not a mechanism: this runs at
	 * the end of every turn and gives the chat the name the work already carries.
	 *
	 * A work thread is left alone — its name is its task's — and so is a chat the
	 * agent has named, whatever it called it.
	 */
	private nameChatIfPlaceholder(batch: InboxItem[]): void {
		const threadId = this.turn.originThreadId;
		const threadLog = this.deps.threadLog;
		if (threadId === undefined || threadLog === undefined) return;
		const chatId = threadLog.chatOf(threadId);
		if (chatId === undefined) return;
		if (!isPlaceholderChatName(threadLog.name(threadId), chatId)) return;

		let source: string | undefined;
		for (const taskId of this.turn.dispatches) {
			const title = this.tasks.get(taskId)?.title;
			if (title !== undefined && title.trim() !== "") {
				source = title;
				break;
			}
		}
		if (source === undefined) {
			// Failing that, the person's own opening words — but only when they name
			// something. "Hey there" is not a title, and a chat called after a greeting
			// is no easier to find than one called "Chat": a turn with no work and no
			// subject leaves the name to the agent, who can see there is none.
			for (const item of batch) {
				if (item.kind !== "trigger") continue;
				const words = item.trigger.text.trim().split(/\s+/).filter((word) => word !== "");
				if (words.length < 4) continue;
				source = item.trigger.text;
				break;
			}
		}
		const title = source === undefined ? undefined : derivedChatTitle(source);
		if (title === undefined) return;

		try {
			const entry = threadLog.rename(threadId, title);
			this.deps.publishEntry?.(threadId, entry);
			metrics.counter("mir_router_chat_named_from_turn_total");
			log.info("named the chat from the turn", { thread: threadId, title });
		} catch (err) {
			log.warn("could not name the chat", { thread: threadId, error: (err as Error).message });
		}
	}

	private async promptWithTimeout(prompt: string): Promise<void> {
		let timer: NodeJS.Timeout | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(new Error(`router turn exceeded ${this.config.routerTurnTimeoutMs}ms`)),
				this.config.routerTurnTimeoutMs,
			);
			timer.unref();
		});
		try {
			await Promise.race([this.session.prompt(prompt), timeout]);
		} catch (err) {
			// A hung turn must not wedge the layer: abort it and let the retry path
			// decide whether the batch is retried or failed.
			await this.session.abort?.().catch(() => {});
			throw err;
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	private async handleTurnFailure(batch: InboxItem[], err: Error): Promise<void> {
		metrics.counter("mir_router_turn_errors_total");
		log.error("router turn failed", { error: err.message, items: batch.length });

		// An aborted turn is a stopped turn, not a failed one: a retry would run
		// the work the person just cancelled, one backoff later.
		if (this.turn.stoppedThreads.size > 0) {
			log.info("router turn stopped; not retrying", { items: batch.length, threads: [...this.turn.stoppedThreads] });
			for (const item of batch) {
				if (item.kind === "trigger") {
					this.deps.store.markEvent(item.trigger.id, "failed", "the person stopped this");
				}
			}
			return;
		}

		const retryable: InboxItem[] = [];
		const exhausted: InboxItem[] = [];
		// Conclusions and recovery notices are retried too: losing the relay of a
		// finished task's result is just as bad as losing the task itself.
		for (const item of batch) {
			const attempts = (item.attempts ?? 0) + 1;
			const retry = attempts < this.config.maxTriggerAttempts;
			if (item.kind === "trigger") {
				if (retry) {
					this.deps.store.bumpEventAttempts(item.trigger.id);
					this.deps.store.markEvent(item.trigger.id, "pending", err.message);
				} else {
					this.deps.store.markEvent(item.trigger.id, "failed", err.message);
				}
			}
			if (retry) retryable.push({ ...item, attempts } as InboxItem);
			else exhausted.push(item);
		}

		if (retryable.length > 0) {
			// Re-queue at the front so ordering is preserved, then back off.
			this.inbox.unshift(...retryable);
			metrics.counter("mir_router_turn_retries_total");
			await sleep(this.config.routerRetryBackoffMs);
		}

		// Tell the human when we give up, instead of silently swallowing the event.
		const origin = this.originOf(exhausted);
		if (origin) {
			const channel = this.channelFor(origin.channelId);
			const text = redactSecrets(
				`I couldn't complete that request (${err.message}). The event is recorded; nothing was lost.`,
			);
			await channel?.respond(text, { eventId: origin.id, threadId: origin.threadId }).catch(() => {});
			this.record(origin.threadId, { kind: "text", role: "assistant", text });
		}
	}

	/** Deliver the model's plain text when it acted through no tool at all. */
	private async ensureReply(batch: InboxItem[]): Promise<void> {
		if (this.turn.stoppedThreads.size > 0) return;
		if (this.turn.replies.length > 0 || this.turn.dispatches.length > 0) return;
		const text = this.turn.captured.trim();
		if (!text) return;
		const origin = this.originOf(batch);
		if (!origin) return;
		const channel = this.channelFor(origin.channelId);
		if (!channel) return;
		log.warn("router answered without a response tool; using fallback delivery", {
			channel: origin.channelId,
			event: origin.id,
		});
		metrics.counter("mir_router_fallback_replies_total", 1, { channel: origin.channelId });
		const delivered = redactSecrets(text);
		await channel.respond(delivered, { eventId: origin.id, threadId: origin.threadId });
		this.record(origin.threadId, { kind: "text", role: "assistant", text: delivered });
	}

	private originOf(batch: InboxItem[]): { channelId: string; id?: string; threadId?: string } | undefined {
		for (let i = batch.length - 1; i >= 0; i--) {
			const item = batch[i]!;
			if (item.kind === "trigger") {
				return { channelId: item.trigger.channelId, id: item.trigger.id, threadId: item.trigger.threadId };
			}
			if (item.kind === "conclusion" && item.channelId) {
				return { channelId: item.channelId, id: item.replyTo, threadId: item.threadId };
			}
			if (item.kind === "recovery" && item.channelId) {
				return { channelId: item.channelId, id: item.replyTo, threadId: item.threadId };
			}
			if (item.kind === "worker-exit") {
				const task = this.tasks.get(item.taskId);
				if (task?.channelId) {
					return { channelId: task.channelId, id: task.replyTo, threadId: task.threadId };
				}
			}
		}
		return undefined;
	}

	private channelFor(channelId: string): Channel | undefined {
		return this.deps.channels.find((c) => c.id === channelId) ?? this.deps.channels[0];
	}

	private buildPrompt(batch: InboxItem[]): string {
		const lines: string[] = ["=== Inbound (Router turn) ===", ""];

		for (const item of batch) {
			switch (item.kind) {
				case "trigger": {
					const t = item.trigger;
					const thread = t.threadId ? this.deps.threads.getThread(t.threadId) : undefined;
					const related = [
						...(thread ? [this.threadObjectId(thread.id), ...thread.subscriberWorkerIds.map((w) => `worker:${w}`)] : []),
					];
					// Inline a summary, spill the full text: the model can `recall` it.
					const objectId = `trigger:${t.id}`;
					this.deps.context.spill({
						id: objectId,
						type: "trigger",
						summary: `${t.channelId}${t.threadId ? ` thread=${t.threadId}` : " (new thread)"} from=${
							t.metadata?.["user"] ?? t.metadata?.["from"] ?? "unknown"
						} :: ${t.text.replace(/\s+/g, " ")}`,
						ref: `mir://event/${t.id}`,
						inlineIds: related,
					});
					lines.push(
						this.deps.context.inline({
							id: objectId,
							type: "trigger",
							summary: `${t.channelId} thread=${t.threadId ?? "(new)"} from=${
								t.metadata?.["user"] ?? "unknown"
							} :: ${t.text}`,
							relatedIds: related,
						}),
					);
					lines.push(`  reply_to=${t.id}`);
					lines.push("");
					break;
				}
				case "conclusion": {
					const objectId = `conclusion:${item.taskId}:${Date.now()}`;
					this.deps.context.spill({
						id: objectId,
						type: "conclusion",
						summary: `worker ${item.workerId} / task ${item.taskId}${item.failed ? " (FAILED)" : ""}: ${item.text.replace(/\s+/g, " ")}`,
						ref: `mir://task/${item.taskId}`,
						inlineIds: [`task:${item.taskId}`, `worker:${item.workerId}`],
					});
					lines.push(
						this.deps.context.inline({
							id: objectId,
							type: "conclusion",
							summary: `worker ${item.workerId} finished task ${item.taskId}${item.failed ? " (FAILED)" : ""}:\n${item.text}`,
							relatedIds: [`task:${item.taskId}`, `worker:${item.workerId}`],
						}),
					);
					if (item.channelId) {
						lines.push(
							`  origin: channel=${item.channelId}${item.replyTo ? ` reply_to=${item.replyTo}` : ""}${
								item.threadId ? ` thread=${item.threadId}` : ""
							}`,
						);
					}
					lines.push("");
					break;
				}
				case "worker-exit":
					lines.push(
						`[worker-exit] ${item.workerId} (task ${item.taskId}) exited without a conclusion: ${item.reason}`,
						"",
					);
					break;
				case "recovery":
					lines.push(`[recovery] ${item.text}`, "");
					break;
				case "signal":
					lines.push(`[signal] ${item.text}`, "");
					break;
			}
		}

		lines.push(this.stateBlock());
		lines.push(this.instructionsBlock());
		return lines.join("\n");
	}

	private stateBlock(): string {
		const live = [...this.workers.values()].filter((w) => w.status === "busy" || w.status === "blocked");
		const recentTasks = this.listTasks().slice(-5);
		const parts: string[] = ["=== State ==="];
		const hands = this.deps.hands?.listHands() ?? [];
		if (hands.length) {
			parts.push(
				`hands: ${hands.filter((h) => h.connected).length} connected — ` +
					hands
						.map(
							(h) =>
								`${h.endpointId}${h.connected ? "" : "(offline)"} fs=${h.capabilities.fs} exec=${h.capabilities.exec} running=${h.running}/${h.policy.maxConcurrent}`,
						)
						.join(", "),
			);
		}
		parts.push(
			`workers: ${live.length} active of ${this.workers.size} tracked (capacity ${this.config.maxConcurrentWorkers}), queued tasks: ${this.dispatchQueue.length}`,
		);
		if (live.length) {
			parts.push(
				"active: " +
					live
						.map((w) => `${w.workerId}→${w.taskId} (${w.progress ?? w.status})`)
						.join(", "),
			);
		}
		if (recentTasks.length) {
			parts.push(
				"recent tasks: " +
					recentTasks.map((t) => `${t.id}[${t.status}] ${t.title}`).join("; "),
			);
		}
		return parts.join("\n") + "\n";
	}

	private instructionsBlock(): string {
		const channelTools = this.deps.channels.map((c) => `respond_${c.id}`).join(", ");
		return [
			"=== How to act ===",
			"You do not do work. A Worker does.",
			"",
			`Your tools: ${channelTools} (say something to the person), dispatch_task (start a Worker on a hand), stop_task, list_workers, list_tasks, list_hands (execution environments), chat_title (read or set this chat's name), recall (read spilled context by id).`,
			"You have no bash, no file tools, no browser, and none of the member's connected services (Linear, Context7, whatever else they linked) — a Worker is handed those at dispatch. So \"I don't have that tool\" is never an answer: it is a dispatch.",
			"",
			"**Dispatch, unless it is one of these five:**",
			"1. A greeting or a thank you — reply in kind.",
			"2. Something already in this turn or the State block — answer from it.",
			"3. A refusal or a policy answer — say it.",
			"4. \"What are you doing?\" — answer from the State block.",
			"5. \"Stop that\" — stop_task.",
			"",
			"Anything else is dispatch_task. If you are unsure whether it is a quick reply, it is not a quick reply: a question about their machine, their repo, their files, their accounts or their services is a dispatch.",
			"",
			"**Answer first, then work.** Someone is waiting on you, so the first thing you do in a turn is say something to them:",
			"- If the answer is one of the five, say it now — one or two sentences, no preamble.",
			"- If it is work, say in one short line what you are about to do, then dispatch. A confirmation is a reply: \"Checking the repo now.\" beats ten seconds of silence, and the person should never watch a spinner wondering whether you heard them.",
			"- That line is conversation, not a label. \"Checking your Linear projects now.\" — never the task title (\"List active Linear projects\"), never an imperative, never a summary of what you were asked.",
			"- A dispatch already tells the person it started, in the words of the thing that started it. Do not repeat it: add only what that line does not say, or nothing.",
			"",
			"Then act with tools, and do not wait for the Worker: your turn ends and its conclusion arrives as a new turn.",
			"- one job → one dispatch_task. Independent jobs (a fix and its docs) may go as two, up to three per turn; never split one question into research and answer.",
			"- a running Worker that needs a correction → message it, do not dispatch a second one at the same files.",
			"- a worker conclusion → tell the person the outcome, once. Add a sentence only if it changes what they should do; otherwise say nothing at all.",
			"- pure noise → do nothing.",
			"",
			`Channels: ${this.deps.channels.map((c) => c.id).join(", ")}. Always reply through respond_<channel> with reply_to = the event id — never as plain assistant text.`,
			"Write like a person talking to a person: their language, no headings, no \"Done.\", no \"Task complete.\", no \"I will now…\", and never restate the question.",
			"Never mention the machinery: no \"worker\", \"subagent\", \"agent\", \"hand\", \"tool\", \"task\" or \"thread\", and no describing a dispatch (\"spinning up\", \"sending this to\", \"the Worker will\"). They asked one assistant for something; say what you are doing about it, in the first person: \"Checking the repo now.\", not \"Spinning up a Worker to check the repo.\" If the answer is \"I'll figure it out\", that is the whole line.",
			"If you need context that is not in this turn, call recall with an id or a query rather than guessing.",
			"",
			"**Name the chat, and keep naming it.** The title is what the person sees in their list: a chat called \"Chat\" is one they cannot find again, and one named after the first thing they said is wrong the moment the conversation moves. You are the only thing that knows what this conversation is about, so naming it is part of answering it:",
			"- The first real request: call chat_title with four or five words in their language — \"Linear projects in flight\", \"Login redirect bug\". Never end a turn with the chat still called \"Chat\".",
			"- Every turn after that: if this turn is about something the current name does not describe — a different file, a different problem, a new request that has moved on — rename it. Do not wait to be asked, and do not keep a name that has stopped being true.",
			"- A name is the whole conversation, not the last message: do not restate the request you just answered, and do not rename when the subject has not moved. \"Fixing the login redirect\" stays right for ten turns about it.",
			"- Called with no title it tells you what the chat is called now, which is how you tell a placeholder from a name someone chose.",
		].join("\n");
	}

	/**
	 * Whether `entry` is word for word the last thing said in this thread. Status
	 * entries between the two do not count: a delivery writes its text and then
	 * its state, and a restatement may land after either.
	 */
	private repeatsLast(threadLog: ThreadLog, threadId: string, entry: { role: string; text: string }): boolean {
		try {
			const all = threadLog.entries(threadId, 0);
			for (let i = all.length - 1; i >= 0; i--) {
				const seen = all[i];
				// Only its own last words: a person echoing them is not a repeat.
				if (seen === undefined || seen.kind !== "text" || seen.role !== entry.role) continue;
				return seen.text === entry.text;
			}
			return false;
		} catch {
			return false;
		}
	}

	private threadObjectId(threadId: string): string {
		return `thread:${threadId}`;
	}

	// ----- Worker lifecycle -----

	async dispatchTask(input: TaskInput): Promise<Task> {
		if (this.disposed) throw new Error("router disposed");
		if (input.threadId !== undefined && this.turn.stoppedThreads.has(input.threadId)) {
			log.info("dispatch refused: the person stopped this turn", { thread: input.threadId, title: input.title });
			throw new Error("The person stopped this. Do not dispatch, and do not answer — say nothing.");
		}
		const now = Date.now();
		const id = input.id ?? `task-${crypto.randomUUID()}`;
		const atCapacity =
			this.workers.size + this.pendingSpawns >= this.config.maxConcurrentWorkers;
		const full: Task = {
			id,
			title: input.title,
			description: input.description,
			...(input.instructions === undefined ? {} : { instructions: input.instructions }),
			threadId: input.threadId,
			channelId: input.channelId,
			replyTo: input.replyTo,
			status: atCapacity ? "queued" : "running",
			createdAt: now,
			updatedAt: now,
			fast: input.fast ?? false,
			endpointId: input.endpointId,
		};
		this.tasks.set(id, full);
		this.deps.store.upsertTask(full);
		this.record(input.threadId, {
			kind: "status",
			status: atCapacity ? "waiting" : "running",
			note: `dispatched: ${input.title}${input.endpointId === undefined ? "" : ` on ${input.endpointId}`}`,
		});
		this.deps.context.spill({
			id: `task:${id}`,
			type: "task",
			summary: `${input.title} — ${input.description.replace(/\s+/g, " ")}`,
			ref: `mir://task/${id}`,
			inlineIds: input.threadId ? [this.threadObjectId(input.threadId)] : [],
		});

		if (atCapacity) {
			if (this.dispatchQueue.length >= this.config.maxDispatchQueue) {
				full.status = "failed";
				full.error = "dispatch queue full";
				full.updatedAt = Date.now();
				this.deps.store.upsertTask(full);
				throw new Error(`dispatch queue full (${this.config.maxDispatchQueue} waiting)`);
			}
			this.dispatchQueue.push({ taskId: id, input });
			metrics.counter("mir_tasks_queued_total");
			log.info("task queued (worker capacity full)", { task: id, queue: this.dispatchQueue.length });
			return full;
		}

		await this.spawnWorker(full, input);
		return full;
	}

	/** Spawn a Worker process for an already-registered task. */
	private async spawnWorker(task: Task, input: TaskInput): Promise<void> {
		const now = Date.now();
		const workerId = `worker-${crypto.randomUUID().slice(0, 12)}`;
		task.workerId = workerId;
		task.status = "running";
		task.updatedAt = now;
		this.pendingSpawns++;
		this.workers.set(workerId, {
			workerId,
			taskId: task.id,
			status: "busy",
			threadIds: task.threadId ? [task.threadId] : [],
			channelId: task.channelId,
			replyTo: task.replyTo,
			lastHeartbeat: now,
			progress: "spawning",
		});
		this.persistWorker(workerId);
		this.deps.store.upsertTask(task);
		if (task.threadId) this.deps.threads.subscribe(workerId, task.threadId);

		const workerModelId = task.fast ? this.config.fastModelId : this.config.modelId;
		try {
			await this.deps.processManager.spawnWorker({
				workerId,
				taskId: task.id,
				title: task.title,
				description: task.description,
				...(task.instructions === undefined ? {} : { instructions: task.instructions }),
				threadId: task.threadId,
				channelId: task.channelId,
				replyTo: task.replyTo,
				modelId: workerModelId,
				providerRouting: this.config.providerRouting,
				thinkingLevel: this.config.thinkingLevel,
				socketPath: this.config.socketPath,
				idleExitMs: this.config.workerIdleExitMs,
				heartbeatMs: this.config.workerHeartbeatMs,
				maxTokens: this.config.maxTokens,
				sessionDir: this.config.workerSessionDir,
				mcpConfigPath: this.config.mcpConfigPath,
				...(this.deps.mcpServers === undefined ? {} : { mcpConfig: this.deps.mcpServers.current() }),
				endpointId: task.endpointId,
				handsSocketPath: this.deps.hands?.socketPath,
				capabilities: this.config.workerCapabilities,
				toolPolicy: this.config.workerToolPolicy,
			});
			metrics.counter("mir_worker_spawns_total", 1, { fast: String(Boolean(task.fast)) });
			log.info("worker spawned", { task: task.id, worker: workerId, model: workerModelId, hand: task.endpointId ?? "auto" });
		} catch (err) {
			this.failWorker(workerId, `failed to spawn worker: ${(err as Error).message}`);
		} finally {
			this.pendingSpawns--;
			this.drainDispatchQueue();
		}
	}

	private drainDispatchQueue(): void {
		while (
			this.dispatchQueue.length > 0 &&
			this.workers.size + this.pendingSpawns < this.config.maxConcurrentWorkers
		) {
			const next = this.dispatchQueue.shift()!;
			const task = this.tasks.get(next.taskId);
			// The task may have been cancelled while it waited.
			if (!task || task.status !== "queued") continue;
			void this.spawnWorker(task, next.input).catch((err) => {
				log.error("queued task spawn failed", { task: task.id, error: (err as Error).message });
			});
		}
	}

	private persistWorker(workerId: string): void {
		const rec = this.workers.get(workerId);
		if (!rec) return;
		this.deps.store.upsertWorker({
			id: rec.workerId,
			taskId: rec.taskId,
			status: rec.status,
			threadIds: rec.threadIds,
			channelId: rec.channelId,
			replyTo: rec.replyTo,
			lastHeartbeat: rec.lastHeartbeat,
			progress: rec.progress,
		});
	}

	/** A Worker connected to the control channel. */
	handleWorkerHello(workerId: string): void {
		const rec = this.workers.get(workerId);
		if (!rec) {
			log.warn("hello from unknown worker", { worker: workerId });
			return;
		}
		rec.status = "busy";
		rec.lastHeartbeat = Date.now();
		rec.progress = "connected";
		this.persistWorker(workerId);
	}

	/** A Worker sent a status update or heartbeat. */
	handleWorkerStatus(workerId: string, status: string, progress?: string): void {
		const rec = this.workers.get(workerId);
		if (!rec) return;
		rec.status = status as WorkerInfo["status"];
		rec.lastHeartbeat = Date.now();
		if (progress !== undefined) rec.progress = progress;
		this.persistWorker(workerId);
	}

	/** A Worker reported a conclusion. Queue it for the Router to relay. */
	/**
	 * A worker's streaming output, coalesced into the work thread's log.
	 *
	 * Deltas arrive many per second; appending each one would make the log a
	 * transcript of keystrokes and the panel unreadable. They are buffered per
	 * worker and flushed on a short timer (and on the worker's conclusion or
	 * exit), so the log carries what was said rather than how it was typed.
	 */
	handleWorkerDelta(workerId: string, text: string): void {
		if (this.deps.threadLog === undefined) return;
		const rec = this.workers.get(workerId);
		if (rec === undefined || rec.threadIds.length === 0) return;
		const existing = this.deltaBuffers.get(workerId);
		if (existing !== undefined) {
			existing.text += text;
			return;
		}
		const timer = setTimeout(() => this.flushWorkerDelta(workerId), DELTA_FLUSH_MS);
		timer.unref?.();
		this.deltaBuffers.set(workerId, { text, timer });
	}

	/** Write a worker's buffered output into its threads, if there is any. */
	private flushWorkerDelta(workerId: string): void {
		const buffered = this.deltaBuffers.get(workerId);
		if (buffered === undefined) return;
		this.deltaBuffers.delete(workerId);
		clearTimeout(buffered.timer);
		if (buffered.text.trim() === "") return;
		const rec = this.workers.get(workerId);
		if (rec === undefined) return;
		for (const threadId of rec.threadIds) {
			this.record(threadId, { kind: "text", role: "assistant", text: buffered.text });
		}
	}

	handleWorkerConclusion(workerId: string, text: string): void {
		// Whatever the worker was mid-sentence on belongs before its conclusion.
		this.flushWorkerDelta(workerId);
		const rec = this.workers.get(workerId);
		if (!rec) {
			log.warn("conclusion from unknown worker", { worker: workerId });
			return;
		}
		rec.status = "done";
		rec.lastHeartbeat = Date.now();
		rec.progress = "conclusion reported";
		this.persistWorker(workerId);

		// The work thread's own record: what the worker said, then that it ended.
		// A client watching the thread sees the answer without waiting for the
		// Router to pass it on to a channel.
		for (const threadId of rec.threadIds) {
			this.record(threadId, { kind: "text", role: "assistant", text });
			this.record(threadId, { kind: "status", status: "done", note: `worker ${workerId} finished` });
		}

		const task = this.tasks.get(rec.taskId);
		if (task) {
			task.status = "done";
			task.result = text;
			task.updatedAt = Date.now();
			this.deps.store.upsertTask(task);
			metrics.counter("mir_tasks_completed_total", 1, { status: "done", fast: String(Boolean(task.fast)) });
			metrics.observe("mir_task_duration_ms", Date.now() - task.createdAt, { fast: String(Boolean(task.fast)) });
			this.deps.context.spill({
				id: `task:${task.id}`,
				type: "task",
				summary: `${task.title} [done] — ${text.replace(/\s+/g, " ")}`,
				ref: `mir://task/${task.id}`,
				inlineIds: [`worker:${workerId}`],
			});
		}

		this.push({
			kind: "conclusion",
			workerId,
			taskId: rec.taskId,
			text,
			channelId: rec.channelId,
			replyTo: rec.replyTo,
			threadId: rec.threadIds[0],
		});
	}

	/** A Worker handed an event back: it is not theirs. Re-route it. */
	handleWorkerRelease(workerId: string, eventId: string, reason?: string): void {
		const rec = this.workers.get(workerId);
		const stored = this.deps.store.getEvent(eventId);
		if (rec && stored) {
			this.deps.threads.unsubscribe(workerId, stored.threadId);
			rec.threadIds = rec.threadIds.filter((t) => t !== stored.threadId);
			this.persistWorker(workerId);
		}
		log.info("worker released event", { worker: workerId, event: eventId, reason });
		metrics.counter("mir_worker_releases_total");
		if (!stored) return;
		this.push({
			kind: "trigger",
			trigger: {
				id: stored.id,
				channelId: stored.channelId,
				kind: this.deps.channels.find((c) => c.id === stored.channelId)?.kind ?? "http",
				text: stored.text,
				payload: stored.payload,
				receivedAt: stored.receivedAt,
				threadId: stored.threadId,
				replyTo: stored.replyTo,
				metadata: { ...(stored.from ? { from: stored.from } : {}), released_by: workerId, release_reason: reason ?? "" },
			},
			attempts: stored.attempts,
		});
	}

	/** A Worker asked to stop receiving a Thread. */
	handleWorkerUnsubscribe(workerId: string, threadId: string, reason?: string): void {
		this.deps.threads.unsubscribe(workerId, threadId);
		const rec = this.workers.get(workerId);
		if (rec) {
			rec.threadIds = rec.threadIds.filter((t) => t !== threadId);
			this.persistWorker(workerId);
		}
		log.info("worker unsubscribed from thread", { worker: workerId, thread: threadId, reason });
	}

	/** A Worker's control connection dropped (process exited/crashed). */
	handleWorkerDisconnect(workerId: string): void {
		const rec = this.workers.get(workerId);
		if (!rec) return;
		const task = this.tasks.get(rec.taskId);
		const wasRunning = task && (task.status === "running" || task.status === "blocked");
		if (wasRunning) {
			this.failWorker(workerId, "worker process exited before reporting a conclusion");
			this.push({
				kind: "worker-exit",
				workerId,
				taskId: rec.taskId,
				reason: "process exited without a conclusion",
			});
		} else {
			this.workers.delete(workerId);
			this.deps.store.deleteWorker(workerId);
			this.deps.threads.removeWorker(workerId);
		}
		void this.deps.processManager.killWorker(rec.taskId).catch(() => {});
		this.drainDispatchQueue();
	}

	private failWorker(workerId: string, reason: string): void {
		const rec = this.workers.get(workerId);
		if (!rec) return;
		const task = this.tasks.get(rec.taskId);
		if (task) {
			task.status = "failed";
			task.error = reason;
			task.updatedAt = Date.now();
			this.deps.store.upsertTask(task);
			metrics.counter("mir_tasks_completed_total", 1, { status: "failed", fast: String(Boolean(task.fast)) });
		}
		this.workers.delete(workerId);
		this.deps.store.deleteWorker(workerId);
		this.deps.threads.removeWorker(workerId);
	}

	/** Stop a task: abort the worker, cancel the task, free the slot. */
	async stopTask(taskId: string, reason?: string): Promise<Task> {
		const task = this.tasks.get(taskId);
		if (!task) throw new Error(`unknown task ${taskId}`);
		task.status = "cancelled";
		task.error = reason ?? "stopped by operator";
		task.updatedAt = Date.now();
		this.deps.store.upsertTask(task);
		// A queued task has no worker yet: just remove it from the queue.
		const queueIdx = this.dispatchQueue.findIndex((i) => i.taskId === taskId);
		if (queueIdx >= 0) this.dispatchQueue.splice(queueIdx, 1);
		if (task.workerId) {
			const workerId = task.workerId;
			this.deps.control?.abort(workerId, reason);
			this.workers.delete(workerId);
			this.deps.store.deleteWorker(workerId);
			this.deps.threads.removeWorker(workerId);
			await this.deps.processManager.killWorker(taskId).catch(() => {});
		}
		metrics.counter("mir_tasks_completed_total", 1, { status: "cancelled", fast: String(Boolean(task.fast)) });
		this.drainDispatchQueue();
		return task;
	}

	/**
	 * Stop everything running in a thread: every task that is on it, queued or
	 * working. What a client's Stop reaches, and why it names a thread rather
	 * than a task: a person watching a thread does not know its task ids.
	 */
	/**
	 * The person pressed stop on a thread.
	 *
	 * The turn ends, every task this thread started is stopped, and the thread is
	 * marked stopped for the turn in flight so a dispatch that arrives after this
	 * is refused instead of started.
	 */
	async stopThread(threadId: string, reason?: string): Promise<Task[]> {
		const why = reason ?? "stopped from the thread";
		this.turn.stoppedThreads.add(threadId);
		const tasks = [...this.tasks.values()].filter(
			(task) => task.threadId === threadId && (task.status === "running" || task.status === "queued"),
		);
		const stopped: Task[] = [];
		for (const task of tasks) {
			try {
				stopped.push(await this.stopTask(task.id, why));
			} catch {
				/* already gone: nothing to stop */
			}
		}
		const answeringThisThread = this.turnInFlightSince !== 0 && this.turn.originThreadId === threadId;
		log.info("thread stopped", { thread: threadId, reason: why, tasks: stopped.length, turnAborted: answeringThisThread });
		if (answeringThisThread) await this.session.abort?.().catch(() => {});
		// An entry of its own, which also moves the thread's state: a stop is not an
		// absence of a reply.
		this.record(threadId, { kind: "stop", note: why });
		return stopped;
	}

	/** Reap a finished worker: remove it, free its slot, delete its pm2 app. */
	async reapWorker(workerId: string): Promise<void> {
		const rec = this.workers.get(workerId);
		if (!rec) return;
		this.workers.delete(workerId);
		this.deps.store.deleteWorker(workerId);
		this.deps.threads.removeWorker(workerId);
		await this.deps.processManager.killWorker(rec.taskId).catch(() => {});
		this.drainDispatchQueue();
	}

	// ----- Restore / recovery -----

	/**
	 * Hydrate durable state. Workers from a previous daemon generation are dead
	 * (their control socket is gone), so their tasks are failed with an explicit
	 * reason and the Router is told — instead of silently forgetting the work.
	 */
	private restore(): void {
		for (const task of this.deps.store.listTasks()) this.tasks.set(task.id, task);
		const persisted = this.deps.store.listWorkers();
		const orphaned: Task[] = [];
		for (const rec of persisted) {
			const connected = this.deps.control?.isConnected(rec.id) ?? false;
			if (connected) {
				this.workers.set(rec.id, {
					workerId: rec.id,
					taskId: rec.taskId,
					status: rec.status,
					threadIds: rec.threadIds,
					channelId: rec.channelId,
					replyTo: rec.replyTo,
					lastHeartbeat: rec.lastHeartbeat,
					progress: rec.progress,
				});
				continue;
			}
			const task = this.tasks.get(rec.taskId);
			if (task && (task.status === "running" || task.status === "blocked" || task.status === "queued")) {
				task.status = "failed";
				task.error = "daemon restarted while this task was running";
				task.updatedAt = Date.now();
				this.deps.store.upsertTask(task);
				orphaned.push(task);
			}
			this.deps.store.deleteWorker(rec.id);
			this.deps.threads.removeWorker(rec.id);
			this.deps.onOrphanedWorker?.(rec.id, rec.taskId);
		}
		// Queued tasks with no worker: put them back on the dispatch queue.
		for (const task of this.listTasks()) {
			if (task.status === "queued" && !this.dispatchQueue.some((i) => i.taskId === task.id)) {
				this.dispatchQueue.push({
					taskId: task.id,
					input: {
						id: task.id,
						title: task.title,
						description: task.description,
						threadId: task.threadId,
						channelId: task.channelId,
						replyTo: task.replyTo,
						fast: task.fast,
					},
				});
			}
		}
		if (orphaned.length > 0) {
			// One item per task so each affected channel gets its own reply.
			for (const task of orphaned) {
				this.push({
					kind: "recovery",
					text: [
						`The daemon restarted while task ${task.id} "${task.title}" was running.`,
						`It is now marked failed (${task.error ?? "interrupted"}).`,
						"Tell this channel what happened, and offer to re-dispatch if the work still matters.",
					].join("\n"),
					channelId: task.channelId,
					replyTo: task.replyTo,
					threadId: task.threadId,
				});
			}
			metrics.counter("mir_tasks_interrupted_total", orphaned.length);
		}
		if (this.dispatchQueue.length > 0) this.drainDispatchQueue();
	}

	/** Queue a system signal for the Router (MCP changes, watchdog notes, …). */
	submitSignal(text: string): void {
		this.push({ kind: "signal", text });
	}

	// ----- Introspection -----

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

	/** Snapshot for the Watchdog and for `/healthz`. */
	status(): RouterStatus {
		return {
			turnCount: this.turnCount,
			lastTurnAt: this.lastTurnAt,
			turnInFlightSince: this.turnInFlightSince,
			queueDepth: this.inbox.length,
			draining: this.draining,
			dispatchQueue: this.dispatchQueue.length,
			workers: this.workers.size,
			tasks: this.tasks.size,
		};
	}

	/**
	 * Keep only the newest `keep` tasks in memory. Terminal tasks stay in the
	 * durable store (and the recall graph), so nothing is lost — the in-memory
	 * map is a cache, and an unbounded one is §8.1's memory leak.
	 */
	pruneTasks(keep = 500): number {
		const all = this.listTasks();
		if (all.length <= keep) return 0;
		const removable = all
			.filter((t) => t.status === "done" || t.status === "failed" || t.status === "cancelled")
			.sort((a, b) => a.updatedAt - b.updatedAt);
		const excess = all.length - keep;
		let removed = 0;
		for (const task of removable) {
			if (removed >= excess) break;
			if (this.tasks.delete(task.id)) removed++;
		}
		return removed;
	}

	/** Watchdog hook: abort a hung turn. */
	async abortTurn(reason: string): Promise<void> {
		log.warn("aborting router turn", { reason });
		await this.session.abort?.().catch(() => {});
	}

	getTask(taskId: string): Task | undefined {
		return this.tasks.get(taskId);
	}

	/** Re-dispatch a failed/interrupted task with the same inputs. */
	async retryTask(taskId: string): Promise<Task> {
		const task = this.tasks.get(taskId);
		if (!task) throw new Error(`unknown task ${taskId}`);
		return this.dispatchTask({
			title: task.title,
			description: task.description,
			threadId: task.threadId,
			channelId: task.channelId,
			replyTo: task.replyTo,
			fast: task.fast,
		});
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		if (this.drainTimer) clearTimeout(this.drainTimer);
		this.drainTimer = null;
		// An in-flight turn may still touch the store; let it finish or abort it
		// before the caller closes the database underneath it.
		if (this.turnInFlightSince > 0) {
			await this.session.abort?.().catch(() => {});
			await Promise.race([
				settleSession(this.session).catch(() => {}),
				sleep(5000),
			]);
		}
		await this.session.dispose().catch(() => {});
	}
}

/** TaskStatus is re-exported for callers that only import the router. */
export type { TaskStatus };
