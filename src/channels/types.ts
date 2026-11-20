/** A place the agent can be reached: events in, `respond_<channel>` out, its own auth. */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/** `anomalous` is the product's own: the host pushes in and takes replies back. */
export type ChannelKind = "terminal" | "http" | "queue" | "anomalous";

/** An inbound message. */
export interface ChannelEvent {
	id: string;
	channelId: string;
	/** The stream this event belongs to. */
	threadId: string;
	/** If known. */
	from?: string;
	/** The words. */
	text: string;
	/** If any. */
	payload?: unknown;
	/** Opaque reply address. */
	replyTo?: string;
	receivedAt: number;
	metadata?: Record<string, string>;
}

	/** Resolved by the Channel from `eventId` or `threadId`. */
export interface ReplyContext {
	eventId?: string;
	threadId?: string;
	replyTo?: string;
}

/** A turn has one reply; a further call is another bubble in a person's chat. */
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

	/** What this place is, in one line. */
	describe(): string;

	/** IM short, GitHub structured, … */
	norms(): string;

	/** Start listening. Call `sink` for every inbound event. */
	start(sink: (event: ChannelEvent) => void): Promise<void>;

	/** Deliver the agent's reply into this channel. */
	respond(text: string, ctx: ReplyContext): Promise<void>;

	/** Build the per-channel response tool the Router calls. */
	responseTool(recorder?: ReplyRecorder, context?: () => ReplyContext): ToolDefinition;

	/** Refuse an event that must not enter the system (bad signature, wrong owner, …). */
	verify?(event: ChannelEvent): { ok: boolean; reason?: string };

	/** True when this channel has authentication configured. */
	authenticated?(): boolean;

	stop(): Promise<void>;
}

	/** Bounded, so the map cannot grow forever. */
const REPLY_BOOK_CAPACITY = 1000;

/** Bounded FIFO, so a long-running daemon cannot leak memory through it. */
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
