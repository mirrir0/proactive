/** Shared types: Router, Worker (ADR 0001), Triggers, threads, context. */

import type { ChannelKind } from "./channels/types.ts";
import type { WorkerCapabilities } from "./security.ts";
import type { HandCapabilities, HandPolicy } from "./hands/protocol.ts";
import type { McpServers } from "./mcp-servers.ts";
import { DEFAULT_HAND_CAPABILITIES, DEFAULT_HAND_POLICY } from "./hands/protocol.ts";
import { mirPaths, type MirPaths } from "./paths.ts";

export type ModelProvider = "openrouter";

/** An Event that passed filtering and now warrants a Router decision. */
export interface Trigger {
	id: string;
	/** The response tool is `respond_<channelId>`. */
	channelId: string;
	/** Transport kind, used for programmatic policies. */
	kind: ChannelKind;
	text: string;
	payload?: unknown;
	receivedAt: number;
	threadId?: string; // undefined => cold start, needs router dispatch
	replyTo?: string; // opaque reply address within the channel
	metadata?: Record<string, string>;
	/** Carried from the `say` frame to the dispatch, so the hub cannot pick another folder. */
	hand?: string;
	/** How many Router turns have already tried to handle this trigger. */
	attempts?: number;
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
	/** What the task is for, in the words of the person who asked: what a card shows. */
	description: string;
	/** The brief for the Worker: paths, constraints, the shape of the answer. */
	instructions?: string;
	threadId?: string;
	/** The Worker's own log. The chat gets the card and the answer, not the narration. */
	workThreadId?: string;
	channelId?: string;
	replyTo?: string;
	status: TaskStatus;
	workerId?: string;
	createdAt: number;
	updatedAt: number;
	result?: string;
	error?: string;
	/** It ran on the fast model. */
	fast?: boolean;
	/** The hand this task is pinned to, when one was chosen. */
	endpointId?: string;
	/** A child's conclusion is its parent's return value, and a child cannot dispatch further. */
	parentTaskId?: string;
	/** 0 for the Router's own dispatch, 1 for a Worker's check. Absent means 0. */
	depth?: number;
}

export type TaskStatus = "queued" | "running" | "blocked" | "done" | "failed" | "cancelled";

export interface WorkerInfo {
	id: string;
	taskId: string;
	status: "idle" | "busy" | "blocked" | "done" | "failed";
	threadIds: string[];
	lastHeartbeat: number;
	progress?: string;
}

/** Sent verbatim as OpenRouter's `provider`. */
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

/** Router scheduling state, shared by the Router, Watchdog and health endpoint. */
export interface RouterStatus {
	turnCount: number;
	lastTurnAt: number;
	turnInFlightSince: number;
	queueDepth: number;
	draining: boolean;
	dispatchQueue: number;
	workers: number;
	tasks: number;
}

/** One semantic (model-judged) admission policy. */
export interface SemanticPolicyConfig {
	name: string;
	/** Natural-language rule the judge applies. */
	prompt: string;
	enabled?: boolean;
}

export interface TriggerPolicyConfig {
	/** Per channel-kind admission policy. */
	kindPolicy?: Partial<Record<ChannelKind, "ignore" | "candidate" | "respond_only">>;
	/** When non-empty, only these sender ids are admitted. */
	allowedUsers?: string[];
	/** Channel kinds that require an @-mention to be admitted. */
	requireMention?: ChannelKind[];
}

export interface SemanticFilterConfig {
	enabled: boolean;
	/** Model used for the slow path. Defaults to `fastModelId`. */
	modelId?: string;
	policies: SemanticPolicyConfig[];
	/** 0 = unlimited. Protects the budget. */
	maxJudgementsPerMinute?: number;
}

export interface WatchdogConfig {
	enabled: boolean;
	checkIntervalMs: number;
	/** Heartbeat age after which a busy worker is considered stuck. */
	stuckMs: number;
	/** A Router turn running longer than this is considered hung. */
	routerTurnTimeoutMs: number;
	/** Model used by the watchdog session. Defaults to `fastModelId`. */
	modelId?: string;
	/** Cap on watchdog model turns per hour (0 = unlimited). */
	maxTurnsPerHour?: number;
}

/** Hands: the execution environments work can be dispatched to. They dial out; `mir hands` manages them. */
export interface HandsConfig {
	enabled: boolean;
	/** Endpoint listener bind address. */
	host: string;
	/** 0 = no listener. */
	port: number;
	/** Where Workers reach the hub. */
	socketPath: string;
	tlsCert?: string;
	tlsKey?: string;
	heartbeatMs: number;
	offlineGraceMs: number;
	requestTimeoutMs: number;
	/** A client re-registers its hands on every start, so silence this long means the machine is gone. */
	staleAfterMs: number;
}

export interface WorkerToolPolicy {
	allow?: string[];
	deny?: string[];
}

/** Where a display connects. Off unless a socket is named; the frames are in `api/protocol.ts`. */
export interface BrainApiConfig {
	/** Unix socket path. Empty = the API is off. */
	socketPath: string;
	/** A brain with a socket and no token refuses to start. */
	token: string;
}

