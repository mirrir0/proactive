/**
 * Super-agent shared types.
 *
 * Mirrors the DeepSeek Harness Super-agent architecture:
 *   - Router layer: global continuity, dispatch, coordination
 *   - Worker layer: isolated task execution (own pm2 process, ADR 0001)
 *   - Triggers: filtered Events that arrived via a Channel
 *   - Threads: event streams routed to subscribed workers
 *   - Inline & Spill + Chain of Recall: context cache management
 */

import type { ChannelKind } from "./channels/types.ts";

export type ModelProvider = "openrouter";

/** An Event that passed filtering and now warrants a Router decision. */
export interface Trigger {
	id: string;
	/** Which Channel it came from (response tool is `respond_<channelId>`). */
	channelId: string;
	/** Transport kind, used for programmatic policies. */
	kind: ChannelKind;
	text: string;
	payload?: unknown;
	receivedAt: number;
	threadId?: string; // undefined => cold start, needs router dispatch
	replyTo?: string; // opaque reply address within the channel
	metadata?: Record<string, string>;
}

export interface Thread {
	id: string;
	name: string;
	channelId: string;
	subscriberWorkerIds: string[];
	lastEventAt: number;
}

export interface Task {
	id: string;
	title: string;
	description: string;
	threadId?: string;
	channelId?: string;
	replyTo?: string;
	status: TaskStatus;
	workerId?: string;
	createdAt: number;
	updatedAt: number;
	result?: string;
	error?: string;
}

export type TaskStatus = "queued" | "running" | "blocked" | "done" | "failed";

export interface WorkerInfo {
	id: string;
	taskId: string;
	status: "idle" | "busy" | "blocked" | "done" | "failed";
	threadIds: string[];
	lastHeartbeat: number;
	progress?: string;
}

export interface RouterDecision {
	action: "dispatch" | "route_to_worker" | "ignore" | "ask_user";
	workerId?: string;
	taskId?: string;
	reason?: string;
}

/**
 * OpenRouter provider-routing preferences. Sent verbatim as the `provider`
 * field in the OpenRouter API request body (see pi-ai's openRouterRouting).
 */
export interface OpenRouterRouting {
	only?: string[];
	order?: string[];
	ignore?: string[];
	quantizations?: string[];
	allow_fallbacks?: boolean;
	require_parameters?: boolean;
	data_collection?: "allow" | "deny";
	zdr?: boolean;
}

export interface SuperAgentConfig {
	modelId: string;
	thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	sessionDir: string;
	batchWindowMs: number;
	maxConcurrentWorkers: number;
	providerRouting?: OpenRouterRouting;
	/** Local Unix socket for the daemon↔worker control channel. */
	socketPath: string;
	/** HTTP webhook channel bind address. */
	httpHost: string;
	httpPort: number;
	/** File queue channel directory. */
	queueDir: string;
	/** How long a finished, idle Worker waits for follow-up events before exiting. */
	workerIdleExitMs: number;
	/** Cap on max_tokens per request (avoids OpenRouter reserving the whole context). */
	maxTokens: number;
}

export const DEFAULT_CONFIG: SuperAgentConfig = {
	modelId: "nvidia/nemotron-3.5-super-vl:free",
	thinkingLevel: "medium",
	sessionDir: "",
	batchWindowMs: 500,
	maxConcurrentWorkers: 8,
	providerRouting: undefined,
	/** Example forced routing (opt in via env). */
	// providerRouting: { only: ["deepinfra"], quantizations: ["fp8"], allow_fallbacks: false },
	socketPath: "",
	httpHost: "127.0.0.1",
	httpPort: 4599,
	queueDir: "",
	workerIdleExitMs: 120_000,
	maxTokens: 8192,
};
