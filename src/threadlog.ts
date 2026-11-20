/**
 * A thread as a durable, ordered log of entries (ADR 0002: SQLite is the source of
 * truth).
 *
 * Append-only, with a per-thread `seq`, so a reconnecting client asks for what it
 * missed. A tool call's result is a second entry, never an edit of the first.
 */

import crypto from "node:crypto";
import type { MirStore } from "./store.ts";
import type { Logger } from "./telemetry.ts";

/** How a thread is doing, as a person would say it. */
export type ThreadStatus = "running" | "waiting" | "idle" | "done" | "failed" | "stopped";

/** `seq` orders; `at` is only a timestamp — two entries can share a millisecond. */
export type ThreadEntry =
	| {
			seq: number;
			at: number;
			kind: "text";
			role: "assistant" | "user";
			text: string;
			/** Set when a worker said it, so the work is not read as the conversation. */
			workerId?: string;
	  }
	| { seq: number; at: number; kind: "thinking"; text: string }
	| {
			seq: number;
			at: number;
			kind: "tool_call";
			toolCallId: string;
			toolName: string;
			args?: unknown;
			/** The worker that made the call, when it was a worker's and not the Router's. */
			workerId?: string;
	  }
	| {
			seq: number;
			at: number;
			kind: "tool_result";
			toolCallId: string;
			result?: unknown;
			isError: boolean;
			workerId?: string;
	  }
	| {
			seq: number;
			at: number;
			kind: "hand";
			endpointId: string;
			op: string;
			ok: boolean;
			durationMs?: number;
			workerId?: string;
	  }
	| { seq: number; at: number; kind: "status"; status: ThreadStatus; note?: string }
	/** Its own entry, not a status: a stop is something that happened, and is read where it happened. */
	| { seq: number; at: number; kind: "stop"; note?: string }
	/** Not drawn in the transcript, but a client that opens the chat later reads the same name. */
	| { seq: number; at: number; kind: "title"; title: string }
	/**
	 * A pointer to an MCP App: `server` + `uri` + the data to draw it. The entry carries
	 * an id rather than a snapshot, so a client that reloads asks for the state now.
	 */
	| {
			seq: number;
			at: number;
			kind: "app";
			/** `mir`, or another agent's name. */
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

	/** The store assigns the sequence in the same statement as the row, so two appends cannot collide. */
	append(threadId: string, entry: NewThreadEntry): ThreadEntry {
		// A thread does not say the same thing twice running. Only the same speaker
		// counts: a person echoing the agent is not a repeat.
		if (entry.kind === "text") {
			const said = entry as { role: string; text: string };
			const said_ = this.lastTextEntryOf(threadId, said.role);
			// The words are already there, so that entry is what a caller publishes
			// and nothing new is written.
			if (said_ !== null && said_.text === said.text) return said_;
		}
		// A status entry moves the thread's column as well as the log, so a list and a
		// panel cannot disagree.
		if (entry.kind === "status") this.store.setThreadStatus(threadId, entry.status);
		// A stop is its own kind, with its own word.
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

	/** `match` runs on the parsed entry; the SQL pass only narrows. */
	search(
		threadId: string,
		options: {
			kinds?: readonly string[];
			like?: string;
			limit: number;
			match?: (entry: ThreadEntry) => boolean;
		},
	): { entries: ThreadEntry[]; total: number } {
		const scan = Math.max(options.limit * 4, 200);
		const { rows, total } = this.store.searchThreadEntries(threadId, {
			...(options.kinds === undefined ? {} : { kinds: options.kinds }),
			...(options.like === undefined ? {} : { like: options.like }),
			limit: scan,
		});
		const parsed = rows.flatMap((row) => {
			const entry = parseEntry(row);
			if (entry === null) return [];
			return options.match === undefined || options.match(entry) ? [entry] : [];
		});
		return { entries: parsed.slice(-options.limit), total: options.match === undefined ? total : parsed.length };
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

	/** A Worker's own thread: a name, no chat. Idempotent. */
	ensureThread(threadId: string, name: string, channelId: string): void {
		if (this.store.getThread(threadId) !== undefined) return;
		this.store.upsertThread({ id: threadId, name, channelId, subscriberWorkerIds: [], lastEventAt: Date.now() });
	}

	/** The thread a chat shows, minted on first use. Safe to race: the store decides. */
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
