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
import type { WorkerCapabilities } from "./security.ts";
import type { HandCapabilities, HandPolicy } from "./hands/protocol.ts";
import type { McpServers } from "./mcp-servers.ts";
import { DEFAULT_HAND_CAPABILITIES, DEFAULT_HAND_POLICY } from "./hands/protocol.ts";
import { mirPaths, type MirPaths } from "./paths.ts";

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
	/**
	 * The brief handed to the Worker, when it is more than the description.
	 *
	 * The description is what this is *for* — a line a person reads on a card. The
	 * brief is what the Worker is *told*: the paths, the constraints, the shape of
	 * the answer. One field could not be both, and a card that shows a full prompt
	 * is a card nobody reads.
	 */
	instructions?: string;
	threadId?: string;
	channelId?: string;
	replyTo?: string;
	status: TaskStatus;
	workerId?: string;
	createdAt: number;
	updatedAt: number;
	result?: string;
	error?: string;
	/** True if this task used the fast (lightning) model. */
	fast?: boolean;
	/** Hand this task was pinned to, when the Router chose one. */
	endpointId?: string;
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

/** OpenRouter provider-routing preferences (sent verbatim as `provider`). */
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
	/** Cap on judged events per minute (0 = unlimited). Protects the budget. */
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

/**
 * Hands: the execution environments this daemon can dispatch work to.
 * `local` registers the daemon's own machine so a deployment works out of the
 * box; remote hands dial out and are managed with `mir hands`.
 */
export interface HandsConfig {
	enabled: boolean;
	/** Endpoint listener bind address. */
	host: string;
	/** Endpoint listener port (0 = no listener; local hand only). */
	port: number;
	/** Unix socket the brains (Workers) use to reach the hub. */
	socketPath: string;
	tlsCert?: string;
	tlsKey?: string;
	heartbeatMs: number;
	offlineGraceMs: number;
	requestTimeoutMs: number;
	/** Register the daemon's own machine as a hand. */
	local: boolean;
	localPolicy: HandPolicy;
	localCapabilities: HandCapabilities;
}

export interface WorkerToolPolicy {
	allow?: string[];
	deny?: string[];
}

/**
 * The brain's client API: where a display connects, and with what token.
 *
 * Off unless a socket is named. When it is on, the brain serves the door
 * described in `src/api/protocol.ts` — threads, entries, say, stop, hands — and
 * nothing else.
 */
export interface BrainApiConfig {
	/** Unix socket path. Empty = the API is off. */
	socketPath: string;
	/** Shared bearer token. A brain with a socket and no token refuses to start. */
	token: string;
}

export interface SuperAgentConfig {
	modelId: string;
	/** Fast-model override for fast-task Workers (e.g. nemotron-3.5-lightning). */
	fastModelId: string;
	thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	sessionDir: string;
	/** Coalescing window applied only when the Router is idle (never reset mid-batch). */
	batchWindowMs: number;
	/** Max triggers folded into one Router prompt (rest are handled next turn). */
	maxBatchSize: number;
	maxConcurrentWorkers: number;
	/** Tasks beyond `maxConcurrentWorkers` wait here instead of being rejected. */
	maxDispatchQueue: number;
	providerRouting?: OpenRouterRouting;
	/** Local Unix socket for the daemon↔worker control channel. */
	socketPath: string;
	/** The client API a display connects to. Off by default. */
	api: BrainApiConfig & {
		/**
		 * The secret a signed member token is verified with.
		 *
		 * One daemon, several members: a token names its member and is signed with a
		 * secret both sides already hold. Empty means a single-member install, where
		 * `token` is the only way in.
		 */
		secret?: string;
		/** The member the static token belongs to. */
		member?: string;
	};
	/** Where this install keeps its files (paths.ts). The instance record lives here. */
	paths: MirPaths;
	/**
	 * The MCP app server: where a client fetches this brain's views (`ui://mir/work`)
	 * and calls their tools. Off unless a port is set, and it refuses to start
	 * without a token.
	 */
	mcpApp: { host: string; port: number; token: string };
	/** The web dashboard: what this brain is doing, for a person. Off by default. */
	dashboard: { host: string; port: number; token: string };
	/** HTTP webhook channel bind address. */
	httpHost: string;
	httpPort: number;
	/** Shared token / HMAC for the HTTP channel (empty = unauthenticated). */
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
		local: true,
		localPolicy: { ...DEFAULT_HAND_POLICY },
		localCapabilities: { ...DEFAULT_HAND_CAPABILITIES },
	},
};
