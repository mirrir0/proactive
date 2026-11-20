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
 * Authentication: set `MIR_HTTP_TOKEN` (shared bearer token) and/or
 * `MIR_HTTP_HMAC_SECRET` (HMAC-SHA256 over `<timestamp>.<body>`, replay window
 * 5 minutes). Requests that fail either check are rejected before their body
 * is even parsed, so a spoofed event never reaches the agent.
 */

import http from "node:http";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	type Channel,
	type ChannelEvent,
	type ReplyContext,
	type ReplyRecorder,
	ReplyBook,
} from "./types.ts";
import { makeResponseTool } from "./tool.ts";
import { redactSecrets, verifyChannelRequest, type ChannelAuthOptions } from "../security.ts";
import { log } from "../telemetry.ts";

export interface HttpChannelOptions {
	host: string;
	port: number;
	/** Shared token accepted in `x-mir-token`. */
	token?: string;
	/** HMAC secret for `x-mir-signature`. */
	hmacSecret?: string;
	maxBodyBytes?: number;
}

interface OutboxEntry {
	id: string;
	threadId: string;
	text: string;
	at: number;
}

const DEFAULT_MAX_BODY_BYTES = 256 * 1024;

export class HttpChannel implements Channel {
	readonly id = "http";
	readonly kind = "http" as const;
	private readonly book = new ReplyBook();
	private readonly outbox: OutboxEntry[] = [];
	private readonly options: HttpChannelOptions;
	private readonly tools = new WeakMap<ReplyRecorder, ToolDefinition>();
	private defaultTool: ToolDefinition | null = null;
	private server: http.Server | null = null;
	private sink: ((e: ChannelEvent) => void) | null = null;

	constructor(options: HttpChannelOptions) {
		this.options = options;
	}

	private authOptions(): ChannelAuthOptions {
		return { token: this.options.token, hmacSecret: this.options.hmacSecret };
	}

	describe(): string {
		return `an HTTP webhook (POST http://${this.options.host}:${this.options.port}/channels/http/events) that external systems use to reach the agent`;
	}
	norms(): string {
		return "Structured and information-dense, like an API/markdown reply. Include what changed, the result, and any next step. No filler.";
	}

	authenticated(): boolean {
		return Boolean(this.options.token || this.options.hmacSecret);
	}

	/** Bound port (useful when constructed with port 0, e.g. in tests). */
	get port(): number {
		const address = this.server?.address();
		return typeof address === "object" && address ? address.port : this.options.port;
	}

	async start(sink: (event: ChannelEvent) => void): Promise<void> {
		this.sink = sink;
		this.server = http.createServer((req, res) => this.handle(req, res));
		await new Promise<void>((resolve, reject) => {
			this.server!.once("error", reject);
			this.server!.listen(this.options.port, this.options.host, () => resolve());
		});
		if (!this.authenticated()) {
			log.warn("http channel is unauthenticated", {
				channel: "http",
				host: this.options.host,
				port: this.options.port,
				hint: "set MIR_HTTP_TOKEN and/or MIR_HTTP_HMAC_SECRET",
			});
		}
	}

	private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
		const url = req.url ?? "/";
		if (req.method === "GET" && url.startsWith("/channels/http/outbox")) {
			if (!this.authorize(req, res, "")) return;
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ replies: this.outbox }));
			return;
		}
		if (req.method === "POST" && url.startsWith("/channels/http/events")) {
			const maxBytes = this.options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
			let body = "";
			let tooLarge = false;
			req.on("data", (chunk: Buffer) => {
				if (tooLarge) return;
				body += chunk.toString("utf8");
				if (body.length > maxBytes) {
					tooLarge = true;
					res.writeHead(413, { "content-type": "application/json" });
					res.end(JSON.stringify({ error: "payload too large" }));
					req.destroy();
				}
			});
			req.on("end", () => {
				if (tooLarge) return;
				// Authenticate before parsing: an unauthenticated body is never trusted.
				if (!this.authorize(req, res, body)) return;
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
				const threadId = String(
					parsed.thread ?? parsed.threadId ?? `http-${crypto.randomUUID().slice(0, 8)}`,
				);
				const event: ChannelEvent = {
					id: String(parsed.id ?? `evt-${crypto.randomUUID().slice(0, 8)}`),
					channelId: this.id,
					threadId,
					from: parsed.from,
					text,
					payload: parsed.payload,
					replyTo: parsed.reply_to ?? parsed.replyTo ?? parsed.callback_url,
					receivedAt: Date.now(),
					metadata: {
						explicit_request: String(parsed.explicit_request ?? true),
						...(parsed.metadata && typeof parsed.metadata === "object" ? parsed.metadata : {}),
					},
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

	private authorize(req: http.IncomingMessage, res: http.ServerResponse, rawBody: string): boolean {
		const result = verifyChannelRequest(this.authOptions(), req.headers, rawBody);
		if (result.ok) return true;
		log.warn("rejected unauthenticated channel request", {
			channel: "http",
			reason: result.reason,
			remote: req.socket.remoteAddress,
		});
		res.writeHead(401, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: "unauthorized", reason: result.reason }));
		return false;
	}

	async respond(text: string, ctx: ReplyContext): Promise<void> {
		const resolved = this.book.resolve(ctx) ?? ctx;
		const safeText = redactSecrets(text);
		const entry: OutboxEntry = {
			id: `out-${crypto.randomUUID().slice(0, 8)}`,
			threadId: resolved.threadId ?? "http",
			text: safeText,
			at: Date.now(),
		};
		this.outbox.push(entry);
		if (this.outbox.length > 100) this.outbox.shift();

		if (resolved.replyTo && /^https?:\/\//.test(resolved.replyTo)) {
			try {
				await fetch(resolved.replyTo, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ text: safeText, thread: entry.threadId, event_id: resolved.eventId }),
					signal: AbortSignal.timeout(10_000),
				});
			} catch (err) {
				// Non-fatal: the reply is still in the outbox for polling.
				log.warn("http reply callback failed", { channel: "http", error: (err as Error).message });
			}
		}
		log.info("http reply", { channel: "http", thread: entry.threadId, chars: safeText.length });
	}

	responseTool(recorder?: ReplyRecorder, context?: () => ReplyContext): ToolDefinition {
		if (!recorder) return (this.defaultTool ??= makeResponseTool(this, recorder, context));
		let tool = this.tools.get(recorder);
		if (!tool) {
			tool = makeResponseTool(this, recorder, context);
			this.tools.set(recorder, tool);
		}
		return tool;
	}

	async stop(): Promise<void> {
		await new Promise<void>((resolve) => {
			if (!this.server) return resolve();
			this.server.close(() => resolve());
			this.server = null;
		});
	}
}
