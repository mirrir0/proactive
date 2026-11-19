/**
 * Test doubles for the system's outer edges: process spawning, channels, and
 * temporary state directories.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type {
	Channel,
	ChannelEvent,
	ChannelKind,
	ReplyContext,
	ReplyRecorder,
} from "../../src/channels/types.ts";
import { makeResponseTool } from "../../src/channels/tool.ts";
import type { WorkerProcessInfo, WorkerSpec, WorkerSpawner } from "../../src/process-manager.ts";
import type { Trigger } from "../../src/types.ts";

export function tmpDir(prefix = "mir-test-"): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function rmDir(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

/** A WorkerSpawner that records what the Router asked for. */
export class FakeSpawner implements WorkerSpawner {
	readonly spawned: WorkerSpec[] = [];
	readonly killed: string[] = [];
	/** When set, the next spawn rejects with this message. */
	failNextWith: string | null = null;
	/** What the process manager says a dead worker died of, for the diagnostics path. */
	workerError: string | undefined;
	disconnected = false;

	async spawnWorker(spec: WorkerSpec): Promise<string> {
		if (this.failNextWith) {
			const message = this.failNextWith;
			this.failNextWith = null;
			throw new Error(message);
		}
		this.spawned.push(spec);
		return `mir-worker-${spec.taskId}`;
	}

	async killWorker(taskId: string): Promise<void> {
		this.killed.push(taskId);
	}

	lastWorkerError(_taskId: string): string | undefined {
		return this.workerError;
	}

	async listWorkers(): Promise<WorkerProcessInfo[]> {
		return this.spawned.map((s) => ({ name: `mir-worker-${s.taskId}`, status: "online" }));
	}

	async disconnect(): Promise<void> {
		this.disconnected = true;
	}
}

/** A channel that records replies instead of sending them anywhere. */
export class RecordingChannel implements Channel {
	readonly replies: Array<{ text: string; ctx: ReplyContext }> = [];
	private readonly tools = new WeakMap<ReplyRecorder, ToolDefinition>();
	private defaultTool: ToolDefinition | null = null;

	constructor(
		readonly id: string = "terminal",
		readonly kind: ChannelKind = "terminal",
	) {}

	describe(): string {
		return `recording channel ${this.id}`;
	}
	norms(): string {
		return "short";
	}
	authenticated(): boolean {
		return true;
	}
	async start(): Promise<void> {}
	async stop(): Promise<void> {}

	async respond(text: string, ctx: ReplyContext): Promise<void> {
		this.replies.push({ text, ctx });
	}

	responseTool(recorder?: ReplyRecorder): ToolDefinition {
		if (!recorder) return (this.defaultTool ??= makeResponseTool(this));
		let tool = this.tools.get(recorder);
		if (!tool) {
			tool = makeResponseTool(this, recorder);
			this.tools.set(recorder, tool);
		}
		return tool;
	}
}

export function makeTrigger(overrides: Partial<Trigger> = {}): Trigger {
	return {
		id: overrides.id ?? `evt-${Math.random().toString(36).slice(2, 10)}`,
		channelId: overrides.channelId ?? "terminal",
		kind: overrides.kind ?? "terminal",
		text: overrides.text ?? "please do the thing",
		receivedAt: overrides.receivedAt ?? Date.now(),
		threadId: overrides.threadId,
		replyTo: overrides.replyTo,
		metadata: overrides.metadata ?? { explicit_request: "true" },
		payload: overrides.payload,
		attempts: overrides.attempts,
	};
}

export function makeEvent(overrides: Partial<ChannelEvent> = {}): ChannelEvent {
	return {
		id: overrides.id ?? `evt-${Math.random().toString(36).slice(2, 10)}`,
		channelId: overrides.channelId ?? "http",
		threadId: overrides.threadId ?? "thread-1",
		text: overrides.text ?? "hello",
		from: overrides.from,
		payload: overrides.payload,
		replyTo: overrides.replyTo,
		receivedAt: overrides.receivedAt ?? Date.now(),
		metadata: overrides.metadata,
	};
}

/** Poll until `predicate` is true (or throw after `timeoutMs`). */
export async function waitFor(
	predicate: () => boolean,
	timeoutMs = 2000,
	label = "condition",
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`timed out waiting for ${label}`);
}

/** Let pending microtasks/timers run. */
export function tick(ms = 0): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
