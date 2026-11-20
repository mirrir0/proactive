/**
 * The slow path: a small, cheap model call with a strict output contract, for the events the
 * programmatic policies could not decide. Policies are prose, so a person can add one
 * without touching code. A judge error admits the event (fail-open) unless `failClosed`.
 */

import type { SemanticPolicyConfig } from "./types.ts";
import type { Trigger } from "./types.ts";
import { log } from "./telemetry.ts";
import { redactSecrets } from "./security.ts";

export interface SemanticVerdict {
	act: boolean;
	reason: string;
}

export interface SemanticJudge {
	judge(trigger: Trigger, policies: SemanticPolicyConfig[]): Promise<SemanticVerdict>;
}

/** Judge that admits everything — used when the slow path is disabled. */
export const ADMIT_ALL_JUDGE: SemanticJudge = {
	async judge() {
		return { act: true, reason: "semantic filter disabled" };
	},
};

/** Token bucket: `capacity` events per `windowMs`, refilling continuously. */
export class RateLimiter {
	private tokens: number;
	private last: number;
	constructor(
		private readonly capacity: number,
		private readonly windowMs: number,
		now = Date.now(),
	) {
		this.tokens = capacity;
		this.last = now;
	}

	take(now = Date.now()): boolean {
		if (this.capacity <= 0) return true;
		const elapsed = now - this.last;
		this.last = now;
		this.tokens = Math.min(this.capacity, this.tokens + (elapsed / this.windowMs) * this.capacity);
		if (this.tokens < 1) return false;
		this.tokens -= 1;
		return true;
	}
}

export interface LlmSemanticJudgeOptions {
	modelRuntime: any;
	model: any;
	/** Cap on judge output tokens. Keep it small: the answer is two fields. */
	maxTokens?: number;
	timeoutMs?: number;
	/** Judgements per minute; 0 = unlimited. */
	maxPerMinute?: number;
	/** Admit on judge error (default) or drop. */
	failClosed?: boolean;
}

const JUDGE_SYSTEM_PROMPT = [
	"You are the admission filter for an autonomous agent that works in group chats, code review and email.",
	"Decide whether ONE inbound message warrants the agent's attention, given the policies below.",
	"Be conservative: casual chat, acknowledgements, bot noise, CI status with no failure, and messages aimed at other people are NOT for the agent.",
	"A message is for the agent when it asks for work, reports a problem, asks a question the agent can answer, or is a direct instruction to the agent.",
	'Answer with JSON only: {"act": true|false, "reason": "<one short sentence>"}',
].join("\n");

/** Render the policy list + the event into a judge prompt (exported for tests). */
export function buildJudgePrompt(trigger: Trigger, policies: SemanticPolicyConfig[]): string {
	const enabled = policies.filter((p) => p.enabled !== false);
	const policyText =
		enabled.length > 0
			? enabled.map((p, i) => `${i + 1}. ${p.name}: ${p.prompt}`).join("\n")
			: "(no extra policies — apply the default rule above)";
	const meta = Object.entries(trigger.metadata ?? {})
		.map(([k, v]) => `${k}=${v}`)
		.join(" ");
	return [
		"Policies:",
		policyText,
		"",
		"Inbound message:",
		`channel: ${trigger.channelId} (${trigger.kind})`,
		`thread: ${trigger.threadId ?? "(new thread)"}`,
		`sender: ${trigger.metadata?.["user"] ?? trigger.metadata?.["from"] ?? "unknown"}`,
		meta ? `metadata: ${meta}` : "",
		"text:",
		"<<<",
		trigger.text,
		">>>",
		"",
		'JSON answer:',
	]
		.filter((line) => line !== "")
		.join("\n");
}

/** Extract the first JSON object from a model reply, tolerating prose/fences. */
export function parseVerdict(text: string): SemanticVerdict | null {
	const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
	const candidate = fenced ? fenced[1]! : text;
	const start = candidate.indexOf("{");
	const end = candidate.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	try {
		const parsed = JSON.parse(candidate.slice(start, end + 1)) as { act?: unknown; reason?: unknown };
		if (typeof parsed.act !== "boolean") return null;
		return { act: parsed.act, reason: typeof parsed.reason === "string" ? parsed.reason : "" };
	} catch {
		return null;
	}
}

export class LlmSemanticJudge implements SemanticJudge {
	private readonly limiter: RateLimiter;
	private readonly maxTokens: number;
	private readonly timeoutMs: number;
	private readonly failClosed: boolean;

	constructor(private readonly options: LlmSemanticJudgeOptions) {
		this.maxTokens = options.maxTokens ?? 200;
		this.timeoutMs = options.timeoutMs ?? 15_000;
		this.limiter = new RateLimiter(options.maxPerMinute ?? 0, 60_000);
		this.failClosed = options.failClosed ?? false;
	}

	async judge(trigger: Trigger, policies: SemanticPolicyConfig[]): Promise<SemanticVerdict> {
		const enabled = policies.filter((p) => p.enabled !== false);
		if (enabled.length === 0) return { act: true, reason: "no semantic policies configured" };

		if (!this.limiter.take()) {
			// Budget exhausted: admit, and let the Router's own judgement decide.
			// This preserves the batching property instead of silently dropping work.
			return { act: true, reason: "judge rate limit reached" };
		}

		const started = Date.now();
		try {
			const reply = await this.complete(buildJudgePrompt(trigger, enabled));
			const verdict = parseVerdict(reply);
			if (!verdict) {
				log.warn("semantic judge returned unparseable output", {
					event: trigger.id,
					ms: Date.now() - started,
					reply: redactSecrets(reply).slice(0, 200),
				});
				return { act: !this.failClosed, reason: "unparseable judge output" };
			}
			return verdict;
		} catch (err) {
			log.warn("semantic judge failed", {
				event: trigger.id,
				ms: Date.now() - started,
				error: (err as Error).message,
			});
			return { act: !this.failClosed, reason: `judge error: ${(err as Error).message}` };
		}
	}

	private async complete(prompt: string): Promise<string> {
		const request = this.options.modelRuntime.completeSimple(
			this.options.model,
			{
				systemPrompt: JUDGE_SYSTEM_PROMPT,
				messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
			},
			{ maxTokens: this.maxTokens, temperature: 0 },
		);
		// A judge that hangs must never hold the event stream: race it out.
		const message = await Promise.race([
			request,
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error(`judge timed out after ${this.timeoutMs}ms`)), this.timeoutMs).unref(),
			),
		]);
		const content = Array.isArray(message?.content) ? message.content : [];
		return content
			.filter((part: any) => part?.type === "text")
			.map((part: any) => part.text)
			.join("\n");
	}
}
