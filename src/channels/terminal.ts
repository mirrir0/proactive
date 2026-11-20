/**
 * The daemon's own stdin and stdout. stdin is attached only for a real TTY: under pm2 it is
 * usually a shared pipe, and consuming it would steal input from whatever else owns it.
 */

import readline from "node:readline";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Channel, type ChannelEvent, type ReplyContext, type ReplyRecorder, ReplyBook } from "./types.ts";
import { makeResponseTool } from "./tool.ts";
import { redactSecrets } from "../security.ts";

export class TerminalChannel implements Channel {
	readonly id = "terminal";
	readonly kind = "terminal" as const;
	private readonly book = new ReplyBook();
	private readonly tools = new WeakMap<ReplyRecorder, ToolDefinition>();
	private defaultTool: ToolDefinition | null = null;
	private rl: readline.Interface | null = null;

	describe(): string {
		return "the interactive terminal — the human is typing on stdin and reading stdout";
	}
	norms(): string {
		return "Plain text, no internal reasoning or meta-tags. Short and direct. This is a developer terminal, so code and detail are welcome, but never narrate tool calls.";
	}

	authenticated(): boolean {
		// Local stdin is the authenticated principal: whoever owns the process.
		return true;
	}

	async start(sink: (event: ChannelEvent) => void): Promise<void> {
		const attachStdin = process.stdin.isTTY || process.env.MIR_TERMINAL_STDIN === "1";
		if (!attachStdin) return;
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
		process.stdout.write(`\nmir: ${redactSecrets(text)}\n> `);
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
		this.rl?.close();
		this.rl = null;
	}
}
