/**
 * Two-stage filtering before the Router sees an event: programmatic policies, then a cheap
 * model judgement. A subscribed thread skips both — a follow-up on work the agent already
 * owns is interesting by definition.
 */

import type { SemanticPolicyConfig, Thread, Trigger, TriggerPolicyConfig } from "./types.ts";
import type { ChannelKind } from "./channels/types.ts";
import { ThreadManager } from "./thread.ts";
import { ADMIT_ALL_JUDGE, type SemanticJudge } from "./policy.ts";
import { log } from "./telemetry.ts";

// ---------- Stage 1: Programmatic policies (Fast Path) ----------

export type KindPolicy = "ignore" | "candidate" | "respond_only";

export interface ProgrammaticPolicies {
	kindPolicy: Partial<Record<ChannelKind, KindPolicy>>;
	allowedUsers: Set<string>;
	requireMention: Set<ChannelKind>;
}

export const DEFAULT_PROGRAMMATIC_POLICIES: ProgrammaticPolicies = {
	kindPolicy: {
		terminal: "respond_only",
		http: "candidate",
		queue: "candidate",
	},
	allowedUsers: new Set(),
	requireMention: new Set(),
};

/** Build policies from config, layering over the defaults. */
export function resolvePolicies(config: TriggerPolicyConfig = {}): ProgrammaticPolicies {
	return {
		kindPolicy: { ...DEFAULT_PROGRAMMATIC_POLICIES.kindPolicy, ...(config.kindPolicy ?? {}) },
		allowedUsers: new Set(config.allowedUsers ?? []),
		requireMention: new Set(config.requireMention ?? []),
	};
}

/** Deterministic admission check. Returns false if the Trigger is noise. */
export function programmaticFilter(
	trigger: Trigger,
	pol: ProgrammaticPolicies,
): { pass: boolean; reason?: string } {
	const policy = pol.kindPolicy[trigger.kind] ?? "candidate";
	if (policy === "ignore") {
		return { pass: false, reason: `channel kind ${trigger.kind} set to ignore` };
	}
	if (policy === "respond_only" && !trigger.metadata?.["explicit_request"]) {
		return { pass: false, reason: `${trigger.kind} requires an explicit request` };
	}
	if (pol.requireMention.has(trigger.kind) && !trigger.metadata?.["mentioned"]) {
		return { pass: false, reason: `${trigger.kind} requires @-mention` };
	}
	if (
		pol.allowedUsers.size > 0 &&
		trigger.metadata?.["user"] &&
		!pol.allowedUsers.has(trigger.metadata["user"])
	) {
		return { pass: false, reason: "user not in allowlist" };
	}
	return { pass: true };
}

// ---------- Router ----------

export interface RouteResult {
	thread: Thread;
	/** Several entries = fan-out to every subscriber; `"router"` = a decision; empty = filtered out. */
	targets: Array<"router" | `worker:${string}`>;
	reason?: string;
	/** Which stage made the decision (useful for metrics/abuse analysis). */
	stage: "programmatic" | "semantic" | "subscription" | "cold-start";
}

export interface TriggerSystemOptions {
	policies?: ProgrammaticPolicies;
	judge?: SemanticJudge;
	semanticPolicies?: SemanticPolicyConfig[];
	/** Master switch for the slow path. */
	semanticEnabled?: boolean;
}

export class TriggerSystem {
	private readonly threads: ThreadManager;
	private readonly policies: ProgrammaticPolicies;
	private readonly judge: SemanticJudge;
	private readonly semanticPolicies: SemanticPolicyConfig[];
	private readonly semanticEnabled: boolean;

	constructor(threads: ThreadManager, options: TriggerSystemOptions = {}) {
		this.threads = threads;
		this.policies = options.policies ?? resolvePolicies();
		this.judge = options.judge ?? ADMIT_ALL_JUDGE;
		this.semanticPolicies = options.semanticPolicies ?? [];
		this.semanticEnabled = options.semanticEnabled ?? false;
	}

	/** Process an incoming Trigger: filter, then route. */
	async process(trigger: Trigger): Promise<RouteResult> {
		const stage1 = programmaticFilter(trigger, this.policies);
		const thread = this.threads.getOrCreateThread(trigger);
		if (!stage1.pass) {
			return { thread, targets: [], reason: stage1.reason, stage: "programmatic" };
		}
		this.threads.touchThread(thread.id, trigger.receivedAt);

		// Fast path: an existing subscription means the thread is already owned.
		const subscribers = this.threads.getSubscribers(thread.id);
		if (subscribers.length > 0) {
			return {
				thread,
				targets: subscribers.map((w) => `worker:${w}` as const),
				reason: `pass-through to ${subscribers.length} subscribed worker(s)`,
				stage: "subscription",
			};
		}

		// Slow path: only for threads nobody owns yet.
		if (this.semanticEnabled && this.semanticPolicies.some((p) => p.enabled !== false)) {
			const verdict = await this.judge.judge(trigger, this.semanticPolicies);
			if (!verdict.act) {
				return {
					thread,
					targets: [],
					reason: `semantic: ${verdict.reason}`,
					stage: "semantic",
				};
			}
			log.debug("semantic judge admitted event", {
				event: trigger.id,
				reason: verdict.reason,
			});
		}

		return { thread, targets: ["router"], reason: "new thread, router dispatch", stage: "cold-start" };
	}

	getThreadManager(): ThreadManager {
		return this.threads;
	}

	getPolicies(): ProgrammaticPolicies {
		return this.policies;
	}

	/** Runtime policy adjustment (the Watchdog can use this). */
	updatePolicies(patch: TriggerPolicyConfig): void {
		const next = resolvePolicies({ ...this.getPolicyConfig(), ...patch });
		this.policies.kindPolicy = next.kindPolicy;
		this.policies.allowedUsers = next.allowedUsers;
		this.policies.requireMention = next.requireMention;
	}

	private getPolicyConfig(): TriggerPolicyConfig {
		return {
			kindPolicy: this.policies.kindPolicy,
			allowedUsers: [...this.policies.allowedUsers],
			requireMention: [...this.policies.requireMention],
		};
	}
}
