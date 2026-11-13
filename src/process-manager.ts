/**
 * pm2 process manager (ADR 0001).
 *
 * Each Task runs as its own pm2 app `mir-worker-<taskId>`. The daemon spawns it,
 * hands it the task spec, and deletes it when it finishes.
 *
 * The spec is passed as a **0600 file path**, not as an inline env var: task
 * descriptions can contain private context, and `pm2 env <app>` / `ps eww`
 * would otherwise expose it to every local user. The file is removed when the
 * worker is deleted.
 */

import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import type { OpenRouterRouting } from "./types.ts";
import type { WorkerCapabilities } from "./security.ts";
import type { WorkerToolPolicy } from "./types.ts";
import type { McpConfig } from "./mcp.ts";
import { log } from "./telemetry.ts";

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
	heartbeatMs: number;
	maxTokens: number;
	sessionDir: string;
	mcpConfigPath: string;
	/** The servers this Worker should load, when the daemon knows better than the file. */
	mcpConfig?: McpConfig;
	/** Hand this task is pinned to (omitted = the hub picks one). */
	endpointId?: string;
	/** Unix socket for the hands hub (omitted = no hands; worker uses local tools). */
	handsSocketPath?: string;
	capabilities: WorkerCapabilities;
	toolPolicy: WorkerToolPolicy;
}

/** Structural seam: the Router only needs these four operations. */
export interface WorkerSpawner {
	spawnWorker(spec: WorkerSpec): Promise<string>;
	killWorker(taskId: string): Promise<void>;
	listWorkers(): Promise<WorkerProcessInfo[]>;
	disconnect(): Promise<void>;
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

export class ProcessManager implements WorkerSpawner {
	private pm2: Pm2 | null = null;

	/**
	 * @param specDir directory for per-worker spec files (0600). Defaults to a
	 *   temp subdirectory; the daemon passes its state dir.
	 */
	constructor(private readonly specDir: string = path.join(process.cwd(), ".mir", "specs")) {}

	async connect(): Promise<void> {
		if (this.pm2) return;
		this.pm2 = await loadPm2();
		await new Promise<void>((resolve, reject) => {
			this.pm2.connect((err: Error | null) => (err ? reject(err) : resolve()));
		});
	}

	private writeSpec(spec: WorkerSpec): string {
		fs.mkdirSync(this.specDir, { recursive: true });
		const file = path.join(this.specDir, `${spec.workerId}.json`);
		// `mode` on write only applies when creating; chmod covers overwrite.
		fs.writeFileSync(file, JSON.stringify(spec), { mode: 0o600 });
		try {
			fs.chmodSync(file, 0o600);
		} catch {
			/* best effort on filesystems without POSIX modes */
		}
		return file;
	}

	private removeSpec(workerId: string): void {
		try {
			fs.unlinkSync(path.join(this.specDir, `${workerId}.json`));
		} catch {
			/* already gone */
		}
	}

	/** Spawn a Worker as a pm2 app for this Task. */
	async spawnWorker(spec: WorkerSpec): Promise<string> {
		await this.connect();
		const name = `mir-worker-${spec.taskId}`;
		const dev = isTsRuntime();
		const workerEntry = path.join(here(), dev ? "worker-main.ts" : "worker-main.js");
		const specPath = this.writeSpec(spec);
		const opts: Record<string, unknown> = {
			name,
			script: workerEntry,
			cwd: process.cwd(),
			exec_mode: "fork",
			autorestart: false,
			watch: false,
			// Only the path goes into the environment, never the spec itself.
			env: { MIR_WORKER_SPEC_PATH: specPath, MIR_WORKER_ID: spec.workerId },
		};
		if (dev) {
			opts.interpreter = process.execPath;
			opts.interpreter_args = "--import tsx";
		}
		try {
			await new Promise<void>((resolve, reject) => {
				this.pm2!.start(opts, (err: Error | null) => (err ? reject(err) : resolve()));
			});
		} catch (err) {
			this.removeSpec(spec.workerId);
			throw err;
		}
		log.debug("pm2 app started", { name, spec: specPath });
		return name;
	}

	/** Delete a Worker's pm2 app (after it finishes or is reaped). */
	async killWorker(taskId: string): Promise<void> {
		await this.connect();
		const name = `mir-worker-${taskId}`;
		await new Promise<void>((resolve) => {
			this.pm2!.delete(name, () => resolve());
		});
		// The spec file is named by workerId, so clean up any spec for this task.
		try {
			for (const file of fs.readdirSync(this.specDir)) {
				if (!file.endsWith(".json")) continue;
				const full = path.join(this.specDir, file);
				try {
					const parsed = JSON.parse(fs.readFileSync(full, "utf8")) as { taskId?: string };
					if (parsed.taskId === taskId) fs.unlinkSync(full);
				} catch {
					/* ignore malformed spec */
				}
			}
		} catch {
			/* spec dir gone */
		}
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
