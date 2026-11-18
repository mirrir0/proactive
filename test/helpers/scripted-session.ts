/**
 * A scripted stand-in for a pi AgentSession.
 *
 * The scheduling logic under test (batching, reply attribution, event queueing,
 * retries, recovery) is not model logic. Replacing the session with a script
 * makes those behaviours deterministic and free to run, and lets a test
 * reproduce the exact hazard that motivated the fix — e.g. `detached: true`
 * makes `prompt()` resolve before the turn's work finishes, which is what pi
 * does when a message is queued with `streamingBehavior: "followUp"`.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentSessionLike, SessionFactory } from "../../src/session.ts";

export type Step =
	| { type: "text"; text: string }
	| { type: "tool"; name: string; args?: Record<string, unknown> }
	| { type: "throw"; message: string }
	| { type: "sleep"; ms: number };

export type Script = (prompt: string, turn: number) => Step[] | Promise<Step[]>;

export interface ScriptedSessionOptions {
	script: Script;
	/**
	 * Resolve `prompt()` before the turn's steps finish (mimics a queued
	 * follow-up). `waitForIdle()` then awaits the real work.
	 */
	detached?: boolean;
}

export class ScriptedSession implements AgentSessionLike {
	readonly prompts: string[] = [];
	readonly calls: Array<{ name: string; args: Record<string, unknown>; result?: any }> = [];
	readonly customMessages: string[] = [];
	aborted = false;
	disposed = false;

	private readonly listeners = new Set<(event: any) => void>();
	/** The tool surface this session was created with, for a test that asserts it. */
	readonly tools: ToolDefinition[];
	/** What the layer handed the session: the loader is where a test reads the system prompt. */
	readonly resourceLoader: unknown;
	private readonly options: ScriptedSessionOptions;
	private pending: Promise<void> | null = null;
	private streaming = false;
	private idleWaiters: Array<() => void> = [];

	constructor(tools: ToolDefinition[], options: ScriptedSessionOptions, resourceLoader?: unknown) {
		this.tools = tools;
		this.options = options;
		this.resourceLoader = resourceLoader;
	}

	get isStreaming(): boolean {
		return this.streaming;
	}

	get isIdle(): boolean {
		return !this.streaming && this.pending === null;
	}

	async prompt(text: string): Promise<void> {
		if (this.disposed) throw new Error("session disposed");
		this.prompts.push(text);
		const turn = this.prompts.length;
		const steps = await this.options.script(text, turn);
		const run = this.runSteps(steps);
		this.streaming = true;

		if (this.options.detached) {
			// Resolve now; the turn continues in the background.
			this.pending = run.finally(() => {
				this.streaming = false;
				this.pending = null;
				this.releaseIdleWaiters();
			});
			return;
		}

		try {
			await run;
		} finally {
			this.streaming = false;
			this.releaseIdleWaiters();
		}
	}

	async waitForIdle(): Promise<void> {
		if (this.pending) {
			await this.pending;
			return;
		}
		if (!this.streaming) return;
		await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
	}

	subscribe(listener: (event: any) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async abort(): Promise<void> {
		this.aborted = true;
	}

	async sendCustomMessage(message: any): Promise<void> {
		this.customMessages.push(String(message?.content ?? ""));
	}

	async dispose(): Promise<void> {
		this.disposed = true;
	}

	/** The prompt of the most recent turn. */
	get lastPrompt(): string {
		return this.prompts[this.prompts.length - 1] ?? "";
	}

	/** Names of tools called, in order. */
	get calledToolNames(): string[] {
		return this.calls.map((c) => c.name);
	}

	private releaseIdleWaiters(): void {
		const waiters = this.idleWaiters;
		this.idleWaiters = [];
		for (const resolve of waiters) resolve();
	}

	private emit(event: any): void {
		for (const listener of this.listeners) listener(event);
	}

	/** Honour tools swapped in after creation (WorkerRuntime.addTools / replaceMcpTools). */
	private currentTools(): ToolDefinition[] {
		const swapped = (this as any)._customTools;
		return Array.isArray(swapped) ? swapped : this.tools;
	}

	private async runSteps(steps: Step[]): Promise<void> {
		for (const step of steps) {
			if (step.type === "text") {
				this.emit({
					type: "message_update",
					assistantMessageEvent: { type: "text_delta", delta: step.text },
				});
				continue;
			}
			if (step.type === "throw") throw new Error(step.message);
			if (step.type === "sleep") {
				await new Promise((resolve) => setTimeout(resolve, step.ms));
				continue;
			}
			if (step.type === "tool") {
				const tool = this.currentTools().find((t) => (t as any).name === step.name);
				if (!tool) throw new Error(`scripted session: unknown tool "${step.name}"`);
				const args = (step.args ?? {}) as any;
				const result = await (tool as any).execute(
					`call-${this.calls.length + 1}`,
					args,
					undefined,
					undefined,
					{},
				);
				this.calls.push({ name: step.name, args, result });
			}
		}
	}
}

/** Build a SessionFactory that hands out ScriptedSessions with the given script. */
export function scriptedFactory(options: ScriptedSessionOptions): {
	factory: SessionFactory;
	sessions: ScriptedSession[];
} {
	const sessions: ScriptedSession[] = [];
	const factory: SessionFactory = async (createOptions) => {
		const session = new ScriptedSession(createOptions.customTools ?? [], options, createOptions.resourceLoader);
		sessions.push(session);
		return session;
	};
	return { factory, sessions };
}
