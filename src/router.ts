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
import { mkdirSync } from "node:fs";
import { join } from "node:path";
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
import { brainResourceLoader, skillCatalogue, useSkillTool } from "./skills.ts";
import { JOURNAL_MAX_CHARS, type Journal , safeName } from "./journal.ts";
import { cardUriFor } from "./mcp-app/card.ts";
import type { ScratchpadRow } from "./store.ts";
import { newThreadId, type NewThreadEntry, type ThreadEntry, type ThreadLog } from "./threadlog.ts";

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
	/** One agent's words to another, at its next turn boundary. */
	sendToWorker?: (workerId: string, from: string, text: string) => boolean;
	/** Where a hand keeps its files, when the client told us and the hand did not. */
	handRoots?: (endpointId: string) => string | undefined;
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
	/**
	 * The Router's journal: what it remembers about a conversation, in a git repo so
	 * a post-mortem can read what it believed at the time.
	 */
	journal?: Journal;
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
	/**
	 * The task that asked for this one.
	 *
	 * A child's conclusion is the return value of its parent's tool call, so it is
	 * never pushed to a channel and never gets a card: the parent's card already
	 * shows the work, and a person does not need a second one for a check.
	 */
	parentTaskId?: string;
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
	/** The channel and event the turn is answering, so a dispatch can answer there too. */
	originChannelId?: string;
	originEventId?: string;
	/** The hand this turn's work belongs on, when the client said which. */
	originHand?: string;
}

/** The key a trigger with no thread gets: the Router answering as itself. */
const SESSION_COLD = "";
/** How many conversations stay warm at once. */
const SESSION_LIMIT = 8;

/** The hand a tool result came from, when it came from one. */
function handOfResult(result: unknown): { endpointId: string; op: string } | undefined {
	if (result === null || typeof result !== "object") return undefined;
	const details = (result as { details?: unknown }).details;
	if (details === null || typeof details !== "object") return undefined;
	const endpointId = (details as { endpointId?: unknown }).endpointId;
	if (typeof endpointId !== "string" || endpointId === "") return undefined;
	const op = (details as { op?: unknown }).op;
	return { endpointId, op: typeof op === "string" ? op : "call" };
}

