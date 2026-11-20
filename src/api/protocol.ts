/**
 * The brain's client API: what a display needs, and nothing more. A client cannot
 * dispatch a task or change a policy. A thread is opened, not polled.
 *
 * Framing is the hands protocol's — newline-delimited JSON, one frame per line.
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
			/** Compared against a hash, in constant time. */
			token: string;
			/** Who is connecting, for the log. */
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
	/** The thread a chat shows, minted on first use. Idempotent. */
	| {
			type: "chat";
			id: string;
			chatId: string;
			/** What the chat is called, when the client knows: the name a person sees. */
			title?: string;
			since?: number;
	  }
	| { type: "close"; id: string; threadId: string }
	/** A person said something. `hand` only ever narrows what a dispatch may choose. */
	| { type: "say"; id: string; threadId: string; content: string; hand?: string }
	| { type: "stop"; id: string; threadId: string }
	| { type: "hands"; id: string }
	/** A hand the client is about to run. The brain mints its token. */
	| {
			type: "hand_add";
			id: string;
			/** The endpoint id the hand will present. Re-adding an id rotates its token. */
			handId: string;
			name?: string;
			/** Narrower than the hand's own policy, never wider. */
			roots: readonly string[];
			fs?: "none" | "ro" | "rw";
			exec?: boolean;
			shell?: boolean;
			git?: boolean;
	  };

/** What a brain can do, so a client renders only what is there. */
export interface BrainCapabilities {
	/** The rail a client draws. */
	threads: { entries: boolean; names: boolean; rename: boolean; stop: boolean };
	/** How a turn's words arrive. */
	streaming: "deltas" | "message" | "none";
	/** Work started from a conversation. */
	dispatch: { tasks: boolean; cards: boolean };
	/** Execution environments this brain can reach. */
	hands: boolean;
	/** The brain's own memory of a conversation. */
	journal: boolean;
	/** Reading a thread's log on demand. */
	readLog: boolean;
}

/** What this implementation can do, for the `ready` frame. */
export const BRAIN_CAPABILITIES: BrainCapabilities = {
	threads: { entries: true, names: true, rename: true, stop: true },
	streaming: "deltas",
	dispatch: { tasks: true, cards: true },
	hands: true,
	journal: true,
	readLog: true,
};

export type BrainToClient =
	/** The first frame, always: what this brain is and what it can do now. */
	| {
			type: "ready";
			v: number;
			agent: string;
			hands: HandStatus[];
			/**
			 * What this brain can do, so a client renders what exists instead of
			 * assuming. A client that knows only `v` is not wrong, it is older: the
			 * fields are additive and an unknown one is ignored.
			 */
			capabilities: BrainCapabilities;
	  }
	| { type: "threads"; id: string; threads: ThreadSummary[] }
	| {
			type: "snapshot";
			id: string;
			threadId: string;
			seq: number;
			status: ThreadStatus;
			entries: ThreadEntry[];
			/** The work thread of the task that asked for this one, when one did. */
			parentThreadId?: string;
			/** 0 for a chat's work, 1 for a check. Absent means 0. */
			depth?: number;
	  }
	| { type: "entry"; threadId: string; entry: ThreadEntry }
	| { type: "status"; threadId: string; status: ThreadStatus }
	| { type: "hands"; id: string; hands: HandStatus[] }
	/** One request's answer. `ok: false` carries words a client can show. */
	| { type: "reply"; id: string; ok: true; result?: unknown }
	| { type: "reply"; id: string; ok: false; error: string }
	| { type: "error"; code: "version" | "auth" | "bad-frame" | "internal"; message: string };

/** What the server needs of the brain. Tests fake this; `serve` wires the daemon. */
/** What a client asks for when it brings a hand. */
export interface HandRegistration {
	handId: string;
	name?: string;
	roots: readonly string[];
	fs?: "none" | "ro" | "rw";
	exec?: boolean;
	shell?: boolean;
	git?: boolean;
}

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
	/**
	 * Where a thread sits in the tree: the work thread of the task that asked for this
	 * one, and how deep it is. Absent for a chat's own thread and for the cold start.
	 */
	threadFacts(threadId: string): { parentThreadId?: string; depth?: number };
	/** A thread's status right now. */
	status(threadId: string): ThreadStatus;
	/** A person said something. `hand` pins the work to one hand; omitted, the hub picks. */
	say(threadId: string, content: string, hand?: string): void;
	/** Stop what is running in a thread. */
	stop(threadId: string): void;
	/** The hands this brain can reach. */
	hands(): HandStatus[];
	/** Accept a hand a client is about to run; the token it must present comes back. */
	addHand(request: HandRegistration): { handId: string; token: string; hubPort: number };
	/** A client opened or closed a thread. A watched thread can keep its Router warm. */
	watch?(threadId: string, watching: boolean): void;
}
