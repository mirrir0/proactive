/**
 * A chat in the product, as a place the agent is. Unlike the other channels this one
 * owns no transport: the host pushes messages in and takes replies back.
 *
 * A reply must be addressed. When more than one chat has been heard from and the reply
 * names none, it is refused with words the model can act on — never guessed.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Channel, type ChannelEvent, type ReplyContext, type ReplyRecorder, ReplyBook } from "./types.ts";
import { makeResponseTool } from "./tool.ts";

/**
 * A thread is the real target — a chat is a window onto one. A reply that knows only a
 * chat is delivered to the chat, and the brain maps it to the thread.
 */
export interface ReplyTarget {
	readonly threadId?: string;
	readonly chatId?: string;
}

export type ChatDelivery = (target: ReplyTarget, text: string) => Promise<void> | void;

export interface AnomalousChannelOptions {
	/** The host writes the transcript row and the socket frame. */
	deliver: ChatDelivery;
	/** How many are remembered. */
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

	/** A member's message from the host: the chat id is the reply address. */
	submit(input: {
		chatId: string;
		text: string;
		eventId: string;
		threadId?: string;
		from?: string;
	/** Carried to the dispatch. */
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

	/** For a caller that already has the thread: resolving again is how a reply lands elsewhere. */
	async deliverTo(threadId: string, text: string): Promise<void> {
		await this.options.deliver({ threadId }, text);
	}

	responseTool(recorder?: ReplyRecorder, context?: () => ReplyContext): ToolDefinition {
		// `context` is a reader of the turn, not a value: one tool per recorder is right,
		// but the path that creates it must be given one — a tool built without it answers
		// into the last chat this channel heard from.
		if (recorder === undefined) return (this.defaultTool ??= makeResponseTool(this, recorder, context));
		let tool = this.tools.get(recorder);
		if (tool === undefined) {
			tool = makeResponseTool(this, recorder, context);
			this.tools.set(recorder, tool);
		}
		return tool;
	}

/**
 * The thread it was asked about wins; a chat is the fallback. Unaddressed and more than
 * one chat heard from is refused rather than guessed.
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

	/** Oldest first, deduped at read time. */
	private rememberChat(chatId: string): void {
		const limit = this.options.recentChats ?? DEFAULT_RECENT_CHATS;
		const index = this.recent.indexOf(chatId);
		if (index !== -1) this.recent.splice(index, 1);
		this.recent.push(chatId);
		while (this.recent.length > limit) this.recent.shift();
	}
}
