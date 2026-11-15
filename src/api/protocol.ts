/**
 * The brain's client API — what a *display* needs, and nothing else.
 *
 * This is the door the product reaches the brain through. It is deliberately
 * narrower than the brain: a client can list threads, open one, say into it,
 * stop it, and look at the hands. It cannot dispatch a task, change a policy,
 * or read the Router's prompt. Those are the brain's own business, and a client
 * that could reach them would be a second brain.
 *
 * Framing is the hands protocol's (`encodeFrame` / `FrameDecoder`): newline
 * delimited JSON, one frame per line, size-capped. Two links already speak it,
 * and a third that spoke something else would be a second thing to debug.
 *
 * The one asymmetry worth naming: **a thread is opened, not polled.** `open`
 * answers with a snapshot and then the connection carries that thread's entries
 * as they happen, until `close`. A client that reconnects sends the last `seq`
 * it saw, so a missed frame costs one frame, not a resync.
 */

import type { HandStatus } from "../hands/protocol.ts";
import type { ThreadEntry, ThreadStatus, ThreadSummary } from "../threadlog.ts";

/** Bump when a frame shape changes incompatibly. A mismatched client is refused. */
export const BRAIN_API_VERSION = 1;

export interface ThreadFilter {
	/** Only threads in this state. */
	status?: ThreadStatus;
	limit?: number;
}

export type ClientToBrain =
	| {
			type: "hello";
			v: number;
			/** Shared bearer token. The brain compares a hash, in constant time. */
			token: string;
			/** Who is connecting, for the log: `anomalous-host`, `thread-panel`, a test. */
			agent: string;
	  }
	| { type: "threads"; id: string; filter?: ThreadFilter }
	| {
			type: "open";
			id: string;
			threadId: string;
			/** The last entry the client has; only what is after it is sent. */
			since?: number;
	  }
	/**
	 * The thread a chat shows, minted on first use, opened like `open`.
	 *
	 * A chat driver does not know a thread id — the chat is what it has. This is
	 * the one request that turns one into the other, and it is idempotent: the
	 * second turn of the same chat gets the same thread.
	 */
	| {
			type: "chat";
			id: string;
			chatId: string;
			/** What the chat is called, when the client knows: the name a person sees. */
			title?: string;
			since?: number;
	  }
	| { type: "close"; id: string; threadId: string }
	| { type: "say"; id: string; threadId: string; content: string }
	| { type: "stop"; id: string; threadId: string }
	| { type: "hands"; id: string };

export type BrainToClient =
	/** The first frame, always: what this brain is and what it can do now. */
	| { type: "ready"; v: number; agent: string; hands: HandStatus[] }
	| { type: "threads"; id: string; threads: ThreadSummary[] }
	| {
			type: "snapshot";
			id: string;
			threadId: string;
			seq: number;
			status: ThreadStatus;
			entries: ThreadEntry[];
	  }
	| { type: "entry"; threadId: string; entry: ThreadEntry }
	| { type: "status"; threadId: string; status: ThreadStatus }
	| { type: "hands"; id: string; hands: HandStatus[] }
	/** One request's answer. `ok: false` carries words a client can show. */
	| { type: "reply"; id: string; ok: true; result?: unknown }
	| { type: "reply"; id: string; ok: false; error: string }
	| { type: "error"; code: "version" | "auth" | "bad-frame" | "internal"; message: string };

/** What the server needs of the brain. Tests fake this; `serve` wires the daemon. */
export interface BrainHost {
	/** Every thread, newest activity first. */
	listThreads(filter?: ThreadFilter): ThreadSummary[];
	/**
	 * The thread a chat shows, minted on first use — holding the chat's name when
	 * the client knows it, so the agent can read what this chat is called.
	 */
	chatThread(chatId: string, title?: string): string;
	/** One thread's entries after `since`, oldest first. */
	entries(threadId: string, since: number): ThreadEntry[];
	/** A thread's status right now. */
	status(threadId: string): ThreadStatus;
	/** A person said something in a thread: the Router hears it. */
	say(threadId: string, content: string): void;
	/** Stop what is running in a thread. */
	stop(threadId: string): void;
	/** The hands this brain can reach. */
	hands(): HandStatus[];
	/**
	 * Called when a client opens or closes a thread, so the brain knows which
	 * threads are being watched. A brain that knows this can keep a Router warm
	 * for a thread a person is looking at and let the rest idle.
	 */
	watch?(threadId: string, watching: boolean): void;
}