export interface SuperAgentConfig {
	modelId: string;
	/** For fast-task Workers. */
	fastModelId: string;
	thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	sessionDir: string;
	/** Applied only when the Router is idle; never reset mid-batch. */
	batchWindowMs: number;
	/** The rest are handled next turn. */
	maxBatchSize: number;
	maxConcurrentWorkers: number;
	/** Checks in flight across all Workers. Budgeted apart, so a fan-out cannot starve the Router. */
	maxNestedWorkers: number;
	/** Tasks beyond `maxConcurrentWorkers` wait here rather than being refused. */
	maxDispatchQueue: number;
	providerRouting?: OpenRouterRouting;
	/** The daemon↔worker control channel. */
	socketPath: string;
	/** Off by default. */
	api: BrainApiConfig & {
		/** Empty means a single-member install, where `token` is the only way in. */
		secret?: string;
		/** The member the static token belongs to. */
		member?: string;
	};
	/** Where this install keeps its files (see `paths.ts`). */
	paths: MirPaths;
	/** Where a client fetches this brain's views (`ui://mir/work`). Refuses to start without a token. */
	mcpApp: { host: string; port: number; token: string };
	/** What this brain is doing, for a person. Off by default. */
	dashboard: { host: string; port: number; token: string };
	/** HTTP webhook channel bind address. */
	httpHost: string;
	httpPort: number;
	/** Empty = unauthenticated. */
	httpToken?: string;
	httpHmacSecret?: string;
	/** File queue channel directory. */
	queueDir: string;
	/** Queue channel polling fallback interval (fs.watch is unreliable on some FS). */
	queuePollMs: number;
	/** How long a finished, idle Worker waits for follow-up events before exiting. */
	workerIdleExitMs: number;
	/** Worker heartbeat interval, independent of turn progress. */
	workerHeartbeatMs: number;
	/**
	 * How long a spawned Worker may take to connect before its task fails.
	 *
	 * A process manager that accepts a start and then loses the child is the common
	 * case — pm2's fork entry failing to resolve, a container without the module —
	 * and it reads exactly like a task that is running and doing nothing. Silence
	 * is not a state a person can see, so it gets a deadline and a word.
	 */
	workerHelloTimeoutMs: number;
	/** Cap on max_tokens per request (avoids OpenRouter reserving the whole context). */
	maxTokens: number;
	/** Directory where per-worker durable session files are written (pi-durable). */
	workerSessionDir: string;
	/** Directory for the daemon's durable state (mir.sqlite). */
	stateDir: string;
	/** Path to mcp.config.json for worker MCP server connections. */
	mcpConfigPath: string;
	/**
	 * This member's MCP servers as the stack serves them (`MIR_STACK_URL`). Unset
	 * means the file is the source, which is how a brain run by hand behaves.
	 */
	mcpServers?: McpServers;
	/** Capabilities granted to Workers (tool surface is a policy decision). */
	workerCapabilities: WorkerCapabilities;
	/** Extra tool allow/deny policy applied to Workers on top of capabilities. */
	workerToolPolicy: WorkerToolPolicy;
	/** Trigger admission policies. */
	triggerPolicies: TriggerPolicyConfig;
	/** Model-judged admission (slow path). */
	semanticFilter: SemanticFilterConfig;
	/** Wall-clock cap on one Router turn before it is aborted. */
	routerTurnTimeoutMs: number;
	/** Backoff before a failed Router batch is retried. */
	routerRetryBackoffMs: number;
	/** Max attempts for one batch before its events are failed. */
	maxTriggerAttempts: number;
	/** Retention for terminal events in the trigger log. */
	eventRetentionMs: number;
	/** Max spilled objects kept for Chain of Recall. */
	objectRetention: number;
	/** Prometheus metrics endpoint (0 = disabled). */
	metricsPort: number;
	metricsHost: string;
	watchdog: WatchdogConfig;
	hands: HandsConfig;
}

export const DEFAULT_CONFIG: SuperAgentConfig = {
	modelId: "nvidia/nemotron-3.5-super-vl:free",
	fastModelId: "nvidia/nemotron-3.5-lightning:free",
	thinkingLevel: "medium",
	sessionDir: "",
	batchWindowMs: 500,
	maxBatchSize: 20,
	maxConcurrentWorkers: 8,
	maxNestedWorkers: 4,
	maxDispatchQueue: 50,
	providerRouting: undefined,
	socketPath: "",
	mcpApp: { host: "127.0.0.1", port: 0, token: "" },
	dashboard: { host: "127.0.0.1", port: 0, token: "" },
	api: { socketPath: "", token: "" },
	paths: mirPaths(),
	httpHost: "127.0.0.1",
	httpPort: 4599,
	httpToken: undefined,
	httpHmacSecret: undefined,
	queueDir: "",
	queuePollMs: 2000,
	workerIdleExitMs: 120_000,
	workerHeartbeatMs: 15_000,
	workerHelloTimeoutMs: 20_000,
	maxTokens: 8192,
	workerSessionDir: "",
	stateDir: "",
	mcpConfigPath: "mcp.config.json",
	workerCapabilities: { net: true, fs: "rw", mcp: true, codemode: true },
	workerToolPolicy: {},
	triggerPolicies: {},
	semanticFilter: {
		enabled: true,
		policies: [],
		maxJudgementsPerMinute: 120,
	},
	routerTurnTimeoutMs: 5 * 60_000,
	routerRetryBackoffMs: 2000,
	maxTriggerAttempts: 3,
	eventRetentionMs: 7 * 24 * 60 * 60_000,
	objectRetention: 5000,
	metricsPort: 0,
	metricsHost: "127.0.0.1",
	watchdog: {
		enabled: true,
		checkIntervalMs: 30_000,
		stuckMs: 5 * 60_000,
		routerTurnTimeoutMs: 6 * 60_000,
		maxTurnsPerHour: 30,
	},
	hands: {
		enabled: true,
		host: "127.0.0.1",
		port: 4700,
		socketPath: "",
		heartbeatMs: 15_000,
		offlineGraceMs: 90_000,
		requestTimeoutMs: 10 * 60_000,
		staleAfterMs: 7 * 24 * 60 * 60_000,
	},
};
