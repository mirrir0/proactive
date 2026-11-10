/**
 * Terminal channel — the daemon's own stdin/stdout.
 *
 * Inbound: lines typed on stdin become Events on the "terminal-main" thread.
 * Outbound: `respond_terminal` prints `mir: <text>` to stdout. When the daemon
 * runs under pm2 there is no TTY, so this channel is mainly used when running
 * the daemon in the foreground (`pnpm run dev`); piped stdin also works.
 */

import readline from "node:readline";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Channel, type ChannelEvent, type ReplyContext, ReplyBook } from "./types.ts";
import { makeResponseTool } from "./tool.ts";

export class TerminalChannel implements Channel {
	readonly id = "terminal";
	readonly kind = "terminal" as const;
	private readonly book = new ReplyBook();
	private rl: readline.Interface | null = null;
	private tool: ToolDefinition | null = null;

	describe(): string {
		return "the interactive terminal — the human is typing on stdin and reading stdout";
	}
	norms(): string {
		return "Plain text, no internal reasoning or meta-tags. Short and direct. This is a developer terminal, so code and detail are welcome, but never narrate tool calls.";
	}

	async start(sink: (event: ChannelEvent) => void): Promise<void> {
		this.rl = readline.createInterface({ input: process.stdin, output: process.stdout });
		process.stdout.write("\n> ");
		this.rl.on("line", (line: string) => {
			const text = line.trim();
			if (!text) {
				process.stdout.write("> ");
				return;
			}
			const event: ChannelEvent = {
				id: `evt-${crypto.randomUUID().slice(0, 8)}`,
				channelId: this.id,
				threadId: "terminal-main",
				from: "human",
				text,
				receivedAt: Date.now(),
				metadata: { explicit_request: "true" },
			};
			this.book.remember(event);
			sink(event);
		});
		this.rl.on("close", () => {
			// stdin ended; keep the daemon alive under pm2.
		});
	}

	async respond(text: string, _ctx: ReplyContext): Promise<void> {
		process.stdout.write(`\nmir: ${text}\n> `);
	}

	responseTool(): ToolDefinition {
		if (!this.tool) this.tool = makeResponseTool(this);
		return this.tool;
	}

	async stop(): Promise<void> {
		this.rl?.close();
		this.rl = null;
	}
}