function emptyTurn(
	originThreadId?: string,
	originChannelId?: string,
	originEventId?: string,
	originHand?: string,
): TurnState {
	return {
		startedAt: Date.now(),
		replies: [],
		dispatches: [],
		stops: 0,
		stoppedThreads: new Set<string>(),
		captured: "",
		originThreadId,
		...(originChannelId === undefined ? {} : { originChannelId }),
		...(originEventId === undefined ? {} : { originEventId }),
		...(originHand === undefined ? {} : { originHand }),
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
 * How many log entries to read when rebuilding a chat's conversation for a turn.
 *
 * Larger than the tail, because most entries are not conversation: a turn of tool
 * calls and results can be ten rows, and reading too few would leave the tail
 * half-empty while the log had plenty to show.
 */
const CONVERSATION_SCAN = 1200;

/** How much of one line to keep, so a pasted wall of text cannot fill the turn. */
const CONVERSATION_LINE_CHARS = 600;

/**
 * The tail, as a budget rather than a line count.
 *
 * Forty lines was the whole of a turn's memory and it is about ten exchanges: a
 * decision from the morning is simply gone. The tail now holds a real working
 * set — a hundred-odd lines, or six thousand characters, whichever comes first —
 * and everything older than that belongs in the journal, which is what the turn
 * reads first.
 */
const CONVERSATION_TAIL_CHARS = 6000;
const CONVERSATION_TAIL_LINES = 120;
/** However tight the budget, a turn always sees this much of the conversation. */
const CONVERSATION_MIN_LINES = 20;

/**
 * The Router's tools whose effect is already an entry of its own.
 *
 * A dispatch is the card; a stop is the stop line. Their raw tool call is the same
 * fact in machine words, and a chat is read by a person.
 */
const SUPERSEDED_IN_CHAT: ReadonlySet<string> = new Set<string>(["stop_task"]);

/** How many log entries `read_log` will look through. */

/** How many lines of each list a turn reads; the rest is one `scratchpad` call away. */
const SCRATCHPAD_BLOCK_ITEMS = 8;

/**
 * One line of a conversation, as a turn reads it.
 *
 * Not a transcript: the entries that *are* the conversation (what the person said,
 * what the assistant said, a dispatch, a stop, a rename) become a line each, and
 * the machinery — tool calls, tool results, hand calls, status — becomes nothing.
 * A turn does not need to know that a tool ran; it needs to know what was said,
 * because the model's context is not this chat's (one session serves them all).
 */
/** The words of an entry, whatever kind it is — what `read_log` searches. */
function entryText(entry: ThreadEntry): string {
	switch (entry.kind) {
		case "text":
			return entry.text;
		case "thinking":
			return entry.text;
		case "tool_call":
			return `${entry.toolName} ${entry.args === undefined ? "" : JSON.stringify(entry.args)}`;
		case "tool_result":
			return entry.result === undefined ? "" : JSON.stringify(entry.result);
		case "hand":
			return `${entry.op} on ${entry.endpointId} — ${entry.ok ? "ok" : "failed"}`;
		case "status":
			return entry.note ?? "";
		case "stop":
			return entry.note ?? "";
		case "title":
			return entry.title;
		case "app":
			// The view is the entry; its data is for the view, not for a search.
			return "";
	}
}

function conversationLine(entry: ThreadEntry): string | undefined {
	switch (entry.kind) {
		case "text": {
			const said = entry.text.replace(/\s+/g, " ").trim();
			if (said === "") return undefined;
			const clipped = said.length > CONVERSATION_LINE_CHARS ? `${said.slice(0, CONVERSATION_LINE_CHARS)}…` : said;
			return entry.role === "user" ? `them: ${clipped}` : `you said: ${clipped}`;
		}
		case "status": {
			const note = entry.note ?? "";
			if (!note.startsWith("dispatched: ")) return undefined;
			return `· dispatched ${note.slice("dispatched: ".length)}`;
		}
		case "stop":
			return `· the person stopped it${entry.note === undefined ? "" : `: ${entry.note}`}`;
		case "title":
			return `· the chat was named "${entry.title}"`;
		case "app": {
			// Work started, said as the person would: what it is, and where it runs
			// when that matters. The card itself is the client's business.
			const title = typeof entry.data.title === "string" ? entry.data.title : undefined;
			const endpoint = typeof entry.data.endpointId === "string" ? entry.data.endpointId : undefined;
			const state = typeof entry.data.status === "string" ? entry.data.status : undefined;
			if (title === undefined) return undefined;
			const where = endpoint === undefined ? "" : ` on ${endpoint}`;
			return state === "done" || state === "failed" || state === "stopped"
				? `· "${title}" ${state}${where}`
				: `· started "${title}"${where}`;
		}
		// A hand call is how the answer was found, like a tool call: the person
		// never saw it, and the conclusion already says whether it worked.
		default:
			return undefined;
	}
}

/**
 * The channels a person types into. Their words are conversation, so they belong
 * in the thread's log; a tool's or the watchdog's trigger is machinery, and the
 * log is what a person reads.
 */
const PERSON_CHANNELS: ReadonlySet<string> = new Set<string>(["anomalous", "terminal"]);

/**
 * What holds on every turn, whatever a skill says.
 *
 * These are appended to the Router's system prompt rather than restated in each
 * turn's message. Two reasons: a rule that must never be optional cannot compete
 * with the turn's content for attention, and pi's own system prompt describes a
 * coding agent with tools — which this is not — so the conflict is resolved where
 * the framing lives.
 */
/**
 * What the Router is, in its own words.
 *
 * Replaces pi's "You are a coding assistant running inside pi" preamble, which described a
 * different program: one with a working directory, built-in tools and documentation. The
 * Router has none of those, and a model told it has a working directory answers questions
 * about that directory.
 */
export const ROUTER_PROMPT = [
	"You are one person's assistant, in a chat with them.",
	"You have no filesystem, no shell and no working directory: nothing here can read or run anything. What you have is a set of hands — machines with a folder, a policy and a name — and Workers, which use them.",
	"You reply, or you dispatch work. There is nothing else you can do, and that is the design.",
].join("\n");

export const ROUTER_INVARIANTS: readonly string[] = [
	"Never mention the machinery: no \"worker\", \"subagent\", \"agent\", \"hand\", \"tool\", \"task\" or \"thread\", and never describe a dispatch (\"spinning up\", \"sending this to\", \"the Worker will\"). They asked one assistant for something; say what you are doing about it, in the first person: \"Checking the repo now.\", not \"Spinning up a Worker to check the repo.\" If the answer is \"I'll figure it out\", that is the whole line.",
	"Write like a person talking to a person: their language, no headings, no \"Done.\", no \"Task complete.\", no \"I will now…\", and never restate the question.",
	"Never promise to come back: no \"I'll report back\", \"I'll let you know\", \"I'll update you\". The answer simply arrives — saying you will send it is a line about the conversation instead of a line about the work.",
	"Never name a path you were not given. You have no filesystem: the working directory you can see is the brain's own, and it is not the person's folder. `list_hands` says where the work will run; put its `roots` in the brief when the Worker needs a place — a path you invent sends the Worker to the wrong folder and its answer will say so, confidently.",
	"When you name a hand to `dispatch_task`, use the name `list_hands` printed — or leave `endpoint` out and let the hub choose. An identifier you were not shown is not a hand, and a dispatch to one runs with no files at all.",
];

export class RouterLayer {
	/**
	 * One model session per conversation, made on first use and kept warm.
	 *
	 * A session carries one transcript. One session for the whole Router meant the
	 * model's context was every chat interleaved — so what it was told in one chat
	 * could surface in the answer to another, and the conversation block was doing
	 * work the session should have done by existing.
	 *
	 * Warm, because a session costs a context to build and a chat's next turn usually
	 * comes soon; capped, because a brain serves every chat its member has and a
	 * session each, forever, is a leak with a transcript.
	 */
	private readonly sessions = new Map<string, AgentSessionLike>();
	private readonly sessionUsedAt = new Map<string, number>();
	private readonly sessionBusy = new Set<string>();
	/** The session the turn in flight is using, so a capture lands in the right one. */
	private activeSessionKey: string | null = null;
	private sessionOptions!: Parameters<SessionFactory>[0];
	private readonly deps: RouterDependencies;
	private readonly config: SuperAgentConfig;
	private readonly tasks = new Map<string, Task>();
	private readonly workers = new Map<string, WorkerRecord>();
	private readonly dispatchQueue: Array<{ taskId: string; input: TaskInput }> = [];
	/** Parents blocked on a check: task id → the answer they are waiting for. */
	private readonly children = new Map<string, (answer: { ok: boolean; text: string }) => void>();
	/**
	 * Workers that have been started and have not said hello yet.
	 *
	 * A spawned process is not a running worker: the process manager accepts the
	 * start, the child dies on its first import, and nothing else happens — which is
	 * indistinguishable from a task that is quietly working. So each spawn gets a
	 * deadline, and a worker that misses it fails its task out loud.
	 */
	private readonly helloTimers = new Map<string, NodeJS.Timeout>();
	/** Per-worker output waiting to be written into its thread. */
	private readonly deltaBuffers = new Map<string, { text: string; timer: NodeJS.Timeout }>();
	/** What a worker has already said in its threads, so its conclusion is not repeated. */
	private readonly streamedByWorker = new Map<string, string>();
	/** Each conversation's journal, as last read or written: the turn reads it synchronously. */
	private readonly journalCache = new Map<string, string>();
	private readonly inbox: InboxItem[] = [];
	private turn: TurnState = emptyTurn();
	/**
	 * Set once the turn has said all it is going to say.
	 *
	 * A reply is the end of a turn: the person has their answer, or the work has
	 * started and the card is the acknowledgement. The model does not know that — it
	 * will keep calling tools while the loop lets it — so the loop is ended here, and
	 * the refusal it gets for a second reply is not an invitation to try a third.
	 */
	private endRequested = false;
	private drainTimer: NodeJS.Timeout | null = null;
	private draining = false;
	private pendingSpawns = 0;
	private disposed = false;
	private lastTurnAt = 0;
	private turnInFlightSince = 0;
	private turnCount = 0;

	private readonly recorder: ReplyRecorder = {
		record: (channelId, text, ctx) => {
			// A turn has one reply. The model that keeps calling the response tool is
			// talking to itself: it has already said the thing, and every further call
			// is another bubble in a person's chat — "I'll stop here and wait", four
			// times, three seconds apart, because the tool it called let it continue.
			if (this.turn.replies.length > 0) {
				metrics.counter("mir_router_replies_refused_total", 1, { reason: "second" });
				return {
					ok: false,
					reason:
						"You have already replied in this turn. Nothing more is delivered: stop calling tools and end the turn. The person has your words once.",
				};
			}
			// And a dispatch is its own acknowledgement: the card in the conversation
			// says what started, in the person's words. A sentence beside it is the same
			// fact twice, and the second one is always an announcement.
			if (this.turn.dispatches.length > 0) {
				metrics.counter("mir_router_replies_refused_total", 1, { reason: "after-dispatch" });
				return {
					ok: false,
					reason:
						"You have already dispatched, and the work is shown in the conversation with its own card. Do not announce it: end the turn and say nothing. The answer arrives when the work does.",
				};
			}
			this.turn.replies.push({ channelId, text, ctx, at: Date.now() });
			metrics.counter("mir_router_replies_total", 1, { channel: channelId });
			// The product's channel writes its reply into the chat's thread itself
			// (channels/anomalous.ts `deliver`), so recording it here as well would
			// post every answer twice. Every other channel has no such write, and is
			// logged here — where every delivery passes, so no reply can reach a
			// person without reaching the log a panel reads.
			if (channelId !== "anomalous") {
				// A reply that names no thread belongs to the one the turn is answering.
				this.record(ctx.threadId ?? this.turn.originThreadId, { kind: "text", role: "assistant", text });
			}
			return { ok: true };
		},
	};

	/**
	 * Record the assistant's own tool call on the conversation's thread.
	 *
	 * The chat draws what the assistant *did* from its thread, not from prose: a
	 * dispatch becomes a card that links to the work, because the call and its
	 * result are entries there like everything else.
	 */
	/**
	 * The Router's own tool calls, in a chat.
	 *
	 * Two of them are not drawn as tool calls, because the conversation already says
	 * what they did: `dispatch_task` writes the card (the work, its state, its answer)
	 * and `stop_task` writes the stop. A tool block beside them is the same fact
	 * twice — a raw call with `{}` arguments next to a card that says the same thing
	 * in the person's words.
	 *
	 * They are still recorded in a *work* thread: that is the record of what happened,
	 * and a trace reads it.
	 */
	private recordTurnTool(call: { id: string; name: string; args: unknown }): void {
		if (SUPERSEDED_IN_CHAT.has(call.name) && this.turnInChat()) return;
		this.record(this.turn.originThreadId, {
			kind: "tool_call",
			toolCallId: call.id,
			toolName: call.name,
			args: call.args,
		});
	}

	/** What that call answered, on the same thread. */
	private recordTurnToolResult(callId: string, result: unknown, isError = false, toolName?: string): void {
		if (toolName !== undefined && SUPERSEDED_IN_CHAT.has(toolName) && this.turnInChat()) return;
		this.record(this.turn.originThreadId, { kind: "tool_result", toolCallId: callId, isError, result });
	}

	/** Whether this turn is answering a chat — a thread a person is reading. */
	private turnInChat(): boolean {
		const threadId = this.turn.originThreadId;
		return threadId !== undefined && this.deps.threadLog?.chatOf(threadId) !== undefined;
	}

	/** Append to a thread's log and tell whoever is watching. Absent log = no-op. */
	/**
	 * The thread a task's own work is written to.
	 *
	 * Created on first use and remembered on the task, so a retry or a re-adopt writes
	 * to the same one. A task with no chat (a queue trigger, a schedule) still gets a
	 * thread: its work is a thing somebody may want to read, and the alternative is
	 * that it exists only in the process's memory.
	 */
	private workThreadFor(task: Task): string | undefined {
		if (task.workThreadId !== undefined) return task.workThreadId;
		const threadLog = this.deps.threadLog;
		if (threadLog === undefined) return task.threadId;
		// A thread that is not a chat's is already the work's own: nothing to separate.
		// Only a chat has a person reading it, and only a chat needs the split.
		if (task.threadId === undefined || threadLog.chatOf(task.threadId) === undefined) return task.threadId;
		const id = newThreadId();
		try {
			threadLog.ensureThread(id, `work: ${task.title}`, "work");
		} catch (err) {
			log.warn("could not create a work thread", { task: task.id, error: (err as Error).message });
			return undefined;
		}
		task.workThreadId = id;
		this.deps.store.upsertTask(task);
		return id;
	}

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
		// A directory that holds nothing and means nothing: the Router has no filesystem,
		// and the one pi names in its prompt should not be the host's source tree.
		const routerCwd = join(deps.config.stateDir, "router");
		mkdirSync(routerCwd, { recursive: true, mode: 0o700 });
		// The Router's instructions are skills, not a template literal: the loader
		// advertises the brain's own set and refuses everything the host machine
		// happens to have installed.
		const agentDir = join(deps.config.stateDir, "router-agent");
		const resourceLoader = await brainResourceLoader({
			cwd: routerCwd,
			agentDir,
			invariants: ROUTER_INVARIANTS,
			systemPrompt: [ROUTER_PROMPT, await skillCatalogue()].filter((part) => part !== "").join("\n\n"),
			// No filesystem, so no path in the prompt: a cwd section is a directory the
			// model quotes as if it were the person's.
			hideCwd: true,
		});
		router.sessionOptions = {
			cwd: routerCwd,
			model: deps.model,
			modelRuntime: deps.modelRuntime,
			sessionManager,
			thinkingLevel: deps.config.thinkingLevel,
			noTools: "builtin",
			agentDir,
			resourceLoader,
			customTools,
		};
		// No session is made here: a conversation's session is made by its first turn,
		// so a brain that is started and never spoken to holds no model context at all.
		router.restore();
		return router;
	}

	/**
	 * The session for one conversation, made on first use and kept warm.
	 *
	 * Each gets its own transcript, on disk when `sessionDir` is set so a restart can
	 * resume it, in memory otherwise.
	 */
	private async sessionFor(key: string): Promise<AgentSessionLike> {
		const held = this.sessions.get(key);
		if (held !== undefined) {
			this.sessionUsedAt.set(key, Date.now());
			return held;
		}
		const manager = this.sessionManagerFor(key);
		const made = await (this.deps.sessionFactory ?? createPiSession)({
			...this.sessionOptions,
			...(manager === undefined ? {} : { sessionManager: manager }),
		});
		made.subscribe((event: any) => {
			if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
				// Only the turn that is running records what was said: a session that
				// outlives its turn must not append to the next one's reply.
				if (this.activeSessionKey === key) this.turn.captured += event.assistantMessageEvent.delta ?? "";
			}
			if (event.type === "auto_retry_end" && event.success === false) {
				log.warn("router model retry exhausted", { error: event.finalError });
			}
		});
		this.sessions.set(key, made);
		this.sessionUsedAt.set(key, Date.now());
		await this.evictSessions(key);
		return made;
	}

	/** A transcript file per conversation, when the Router persists at all. */
	private sessionManagerFor(key: string): any {
		if (this.config.sessionDir === "") return SessionManager.inMemory();
		try {
			const name = key === SESSION_COLD ? "cold" : safeName(key);
			return SessionManager.open(join(this.config.sessionDir, `${name}.json`));
		} catch (err) {
			log.warn("router session file unreadable; starting in memory", {
				thread: key,
				error: (err as Error).message,
			});
			return SessionManager.inMemory();
		}
	}

	/** Keep the warm set small: the coldest session that is not mid-turn goes. */
	private async evictSessions(keep: string): Promise<void> {
		while (this.sessions.size > SESSION_LIMIT) {
			const coldest = [...this.sessionUsedAt.entries()]
				.filter(([id]) => id !== keep && !this.sessionBusy.has(id))
				.sort((a, b) => a[1] - b[1])[0];
			if (coldest === undefined) return;
			const [id] = coldest;
			const session = this.sessions.get(id);
			this.sessions.delete(id);
			this.sessionUsedAt.delete(id);
			await session?.dispose().catch(() => {});
			metrics.counter("mir_router_sessions_evicted_total");
		}
	}

	/** Every session the Router is holding, for an abort or a shutdown. */
	private heldSessions(): AgentSessionLike[] {
		return [...this.sessions.values()];
	}

	// ----- Tools the Router uses to act -----

	private buildTools(): ToolDefinition[] {
		return [
			useSkillTool(),
			this.buildJournalTool(),
			this.buildScratchpadTool(),
			this.buildReadLogTool(),
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
				"The only way work gets done: one job, in an isolated background process.",
				"The `dispatch` skill says when this is the right call rather than a reply — read it if you have not. Anything about their repo, their files, their machine, their accounts or their services is a dispatch.",
				"The Worker reports a conclusion back to you, which arrives as a new turn. This call returns immediately, and you do not announce it: the conversation shows what started.",
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
				// A hand named by the model, or the one the client pinned this conversation
				// to. A name that is neither is refused here: a task pinned to a hand that
				// does not exist starts a Worker with no hand, and that Worker answers
				// "filesystem access is disabled" — a wrong answer shaped like a limitation.
				const requested = params.endpoint === undefined ? undefined : router.resolveHand(params.endpoint);
				if (params.endpoint !== undefined && requested === undefined) {
					const choices = router.handChoices();
					router.recordTurnToolResult(callId, { error: "no such hand" }, true, "dispatch_task");
					return {
						content: [
							{
								type: "text",
								text: `there is no hand called “${params.endpoint}”. ${choices}. Omit \`endpoint\` to let the hub choose, or name one of those.`,
							},
						],
						details: { error: "no such hand" },
						isError: true,
					};
				}
				const pinned = params.endpoint === undefined
					? (router.turn.originHand === undefined ? undefined : router.resolveHand(router.turn.originHand))
					: requested;
				try {
					const task = await router.dispatchTask({
						title: params.title,
						description: params.description,
						// A dispatch belongs to the conversation it was made in, unless the
						// model names another. Without this default a task has no thread,
						// so its work is written nowhere a person can open and its card
						// has nothing to link to.
						threadId: params.thread ?? router.turn.originThreadId,
						channelId: params.channel ?? router.turn.originChannelId,
						replyTo: params.reply_to ?? router.turn.originEventId,
						fast: isTrivial(params.description),
						// Where the client said this work belongs wins over the hub's
						// least-loaded guess: a space is a hand, and only the client knows
						// which. A model that names one explicitly still wins.
						endpointId: pinned,
					});
					router.turn.dispatches.push(task.id);
					// The card reads `details.threadId`: the task's own thread, which is
					// where its work is written and what a click opens.
					router.recordTurnToolResult(
						callId,
						{ details: { taskId: task.id, workerId: task.workerId, status: task.status, threadId: task.threadId } },
						false,
						"dispatch_task",
					);
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
					router.recordTurnToolResult(callId, { error: (err as Error).message }, true, "dispatch_task");
					return {
						content: [{ type: "text", text: `dispatch failed: ${(err as Error).message}` }],
						details: { error: (err as Error).message },
						isError: true,
					};
				}
			},
		});
	}

	/**
	 * Add a line to the scratchpad.
	 *
	 * The Router's own lists are not derived from `tasks`: it waits on a person's
	 * answer, on a deploy, on another conversation, and none of those is a task
	 * row. What a dispatch *does* get is an `outstanding` line written for it, so
	 * the list cannot drift from reality by the Router forgetting to write it.
	 */
	addScratchpadItem(input: {
		kind: "outstanding" | "planned";
		text: string;
		threadId?: string;
		taskId?: string;
	}): ScratchpadRow {
		const now = Date.now();
		const item: ScratchpadRow = {
			id: `pad-${crypto.randomUUID().slice(0, 8)}`,
			kind: input.kind,
			text: input.text,
			...(input.threadId === undefined ? {} : { threadId: input.threadId }),
			...(input.taskId === undefined ? {} : { taskId: input.taskId }),
			status: "open",
			createdAt: now,
			updatedAt: now,
		};
		this.deps.store.putScratchpadItem(item);
		this.writeScratchpadCopy();
		return item;
	}

	/**
	 * Show, or refresh, the card for a task.
	 *
	 * Appended on each transition that changes what a person would see — started,
	 * finished, failed, stopped — never on progress: the log is the durable record,
	 * and the view polls for the rest. Appending rather than editing is the log's
	 * whole design, and a client renders the last card for a task.
	 */
	private recordCard(threadId: string | undefined, taskId: string): void {
		if (threadId === undefined || threadId === "") return;
		const task = this.tasks.get(taskId);
		if (task === undefined) return;
		const data: Record<string, unknown> = {
			taskId: task.id,
			title: task.title,
			description: task.description,
			status: task.status,
			...(task.endpointId === undefined ? {} : { endpointId: task.endpointId }),
			...(task.result === undefined ? {} : { result: task.result }),
			...(task.error === undefined ? {} : { error: task.error }),
			createdAt: task.createdAt,
		};
		// One card per task per thread. The entry is a pointer, and a second pointer to
		// the same task is a second card on screen: the state it carries is refreshed
		// in place, and a client that can read the resource asks the app server anyway.
		const existing = this.deps.threadLog
			?.entries(threadId)
			.filter((entry) => entry.kind === "app" && entry.uri === cardUriFor(task.id))
			.at(-1);
		if (existing !== undefined) {
			this.deps.store.updateThreadEntryPayload(threadId, existing.seq, {
				server: "mir",
				uri: cardUriFor(task.id),
				data,
			});
			// A client already showing this card is told the new state, at the sequence
			// it already has: an update, not a second card.
			this.deps.publishEntry?.(threadId, { ...existing, data } as never);
			return;
		}
		this.record(threadId, { kind: "app", server: "mir", uri: cardUriFor(task.id), data });
	}

	/** Close a line: done, or dropped when it stopped being worth doing. */
	closeScratchpadItem(id: string, status: "done" | "dropped"): void {
		const existing = this.deps.store.getScratchpadItem(id);
		if (existing === undefined) return;
		this.deps.store.putScratchpadItem({ ...existing, status, updatedAt: Date.now() });
		this.writeScratchpadCopy();
	}

	/** Close whatever line a task was tracking, when the task ends. */
	private closeScratchpadForTask(taskId: string, status: "done" | "dropped"): void {
		const line = this.deps.store.listScratchpad().find((item) => item.taskId === taskId && item.status === "open");
		if (line !== undefined) this.closeScratchpadItem(line.id, status);
	}

	/**
	 * Keep the rendered copy in the journal repository.
	 *
	 * The list is the store's; the file is the record. Writing it on every change
	 * is what makes "what did it think it was doing at 14:02" answerable later, and
	 * it costs one file write and one commit on a change that happens a few times a
	 * turn at most.
	 */
	writeScratchpadCopy(): void {
		const journal = this.deps.journal;
		if (journal === undefined) return;
		const items = this.deps.store.listScratchpad();
		const open = items.filter((item) => item.status === "open");
		const outstanding = open.filter((item) => item.kind === "outstanding");
		const planned = open.filter((item) => item.kind === "planned");
		const closed = items.filter((item) => item.status !== "open").slice(-10);
		const lines = [
			"# The Router's scratchpad",
			"",
			"## Outstanding",
			...(outstanding.length === 0 ? ["_nothing in flight_"] : outstanding.map((item) => `- [${item.id}] ${item.text}`)),
			"",
			"## Planned",
			...(planned.length === 0 ? ["_nothing planned_"] : planned.map((item) => `- [${item.id}] ${item.text}`)),
			...(closed.length === 0
				? []
				: ["", "## Recently closed", ...closed.map((item) => `- [${item.status}] ${item.text}`)]),
		];
		void journal
			.writeScratchpad(lines.join("\n"), `${outstanding.length} outstanding, ${planned.length} planned`)
			.catch((err: unknown) => log.warn("scratchpad: could not write the copy", { error: (err as Error).message }));
	}

	/** The scratchpad, as a turn reads it. */
	private scratchpadBlock(): string {
		const open = this.deps.store.listScratchpad().filter((item) => item.status === "open");
		if (open.length === 0) return "";
		const outstanding = open.filter((item) => item.kind === "outstanding");
		const planned = open.filter((item) => item.kind === "planned");
		const shown = (items: ScratchpadRow[], cap: number): string[] => {
			const kept = items.slice(0, cap);
			const lines = kept.map((item) => `- [${item.id}] ${item.text}`);
			if (items.length > kept.length) lines.push(`- (… and ${items.length - kept.length} more)`);
			return lines;
		};
		return [
			"=== Your scratchpad (every conversation) ===",
			"Work already in flight, and what you meant to do. A new request may belong to one of these.",
			...(outstanding.length === 0 ? [] : ["outstanding:", ...shown(outstanding, SCRATCHPAD_BLOCK_ITEMS)]),
			...(planned.length === 0 ? [] : ["planned:", ...shown(planned, SCRATCHPAD_BLOCK_ITEMS)]),
			"",
		].join("\n");
	}

	/**
	 * Read this conversation's journal before the turn is built.
	 *
	 * A file read per turn, not per message: the journal is a few hundred words, and
	 * a turn already reads the thread log. A failure leaves the cached copy in
	 * place — a journal that cannot be read is a journal you still have, and losing
	 * it mid-conversation would be worse than being a turn stale.
	 */
	private async loadJournal(): Promise<void> {
		const journal = this.deps.journal;
		const threadId = this.turn.originThreadId;
		if (journal === undefined || threadId === undefined) return;
		try {
			this.journalCache.set(threadId, await journal.read(threadId));
		} catch (err) {
			log.warn("journal: could not be read", { thread: threadId, error: (err as Error).message });
		}
	}

	/** The journal, as a turn reads it — first, because it is the summary. */
	private journalBlock(): string {
		const journal = this.deps.journal;
		const threadId = this.turn.originThreadId;
		if (journal === undefined || threadId === undefined) return "";
		const text = this.journalCache.get(threadId) ?? "";
		if (text === "") {
			return [
				"=== Your journal for this conversation ===",
				"Empty. When something would be expensive to lose — a decision, a path, an id, an answer — write it with `journal`. It is what this conversation remembers when the lines below fall out of view.",
				"",
			].join("\n");
		}
		return ["=== Your journal for this conversation ===", text, ""].join("\n");
	}

	/**
	 * `journal` — what the Router remembers about this conversation.
	 *
	 * Read with no argument, replaced with a note. Replaced, not appended: a
	 * journal that only grows is a log, and the log is already there. Over the cap
	 * the write is refused with the instruction to compact, so the summary stays a
	 * summary and the model — the only thing that knows what mattered — does the
	 * compacting.
	 */
	private buildJournalTool(): ToolDefinition {
		const router = this;
		return defineTool({
			name: "journal",
			label: "Read or rewrite this conversation's journal",
			description: [
				"Your note to yourself about this conversation: what it is, what was decided, what is still open, and the pointers that make the rest findable.",
				"Call it with no argument to read it. Call it with `note` to replace it — a rewrite, not an append, and the whole note each time.",
				"Write it when something would be expensive to lose: a decision, a path, an id, an answer to a question you asked. Not narration — the log has that.",
			].join("\n"),
			parameters: Type.Object({
				note: Type.Optional(
					Type.String({
						description: "The whole journal, rewritten. Omit to read it.",
					}),
				),
			}),
			exposure: "direct",
			async execute(_id: string, params: { note?: string }) {
				const threadId = router.turn.originThreadId ?? "";
				const journal = router.deps.journal;
				if (journal === undefined || threadId === "") {
					return {
						content: [{ type: "text" as const, text: "this conversation has no journal" }],
						details: { ok: false, chars: 0 },
					};
				}
				if (params.note === undefined) {
					const current = await journal.read(threadId);
					return {
						content: [
							{
								type: "text" as const,
								text: current === "" ? "empty — nothing written for this conversation yet" : current,
							},
						],
						details: { ok: true, chars: current.length },
					};
				}
				const written = await journal.write({
					threadId,
					text: params.note,
					...(router.deps.threadLog?.name(threadId) === undefined
						? {}
						: { label: router.deps.threadLog.name(threadId) }),
				});
				if (!written.ok) {
					return {
						content: [{ type: "text" as const, text: written.reason }],
						details: { ok: false, chars: params.note.length },
						isError: true,
					};
				}
				metrics.counter("mir_journal_writes_total");
				router.journalCache.set(threadId, params.note.trim());
				router.record(threadId, {
					kind: "status",
					status: "running",
					note: `journal written (${written.chars} chars)`,
				});
				return {
					content: [{ type: "text" as const, text: `journal written (${written.chars}/${JOURNAL_MAX_CHARS} chars)` }],
					details: { ok: true, chars: written.chars },
				};
			},
		});
	}

	/**
	 * `scratchpad` — the Router's lists, across every conversation.
	 *
	 * Two kinds, because they are read differently. `outstanding` is work in
	 * flight — a task, a question asked of a person, a deploy being watched — and a
	 * new message has to be reconciled with it. `planned` is what the Router means
	 * to do and has not started. A dispatch adds an outstanding line by itself, so
	 * the list cannot drift from reality by forgetting; a conclusion closes it.
	 */
	private buildScratchpadTool(): ToolDefinition {
		const router = this;
		return defineTool({
			name: "scratchpad",
			label: "The Router's outstanding and planned work",
			description: [
				"Your lists, shared across every conversation: what is in flight (`outstanding`) and what you mean to do (`planned`).",
				"Use it to tie a new request back to work already running — the answer to \"did we already look at that\" is here, not in this chat's history.",
				"`list` shows both. `add` takes kind and text. `done`/`drop` close one by id. `update` rewrites one.",
			].join("\n"),
			parameters: Type.Object({
				op: Type.Union([
					Type.Literal("list"),
					Type.Literal("add"),
					Type.Literal("update"),
					Type.Literal("done"),
					Type.Literal("drop"),
				]),
				kind: Type.Optional(Type.Union([Type.Literal("outstanding"), Type.Literal("planned")])),
				text: Type.Optional(Type.String({ description: "The line, in a few words." })),
				id: Type.Optional(Type.String({ description: "The item id, from `list`." })),
			}),
			exposure: "direct",
			async execute(_id: string, params: { op: string; kind?: "outstanding" | "planned"; text?: string; id?: string }) {
				const store = router.deps.store;
				const threadId = router.turn.originThreadId;
				switch (params.op) {
					case "add": {
						if (params.text === undefined || params.text.trim() === "") {
							return { content: [{ type: "text" as const, text: "add needs text" }], details: { ok: false, id: "" } };
						}
						const item = router.addScratchpadItem({
							kind: params.kind ?? "planned",
							text: params.text.trim(),
							...(threadId === undefined ? {} : { threadId }),
						});
						return {
							content: [{ type: "text" as const, text: `added ${item.id} (${item.kind}): ${item.text}` }],
							details: { ok: true, id: item.id },
						};
					}
					case "update": {
						const existing = params.id === undefined ? undefined : store.getScratchpadItem(params.id);
						if (existing === undefined) {
							return { content: [{ type: "text" as const, text: "no item with that id" }], details: { ok: false, id: params.id ?? "" } };
						}
						const next: ScratchpadRow = {
							...existing,
							...(params.kind === undefined ? {} : { kind: params.kind }),
							...(params.text === undefined ? {} : { text: params.text.trim() }),
							updatedAt: Date.now(),
						};
						store.putScratchpadItem(next);
						router.writeScratchpadCopy();
						return {
							content: [{ type: "text" as const, text: `updated ${next.id}: ${next.text}` }],
							details: { ok: true, id: next.id },
						};
					}
					case "done":
					case "drop": {
						const existing = params.id === undefined ? undefined : store.getScratchpadItem(params.id);
						if (existing === undefined) {
							return { content: [{ type: "text" as const, text: "no item with that id" }], details: { ok: false, id: params.id ?? "" } };
						}
						router.closeScratchpadItem(existing.id, params.op === "done" ? "done" : "dropped");
						return {
							content: [{ type: "text" as const, text: `${params.op === "done" ? "done" : "dropped"} ${existing.id}` }],
							details: { ok: true, id: existing.id },
						};
					}
					default: {
						const items = store.listScratchpad().filter((item) => item.status === "open");
						return {
							content: [
								{
									type: "text" as const,
									text: items.length === 0 ? "nothing on the scratchpad" : items.map((item) => `${item.id} [${item.kind}] ${item.text}`).join("\n"),
								},
							],
							details: { ok: true, id: "" },
						};
					}
				}
			},
		});
	}

	/**
	 * `read_log` — peek at the log itself.
	 *
	 * The turn's window is short by design; this is how a turn goes back further
	 * than the window, or reads what a Worker actually did, without asking the
	 * person to repeat themselves. The log is the record: if the journal and the
	 * log disagree, the log is right.
	 */
	private buildReadLogTool(): ToolDefinition {
		const router = this;
		return defineTool({
			name: "read_log",
			label: "Read a thread's log",
			description: [
				"Read entries from a thread's log — this conversation, or a task's thread — newest last.",
				"Use it when the answer is further back than this turn's window, or when you need what a Worker actually saw rather than its conclusion.",
				"`query` searches entry text; `kinds` narrows to text / tool_call / tool_result / status / stop.",
			].join("\n"),
			parameters: Type.Object({
				thread: Type.Optional(Type.String({ description: "Thread id; defaults to this conversation." })),
				query: Type.Optional(Type.String({ description: "Only entries whose text contains this." })),
				kinds: Type.Optional(Type.String({ description: "Comma-separated kinds to include." })),
				limit: Type.Optional(Type.Number({ description: "How many entries to return (default 60, max 400)." })),
			}),
			exposure: "direct",
			async execute(_id: string, params: { thread?: string; query?: string; kinds?: string; limit?: number }) {
				const threadLog = router.deps.threadLog;
				const threadId = params.thread ?? router.turn.originThreadId;
				if (threadLog === undefined || threadId === undefined) {
					return { content: [{ type: "text" as const, text: "there is no log for that" }], details: { ok: false, entries: 0 } };
				}
				const limit = Math.max(1, Math.min(400, Math.round(params.limit ?? 60)));
				const kinds = params.kinds === undefined ? undefined : new Set(params.kinds.split(",").map((kind) => kind.trim()));
				const query = params.query?.toLowerCase();
				// The filter runs in SQL, so asking about the end of a long log does not read
				// the whole of it: `kind` narrows on an indexed column and `query` narrows
				// the payload before any row is parsed.
				const found = threadLog.search(threadId, {
					...(kinds === undefined ? {} : { kinds: [...kinds] }),
					...(query === undefined ? {} : { like: query }),
					limit,
					...(query === undefined
						? {}
						: { match: (entry: ThreadEntry) => entryText(entry).toLowerCase().includes(query) }),
				});
				const kept = found.entries;
				if (kept.length === 0) {
					return { content: [{ type: "text" as const, text: "no entries matched" }], details: { ok: true, entries: 0 } };
				}
				const lines = kept.map((entry) => {
					const said = entryText(entry);
					const clipped = said.length > CONVERSATION_LINE_CHARS ? `${said.slice(0, CONVERSATION_LINE_CHARS)}…` : said;
					return `[${entry.seq}] ${entry.kind === "text" ? `${entry.role}: ` : ""}${clipped}`;
				});
				return {
					content: [
						{
							type: "text" as const,
							text: [
								`=== ${threadId} (${kept.length} of ${found.total} matching) ===`,
								...lines,
							].join("\n"),
						},
					],
					details: { ok: true, entries: kept.length },
				};
			},
		});
	}

	/**
	 * Where the hand this task runs on keeps its files, when it keeps them anywhere.
	 *
	 * Read from the hand's own policy, not from a naming convention: a hand is a
	 * machine with roots, and whether those roots are a space, a repo or a home
	 * directory is the host's word, not the brain's. A brain that recognised
	 * `space:` prefixes would need a new convention for every place a host invents.
	 */
	/**
	 * The hand a person or a model means, by name or by id.
	 *
	 * A name is what a person calls it, and it is what a model repeats. An id is what the
	 * wire uses. Both are accepted; a word that is neither resolves to nothing, and the
	 * dispatch refuses it — a task pinned to a hand that does not exist runs with no hand
	 * at all, which is how a Worker came to answer "filesystem access is disabled".
	 */
	resolveHand(word: string): string | undefined {
		const wanted = word.trim().toLowerCase();
		if (wanted === "") return undefined;
		const hands = this.deps.hands?.listHands() ?? [];
		const exact = hands.find((hand) => hand.endpointId.toLowerCase() === wanted);
		if (exact !== undefined) return exact.endpointId;
		return hands.find((hand) => (hand.name ?? "").toLowerCase() === wanted)?.endpointId;
	}

	/** The hands a dispatch may name, for a refusal that tells the model what it can say. */
	private handChoices(): string {
		const hands = this.deps.hands?.listHands() ?? [];
		if (hands.length === 0) return "no hands are connected";
		return hands.map((hand) => `“${hand.name}”${hand.connected ? "" : " (offline)"}`).join(", ");
	}

	/** A hand as the brain describes it: the hub's status plus the roots the client named. */
	private handFor(endpointId: string) {
		const hand = this.deps.hands?.listHands().find((candidate) => candidate.endpointId === endpointId);
		if (hand === undefined) return undefined;
		const roots = hand.policy.roots.length > 0 ? hand.policy.roots : this.deps.handRoots?.(endpointId) === undefined
			? []
			: [this.deps.handRoots(endpointId)!];
		return { ...hand, policy: { ...hand.policy, roots } };
	}

	private handRootFor(endpointId: string | undefined): string | undefined {
		if (endpointId === undefined) return undefined;
		// The hub's own view of a remote hand has no roots (a hand's policy is its own
		// and is display only here); the host told us where the folder is, and that is
		// the answer the brief needs.
		return this.handFor(endpointId)?.policy.roots[0];
	}

	/** What the person calls that hand, when the hand says. */
	private handNameFor(endpointId: string | undefined): string | undefined {
		if (endpointId === undefined) return undefined;
		const hand = this.deps.hands?.listHands().find((candidate) => candidate.endpointId === endpointId);
		const name = hand?.name;
		return name === undefined || name === "" ? undefined : name;
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
					router.recordTurnToolResult(
						callId,
						{ details: { taskId: task.id, workerId: task.workerId, status: task.status, threadId: task.threadId } },
						false,
						"stop_task",
					);
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
									`${h.endpointId} (${h.kind}${h.connected ? "" : ", offline"}) — exec=${h.capabilities.exec} shell=${h.capabilities.shell} fs=${h.capabilities.fs} git=${h.capabilities.git} running=${h.running}${h.policy.maxConcurrent !== undefined && h.policy.maxConcurrent > 0 ? `/${String(h.policy.maxConcurrent)}` : ""}\n  roots: ${h.policy.roots.join(", ") || "(none)"}`,
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
		const origin = this.originOf(batch);
		// The turn knows the channel and event it is answering, so a dispatch it
		// makes can inherit them: a task with no channel answers nobody.
		this.turn = emptyTurn(origin?.threadId, origin?.channelId, origin?.id, origin?.hand);
		this.endRequested = false;
		// The turn's conversation is the one the batch came from: its own session, so
		// nothing it was told in another chat can reach this answer.
		const sessionKey = this.turn.originThreadId ?? SESSION_COLD;
		const session = await this.sessionFor(sessionKey);
		this.sessionBusy.add(sessionKey);
		this.activeSessionKey = sessionKey;
		this.turnInFlightSince = Date.now();
		metrics.gauge("mir_router_turn_in_flight", 1);
		await this.loadJournal();
		const prompt = this.buildPrompt(batch);
		const triggerCount = batch.filter((i) => i.kind === "trigger").length;
		log.info("router turn start", {
			items: batch.length,
			triggers: triggerCount,
			queue: this.inbox.length,
		});
		try {
			await this.promptWithTimeout(session, prompt);
			// The turn (including any queued follow-ups) must be settled before we
			// judge whether the model replied — otherwise attribution races the model.
			await settleSession(session);
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
			// An abort this layer asked for is how a turn ends once it has answered:
			// not a failure, and not a batch to retry.
			if (this.endRequested) {
				log.info("router turn ended after its reply", { thread: this.turn.originThreadId });
				metrics.counter("mir_router_turns_ended_by_reply_total");
			} else {
				await this.handleTurnFailure(batch, err as Error);
			}
		} finally {
			this.sessionBusy.delete(sessionKey);
			this.activeSessionKey = null;
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

	private async promptWithTimeout(session: AgentSessionLike, prompt: string): Promise<void> {
		let timer: NodeJS.Timeout | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(new Error(`router turn exceeded ${this.config.routerTurnTimeoutMs}ms`)),
				this.config.routerTurnTimeoutMs,
			);
			timer.unref();
		});
		try {
			await Promise.race([session.prompt(prompt), timeout]);
		} catch (err) {
			// A hung turn must not wedge the layer: abort it and let the retry path
			// decide whether the batch is retried or failed.
			await session.abort?.().catch(() => {});
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
			await this.say(origin.threadId, origin.channelId, text, { eventId: origin.id });
		}
	}

	/**
	 * Say something in a thread, once.
	 *
	 * The product's channel writes its reply into the thread itself (`deliver`), so
	 * recording it here as well posts every answer twice — which is exactly what a
	 * doubled conclusion looked like, word for word, twice in one bubble. Every other
	 * channel has no such write and is logged here: every delivery passes through this
	 * one method, so no answer reaches a person without reaching the log, and none
	 * reaches it twice.
	 */
	private async say(
		threadId: string | undefined,
		channelId: string | undefined,
		text: string,
		ctx: { eventId?: string } = {},
	): Promise<void> {
		const channel = this.deps.channels.find((candidate) => candidate.id === channelId);
		if (channel === undefined) {
			this.record(threadId, { kind: "text", role: "assistant", text });
			return;
		}
		if (channel.id === "anomalous") {
			// The product's channel writes into the thread it is given, with no
			// resolution: `say` always knows the thread, and a second resolution is how a
			// conclusion was refused for "no chat to answer" while answering a chat.
			const deliverTo = (channel as { deliverTo?: (id: string, said: string) => Promise<void> }).deliverTo;
			if (threadId !== undefined && deliverTo !== undefined) {
				await deliverTo.call(channel, threadId, text).catch((err: unknown) =>
					log.warn("could not deliver a reply", { channel: channelId, error: (err as Error).message }),
				);
				return;
			}
		}
		if (channel.id !== "anomalous") this.record(threadId, { kind: "text", role: "assistant", text });
		await channel
			.respond(text, {
				...(ctx.eventId === undefined ? {} : { eventId: ctx.eventId }),
				...(threadId === undefined ? {} : { threadId }),
			})
			.catch((err: unknown) =>
				log.warn("could not deliver a reply", { channel: channelId, error: (err as Error).message }),
			);
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
		await this.say(origin.threadId, origin.channelId, redactSecrets(text), { eventId: origin.id });
	}

	private originOf(
		batch: InboxItem[],
	): { channelId: string; id?: string; threadId?: string; hand?: string } | undefined {
		for (let i = batch.length - 1; i >= 0; i--) {
			const item = batch[i]!;
			if (item.kind === "trigger") {
				return {
					channelId: item.trigger.channelId,
					id: item.trigger.id,
					threadId: item.trigger.threadId,
					...(item.trigger.hand === undefined ? {} : { hand: item.trigger.hand }),
				};
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

		// Where this conversation's work runs, when the client said. The Router has no
		// filesystem of its own, so without this it invents a path from its own cwd —
		// which is the brain's, and is nobody's folder.
		const hand = this.turn.originHand === undefined ? undefined : this.handFor(this.turn.originHand);
		if (hand !== undefined) {
			const where = hand.policy.roots.length > 0 ? ` Its files are at ${hand.policy.roots.join(", ")}.` : "";
			lines.push(
				`This conversation's work runs in “${hand.name}”.${where}`,
				"That is where their files are. Call it by that name if you must; never call it a channel or a machine, and never quote an identifier.",
				"",
			);
		}

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
							// No thread id and no event id: the Router does not need them (a
							// dispatch inherits both), and a model shown an identifier repeats
							// it to the person — "thread 01M7TTQ…" is machinery in a chat.
							summary: `${t.channelId} from=${t.metadata?.["user"] ?? "unknown"} :: ${t.text}`,
							relatedIds: related,
						}),
					);
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

		lines.push(this.journalBlock());
		lines.push(this.conversationBlock(batch));
		lines.push(this.scratchpadBlock());
		lines.push(this.stateBlock());
		lines.push(this.instructionsBlock());
		return lines.join("\n");
	}

	/**
	 * The conversation this turn is in, oldest first.
	 *
	 * The Router's model session is not this chat's: one session answers every
	 * conversation, so its own history is a pile of them in arrival order. What
	 * makes a turn answer *this* chat is the log — the last lines of it, handed
	 * over as text, ending where the batch begins so the person's own message is
	 * not said twice.
	 */
	private conversationBlock(batch: InboxItem[]): string {
		const threadId = this.originOf(batch)?.threadId;
		const threadLog = this.deps.threadLog;
		if (threadLog === undefined || threadId === undefined || threadId === "") return "";
		const entries = threadLog.entries(threadId, 0, CONVERSATION_SCAN);
		// This turn's own message was written at admission and is repeated in the
		// Inbound block, so the history ends where the batch begins: the earliest
		// entry this batch brought is the last line not shown.
		const incoming = new Set(
			batch.flatMap((item) => (item.kind === "trigger" ? [item.trigger.text.trim()] : [])),
		);
		let cut = entries.length;
		for (let index = entries.length - 1; index >= 0; index -= 1) {
			const entry = entries[index]!;
			if (entry.kind === "text" && entry.role === "user" && incoming.has(entry.text.trim())) cut = index;
		}
		const lines: string[] = [];
		for (const entry of entries.slice(0, cut)) {
			const line = conversationLine(entry);
			if (line !== undefined) lines.push(line);
		}
		if (lines.length === 0) return "";
		// A budget, not a count: a hundred-odd lines or six thousand characters,
		// whichever comes first, but never fewer than a turn needs to follow the
		// thread. The tail is the working set; the journal is the memory.
		const kept: string[] = [];
		let chars = 0;
		for (let index = lines.length - 1; index >= 0; index -= 1) {
			const line = lines[index]!;
			const atFloor = kept.length < CONVERSATION_MIN_LINES;
			if (!atFloor && (chars + line.length > CONVERSATION_TAIL_CHARS || kept.length >= CONVERSATION_TAIL_LINES)) break;
			kept.unshift(line);
			chars += line.length + 1;
		}
		const dropped = lines.length - kept.length;
		return [
			"=== This conversation, oldest first ===",
			"Everything below already happened in this chat. It is the record, not a summary: answer from it before dispatching anything.",
			// The moment the window starts forgetting, say so — and say what to do
			// about it. This is what keeps the journal current without a timer.
			...(dropped > 0
				? [
						`(… ${dropped} earlier line(s) not shown. If any of them still matter, they belong in your journal — and \`read_log\` will fetch them.)`,
					]
				: []),
			...kept,
			"",
		].join("\n");
	}

	private stateBlock(): string {
		const live = [...this.workers.values()].filter((w) => w.status === "busy" || w.status === "blocked");
		const recentTasks = this.listTasks().slice(-5);
		const parts: string[] = ["=== State ==="];
		const hands = this.deps.hands?.listHands() ?? [];
		if (hands.length) {
			parts.push(
				// By name: the id is machinery, and a model shown an id repeats it to the
				// person. The roots go with it, because that is the only path it knows.
				`hands: ${hands.filter((h) => h.connected).length} connected — ` +
					hands
						.map((h) => {
							const roots = h.policy.roots.length > 0 ? ` at ${h.policy.roots.join(", ")}` : "";
							return `“${h.name}”${h.connected ? "" : " (offline)"}${roots} can-exec=${h.capabilities.exec}`;
						})
						.join("; "),
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
			`Your tools: ${channelTools} (say something to the person), dispatch_task (start work), stop_task, list_workers, list_tasks, list_hands, chat_title (read or set this chat's name), recall (read spilled context by id), use_skill (read one of your skills).`,
			// The procedure is a skill, and the skill is the only copy of it. A rule
			// stated twice drifts; a rule stated once, in a file with a description
			// that says when it applies, is loaded when it matters.
			"You do not do work yourself: a Worker does. Read the `dispatch` skill before you act on a request — it holds the five things you answer yourself, and why everything else is a dispatch. Read `chat-title` before you end a turn.",
			"If you need context that is not in this turn, call recall with an id or a query rather than guessing.",
			"",
			`Channels: ${this.deps.channels.map((c) => c.id).join(", ")}. Always reply through respond_<channel> with reply_to = the event id — never as plain assistant text.`,
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
			...(input.parentTaskId === undefined ? {} : { parentTaskId: input.parentTaskId }),
			depth: input.parentTaskId === undefined ? 0 : (this.tasks.get(input.parentTaskId)?.depth ?? 0) + 1,
		};
		this.tasks.set(id, full);
		this.deps.store.upsertTask(full);

		// A check a Worker asked for. Its parent's card is the acknowledgement and its
		// answer is a tool result, so nothing here is said to a person: no scratchpad
		// line, no status entry, no card. A person watching would see a second card for
		// work they did not ask for.
		if (input.parentTaskId !== undefined) {
			metrics.counter("mir_tasks_nested_total");
			if (atCapacity) {
				this.dispatchQueue.push({ taskId: id, input });
				return full;
			}
			await this.spawnWorker(full, input);
			return full;
		}

		// The list of what is in flight is written by the dispatch, not by the
		// Router remembering to write it. That is the difference between a list that
		// can drift and one that cannot.
		this.addScratchpadItem({
			kind: "outstanding",
			text: `${input.title}${input.endpointId === undefined ? "" : ` — on ${input.endpointId}`}`,
			...(input.threadId === undefined ? {} : { threadId: input.threadId }),
			taskId: id,
		});
		this.record(input.threadId, {
			kind: "status",
			status: atCapacity ? "waiting" : "running",
			note: `dispatched: ${input.title}${input.endpointId === undefined ? "" : ` on ${input.endpointId}`}`,
		});
		this.recordCard(input.threadId, id);
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

	/**
	 * Ask for a task of its own: a Worker's check.
	 *
	 * The Worker blocks on the answer — the conclusion is this call's result — and the
	 * child runs on the same hand, so a check inside a space reads the same folder its
	 * parent does. Depth stops at one level: the child's tool list has no dispatch.
	 */
	async dispatchChildTask(
		parentTaskId: string,
		input: { title: string; description: string; instructions?: string },
	): Promise<{ ok: boolean; text: string }> {
		const parent = this.tasks.get(parentTaskId);
		if (parent === undefined) return { ok: false, text: `no such task: ${parentTaskId}` };
		if ((parent.depth ?? 0) >= 1) {
			return { ok: false, text: "a check cannot dispatch a check: one level is the depth" };
		}
		if (this.children.size >= this.config.maxNestedWorkers) {
			return { ok: false, text: `too many checks running (${this.config.maxNestedWorkers}); wait for one to finish` };
		}
		const id = `task-${crypto.randomUUID()}`;
		const answer = new Promise<{ ok: boolean; text: string }>((resolve) => {
			this.children.set(id, resolve);
		});
		try {
			await this.dispatchTask({
				id,
				title: input.title,
				description: input.description,
				...(input.instructions === undefined ? {} : { instructions: input.instructions }),
				// Same hand as the parent: a check inside a space must read that space.
				...(parent.endpointId === undefined ? {} : { endpointId: parent.endpointId }),
				parentTaskId,
			});
		} catch (err) {
			this.children.delete(id);
			return { ok: false, text: `could not start the check: ${(err as Error).message}` };
		}
		return answer;
	}

	/** The task a worker is running, when it is still known. */
	taskForWorker(workerId: string): Task | undefined {
		const rec = this.workers.get(workerId);
		return rec === undefined ? undefined : this.tasks.get(rec.taskId);
	}

	/**
	 * Pass one agent's words to another.
	 *
	 * `to` is `"parent"` or a task id. The daemon decides who that is, because only it
	 * knows the whole tree: a Worker cannot address a task it was not given, and a
	 * message that names an unrelated task is refused rather than delivered.
	 */
	routeMessage(fromWorkerId: string, to: string, text: string): { ok: boolean; error?: string } {
		const from = this.taskForWorker(fromWorkerId);
		if (from === undefined) return { ok: false, error: "this worker has no task" };
		let target: Task | undefined;
		if (to === "parent") {
			target = from.parentTaskId === undefined ? undefined : this.tasks.get(from.parentTaskId);
			if (target === undefined) return { ok: false, error: "this task has no parent" };
		} else {
			target = this.tasks.get(to);
			// Only a child of this Worker, or its own parent: an agent may talk along the
			// edge it was given, not to arbitrary tasks in the brain.
			const related = target !== undefined && (target.parentTaskId === from.id || from.parentTaskId === target.id);
			if (target === undefined || !related) return { ok: false, error: `no related task ${to}` };
		}
		if (target.workerId === undefined) return { ok: false, error: `${to} has no worker yet` };
		const delivered = this.deps.sendToWorker?.(target.workerId, from.title, text) ?? false;
		if (!delivered) return { ok: false, error: `${to} is not connected` };
		metrics.counter("mir_agent_messages_total");
		return { ok: true };
	}

	/** Stop a check this Worker dispatched, and nothing else. */
	async stopChild(workerId: string, taskId: string): Promise<{ ok: boolean; error?: string }> {
		const from = this.taskForWorker(workerId);
		const target = this.tasks.get(taskId);
		if (from === undefined || target === undefined) return { ok: false, error: "no such task" };
		if (target.parentTaskId !== from.id) return { ok: false, error: "that task is not yours to stop" };
		try {
			await this.stopTask(taskId, "stopped by the Worker that asked for it");
			return { ok: true };
		} catch (err) {
			return { ok: false, error: (err as Error).message };
		}
	}

	/** Resolve a waiting parent. Idempotent: a task can only be settled once. */
	private settleChild(taskId: string, answer: { ok: boolean; text: string }): void {
		const resolve = this.children.get(taskId);
		if (resolve === undefined) return;
		this.children.delete(taskId);
		resolve(answer);
	}

	/** Spawn a Worker process for an already-registered task. */
	private async spawnWorker(task: Task, input: TaskInput): Promise<void> {
		const now = Date.now();
		const workerId = `worker-${crypto.randomUUID().slice(0, 12)}`;
		task.workerId = workerId;
		task.status = "running";
		task.updatedAt = now;
		this.pendingSpawns++;
		// The Worker's own thread. Its narration — "I'll check the subdirectories",
		// every tool call, every hand call — is how the work was done, not what the
		// person asked for. It belongs somewhere a person can look *if they want to*,
		// which is a thread of its own; the chat gets the card and the answer.
		//
		// Before this, a task dispatched from a chat wrote the Worker's monologue into
		// the chat itself, so a person read "I'll stop here and wait for the search"
		// eleven times in their conversation.
		const workThread = this.workThreadFor(task);
		this.workers.set(workerId, {
			workerId,
			taskId: task.id,
			status: "busy",
			threadIds: workThread === undefined ? [] : [workThread],
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
				...(task.parentTaskId === undefined ? {} : { parentTaskId: task.parentTaskId }),
				depth: task.depth ?? 0,
				...(this.handRootFor(task.endpointId) === undefined
					? {}
					: {
							handRoot: this.handRootFor(task.endpointId),
							...(this.handNameFor(task.endpointId) === undefined
								? {}
								: { handName: this.handNameFor(task.endpointId) }),
						}),
				handsSocketPath: this.deps.hands?.socketPath,
				capabilities: this.config.workerCapabilities,
				toolPolicy: this.config.workerToolPolicy,
			});
			metrics.counter("mir_worker_spawns_total", 1, { fast: String(Boolean(task.fast)) });
			log.info("worker spawned", { task: task.id, worker: workerId, model: workerModelId, hand: task.endpointId ?? "auto" });
			// Started is not connected. The deadline is what tells the two apart.
			const timer = setTimeout(() => {
				this.helloTimers.delete(workerId);
				// The child's own words, when the process manager kept them: "never
				// started" is the symptom, "Cannot find module …" is the cause.
				const died = this.deps.processManager.lastWorkerError?.(task.id);
				const reason =
					`the worker never started (no hello within ${Math.round(this.config.workerHelloTimeoutMs / 1000)}s)` +
					(died === undefined ? "" : `: ${died}`);
				log.warn("worker never said hello", { worker: workerId, task: task.id, reason });
				this.failWorker(workerId, reason);
			}, this.config.workerHelloTimeoutMs);
			timer.unref?.();
			this.helloTimers.set(workerId, timer);
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
		const timer = this.helloTimers.get(workerId);
		if (timer !== undefined) {
			clearTimeout(timer);
			this.helloTimers.delete(workerId);
		}
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

	/**
	 * What a Worker did, recorded where the work is.
	 *
	 * The thread is the audit trail: a tool call and its result are two entries, so
	 * a reader can tell "still running" from "we lost it", and a `use_skill` call is
	 * how a skill's load shows up. `workerId` is on the entry because a thread can
	 * have more than one worker in it, and the panel filters by it.
	 */
	handleWorkerToolCall(workerId: string, toolCallId: string, toolName: string, args?: unknown): void {
		const rec = this.workers.get(workerId);
		for (const threadId of rec?.threadIds ?? []) {
			this.record(threadId, {
				kind: "tool_call",
				toolCallId,
				toolName,
				...(args === undefined ? {} : { args }),
				workerId,
			});
		}
	}

	handleWorkerToolResult(workerId: string, toolCallId: string, isError: boolean, result?: unknown): void {
		const rec = this.workers.get(workerId);
		// Which machine did the work. A hand tool's result says which hand answered, and
		// a thread that does not record it shows "Machines: none" for work that plainly
		// ran somewhere — the panel's question is "where", and only this answers it.
		const hand = handOfResult(result);
		for (const threadId of rec?.threadIds ?? []) {
			if (hand !== undefined) {
				this.record(threadId, {
					kind: "hand",
					endpointId: hand.endpointId,
					op: hand.op,
					ok: !isError,
					workerId,
				});
			}
			this.record(threadId, {
				kind: "tool_result",
				toolCallId,
				isError,
				...(result === undefined ? {} : { result }),
				workerId,
			});
		}
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

	/** Take a worker's buffered output, and stop its timer. */
	private takeWorkerDelta(workerId: string): string {
		const buffered = this.deltaBuffers.get(workerId);
		if (buffered === undefined) return "";
		this.deltaBuffers.delete(workerId);
		clearTimeout(buffered.timer);
		return buffered.text;
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
			this.record(threadId, { kind: "text", role: "assistant", text: buffered.text, workerId });
		}
		// What has already been said, so the conclusion is not said again. The stream
		// and the conclusion are the same words: the model streams its answer and then
		// reports it, and a person read it twice, word for word, in one thread.
		const streamed = this.streamedByWorker.get(workerId) ?? "";
		this.streamedByWorker.set(workerId, streamed + buffered.text);
	}

	async handleWorkerConclusion(workerId: string, text: string): Promise<void> {
		// Whatever the worker was mid-sentence on: if the conclusion contains it, it
		// is the same words arriving twice — the streamed prefix and the finished
		// sentence — so the buffer is dropped rather than flushed. Anything earlier
		// was already written by the delta timer.
		const pending = this.takeWorkerDelta(workerId);
		if (pending !== "" && !text.includes(pending.trim())) {
			const rec = this.workers.get(workerId);
			for (const threadId of rec?.threadIds ?? []) {
				this.record(threadId, { kind: "text", role: "assistant", text: pending, workerId });
			}
		}
		const rec = this.workers.get(workerId);
		if (!rec) {
			log.warn("conclusion from unknown worker", { worker: workerId });
			return;
		}
		// The conclusion is the last assistant message after the last tool call, and a
		// Worker that streamed it has already said it. Recording it again is the same
		// words twice in one thread, which is what "the answer came out doubled" looked
		// like. What is always recorded is that the worker finished.
		// Only what was *written* counts: an unflushed buffer was dropped above when the
		// conclusion already contains it, so the conclusion is the first time these words
		// reach the log and it must be written.
		const streamed = this.streamedByWorker.get(workerId) ?? "";
		const alreadySaid = streamed.replace(/\s+/g, " ").includes(text.replace(/\s+/g, " ").trim());
		this.streamedByWorker.delete(workerId);
		rec.status = "done";
		rec.lastHeartbeat = Date.now();
		rec.progress = "conclusion reported";
		this.persistWorker(workerId);

		const task = this.tasks.get(rec.taskId);
		// A check's conclusion is the return value of the tool call that asked for it.
		// It is not pushed to a channel and does not start a Router turn: the Worker
		// that asked is blocked on the answer, and gets it as a tool result.
		if (task?.parentTaskId !== undefined) {
			task.status = "done";
			task.result = text;
			task.updatedAt = Date.now();
			this.deps.store.upsertTask(task);
			metrics.counter("mir_tasks_completed_total", 1, { status: "done", nested: "true" });
			this.settleChild(task.id, { ok: true, text: redactSecrets(text) });
			return;
		}
		// A conclusion that lands in a *chat* is the answer, and it is delivered
		// there directly; a thread with no chat is work being done for someone who
		// will be told through a channel, and it keeps its own "done" marker.
		const reportThread = task?.threadId;
		const reportIsChat =
			reportThread !== undefined && reportThread !== "" && this.deps.threadLog?.chatOf(reportThread) !== undefined;

		// The work thread's own record: what the worker said, then that it ended.
		// A client watching the thread sees the answer without waiting for the
		// Router to pass it on to a channel.
		for (const threadId of rec.threadIds) {
			if (reportIsChat && threadId === reportThread) continue;
			if (!alreadySaid) this.record(threadId, { kind: "text", role: "assistant", text, workerId });
			this.record(threadId, { kind: "status", status: "done", note: `worker ${workerId} finished` });
		}

		if (task) {
			task.status = "done";
			task.result = text;
			task.updatedAt = Date.now();
			this.deps.store.upsertTask(task);
			metrics.counter("mir_tasks_completed_total", 1, { status: "done", fast: String(Boolean(task.fast)) });
			this.closeScratchpadForTask(task.id, "done");
			// The card, now that the task has its answer: a reload renders this one
			// and asks the app server for the state, so it is never stale.
			this.recordCard(task.threadId, task.id);
			metrics.observe("mir_task_duration_ms", Date.now() - task.createdAt, { fast: String(Boolean(task.fast)) });
			this.deps.context.spill({
				id: `task:${task.id}`,
				type: "task",
				summary: `${task.title} [done] — ${text.replace(/\s+/g, " ")}`,
				ref: `mir://task/${task.id}`,
				inlineIds: [`worker:${workerId}`],
			});
		}

		// The conclusion is the answer, so it goes to the conversation now — not when
		// a model next gets a turn. A turn on a slow provider is a minute or more, and
		// a model asked to relay an answer it was handed says it twice: once in the
		// worker's words and once in its own.
		if (reportIsChat && reportThread !== undefined) {
			// The answer, once. The product's channel writes its reply into the thread
			// itself; every other channel is logged here — saying it both ways is how a
			// conclusion came out twice, word for word.
			await this.say(reportThread, task?.channelId, redactSecrets(text), {
				...(task?.replyTo === undefined ? {} : { eventId: task.replyTo }),
			});
			// And the turn that the dispatch opened is over: without this the chat
			// keeps its thinking loader up, because nothing else closes a turn no
			// model run opened.
			this.record(reportThread, { kind: "status", status: "idle", note: "the worker finished" });
			metrics.counter("mir_conclusions_delivered_direct_total");
			return;
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
		const timer = this.helloTimers.get(workerId);
		if (timer !== undefined) {
			clearTimeout(timer);
			this.helloTimers.delete(workerId);
		}
		const rec = this.workers.get(workerId);
		if (!rec) return;
		const task = this.tasks.get(rec.taskId);
		if (task) {
			task.status = "failed";
			task.error = reason;
			task.updatedAt = Date.now();
			this.deps.store.upsertTask(task);
			metrics.counter("mir_tasks_completed_total", 1, { status: "failed", fast: String(Boolean(task.fast)) });
			this.closeScratchpadForTask(task.id, "dropped");
			// Silence is not a state a person can see. The thread says the work
			// failed, in the words the log has, and the card says the same — so a chat
			// that was waiting on this stops waiting and says why.
			this.record(task.threadId, { kind: "status", status: "failed", note: reason });
			this.recordCard(task.threadId, task.id);
			const channel = this.deps.channels.find((candidate) => candidate.id === task.channelId);
			if (channel !== undefined && task.replyTo !== undefined) {
				void channel
					.respond(reason, { eventId: task.replyTo, ...(task.threadId === undefined ? {} : { threadId: task.threadId }) })
					.catch(() => {});
			}
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
		// A stop from the card goes through the same path as a stop from anywhere
		// else, and the card learns it from the log like every other client.
		this.recordCard(task.threadId, task.id);
		this.closeScratchpadForTask(task.id, "dropped");
		// A queued task has no worker yet: just remove it from the queue.
		const queueIdx = this.dispatchQueue.findIndex((i) => i.taskId === taskId);
		if (queueIdx >= 0) this.dispatchQueue.splice(queueIdx, 1);
		if (task.workerId) {
			const workerId = task.workerId;
			const timer = this.helloTimers.get(workerId);
			if (timer !== undefined) {
				clearTimeout(timer);
				this.helloTimers.delete(workerId);
			}
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
		if (answeringThisThread) {
			// Only that conversation's session: a stop in one chat is not a stop in
			// every other chat the Router is holding.
			await this.sessions.get(this.turn.originThreadId ?? SESSION_COLD)?.abort?.().catch(() => {});
		}
		// An entry of its own, which also moves the thread's state: a stop is not an
		// absence of a reply.
		this.record(threadId, { kind: "stop", note: why });
		// And the cards say stopped, so a reload does not show a spinner for work
		// that ended.
		for (const task of stopped) this.recordCard(threadId, task.id);
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

	/**
	 * End the turn now.
	 *
	 * `abort` is the only lever pi gives for "stop the loop": it cancels the provider
	 * call and the queued steps, and `runTurn` treats it as a clean end because the
	 * turn already said what it had to say.
	 */
	private requestTurnEnd(): void {
		if (this.endRequested) return;
		this.endRequested = true;
		const session = this.sessions.get(this.activeSessionKey ?? SESSION_COLD);
		if (session === undefined) return;
		// A tick later: the tool call that decided this is still unwinding, and aborting
		// inside its own execution is a fight with the loop it is trying to stop.
		const timer = setTimeout(() => {
			void session.abort?.().catch(() => {});
		}, 0);
		timer.unref?.();
	}

	/** Watchdog hook: abort a hung turn. */
	async abortTurn(reason: string): Promise<void> {
		log.warn("aborting router turn", { reason });
		await Promise.all(this.heldSessions().map((session) => session.abort?.().catch(() => {})));
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
		for (const timer of this.helloTimers.values()) clearTimeout(timer);
		this.helloTimers.clear();
		// An in-flight turn may still touch the store; let it finish or abort it
		// before the caller closes the database underneath it.
		if (this.turnInFlightSince > 0) {
			const busy = [...this.sessionBusy]
				.map((key) => this.sessions.get(key))
				.filter((held): held is AgentSessionLike => held !== undefined);
			await Promise.all(busy.map((session) => session.abort?.().catch(() => {})));
			await Promise.race([
				Promise.all(busy.map((session) => settleSession(session).catch(() => {}))),
				sleep(5000),
			]);
		}
		await Promise.all(this.heldSessions().map((session) => session.dispose().catch(() => {})));
		this.sessions.clear();
		this.sessionUsedAt.clear();
	}
}

/** TaskStatus is re-exported for callers that only import the router. */
export type { TaskStatus };
