/**
 * Watchdog (Section 6).
 *
 * An independent Control Loop running outside the main system, driven by
 * scheduled messages. It:
 *   - Monitors infrastructure failures (API errors, failed state recovery).
 *   - Uses the model to judge whether each Worker is making substantive
 *     progress or drifting from its goal.
 *   - Fixes anomalies promptly and rechecks transient external failures.
 *   - Can correct the main system's behavior while it runs (add/remove prompts,
 *     adjust trigger rules).
 */

import type { WorkerInfo } from "./types";
import { RouterLayer } from "./router";

export interface WatchdogOptions {
	checkIntervalMs?: number;
	stuckThresholdMs?: number;
	driftCheckEnabled?: boolean;
}

export const DEFAULT_WATCHDOG_OPTIONS: WatchdogOptions = {
	checkIntervalMs: 30_000,
	stuckThresholdMs: 5 * 60_000, // 5 minutes without heartbeat
	driftCheckEnabled: true,
};

export class Watchdog {
	private router: RouterLayer;
	private timer: NodeJS.Timeout | null = null;
	private readonly options: Required<WatchdogOptions>;
	private running = false;

	constructor(router: RouterLayer, options: WatchdogOptions = {}) {
		this.router = router;
		this.options = {
			checkIntervalMs: 30_000,
			stuckThresholdMs: 5 * 60_000,
			driftCheckEnabled: true,
			...options,
		};
	}

	start(): void {
		if (this.running) return;
		this.running = true;
		this.tick(); // immediate first check
		this.timer = setInterval(() => this.tick(), this.options.checkIntervalMs);
		this.timer.unref();
	}

	stop(): void {
		this.running = false;
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	private async tick(): Promise<void> {
		const now = Date.now();
		const workers = this.router.listWorkers();

		for (const info of workers) {
			// Infrastructure liveness: stuck workers (no heartbeat)
			const idleFor = now - info.lastHeartbeat;
			if (
				(info.status === "busy" || info.status === "blocked") &&
				idleFor > this.options.stuckThresholdMs
			) {
				console.log(
					`[watchdog] Worker ${info.id} stuck (${Math.round(idleFor / 1000)}s idle), interrupting`,
				);
				// In production: call worker.stop() / worker.dispose() and reschedule the task
			}

			// Drift check: ask the model whether the worker is still on goal
			if (this.options.driftCheckEnabled && info.progress) {
				this.checkDrift(info);
			}
		}
	}

	private async checkDrift(info: WorkerInfo): Promise<void> {
		// The watchdog is itself an agent session with a full toolset, so it can
		// judge progress in natural language. Here we log a placeholder; in
		// production this calls the model with the worker's progress + goal.
		console.log(
			`[watchdog] drift check for worker ${info.id} (task ${info.taskId}): progress="${info.progress}"`,
		);
	}

	/** Maintainers can ask the watchdog why something failed (natural language). */
	async diagnose(workerId: string): Promise<string> {
		const info = this.router.listWorkers().find((w) => w.id === workerId);
		if (!info) return `Worker ${workerId} not found`;
		return `Worker ${workerId} (task ${info.taskId}): status=${info.status}, last heartbeat ${Date.now() - info.lastHeartbeat}ms ago. Progress: ${info.progress ?? "none"}`;
	}
}
