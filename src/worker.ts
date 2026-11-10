/**
 * Worker runtime (Section 2.2).
 *
 * Runs inside a dedicated `mir-worker-<taskId>` pm2 process (ADR 0001). Each
 * Worker is a context-isolated agent session dedicated to one Task. Workers:
 *   - have the full execution toolset and the most capable model;
 *   - never talk to humans directly — they report `status`/`conclusion` to the
 *     Router over the control channel, and the Router replies via a Channel;
 *   - can receive follow-up events on their subscribed Thread.
 */

import {
	createAgentSession,
	SessionManager,
	type ModelRuntime,
} from "@earendil-works/pi-coding-agent";

/** How a Worker reports to the Router (implemented over the IPC control channel). */
export interface WorkerReporter {
	status(status: "idle" | "busy" | "done" | "failed", progress?: string): void;
	delta(text: string): void;
}

export interface WorkerRuntimeOptions {
	taskId: string;
	modelRuntime: ModelRuntime;
	model: any;
	reporter: WorkerReporter;
	thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

export class WorkerRuntime {
	private session!: Awaited<ReturnType<typeof createAgentSession>>["session"];
	private disposed = false;
	private busy = false;
	private readonly options: WorkerRuntimeOptions;

	private constructor(options: WorkerRuntimeOptions) {
		this.options = options;
	}

	static async create(options: WorkerRuntimeOptions): Promise<WorkerRuntime> {
		const worker = new WorkerRuntime(options);
		const result = await createAgentSession({
			model: options.model,
			modelRuntime: options.modelRuntime,
			sessionManager: SessionManager.inMemory(),
			thinkingLevel: options.thinkingLevel ?? "high",
		});
		worker.session = result.session;
		worker.session.subscribe((event: any) => {
			if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
				const delta = event.assistantMessageEvent.delta;
				if (delta) options.reporter.delta(String(delta));
			}
		});
		return worker;
	}

	get isBusy(): boolean {
		return this.busy;
	}

	/** Run one prompt to completion. Deltas stream to the reporter. */
	async run(prompt: string): Promise<string> {
		if (this.busy) throw new Error("worker already running a turn");
		this.busy = true;
		this.options.reporter.status("busy");
		let result = "";
		const sink = (event: any) => {
			if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
				result += event.assistantMessageEvent.delta ?? "";
			}
		};
		const unsub = this.session.subscribe(sink);
		try {
			await this.session.prompt(prompt, { streamingBehavior: "followUp" });
		} finally {
			unsub();
			this.busy = false;
		}
		return result;
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		await this.session.dispose();
	}
}
