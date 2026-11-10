/**
 * Event Trigger System (Section 3).
 *
 * Events arrive on Channels. Before the Router sees one it must pass two-stage
 * filtering:
 *   1. Programmatic policies (Fast Path) — deterministic admission checks.
 *   2. Semantic policies (Slow Path) — a model decides whether to act.
 *
 * Then routing: if the Event's Thread already has subscribers, pass it straight
 * to the Worker (fast path). Otherwise cold-start it at the Router.
 */

import type { Thread, Trigger } from "./types.ts";
import type { ChannelKind } from "./channels/types.ts";
import { ThreadManager } from "./thread.ts";

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

// ---------- Stage 2: Semantic policies (Slow Path) ----------

export interface SemanticPolicy {
	name: string;
	prompt: string;
	enabled: boolean;
}

export function semanticFilter(
	_trigger: Trigger,
	_policies: SemanticPolicy[],
	_judge: (prompt: string) => Promise<boolean>,
): Promise<{ pass: boolean; reason?: string }> {
	// In production this calls the model. The Router's own turn is the semantic
	// judge today; here the placeholder admits candidate events.
	return Promise.resolve({ pass: true });
}

// ---------- Router ----------

export interface RouteResult {
	thread: Thread;
	/**
	 * "router" = needs Router-layer evaluation (cold start / new thread).
	 * "worker:<id>" = fast-path pass-through to a subscribed worker.
	 * "ignore" = filtered out.
	 */
	target: "router" | `worker:${string}` | "ignore";
	reason?: string;
}

export class TriggerSystem {
	private threads: ThreadManager;
	private policies: ProgrammaticPolicies;

	constructor(threads: ThreadManager, policies?: Partial<ProgrammaticPolicies>) {
		this.threads = threads;
		this.policies = {
			...DEFAULT_PROGRAMMATIC_POLICIES,
			...policies,
			kindPolicy: {
				...DEFAULT_PROGRAMMATIC_POLICIES.kindPolicy,
				...policies?.kindPolicy,
			},
			allowedUsers: new Set(policies?.allowedUsers),
			requireMention: new Set(policies?.requireMention),
		};
	}

	/** Process an incoming Trigger: filter, then route. */
	async process(
		trigger: Trigger,
		subscribersByThread: (threadId: string) => string[],
	): Promise<RouteResult> {
		const stage1 = programmaticFilter(trigger, this.policies);
		if (!stage1.pass) {
			const thread = this.threads.getOrCreateThread(trigger);
			return { thread, target: "ignore", reason: stage1.reason };
		}

		const stage2 = await semanticFilter(trigger, [], async () => true);
		if (!stage2.pass) {
			const thread = this.threads.getOrCreateThread(trigger);
			return { thread, target: "ignore", reason: stage2.reason };
		}

		const thread = this.threads.getOrCreateThread(trigger);
		this.threads.touchThread(thread.id, trigger.receivedAt);

		const subs = subscribersByThread(thread.id);
		if (subs.length > 0) {
			return { thread, target: `worker:${subs[0]}`, reason: "pass-through to subscribed worker" };
		}
		return { thread, target: "router", reason: "new thread, router dispatch" };
	}

	getThreadManager(): ThreadManager {
		return this.threads;
	}
}
