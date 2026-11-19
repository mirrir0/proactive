/**
 * Thread log — what a thread *is*, as a durable, ordered, addressable record.
 *
 * A thread was a routing label: a stream of Triggers that a Worker subscribes
 * to. That is enough to route, and not enough to show. A client — a chat panel,
 * a thread panel, a document that transcludes one — needs the conversation:
 * what the agent said, what it thought, which tool it called, on which hand, and
 * how it ended.
 *
 * So every thread now keeps an append-only log of entries, sequenced per thread
 * and stored beside everything else (ADR 0002: SQLite is the source of truth,
 * memory is a cache). Two properties matter and both are deliberate:
 *
 *   - **Append-only, with a per-thread `seq`.** A client that reconnects sends
 *     the last `seq` it saw and gets exactly what it missed. There is no
 *     "snapshot plus a guess": `entries(threadId, since)` is the whole protocol.
 *   - **Never rewritten.** An entry is what happened. A tool call's result is a
 *     *second* entry (`tool_result`), not an edit of the first, so a client that
 *     saw the call and not the result can tell the difference between "still
 *     running" and "we lost it".
 *
 * The log is also how the Router's own replies are visible without the Router
 * having to stream: it appends as it goes, and every subscriber reads the same
 * log.
 */

import crypto from "node:crypto";
import type { MirStore } from "./store.ts";
import type { Logger } from "./telemetry.ts";

/** How a thread is doing, as a person would say it. */
export type ThreadStatus = "running" | "waiting" | "idle" | "done" | "failed" | "stopped";

/**
 * One thing that happened in a thread.
 *
 * `seq` is per thread and strictly increasing; `at` is wall-clock. A client
 * renders by `seq` and shows `at` only as a timestamp, because two entries can
 * share a millisecond and a clock can go backwards.
 */
export type ThreadEntry =
	| { seq: number; at: number; kind: "text"; role: "assistant" | "user"; text: string }
	| { seq: number; at: number; kind: "thinking"; text: string }
	| {
			seq: number;
			at: number;
			kind: "tool_call";
			toolCallId: string;
			toolName: string;
			args?: unknown;
	  }
	| {
			seq: number;
			at: number;
			kind: "tool_result";
			toolCallId: string;
			result?: unknown;
			isError: boolean;
	  }
	| {
			seq: number;
			at: number;
			kind: "hand";
			endpointId: string;
			op: string;
			ok: boolean;
			durationMs?: number;
	  }
	| { seq: number; at: number; kind: "status"; status: ThreadStatus; note?: string }
	/**
	 * The person pressed stop.
	 *
	 * Its own entry rather than a `status`: a stop is something that happened in
	 * the conversation, and a chat stopped half-way has to say so where the
	 * person is reading.
	 */
	| { seq: number; at: number; kind: "stop"; note?: string }
	/**
	 * The chat was renamed.
	 *
	 * Not something anyone said, so it is not drawn in the transcript — but it is
	 * a fact about the conversation, and the log is where a conversation's facts
	 * live: a client that opens the chat later reads the same name it has now.
	 */
	| { seq: number; at: number; kind: "title"; title: string }
	/**
	 * Work this thread is showing, as an app the client renders.
	 *
	 * Not a card the client has to understand: a pointer. `server` names an MCP
	 * server the client already knows, `uri` a `ui://` resource on it, and `data`
	 * what the view needs to draw itself. Which is why an agent with a card of its
	 * own and an agent with none are the same shape to the client — and why the
	 * entry carries a task id rather than a snapshot: a client that reloads asks
	 * the server for the state now, instead of drawing yesterday's.
	 */
	| {
			seq: number;
			at: number;
			kind: "app";
			/** The MCP server that serves the view: `mir`, or another agent's name. */
			server: string;
			/** The `ui://` resource to render. */
			uri: string;
			/** What the view needs to draw itself, and to ask for more. */
			data: Record<string, unknown>;
	  }

/** What a client needs to list a thread without reading it. */
export interface ThreadSummary {
	id: string;
	name: string;
	channelId: string;
	status: ThreadStatus;
	/** Highest entry sequence, or 0 for a thread with no entries yet. */
	seq: number;
	lastEventAt: number;
}

/** An entry before the log assigns its sequence. */
export type NewThreadEntry = ThreadEntry extends infer E
	? E extends ThreadEntry
		? Omit<E, "seq" | "at"> & { at?: number }
		: never
	: never;

export interface ThreadLogOptions {
	store: MirStore;
	log: Logger;
	/** Entries kept per thread before the oldest are pruned. 0 keeps everything. */
	retainPerThread?: number;
}

interface EntryRow {
	thread_id: string;
	seq: number;
	at: number;
	kind: string;
	payload: string;
}

/** Rows are stored as `kind` + a JSON payload, so an entry shape can grow without a migration. */
export class ThreadLog {
	private readonly store: MirStore;
	private readonly log: Logger;
	private readonly retainPerThread: number;

	constructor(options: ThreadLogOptions) {
		this.store = options.store;
		this.log = options.log;
		this.retainPerThread = options.retainPerThread ?? 0;
	}

