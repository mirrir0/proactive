/**
 * File/queue channel.
 *
 * Inbound:  drops a JSON file into  <dir>/inbox/*.json
 *           { id?, text, thread?, from?, reply_to? }
 *           The file name is used as the event id. Processed files move to
 *           <dir>/processed/.
 * Outbound: `respond_queue` writes <dir>/outbox/<eventId>.json
 *           { text, thread, event_id, at }.
 *
 * This is the durable, offline-friendly source: anything that can write a file
 * (a cron job, a shell script, another machine) can talk to the agent, and every
 * reply is a file that survives a restart.
 *
 * Two production details that fs.watch alone does not give you:
 *   - a **polling fallback** (`pollMs`), because inotify misses events on NFS,
 *     some Docker mounts and macOS network volumes;
 *   - an **ownership check**: on POSIX only files owned by the daemon's uid are
 *     admitted, so another local user cannot inject events into a shared dir.
 */

import fs from "node:fs";
import path from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	type Channel,
	type ChannelEvent,
	type ReplyContext,
	type ReplyRecorder,
	ReplyBook,
} from "./types.ts";
import { makeResponseTool } from "./tool.ts";
import { redactSecrets } from "../security.ts";
import { log } from "../telemetry.ts";

export interface QueueChannelOptions {
	dir: string;
	/** Polling fallback interval in ms (0 disables). Default 2000. */
	pollMs?: number;
	/** Reject files not owned by this process's uid (POSIX only). Default true. */
	requireOwnership?: boolean;
}

export class QueueChannel implements Channel {
	readonly id = "queue";
	readonly kind = "queue" as const;
	private readonly book = new ReplyBook();
	private readonly tools = new WeakMap<ReplyRecorder, ToolDefinition>();
	private defaultTool: ToolDefinition | null = null;
	private readonly dir: string;
	private readonly inbox: string;
	private readonly outbox: string;
	private readonly processed: string;
	private readonly pollMs: number;
	private readonly requireOwnership: boolean;
	private watcher: fs.FSWatcher | null = null;
	private pollTimer: NodeJS.Timeout | null = null;
	private sink: ((e: ChannelEvent) => void) | null = null;

	constructor(options: QueueChannelOptions) {
		this.dir = options.dir;
		this.inbox = path.join(this.dir, "inbox");
		this.outbox = path.join(this.dir, "outbox");
		this.processed = path.join(this.dir, "processed");
		this.pollMs = options.pollMs ?? 2000;
		this.requireOwnership = options.requireOwnership ?? true;
	}

	describe(): string {
		return `a durable file queue — drop JSON events in ${this.inbox}, read replies from ${this.outbox}`;
	}
	norms(): string {
		return "Structured and information-dense, suitable for an async/offline reader. State the outcome and the next step plainly.";
	}

	authenticated(): boolean {
		return this.requireOwnership;
	}

	async start(sink: (event: ChannelEvent) => void): Promise<void> {
		this.sink = sink;
		for (const d of [this.inbox, this.outbox, this.processed]) {
			fs.mkdirSync(d, { recursive: true });
		}
		const consume = (file: string) => this.consume(file);
		try {
			this.watcher = fs.watch(this.inbox, (_evt, filename) => {
				if (filename && filename.endsWith(".json")) consume(String(filename));
			});
		} catch (err) {
			log.warn("queue channel watch failed; relying on polling", {
				channel: "queue",
				error: (err as Error).message,
			});
		}
		if (this.pollMs > 0) {
			this.pollTimer = setInterval(() => this.drainInbox(), this.pollMs);
			this.pollTimer.unref();
		}
		// Drain anything already waiting on boot.
		this.drainInbox();
	}

	private drainInbox(): void {
		let files: string[];
		try {
			files = fs.readdirSync(this.inbox);
		} catch {
			return;
		}
		for (const f of files) {
			if (f.endsWith(".json")) this.consume(f);
		}
	}

	private consume(filename: string): void {
		const full = path.join(this.inbox, filename);
		let raw: string;
		try {
			raw = fs.readFileSync(full, "utf8");
		} catch {
			return; // already moved by a concurrent drain
		}
		if (this.requireOwnership && process.getuid) {
			try {
				const stat = fs.statSync(full);
				if (stat.uid !== process.getuid()) {
					log.warn("rejected queue event from another uid", {
						channel: "queue",
						file: filename,
						uid: stat.uid,
					});
					fs.renameSync(full, path.join(this.processed, filename));
					return;
				}
			} catch {
				return;
			}
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
		const base = path.basename(filename, ".json");
		const event: ChannelEvent = {
			id: `evt-${parsed.id ?? base}`,
			channelId: this.id,
			threadId: String(parsed.thread ?? parsed.threadId ?? base),
			from: parsed.from,
			text,
			payload: parsed.payload,
			replyTo: filename,
			receivedAt: Date.now(),
			metadata: { explicit_request: String(parsed.explicit_request ?? true) },
		};
		this.book.remember(event);
		fs.renameSync(full, path.join(this.processed, filename));
		this.sink?.(event);
	}

	async respond(text: string, ctx: ReplyContext): Promise<void> {
		const resolved = this.book.resolve(ctx) ?? ctx;
		const name = `${resolved.eventId ?? `out-${Date.now()}`}.json`;
		const safeText = redactSecrets(text);
		const payload = {
			text: safeText,
			thread: resolved.threadId,
			event_id: resolved.eventId,
			at: Date.now(),
		};
		// Write to a temp file then rename, so a reader never sees a partial reply.
		const tmp = path.join(this.outbox, `.${name}.tmp`);
		fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
		fs.renameSync(tmp, path.join(this.outbox, name));
		log.info("queue reply", { channel: "queue", file: name, chars: safeText.length });
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
		this.watcher?.close();
		this.watcher = null;
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
	}
}
