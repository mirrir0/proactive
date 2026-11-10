/**
 * Channel abstraction (Section 4.2 Multi-Channel).
 *
 * A Channel is a *place the agent can be communicated with*. It owns both
 * directions:
 *   - inbound: it emits Events (which may become Triggers)
 *   - outbound: it exposes its own response tool (`respond_<channel>`), and the
 *     Router replies by calling that tool — never by writing raw text.
 *
 * This is what replaces the old `source: im|github|...` enum and the
 * stdout-scraping text filter.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export type ChannelKind = "terminal" | "http" | "queue";

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
	responseTool(): ToolDefinition;

	stop(): Promise<void>;
}

/** Shared event-id + reply-context bookkeeping for channels. */
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
}
