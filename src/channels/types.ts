/**
 * Channel abstraction (Section 4.2 Multi-Channel).
 *
 * A Channel is a *place the agent can be communicated with*. It owns both
 * directions:
 *   - inbound: it emits Events (which may become Triggers)
 *   - outbound: it exposes its own response tool (`respond_<channel>`), and the
 *     Router replies by calling that tool — never by writing raw text.
 *
 * Channels also own their own **authentication**: an inbound Event is only
 * admitted after the transport has verified it (`verify`), because the event
 * stream is what drives the agent.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * What kind of place a channel is. `anomalous` is the product's own: its socket
 * is the host's, so the host pushes messages in and takes replies back (see
 * channels/anomalous.ts).
 */
export type ChannelKind = "terminal" | "http" | "queue" | "anomalous";

/** A single inbound message on a Channel. */
export interface ChannelEvent {
	id: string;
	channelId: string;
	/** Stream this event belongs to (PR, IM topic, email chain, terminal). */
	threadId: string;
	/** Sender identity, if known. */
	from?: string;
	/** Human-readable payload. */
	text: string;
	/** Raw structured payload, if any. */
	payload?: unknown;
	/** Opaque reply address (callback URL, outbox name, …). */
	replyTo?: string;
	receivedAt: number;
	metadata?: Record<string, string>;
}

/** Where a reply should go. Resolved by the Channel from `eventId` or `threadId`. */
export interface ReplyContext {
	eventId?: string;
	threadId?: string;
	replyTo?: string;
}

/**
 * Receives every reply a turn actually delivered.
 *
 * The Router uses this instead of a process-wide counter: attribution must be
 * exact per turn, otherwise the "did the model answer?" fallback fires on
 * stale state and double-posts.
 */
/**
 * Where a turn's replies are counted — and refused.
 *
 * A turn has one reply. A model that keeps calling the response tool is a model
 * talking to itself: it has already said the thing, and each further call is another
 * bubble in a person's chat. The recorder is the only place every delivery passes
 * through, so it is where the rule is kept.
 */
export interface ReplyRecorder {
	/** Undefined when it was delivered; a reason when it was refused. */
	record(channelId: string, text: string, ctx: ReplyContext): { ok: true } | { ok: false; reason: string };
}

/** A no-op recorder for callers that do not track deliveries. */
export const NOOP_RECORDER: ReplyRecorder = { record: () => ({ ok: true }) };

export interface Channel {
	/** Stable id used in prompts and tool names: `respond_<id>`. */
	readonly id: string;
	readonly kind: ChannelKind;

	/** One-line description shown to the Router (what this place is). */
	describe(): string;

	/** Reply norms for this channel (IM short, GitHub structured, …). */
	norms(): string;

	/** Start listening. Call `sink` for every inbound event. */
	start(sink: (event: ChannelEvent) => void): Promise<void>;

	/** Deliver the agent's reply into this channel. */
	respond(text: string, ctx: ReplyContext): Promise<void>;

	/** Build the per-channel response tool the Router calls. */
	responseTool(recorder?: ReplyRecorder): ToolDefinition;

	/**
	 * Optional transport-level admission check. Returns `{ok:false}` for events
	 * that must not enter the system (bad signature, wrong owner, …).
	 */
	verify?(event: ChannelEvent): { ok: boolean; reason?: string };

	/** True when this channel has authentication configured. */
	authenticated?(): boolean;

	stop(): Promise<void>;
}

/** Max remembered reply contexts per channel (prevents an unbounded map). */
const REPLY_BOOK_CAPACITY = 1000;

/**
 * Shared event-id + reply-context bookkeeping for channels.
 * Bounded FIFO so a long-running daemon cannot leak memory through it.
 */
export class ReplyBook {
	private readonly byEvent = new Map<string, ReplyContext>();
	private readonly byThread = new Map<string, ReplyContext>();
	private last: ReplyContext | undefined;

	remember(event: ChannelEvent): void {
		const ctx: ReplyContext = {
			eventId: event.id,
			threadId: event.threadId,
			replyTo: event.replyTo,
		};
		this.byEvent.set(event.id, ctx);
		this.byThread.set(event.threadId, ctx);
		this.last = ctx;
		if (this.byEvent.size > REPLY_BOOK_CAPACITY) {
			const oldest = this.byEvent.keys().next().value;
			if (oldest !== undefined) this.byEvent.delete(oldest);
		}
	}

	resolve(ctx: ReplyContext): ReplyContext | undefined {
		if (ctx.eventId && this.byEvent.has(ctx.eventId)) {
			return this.byEvent.get(ctx.eventId);
		}
		if (ctx.threadId && this.byThread.has(ctx.threadId)) {
			return this.byThread.get(ctx.threadId);
		}
		return this.last;
	}

	get size(): number {
		return this.byEvent.size;
	}
}
