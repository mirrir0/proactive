/**
 * pm2 process manager (ADR 0001).
 *
 * Each Task runs as its own pm2 app `mir-worker-<taskId>`. The daemon spawns it,
 * passes the task spec via env, and deletes it when it finishes.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import type { OpenRouterRouting } from "./types.ts";

/** Everything a Worker process needs to run one Task. */
export interface WorkerSpec {
	workerId: string;
	taskId: string;
	title: string;
	description: string;
	threadId?: string;
	channelId?: string;
	replyTo?: string;
	modelId: string;
	providerRouting?: OpenRouterRouting;
	thinkingLevel: string;
	socketPath: string;
	idleExitMs: number;
	maxTokens: number;
}

export interface WorkerProcessInfo {
	name: string;
	status: string;
	pid?: number;
	restarts?: number;
}

type Pm2 = any;

async function loadPm2(): Promise<Pm2> {
	const mod: any = await import("pm2");
	return mod.default ?? mod;
}

function here(): string {
	return path.dirname(fileURLToPath(import.meta.url));
}

/** True when this code is running from TypeScript (dev) rather than dist. */
function isTsRuntime(): boolean {
	return import.meta.url.endsWith(".ts");
}

export class ProcessManager {
	private pm2: Pm2 | null = null;

	async connect(): Promise<void> {
		if (this.pm2) return;
		this.pm2 = await loadPm2();
		await new Promise<void>((resolve, reject) => {
			this.pm2.connect((err: Error | null) => (err ? reject(err) : resolve()));
		});
	}

	/** Spawn a Worker as a pm2 app for this Task. */
	async spawnWorker(spec: WorkerSpec): Promise<string> {
		await this.connect();
		const name = `mir-worker-${spec.taskId}`;
		const dev = isTsRuntime();
		const workerEntry = path.join(here(), dev ? "worker-main.ts" : "worker-main.js");
		const opts: Record<string, unknown> = {
			name,
			script: workerEntry,
			cwd: process.cwd(),
			exec_mode: "fork",
			autorestart: false,
			watch: false,
			env: { MIR_WORKER_SPEC: JSON.stringify(spec) },
		};
		if (dev) {
			opts.interpreter = process.execPath;
			opts.interpreter_args = "--import tsx";
		}
		await new Promise<void>((resolve, reject) => {
			this.pm2!.start(opts, (err: Error | null) => (err ? reject(err) : resolve()));
		});
		return name;
	}

	/** Delete a Worker's pm2 app (after it finishes or is reaped). */
	async killWorker(taskId: string): Promise<void> {
		await this.connect();
		const name = `mir-worker-${taskId}`;
		await new Promise<void>((resolve) => {
			this.pm2!.delete(name, () => resolve());
		});
	}

	async listWorkers(): Promise<WorkerProcessInfo[]> {
		await this.connect();
		return new Promise((resolve) => {
			this.pm2!.list((err: Error | null, list: any[]) => {
				if (err || !list) return resolve([]);
				resolve(
					list
						.filter((p) => String(p.name ?? "").startsWith("mir-worker-"))
						.map((p) => ({
							name: p.name,
							status: p.pm2_env?.status ?? "unknown",
							pid: p.pid,
							restarts: p.pm2_env?.restart_time,
						})),
				);
			});
		});
	}

	async disconnect(): Promise<void> {
		if (!this.pm2) return;
		await new Promise<void>((resolve) => this.pm2!.disconnect(() => resolve()));
		this.pm2 = null;
	}
}
