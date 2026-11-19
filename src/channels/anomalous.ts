/**
 * The Anomalous channel — a chat in the product, as a place the agent is.
 *
 * Every other channel is a transport the daemon owns: a terminal, an HTTP
 * webhook, a queue directory. This one is different in exactly one way: the
 * product owns the socket, so the *host* pushes messages in and receives replies
 * back. The channel is the seam between them, and it holds no transport of its
 * own — `deliver` and the `submit` method are how the host plugs in.
 *
 * **One channel, many chats, and a reply must be addressed.** The Router replies
 * by calling `respond_anomalous`, and a reply that names no chat is resolved the
 * way every channel resolves one: the most recent inbound event. That is right
 * for a single conversation and wrong for a batch that spans two: a Router
 * answering chat B with chat A's last context would post into the wrong
 * conversation, silently. So when more than one chat has been heard from and the
 * reply names none, it is refused with words the model can act on — never
 * guessed. (The same discipline as settle-before-attribution: correctness in
 * scheduling, not in model behaviour.)
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Channel, type ChannelEvent, type ReplyContext, type ReplyRecorder, ReplyBook } from "./types.ts";
import { makeResponseTool } from "./tool.ts";

/**
 * Where a reply goes: the thread it was asked about, or the chat that shows it.
 *
 * A thread is the real target — a chat is a window onto one — so a reply that
 * knows its thread is delivered to that thread, and the brain maps it to a chat
 * when there is one. A reply that knows only a chat (the model named `reply_to`)
 * is delivered to the chat, which the brain maps to its thread.
 */
export interface ReplyTarget {
	readonly threadId?: string;
	readonly chatId?: string;
}

export type ChatDelivery = (target: ReplyTarget, text: string) => Promise<void> | void;

export interface AnomalousChannelOptions {
	/** Deliver a reply into a chat. The host writes the transcript row and the socket frame. */
	deliver: ChatDelivery;
	/** How many recent chats an unaddressed reply is checked against. */
	recentChats?: number;
}

/** How many chats back an unaddressed reply may resolve to. */
const DEFAULT_RECENT_CHATS = 8;

export class AnomalousChannel implements Channel {
	readonly id = "anomalous";
	readonly kind = "anomalous" as const;
	private readonly book = new ReplyBook();
	private readonly tools = new WeakMap<ReplyRecorder, ToolDefinition>();
	private defaultTool: ToolDefinition | null = null;
	private readonly recent: string[] = [];
	private sink: ((event: ChannelEvent) => void) | null = null;
	private readonly options: AnomalousChannelOptions;

	constructor(options: AnomalousChannelOptions) {
		this.options = options;
	}

	describe(): string {
		return "a chat in Anomalous, where a member talks to their assistant";
	}

	norms(): string {
		return "Short and conversational, in markdown. Never restate the question. One reply per turn unless the member asked for a list.";
	}

	authenticated(): boolean {
		// The host that pushes events in is already the member's; there is no
		// second transport here to authenticate.
		return true;
	}

	async start(sink: (event: ChannelEvent) => void): Promise<void> {
		this.sink = sink;
	}

	async stop(): Promise<void> {
		this.sink = null;
	}

	/**
	 * A member's message, from the host.
	 *
	 * The chat id is the reply address; the thread id is the chat's thread, which
	 * the host has already resolved (or left out, letting the Router cold-start
	 * one). Returns the event it admitted so a caller can correlate.
	 */
	submit(input: {
		chatId: string;
		text: string;
		eventId: string;
		threadId?: string;
		from?: string;
		/** Where the client said this work belongs, carried to the dispatch. */
		hand?: string;
	}): ChannelEvent {
		if (this.sink === null) throw new Error("anomalous channel: not started");
		const event: ChannelEvent = {
			id: input.eventId,
			channelId: this.id,
			threadId: input.threadId ?? input.chatId,
			text: input.text,
			replyTo: input.chatId,
			receivedAt: Date.now(),
			...(input.from === undefined ? {} : { from: input.from }),
			...(input.hand === undefined ? {} : { metadata: { hand: input.hand } }),
		};
		this.book.remember(event);
		this.rememberChat(input.chatId);
		this.sink(event);
		return event;
	}

	async respond(text: string, ctx: ReplyContext): Promise<void> {
		await this.options.deliver(this.resolveTarget(ctx), text);
	}

	/**
	 * Say something in a thread, with no resolution.
	 *
	 * `respond` exists for a model that knows a chat and must be resolved to a thread;
	 * this exists for a caller that already has the thread — a conclusion, a fallback
	 * reply, anything the Router decides rather than the model. Resolving again is how
	 * a conclusion came to be refused for "no chat to answer" when the thread it was
	 * answering was right there.
	 */
	async deliverTo(threadId: string, text: string): Promise<void> {
		await this.options.deliver({ threadId }, text);
	}

	responseTool(recorder?: ReplyRecorder, context?: () => ReplyContext): ToolDefinition {
		if (recorder === undefined) return (this.defaultTool ??= makeResponseTool(this, recorder, context));
		let tool = this.tools.get(recorder);
		if (tool === undefined) {
			tool = makeResponseTool(this, recorder);
			this.tools.set(recorder, tool);
		}
		return tool;
	}

	/**
	 * Where a reply is for.
	 *
	 * The thread it was asked about wins, because a thread is the conversation and
	 * a chat is a window onto one — and it is the address the Router already has
	 * from the event, without the model naming anything. Then an explicit
	 * `reply_to` (a chat), then the only chat heard from.
	 *
	 * When several chats are in play and the reply names none, the ambiguity is
	 * refused: a reply posted into the wrong conversation is worse than a turn
	 * that has to be retried.
	 */
	private resolveTarget(ctx: ReplyContext): ReplyTarget {
		if (ctx.threadId !== undefined && ctx.threadId !== "") return { threadId: ctx.threadId };
		if (ctx.replyTo !== undefined && ctx.replyTo !== "") return { chatId: ctx.replyTo };
		const distinct = [...new Set(this.recent)];
		if (distinct.length === 0) {
			throw new Error(
				"respond_anomalous has no chat to answer: this turn heard from no chat. Pass reply_to with the chat id from the inbound item.",
			);
		}
		if (distinct.length > 1) {
			throw new Error(
				`respond_anomalous needs reply_to: this turn heard from ${String(distinct.length)} chats (${distinct.join(", ")}). ` +
					"Name the one you are answering — an unaddressed reply would go into the wrong conversation.",
			);
		}
		return { chatId: distinct[0]! };
	}

	/** The last few chats heard from, oldest first, deduped at read time. */
	private rememberChat(chatId: string): void {
		const limit = this.options.recentChats ?? DEFAULT_RECENT_CHATS;
		const index = this.recent.indexOf(chatId);
		if (index !== -1) this.recent.splice(index, 1);
		this.recent.push(chatId);
		while (this.recent.length > limit) this.recent.shift();
	}
}