	/**
	 * Append one entry, assigning its sequence.
	 *
	 * The sequence comes from the store in the same statement that writes the
	 * entry (`seq = threads.seq + 1`), so two appends racing on one thread cannot
	 * both take the same number: the log is the authority on order, not the
	 * process that happened to call first.
	 */
	append(threadId: string, entry: NewThreadEntry): ThreadEntry {
		// A thread does not say the same thing twice running. A model handed a
		// conclusion it was told not to restate sometimes restates it, and a
		// person then reads the same paragraph twice; the second adds nothing, so
		// it is not written. Statuses between the two do not count, and only the
		// same speaker repeating itself is a repeat — a person echoing it is not.
		if (entry.kind === "text") {
			const said = entry as { role: string; text: string };
			const said_ = this.lastTextEntryOf(threadId, said.role);
			// The words are already there, so that entry is what a caller publishes
			// and nothing new is written.
			if (said_ !== null && said_.text === said.text) return said_;
		}
		// A stop moves the thread's own state as well as the log: the column a list
		// reads and the entry a panel reads are one event, written once.
		if (entry.kind === "stop") this.store.setThreadStatus(threadId, "stopped");
		const at = entry.at ?? Date.now();
		const seq = this.store.appendThreadEntry(threadId, at, entry.kind, payloadOf(entry));
		const stored = { ...entry, seq, at } as ThreadEntry;
		if (this.retainPerThread > 0) this.store.pruneThreadEntries(threadId, this.retainPerThread);
		return stored;
	}

	/** The last thing `role` said in this thread, or null when it has said nothing. */
	private lastTextEntryOf(threadId: string, role: string): Extract<ThreadEntry, { kind: "text" }> | null {
		for (const entry of this.entries(threadId, 0, this.retainPerThread > 0 ? this.retainPerThread : 500).reverse()) {
			if (entry.kind === "text" && entry.role === role) return entry;
		}
		return null;
	}

	/** The entries after `since` (exclusive), oldest first. `since: 0` is the whole log. */
	entries(threadId: string, since = 0, limit = 500): ThreadEntry[] {
		const rows = this.store.listThreadEntries(threadId, since, limit);
		return rows.flatMap((row) => {
			const parsed = parseEntry(row);
			if (parsed === null) {
				this.log.warn("thread log: dropping an unreadable entry", { thread: threadId, seq: row.seq });
				return [];
			}
			return [parsed];
		});
	}

	/** Set a thread's status, and record the change in the log so a client sees it in order. */
	setStatus(threadId: string, status: ThreadStatus, note?: string): ThreadEntry {
		this.store.setThreadStatus(threadId, status);
		return this.append(threadId, { kind: "status", status, ...(note === undefined ? {} : { note }) });
	}

	/** A thread's status without appending anything (a reader, not a writer). */
	status(threadId: string): ThreadStatus {
		return this.store.getThreadStatus(threadId);
	}

	/**
	 * The thread a chat shows, minting it on first use.
	 *
	 * Idempotent and safe to race: two turns of the same chat arriving at once
	 * get the same id, because the store decides it under one statement.
	 */
	chatThread(chatId: string, title?: string): string {
		return this.store.threadForChat(chatId, () => newThreadId(), title);
	}

	/** What a thread is called: a chat's title, for a chat's thread. */
	name(threadId: string): string | undefined {
		return this.store.threadName(threadId);
	}

	/**
	 * Rename a thread, and record it.
	 *
	 * The name column is what a list reads; the entry is what a chat reads, so the
	 * two cannot disagree about what this conversation came to be about. Returns
	 * the entry, which the caller publishes.
	 */
	rename(threadId: string, title: string): ThreadEntry {
		this.store.renameThread(threadId, title);
		return this.append(threadId, { kind: "title", title });
	}

	/** The chat a thread shows, if it shows one. */
	chatOf(threadId: string): string | undefined {
		return this.store.chatForThread(threadId);
	}

	/** Every thread, newest activity first. */
	summaries(limit = 100): ThreadSummary[] {
		return this.store.listThreadSummaries(limit);
	}
}

/** The entry's fields minus the ones the log owns, as JSON. */
function payloadOf(entry: NewThreadEntry): string {
	const { kind: _kind, at: _at, ...rest } = entry as NewThreadEntry & { kind: string; at?: number };
	return JSON.stringify(rest);
}

/** One stored row as an entry, or null when its payload no longer parses. */
function parseEntry(row: EntryRow): ThreadEntry | null {
	let payload: unknown;
	try {
		payload = JSON.parse(row.payload);
	} catch {
		return null;
	}
	if (payload === null || typeof payload !== "object") return null;
	return { ...(payload as object), kind: row.kind, seq: row.seq, at: row.at } as ThreadEntry;
}

/** A fresh thread id. ULID-shaped so a client can use it as an entity id (see the anomalous proposal). */
export function newThreadId(at: number = Date.now()): string {
	return ulid(at);
}

// ---------------------------------------------------------------------------
// ULID
// ---------------------------------------------------------------------------

const ULID_CHARS = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A Crockford-base32 ULID: 48 bits of time, then 80 bits of randomness.
 *
 * A product that shows a thread as a chip or a mention needs an id it can
 * recognise as one (`ULID_RE` in the anomalous side's markdown tokens). Time
 * first also means ids sort by creation, which is what a thread list wants.
 */
export function ulid(at: number = Date.now()): string {
	let time = "";
	let remaining = at;
	for (let index = 0; index < 10; index++) {
		time = ULID_CHARS[remaining % 32] + time;
		remaining = Math.floor(remaining / 32);
	}
	let random = "";
	const bytes = crypto.randomBytes(16);
	for (let index = 0; index < 16; index++) {
		random += ULID_CHARS[bytes[index]! % 32];
	}
	return time + random;
}
