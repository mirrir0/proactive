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
import { spawn } from "node:child_process";
import fs, { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
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
	/** What the task is for: the person's line. */
	description: string;
	/** The brief the Worker is told, when it is more than the description. */
	instructions?: string;
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
	/** The task that asked for this one, when a Worker fanned out. */
	parentTaskId?: string;
	/** 0 for the Router's own dispatch, 1 for a Worker's check. */
	depth?: number;
	/** Where that hand keeps its files, from its own policy. */
	handRoot?: string;
	/** What the hand is called, when it says. */
	handName?: string;
	/** Unix socket for the hands hub (omitted = no hands; worker uses local tools). */
	handsSocketPath?: string;
	capabilities: WorkerCapabilities;
	toolPolicy: WorkerToolPolicy;
}

/** Structural seam: the Router only needs these four operations. */
export interface WorkerSpawner {
	spawnWorker(spec: WorkerSpec): Promise<string>;
	killWorker(taskId: string): Promise<void>;
	/**
	 * Why a worker that never connected died, when the process manager wrote it
	 * down.
	 *
	 * A process manager that accepts a start and loses the child reports success,
	 * so the only witness is the child's own stderr. Optional: a spawner that keeps
	 * no logs simply has nothing to say.
	 */
	lastWorkerError?(taskId: string): string | undefined;
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

	/**
	 * Say, at boot, that workers will not start.
	 *
	 * pm2 runs a child through its own fork entry, and in a pnpm layout with two
	 * copies of pm2 that file may not resolve: every worker then dies at boot while
	 * `pm2.start` reports success, which reads as "the task is running and nothing is
	 * happening". Checking it once at boot — rather than once per task, twenty
	 * seconds later — is the difference between a hint and an investigation.
	 */
	preflight(): void {
		if ((process.env.MIR_WORKER_SPAWN ?? "pm2") === "process") return;
		try {
			createRequire(import.meta.url).resolve("pm2/lib/ProcessContainerFork.js");
		} catch (err) {
			log.warn("workers will fail to start: pm2's fork entry does not resolve here", {
				error: (err as Error).message,
				hint: "set MIR_WORKER_SPAWN=process to spawn workers as plain children",
			});
		}
	}

	/** Spawn a Worker as a pm2 app for this Task. */
	async spawnWorker(spec: WorkerSpec): Promise<string> {
		const name = `mir-worker-${spec.taskId}`;
		const dev = isTsRuntime();
		const workerEntry = path.join(here(), dev ? "worker-main.ts" : "worker-main.js");
		const specPath = this.writeSpec(spec);

		/**
		 * A worker can be started without pm2.
		 *
		 * pm2 is how a worker outlives its daemon (ADR 0001), and it is the default.
		 * It is also a process manager whose own fork entry has to resolve, and in a
		 * container — or a pnpm layout with two copies of pm2 — it may not: the worker
		 * dies at boot with `ERR_MODULE_NOT_FOUND` inside pm2's container, which reads
		 * as "the task is running and nothing is happening".
		 *
		 * So there is a second way, chosen when the operator asks for it: a plain
		 * child process, tied to this daemon. It is worse at surviving the daemon and
		 * better at existing at all.
		 */
		if ((process.env.MIR_WORKER_SPAWN ?? "pm2") === "process") {
			this.spawnDirect(name, workerEntry, dev, spec);
			log.info("worker spawned without pm2", { worker: spec.workerId, task: spec.taskId });
			return name;
		}

		await this.connect();
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
	/** Worker processes started without pm2, by name, so a kill can find them. */
	private readonly direct = new Map<string, import("node:child_process").ChildProcess>();

	private spawnDirect(name: string, entry: string, dev: boolean, spec: WorkerSpec): void {
		const args = dev ? ["--import", "tsx", entry] : [entry];
		const child = spawn(process.execPath, args, {
			cwd: process.cwd(),
			env: { ...process.env, MIR_WORKER_SPEC_PATH: this.writeSpec(spec), MIR_WORKER_ID: spec.workerId },
			stdio: ["ignore", "pipe", "pipe"],
		});
		child.stdout?.on("data", (chunk: Buffer) => log.debug("worker stdout", { worker: spec.workerId, line: String(chunk).trim() }));
		child.stderr?.on("data", (chunk: Buffer) => log.warn("worker stderr", { worker: spec.workerId, line: String(chunk).trim() }));
		child.on("exit", (code, signal) => {
			this.direct.delete(name);
			log.info("worker process exited", { worker: spec.workerId, code, signal });
		});
		this.direct.set(name, child);
	}

	/**
	 * The last thing the child said before it died.
	 *
	 * pm2 writes a worker's stderr to `~/.pm2/logs/<app>-error.log`, and when the
	 * failure is pm2's own (`ProcessContainerFork.js` not resolving in a pnpm
	 * layout) that file is the only place the reason exists. Reading it turns "the
	 * worker never started" into "the worker never started: Cannot find module …".
	 */
	lastWorkerError(taskId: string): string | undefined {
		const name = `mir-worker-${taskId}`;
		const file = path.join(homedir(), ".pm2", "logs", `${name}-error.log`);
		try {
			const tail = readFileSync(file, "utf8").trim().split("\n").filter((line) => line.trim() !== "");
			// The last few lines are a stack; the message is the line that names it.
			const message = tail.reverse().find((line) => /^\w*Error:|Cannot find module|EADDRINUSE|SyntaxError/.test(line.trim()));
			return message?.trim();
		} catch {
			return undefined;
		}
	}

	async killWorker(taskId: string): Promise<void> {
		const directName = `mir-worker-${taskId}`;
		const child = this.direct.get(directName);
		if (child !== undefined) {
			child.kill("SIGTERM");
			this.direct.delete(directName);
			this.removeSpec(taskId);
			return;
		}

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
