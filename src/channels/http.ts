/**
 * HTTP webhook channel.
 *
 * Inbound:  POST /channels/http/events  { text, thread?, from?, reply_to? }
 *           → 202 Accepted, becomes an Event on thread `thread` (default: the
 *           sender-provided id or a fresh thread).
 * Outbound: `respond_http` POSTs { text, thread } back to the event's
 *           `reply_to` URL when one was supplied; otherwise stores the reply in
 *           an in-memory outbox readable at GET /channels/http/outbox.
 *
 * This lets any external system (CI, curl, a GitHub relay, another agent) drive
 * Triggers and receive the agent's reply.
 */

import http from "node:http";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Channel, type ChannelEvent, type ReplyContext, ReplyBook } from "./types.ts";
import { makeResponseTool } from "./tool.ts";

export interface HttpChannelOptions {
	host: string;
	port: number;
}

interface OutboxEntry {
	id: string;
	threadId: string;
	text: string;
	at: number;
}

export class HttpChannel implements Channel {
	readonly id = "http";
	readonly kind = "http" as const;
	private readonly book = new ReplyBook();
	private readonly outbox: OutboxEntry[] = [];
	private readonly options: HttpChannelOptions;
	private server: http.Server | null = null;
	private tool: ToolDefinition | null = null;
	private sink: ((e: ChannelEvent) => void) | null = null;

	constructor(options: HttpChannelOptions) {
		this.options = options;
	}

	describe(): string {
		return `an HTTP webhook (POST http://${this.options.host}:${this.options.port}/channels/http/events) that external systems use to reach the agent`;
	}
	norms(): string {
		return "Structured and information-dense, like an API/markdown reply. Include what changed, the result, and any next step. No filler.";
	}

	async start(sink: (event: ChannelEvent) => void): Promise<void> {
		this.sink = sink;
		this.server = http.createServer((req, res) => this.handle(req, res));
		await new Promise<void>((resolve, reject) => {
			this.server!.once("error", reject);
			this.server!.listen(this.options.port, this.options.host, () => resolve());
		});
	}

	private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
		const url = req.url ?? "/";
		if (req.method === "GET" && url.startsWith("/channels/http/outbox")) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ replies: this.outbox }));
			return;
		}
		if (req.method === "POST" && url.startsWith("/channels/http/events")) {
			let body = "";
			req.on("data", (c) => (body += c));
			req.on("end", () => {
				let parsed: any = {};
				try {
					parsed = body ? JSON.parse(body) : {};
				} catch {
					res.writeHead(400, { "content-type": "application/json" });
					res.end(JSON.stringify({ error: "invalid JSON" }));
					return;
				}
				const text = typeof parsed.text === "string" ? parsed.text : String(parsed.payload ?? "");
				if (!text) {
					res.writeHead(422, { "content-type": "application/json" });
					res.end(JSON.stringify({ error: "missing text" }));
					return;
				}
				const threadId = String(parsed.thread ?? parsed.threadId ?? `http-${crypto.randomUUID().slice(0, 8)}`);
				const event: ChannelEvent = {
					id: `evt-${crypto.randomUUID().slice(0, 8)}`,
					channelId: this.id,
					threadId,
					from: parsed.from,
					text,
					payload: parsed.payload,
					replyTo: parsed.reply_to ?? parsed.replyTo ?? parsed.callback_url,
					receivedAt: Date.now(),
					metadata: { explicit_request: String(parsed.explicit_request ?? true) },
				};
				this.book.remember(event);
				this.sink?.(event);
				res.writeHead(202, { "content-type": "application/json" });
				res.end(JSON.stringify({ accepted: true, event_id: event.id, thread: threadId }));
			});
			return;
		}
		res.writeHead(404, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: "not found" }));
	}

	async respond(text: string, ctx: ReplyContext): Promise<void> {
		const resolved = this.book.resolve(ctx) ?? ctx;
		const entry: OutboxEntry = {
			id: `out-${crypto.randomUUID().slice(0, 8)}`,
			threadId: resolved.threadId ?? "http",
			text,
			at: Date.now(),
		};
		this.outbox.push(entry);
		if (this.outbox.length > 100) this.outbox.shift();

		if (resolved.replyTo && /^https?:\/\//.test(resolved.replyTo)) {
			try {
				await fetch(resolved.replyTo, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ text, thread: entry.threadId, event_id: resolved.eventId }),
				});
			} catch {
				// Non-fatal: the reply is still in the outbox for polling.
			}
		}
		console.log(`[http] reply → thread=${entry.threadId}: ${text.slice(0, 120)}`);
	}

	responseTool(): ToolDefinition {
		if (!this.tool) this.tool = makeResponseTool(this);
		return this.tool;
	}

	async stop(): Promise<void> {
		await new Promise<void>((resolve) => {
			if (!this.server) return resolve();
			this.server.close(() => resolve());
			this.server = null;
		});
	}
}
