/**
 * File/queue channel.
 *
 * Inbound:  drops a JSON file into  <dir>/inbox/*.json
 *           { text, thread?, from?, reply_to? }
 *           The file name is used as the event id. Processed files move to
 *           <dir>/processed/.
 * Outbound: `respond_queue` writes <dir>/outbox/<eventId>.json
 *           { text, thread, event_id, at }.
 *
 * This is the durable, offline-friendly source: anything that can write a file
 * (a cron job, a shell script, another machine) can talk to the agent, and every
 * reply is a file that survives a restart.
 */

import fs from "node:fs";
import path from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Channel, type ChannelEvent, type ReplyContext, ReplyBook } from "./types.ts";
import { makeResponseTool } from "./tool.ts";

export interface QueueChannelOptions {
	dir: string;
}

export class QueueChannel implements Channel {
	readonly id = "queue";
	readonly kind = "queue" as const;
	private readonly book = new ReplyBook();
	private readonly dir: string;
	private readonly inbox: string;
	private readonly outbox: string;
	private readonly processed: string;
	private watcher: fs.FSWatcher | null = null;
	private tool: ToolDefinition | null = null;

	constructor(options: QueueChannelOptions) {
		this.dir = options.dir;
		this.inbox = path.join(this.dir, "inbox");
		this.outbox = path.join(this.dir, "outbox");
		this.processed = path.join(this.dir, "processed");
	}

	describe(): string {
		return `a durable file queue — drop JSON events in ${this.inbox}, read replies from ${this.outbox}`;
	}
	norms(): string {
		return "Structured and information-dense, suitable for an async/offline reader. State the outcome and the next step plainly.";
	}

	async start(sink: (event: ChannelEvent) => void): Promise<void> {
		for (const d of [this.inbox, this.outbox, this.processed]) {
			fs.mkdirSync(d, { recursive: true });
		}
		const consume = (file: string) => this.consume(file, sink);
		this.watcher = fs.watch(this.inbox, (_evt, filename) => {
			if (filename && filename.endsWith(".json")) consume(String(filename));
		});
		// Drain anything already waiting on boot.
		for (const f of fs.readdirSync(this.inbox)) {
			if (f.endsWith(".json")) consume(f);
		}
	}

	private consume(filename: string, sink: (event: ChannelEvent) => void): void {
		const full = path.join(this.inbox, filename);
		let raw: string;
		try {
			raw = fs.readFileSync(full, "utf8");
		} catch {
			return; // already moved by a concurrent drain
		}
		let parsed: any = {};
		try {
			parsed = JSON.parse(raw);
		} catch {
			// Malformed: park it so it does not loop.
			fs.renameSync(full, path.join(this.processed, filename));
			return;
		}
		const text = typeof parsed.text === "string" ? parsed.text : String(parsed.payload ?? "");
		if (!text) {
			fs.renameSync(full, path.join(this.processed, filename));
			return;
		}
		const event: ChannelEvent = {
			id: `evt-${path.basename(filename, ".json")}`,
			channelId: this.id,
			threadId: String(parsed.thread ?? parsed.threadId ?? path.basename(filename, ".json")),
			from: parsed.from,
			text,
			payload: parsed.payload,
			replyTo: filename,
			receivedAt: Date.now(),
			metadata: { explicit_request: String(parsed.explicit_request ?? true) },
		};
		this.book.remember(event);
		fs.renameSync(full, path.join(this.processed, filename));
		sink(event);
	}

	async respond(text: string, ctx: ReplyContext): Promise<void> {
		const resolved = this.book.resolve(ctx) ?? ctx;
		const name = `${resolved.eventId ?? `out-${Date.now()}`}.json`;
		const payload = {
			text,
			thread: resolved.threadId,
			event_id: resolved.eventId,
			at: Date.now(),
		};
		fs.writeFileSync(path.join(this.outbox, name), JSON.stringify(payload, null, 2));
		console.log(`[queue] reply → ${name}: ${text.slice(0, 120)}`);
	}

	responseTool(): ToolDefinition {
		if (!this.tool) this.tool = makeResponseTool(this);
		return this.tool;
	}

	async stop(): Promise<void> {
		this.watcher?.close();
		this.watcher = null;
	}
}
