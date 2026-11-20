/**
 * An independent control loop. Deterministic recovery first — a stale heartbeat or an
 * over-budget turn is an infrastructure fault, fixed without an inference call — then
 * judgement, in its own agent session, for what is not mechanical. It keeps its session
 * file, so a maintainer can ask it what it saw.
 */

import { SessionManager, defineTool, type AgentToolResult, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { RouterStatus, SuperAgentConfig, Task, WorkerInfo } from "./types.ts";

import type { MirStore } from "./store.ts";
import type { TriggerSystem } from "./trigger.ts";
import type { TriggerPolicyConfig } from "./types.ts";
import { createPiSession, settleSession, type AgentSessionLike, type SessionFactory } from "./session.ts";
import { metrics, log } from "./telemetry.ts";
import { join } from "node:path";

export type FindingKind = "stuck-worker" | "hung-router" | "backlog" | "failed-tasks";

export interface Finding {
	kind: FindingKind;
	severity: "warn" | "critical";
	message: string;
	workerId?: string;
	taskId?: string;
}

export interface WatchdogSnapshot {
	now: number;
	workers: WorkerInfo[];
	tasks: Task[];
	router: RouterStatus;
	/** Tasks that failed since the previous check (filled by the caller). */
	recentFailures?: Task[];
}

/** Structural, so the Watchdog is testable without a whole Router. */
export interface WatchdogRouter {
	listWorkers(): WorkerInfo[];
	listTasks(): Task[];
	status(): RouterStatus;
	stopTask(taskId: string, reason?: string): Promise<Task>;
	retryTask(taskId: string): Promise<Task>;
	abortTurn(reason: string): Promise<void>;
	submitSignal(text: string): void;
}

export interface WatchdogOptions {
	enabled: boolean;
	checkIntervalMs: number;
	stuckMs: number;
	routerTurnTimeoutMs: number;
	maxTurnsPerHour: number;
	/** Router queue depth that counts as a backlog. */
	backlogDepth: number;
}

export const DEFAULT_WATCHDOG_OPTIONS: WatchdogOptions = {
	enabled: true,
	checkIntervalMs: 30_000,
	stuckMs: 5 * 60_000,
	routerTurnTimeoutMs: 6 * 60_000,
	maxTurnsPerHour: 30,
	backlogDepth: 50,
};

/** No I/O, so it is unit-testable with a fabricated clock. */
export function assess(snapshot: WatchdogSnapshot, options: WatchdogOptions): Finding[] {
	const findings: Finding[] = [];
	const { now } = snapshot;

	for (const worker of snapshot.workers) {
		const active = worker.status === "busy" || worker.status === "blocked";
		if (!active) continue;
		const age = now - worker.lastHeartbeat;
		if (age > options.stuckMs) {
			findings.push({
				kind: "stuck-worker",
				severity: "critical",
				message: `worker ${worker.id} (task ${worker.taskId}) has not sent a heartbeat for ${Math.round(age / 1000)}s (progress: ${worker.progress ?? "unknown"})`,
				workerId: worker.id,
				taskId: worker.taskId,
			});
		}
	}

	if (snapshot.router.turnInFlightSince > 0) {
		const age = now - snapshot.router.turnInFlightSince;
		if (age > options.routerTurnTimeoutMs) {
			findings.push({
				kind: "hung-router",
				severity: "critical",
				message: `Router turn has been in flight for ${Math.round(age / 1000)}s (budget ${Math.round(options.routerTurnTimeoutMs / 1000)}s)`,
			});
		}
	}

	if (snapshot.router.queueDepth > options.backlogDepth) {
		findings.push({
			kind: "backlog",
			severity: "warn",
			message: `Router inbox backlog is ${snapshot.router.queueDepth} items (threshold ${options.backlogDepth}); turns may be falling behind`,
		});
	}

	const failures = snapshot.recentFailures ?? [];
	if (failures.length > 0) {
		findings.push({
			kind: "failed-tasks",
			severity: "warn",
			message: `${failures.length} task(s) failed since the last check: ${failures
				.map((t) => `${t.id} (${t.error ?? "no error"})`)
				.join("; ")}`,
		});
	}

	return findings;
}

export interface WatchdogDependencies {
	modelRuntime: any;
	model: any;
	config: SuperAgentConfig;
	router: WatchdogRouter;
	store: MirStore;
	triggerSystem: TriggerSystem;
	sessionFactory?: SessionFactory;
	options?: Partial<WatchdogOptions>;
}

export class Watchdog {
	private readonly deps: WatchdogDependencies;
	private readonly options: WatchdogOptions;
	private session: AgentSessionLike | null = null;
	private timer: NodeJS.Timeout | null = null;
	private running = false;
	private ticking = false;
	private turnsThisWindow = 0;
	private windowStartedAt = Date.now();
	private lastFailureSeenAt = Date.now();

	private constructor(deps: WatchdogDependencies) {
		this.deps = deps;
		const cfg = deps.config.watchdog;
		this.options = {
			...DEFAULT_WATCHDOG_OPTIONS,
			enabled: cfg.enabled,
			checkIntervalMs: cfg.checkIntervalMs,
			stuckMs: cfg.stuckMs,
			routerTurnTimeoutMs: cfg.routerTurnTimeoutMs,
			maxTurnsPerHour: cfg.maxTurnsPerHour ?? DEFAULT_WATCHDOG_OPTIONS.maxTurnsPerHour,
			...deps.options,
		};
	}

	/** Create the watchdog and its own agent session (lazily started by `start`). */
	static async create(deps: WatchdogDependencies): Promise<Watchdog> {
		const watchdog = new Watchdog(deps);
		await watchdog.initSession();
		return watchdog;
	}

	private async initSession(): Promise<void> {
		if (!this.options.enabled) return;
		const model = this.deps.config.watchdog.modelId
			? (this.deps.modelRuntime.getModel("openrouter", this.deps.config.watchdog.modelId) ?? this.deps.model)
			: this.deps.model;
		const sessionManager = (() => {
			try {
				return SessionManager.open(join(this.deps.config.stateDir, "watchdog.session"));
			} catch {
				return SessionManager.inMemory();
			}
		})();
		const factory = this.deps.sessionFactory ?? createPiSession;
		this.session = await factory({
			model,
			modelRuntime: this.deps.modelRuntime,
			sessionManager,
			thinkingLevel: "low",
			noTools: "builtin",
			customTools: this.buildTools(),
		});
	}

	private buildTools(): ToolDefinition[] {
		const wd = this;
		return [
			defineTool({
				name: "inspect_system",
				label: "Inspect the system",
				description: "Return a snapshot of workers, tasks, router state and recent findings.",
				parameters: Type.Object({}),
				async execute() {
					return {
						content: [{ type: "text", text: JSON.stringify(wd.snapshot(), null, 2) }],
						details: {},
					};
				},
			}),
			defineTool({
				name: "stop_task",
				label: "Stop a task",
				description: "Abort a running or queued task. Use for tasks that are stuck or clearly wrong.",
				parameters: Type.Object({
					task_id: Type.String({}),
					reason: Type.String({ description: "Why — recorded on the task and visible to maintainers." }),
				}),
				async execute(_id, params): Promise<AgentToolResult<any>> {
					try {
						const task = await wd.deps.router.stopTask(params.task_id, `watchdog: ${params.reason}`);
						return {
							content: [{ type: "text", text: `stopped ${task.id}` }],
							details: { taskId: task.id },
						};
					} catch (err) {
						return {
							content: [{ type: "text", text: `stop failed: ${(err as Error).message}` }],
							details: {},
							isError: true,
						};
					}
				},
			}),
			defineTool({
				name: "retry_task",
				label: "Retry a task",
				description: "Re-dispatch a failed or interrupted task with the same inputs.",
				parameters: Type.Object({
					task_id: Type.String({}),
					reason: Type.String({}),
				}),
				async execute(_id, params): Promise<AgentToolResult<any>> {
					try {
						const task = await wd.deps.router.retryTask(params.task_id);
						return {
							content: [{ type: "text", text: `retried as ${task.id} (${task.status})` }],
							details: { taskId: task.id },
						};
					} catch (err) {
						return {
							content: [{ type: "text", text: `retry failed: ${(err as Error).message}` }],
							details: {},
							isError: true,
						};
					}
				},
			}),
			defineTool({
				name: "set_trigger_policy",
				label: "Adjust trigger policy",
				description:
					"Adjust admission policy at runtime (e.g. ignore a noisy channel kind, require a mention). Takes effect immediately.",
				parameters: Type.Object({
					kind: Type.Optional(Type.String({ description: "Channel kind: terminal|http|queue" })),
					policy: Type.Optional(Type.String({ description: "ignore|candidate|respond_only" })),
					require_mention: Type.Optional(Type.Boolean({})),
					allow_user: Type.Optional(Type.String({ description: "Add a sender id to the allowlist." })),
				}),
				async execute(_id, params): Promise<AgentToolResult<any>> {
					const patch: TriggerPolicyConfig = {};
					if (params.kind && params.policy) {
						patch.kindPolicy = { [params.kind]: params.policy } as TriggerPolicyConfig["kindPolicy"];
					}
					if (params.require_mention !== undefined) {
						const current = wd.deps.triggerSystem.getPolicies().requireMention;
						const kinds = new Set(current);
						if (params.require_mention) {
							for (const k of ["terminal", "http", "queue"] as const) kinds.add(k);
						} else {
							kinds.clear();
						}
						patch.requireMention = [...kinds];
					}
					if (params.allow_user) {
						const users = new Set(wd.deps.triggerSystem.getPolicies().allowedUsers);
						users.add(params.allow_user);
						patch.allowedUsers = [...users];
					}
					wd.deps.triggerSystem.updatePolicies(patch);
					log.warn("watchdog adjusted trigger policy", { patch });
					return {
						content: [{ type: "text", text: `policy updated: ${JSON.stringify(patch)}` }],
						details: { patch },
					};
				},
			}),
			defineTool({
				name: "note_incident",
				label: "Record an incident",
				description:
					"Record what happened and what you did, so the Router and maintainers can recall it later.",
				parameters: Type.Object({
					summary: Type.String({ description: "One or two sentences." }),
					notify_router: Type.Optional(Type.Boolean({ description: "Also tell the Router (default false)." })),
				}),
				async execute(_id, params): Promise<AgentToolResult<any>> {
					const id = `incident:${Date.now()}`;
					wd.deps.store.putObject({
						id,
						type: "message",
						summary: `watchdog incident — ${params.summary}`,
						ref: `mir://incident/${id}`,
						inlineIds: [],
					});
					if (params.notify_router) wd.deps.router.submitSignal(`watchdog: ${params.summary}`);
					log.warn("watchdog incident recorded", { id, summary: params.summary });
					return {
						content: [{ type: "text", text: `recorded ${id}` }],
						details: { id },
					};
				},
			}),
		];
	}

	start(): void {
		if (this.running || !this.options.enabled) return;
		this.running = true;
		void this.tick();
		this.timer = setInterval(() => void this.tick(), this.options.checkIntervalMs);
		this.timer.unref();
		log.info("watchdog started", { intervalMs: this.options.checkIntervalMs });
	}

	stop(): void {
		this.running = false;
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	/** One check: deterministic recovery first, then (if needed) model judgement. */
	async tick(now = Date.now()): Promise<Finding[]> {
		if (!this.options.enabled || this.ticking) return [];
		this.ticking = true;
		try {
			const recentFailures = this.deps
				.router.listTasks()
				.filter((t) => t.status === "failed" && t.updatedAt > this.lastFailureSeenAt);
			this.lastFailureSeenAt = now;
			const snapshot = this.snapshot(now, recentFailures);
			const findings = assess(snapshot, this.options);
			metrics.gauge("mir_watchdog_findings", findings.length);

			for (const finding of findings) {
				metrics.counter("mir_watchdog_findings_total", 1, { kind: finding.kind });
				log.warn("watchdog finding", { kind: finding.kind, message: finding.message });
			}

			// 1. Deterministic recovery — no model, no waiting.
			for (const finding of findings) {
				if (finding.kind === "stuck-worker" && finding.taskId) {
					await this.deps.router
						.stopTask(finding.taskId, "watchdog: worker stopped sending heartbeats")
						.catch((err) => log.error("watchdog stopTask failed", { error: (err as Error).message }));
				}
				if (finding.kind === "hung-router") {
					await this.deps.router.abortTurn("watchdog: turn exceeded its budget");
				}
			}

			// 2. Judgement — only when there is something to judge, and within budget.
			const judged = findings.filter((f) => f.kind !== "stuck-worker" && f.kind !== "hung-router");
			if (judged.length > 0 && this.session && this.takeTurnBudget(now)) {
				await this.runJudgementTurn(snapshot, findings);
			}
			return findings;
		} finally {
			this.ticking = false;
		}
	}

	private takeTurnBudget(now: number): boolean {
		if (now - this.windowStartedAt > 3_600_000) {
			this.windowStartedAt = now;
			this.turnsThisWindow = 0;
		}
		if (this.options.maxTurnsPerHour > 0 && this.turnsThisWindow >= this.options.maxTurnsPerHour) {
			log.warn("watchdog turn budget exhausted; deferring judgement", {
				turns: this.turnsThisWindow,
			});
			return false;
		}
		this.turnsThisWindow++;
		return true;
	}

	private async runJudgementTurn(snapshot: WatchdogSnapshot, findings: Finding[]): Promise<void> {
		if (!this.session) return;
		const prompt = [
			"You are the Watchdog for a super-agent (Router + Workers).",
			"Findings from this check:",
			...findings.map((f) => `- [${f.severity}] ${f.kind}: ${f.message}`),
			"",
			"System snapshot:",
			JSON.stringify(snapshot, null, 2),
			"",
			"Act with your tools if action is clearly warranted (stop_task, retry_task, set_trigger_policy), and record what you did with note_incident.",
			"Do not take action for transient noise. Be brief: one short paragraph at most.",
		].join("\n");
		try {
			await this.session.prompt(prompt);
			await settleSession(this.session);
			metrics.counter("mir_watchdog_turns_total");
		} catch (err) {
			log.error("watchdog judgement turn failed", { error: (err as Error).message });
		}
	}

	snapshot(now = Date.now(), recentFailures?: Task[]): WatchdogSnapshot {
		return {
			now,
			workers: this.deps.router.listWorkers(),
			tasks: this.deps.router.listTasks(),
			router: this.deps.router.status(),
			recentFailures,
		};
	}

	/** Maintainers can ask the watchdog why something failed (natural language). */
	async diagnose(workerId: string): Promise<string> {
		const info = this.deps.router.listWorkers().find((w) => w.id === workerId);
		if (!info) {
			const task = this.deps.store.listTasks().find((t) => t.workerId === workerId);
			if (task) {
				return `Worker ${workerId} is gone. Task ${task.id} ended as ${task.status}${
					task.error ? `: ${task.error}` : ""
				}.`;
			}
			return `Worker ${workerId} not found`;
		}
		return `Worker ${workerId} (task ${info.taskId}): status=${info.status}, last heartbeat ${
			Date.now() - info.lastHeartbeat
		}ms ago. Progress: ${info.progress ?? "none"}`;
	}

	async dispose(): Promise<void> {
		this.stop();
		await this.session?.dispose().catch(() => {});
		this.session = null;
	}
}
