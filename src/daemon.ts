/**
 * Daemon entrypoint (`mir-daemon` under pm2).
 *
 * Runs the Router, Watchdog, the control server and every Channel listener.
 * Workers are separate pm2 processes (ADR 0001), spawned on demand.
 *
 * All configuration comes from the environment (see .env.example). Anything
 * security-relevant is logged at startup so an unsafe deployment is never
 * silent: unauthenticated channels, permissive worker capabilities, a public
 * bind address.
 */

import { homedir } from "node:os";
import { loadEnv, expandHome } from "./env.ts";
import { mirPaths } from "./paths.ts";
import { join } from "node:path";
import { SuperAgent } from "./superagent.ts";
import type { Channel } from "./channels/types.ts";
import { TerminalChannel } from "./channels/terminal.ts";
import { HttpChannel } from "./channels/http.ts";
import { QueueChannel } from "./channels/queue.ts";
import { parseCapabilities, authConfigured } from "./security.ts";
import { normalizePolicy } from "./hands/policy.ts";
import { DEFAULT_HAND_POLICY } from "./hands/protocol.ts";
import { log } from "./telemetry.ts";
import { McpServers } from "./mcp-servers.ts";
import type { SemanticPolicyConfig, SuperAgentConfig, WatchdogConfig } from "./types.ts";

function csvEnv(name: string): string[] | undefined {
	const v = process.env[name];
	if (!v) return undefined;
	const parts = v
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	return parts.length ? parts : undefined;
}

function numEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return fallback;
	const n = Number(raw);
	return Number.isFinite(n) ? n : fallback;
}

function boolEnv(name: string, fallback: boolean): boolean {
	const raw = (process.env[name] ?? "").toLowerCase();
	if (!raw) return fallback;
	return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/** Semantic policies: a JSON array, or one natural-language policy from a single var. */
export function semanticPoliciesFromEnv(env: NodeJS.ProcessEnv = process.env): SemanticPolicyConfig[] {
	const json = env.MIR_SEMANTIC_POLICIES;
	if (json && json.trim()) {
		try {
			const parsed = JSON.parse(json);
			if (Array.isArray(parsed)) {
				return parsed
					.filter((p) => p && typeof p.prompt === "string")
					.map((p, i) => ({
						name: typeof p.name === "string" ? p.name : `policy-${i + 1}`,
						prompt: p.prompt as string,
						enabled: p.enabled !== false,
					}));
			}
		} catch {
			log.warn("MIR_SEMANTIC_POLICIES is not valid JSON; ignoring", {});
		}
	}
	const single = env.MIR_SEMANTIC_POLICY;
	if (single && single.trim()) return [{ name: "default", prompt: single.trim(), enabled: true }];
	return [];
}

export function buildConfig(env: NodeJS.ProcessEnv = process.env): SuperAgentConfig {
	// Where this install keeps its files, on this platform (see paths.ts). Every
	// value below can still be overridden by its own environment variable, which is
	// what an existing deployment and a container both rely on.
	const paths = mirPaths();
	// The stack this brain belongs to, when it has one. Absent, this brain runs on
	// its own config file and reaches no connected service.
	const stackUrl = env.MIR_STACK_URL ?? "";
	const only = csvEnv("OPENROUTER_PROVIDER_ONLY");
	const quantizations = csvEnv("OPENROUTER_QUANTIZATIONS");
	const watchdog: WatchdogConfig = {
		enabled: boolEnv("MIR_WATCHDOG", true),
		checkIntervalMs: numEnv("MIR_WATCHDOG_INTERVAL_MS", 30_000),
		stuckMs: numEnv("MIR_WATCHDOG_STUCK_MS", 5 * 60_000),
		routerTurnTimeoutMs: numEnv("MIR_WATCHDOG_ROUTER_MS", 6 * 60_000),
		modelId: env.MIR_WATCHDOG_MODEL,
		maxTurnsPerHour: numEnv("MIR_WATCHDOG_MAX_TURNS_PER_HOUR", 30),
	};
	return {
		modelId: env.OPENROUTER_MODEL ?? "nvidia/nemotron-3.5-super-vl:free",
		fastModelId: env.MIR_FAST_MODEL_ID ?? "nvidia/nemotron-3.5-lightning:free",
		thinkingLevel: (env.MIR_THINKING ?? "medium") as SuperAgentConfig["thinkingLevel"],
		batchWindowMs: numEnv("MIR_BATCH_WINDOW_MS", 500),
		maxBatchSize: numEnv("MIR_MAX_BATCH_SIZE", 20),
		maxConcurrentWorkers: numEnv("MIR_MAX_WORKERS", 8),
		maxDispatchQueue: numEnv("MIR_MAX_DISPATCH_QUEUE", 50),
		providerRouting:
			only || quantizations ? { only, quantizations, allow_fallbacks: false } : undefined,
		httpHost: env.MIR_HTTP_HOST ?? "127.0.0.1",
		httpPort: numEnv("MIR_HTTP_PORT", 4599),
		httpToken: env.MIR_HTTP_TOKEN || undefined,
		httpHmacSecret: env.MIR_HTTP_HMAC_SECRET || undefined,
		queueDir: expandHome(env.MIR_QUEUE_DIR ?? paths.queueDir),
		queuePollMs: numEnv("MIR_QUEUE_POLL_MS", 2000),
		socketPath: expandHome(
			env.MIR_SOCKET_PATH ?? paths.daemonSocket,
		),
		// The door a display connects to. Off unless a socket is named: a daemon
		// that serves threads to nobody should not be listening.
		api: {
			socketPath: env.MIR_API_SOCKET ? expandHome(env.MIR_API_SOCKET) : "",
			token: env.MIR_API_TOKEN ?? "",
		},
		// A client that renders views fetches them here; the same token as the
		// client API, because it is the same brain answering.
		mcpApp: {
			host: env.MIR_MCP_APP_HOST ?? "127.0.0.1",
			port: numEnv("MIR_MCP_APP_PORT", 0),
			token: env.MIR_API_TOKEN ?? "",
		},
		dashboard: {
			host: env.MIR_DASHBOARD_HOST ?? "127.0.0.1",
			port: numEnv("MIR_DASHBOARD_PORT", 0),
			token: env.MIR_API_TOKEN ?? "",
		},
		workerIdleExitMs: numEnv("MIR_WORKER_IDLE_MS", 120_000),
		workerHeartbeatMs: numEnv("MIR_WORKER_HEARTBEAT_MS", 15_000),
		workerHelloTimeoutMs: numEnv("MIR_WORKER_HELLO_MS", 20_000),
		maxTokens: numEnv("MIR_MAX_TOKENS", 8192),
		workerSessionDir: expandHome(env.MIR_WORKER_STATE_DIR ?? join(paths.state, "worker-state")),
		// The durable store (SQLite, the journal, spilled objects) is the data
		// directory; `paths.state` holds what describes a *running* install.
		stateDir: expandHome(env.MIR_STATE_DIR ?? paths.data),
		mcpConfigPath: env.MIR_MCP_CONFIG_PATH ?? "mcp.config.json",
		// The stack says what this member may reach; without one, the file does.
		...(stackUrl === "" ? {} : { mcpServers: new McpServers({ stackUrl, token: env.MIR_API_TOKEN ?? "", log }) }),
		workerCapabilities: parseCapabilities(env.MIR_CAPABILITIES),
		workerToolPolicy: {
			allow: csvEnv("MIR_WORKER_TOOL_ALLOW"),
			deny: csvEnv("MIR_WORKER_TOOL_DENY"),
		},
		triggerPolicies: {
			kindPolicy: {
				terminal: "respond_only",
				http: (env.MIR_HTTP_POLICY as any) ?? "candidate",
				queue: (env.MIR_QUEUE_POLICY as any) ?? "candidate",
			},
			allowedUsers: csvEnv("MIR_ALLOWED_USERS"),
			requireMention: csvEnv("MIR_REQUIRE_MENTION") as any,
		},
		semanticFilter: {
			enabled: boolEnv("MIR_SEMANTIC_FILTER", true),
			modelId: env.MIR_SEMANTIC_MODEL,
			policies: semanticPoliciesFromEnv(env),
			maxJudgementsPerMinute: numEnv("MIR_SEMANTIC_MAX_PER_MINUTE", 120),
		},
		routerTurnTimeoutMs: numEnv("MIR_ROUTER_TURN_TIMEOUT_MS", 5 * 60_000),
		routerRetryBackoffMs: numEnv("MIR_ROUTER_RETRY_BACKOFF_MS", 2000),
		maxTriggerAttempts: numEnv("MIR_MAX_TRIGGER_ATTEMPTS", 3),
		eventRetentionMs: numEnv("MIR_EVENT_RETENTION_MS", 7 * 24 * 60 * 60_000),
		objectRetention: numEnv("MIR_OBJECT_RETENTION", 5000),
		metricsPort: numEnv("MIR_METRICS_PORT", 0),
		metricsHost: env.MIR_METRICS_HOST ?? "127.0.0.1",
		watchdog,
		hands: {
			enabled: boolEnv("MIR_HANDS", true),
			host: env.MIR_HANDS_HOST ?? "127.0.0.1",
			port: numEnv("MIR_HANDS_PORT", 4700),
			socketPath: expandHome(
				env.MIR_HANDS_SOCKET ?? paths.handsSocket,
			),
			tlsCert: env.MIR_HANDS_TLS_CERT || undefined,
			tlsKey: env.MIR_HANDS_TLS_KEY || undefined,
			heartbeatMs: numEnv("MIR_HANDS_HEARTBEAT_MS", 15_000),
			offlineGraceMs: numEnv("MIR_HANDS_OFFLINE_GRACE_MS", 90_000),
			requestTimeoutMs: numEnv("MIR_HANDS_REQUEST_TIMEOUT_MS", 10 * 60_000),
			local: boolEnv("MIR_HANDS_LOCAL", true),
			localPolicy: normalizePolicy(
				{
					roots: csvEnv("MIR_HANDS_LOCAL_ROOTS") ?? [process.cwd()],
					allow: csvEnv("MIR_HANDS_LOCAL_ALLOW") ?? DEFAULT_HAND_POLICY.allow,
					deny: csvEnv("MIR_HANDS_LOCAL_DENY") ?? [],
					maxConcurrent: numEnv("MIR_HANDS_LOCAL_MAX_CONCURRENT", DEFAULT_HAND_POLICY.maxConcurrent),
					defaultTimeoutMs: numEnv("MIR_HANDS_TIMEOUT_MS", DEFAULT_HAND_POLICY.defaultTimeoutMs),
					maxTimeoutMs: numEnv("MIR_HANDS_MAX_TIMEOUT_MS", DEFAULT_HAND_POLICY.maxTimeoutMs),
					maxOutputBytes: numEnv("MIR_HANDS_MAX_OUTPUT", DEFAULT_HAND_POLICY.maxOutputBytes),
					sandbox: boolEnv("MIR_HANDS_LOCAL_SANDBOX", false) ? "srt" : "none",
					network: {
						allowedDomains: csvEnv("MIR_HANDS_LOCAL_ALLOW_NET") ?? [],
						deniedDomains: csvEnv("MIR_HANDS_LOCAL_DENY_NET") ?? [],
						allowLocalBinding: boolEnv("MIR_HANDS_LOCAL_ALLOW_LOCAL_BINDING", false),
						allowUnixSockets: csvEnv("MIR_HANDS_LOCAL_UNIX_SOCKETS") ?? [],
					},
					denyReadPaths: csvEnv("MIR_HANDS_LOCAL_DENY_READ") ?? [],
					denyWritePaths: csvEnv("MIR_HANDS_LOCAL_DENY_WRITE") ?? [],
				},
				DEFAULT_HAND_POLICY,
			),
			localCapabilities: {
				exec: boolEnv("MIR_HANDS_LOCAL_EXEC", true),
				shell: boolEnv("MIR_HANDS_LOCAL_SHELL", false),
				fs: (env.MIR_HANDS_LOCAL_FS as any) ?? "rw",
				git: boolEnv("MIR_HANDS_LOCAL_GIT", true),
			},
		},
		sessionDir: expandHome(env.MIR_ROUTER_SESSION ?? paths.sessions),
	};
}

export function buildChannels(config: SuperAgentConfig): Channel[] {
	return [
		new TerminalChannel(),
		new HttpChannel({
			host: config.httpHost,
			port: config.httpPort,
			token: config.httpToken,
			hmacSecret: config.httpHmacSecret,
		}),
		new QueueChannel({ dir: config.queueDir, pollMs: config.queuePollMs }),
	];
}

export async function runDaemon(): Promise<void> {
	loadEnv();
	const config = buildConfig();
	const channels = buildChannels(config);

	const agent = new SuperAgent(config, { channels });
	await agent.init();
	await agent.start();

	for (const ch of channels) {
		await ch.start((event) => {
			void agent.submitEvent(event);
		});
	}

	// Startup security posture, stated plainly in the log.
	for (const ch of channels) {
		const auth = ch.authenticated?.() ?? false;
		if (!auth) {
			log.warn("channel is unauthenticated", {
				channel: ch.id,
				kind: ch.kind,
				hint: "set MIR_HTTP_TOKEN / MIR_HTTP_HMAC_SECRET (http) or keep the bind on localhost",
			});
		}
	}
	if (config.workerCapabilities.net && config.workerCapabilities.fs === "rw") {
		log.warn("workers have full network + read/write filesystem capability", {
			hint: "tighten with MIR_CAPABILITIES=net,fs:ro or fs:none",
		});
	}
	if (config.hands.enabled && config.hands.port > 0 && !config.hands.tlsCert && config.hands.host !== "127.0.0.1" && config.hands.host !== "::1") {
		log.error("hands endpoint listener is unencrypted on a non-loopback address", {
			host: config.hands.host,
			port: config.hands.port,
			hint: "set MIR_HANDS_TLS_CERT / MIR_HANDS_TLS_KEY",
		});
	}
	if (config.httpHost !== "127.0.0.1" && config.httpHost !== "::1" && !authConfigured({ token: config.httpToken, hmacSecret: config.httpHmacSecret })) {
		log.error("HTTP channel is bound to a non-loopback address without authentication", {
			host: config.httpHost,
		});
	}

	const shutdown = async (signal: string) => {
		log.info("shutting down", { signal });
		// Stop accepting input first, then tear down state in dependency order.
		for (const ch of channels) await ch.stop().catch(() => {});
		await agent.stop().catch((err) => log.error("shutdown error", { error: (err as Error).message }));
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));
	process.on("unhandledRejection", (reason) => {
		log.error("unhandled rejection", { error: String(reason) });
	});
	process.on("uncaughtException", (err) => {
		log.error("uncaught exception", { error: err.message, stack: err.stack });
	});

	log.info("daemon channels live", {
		channels: channels.map((c) => c.id),
		http: `http://${config.httpHost}:${config.httpPort}/channels/http/events`,
		hands: config.hands.enabled
			? `${config.hands.host}:${config.hands.port}${config.hands.tlsCert ? " (tls)" : ""} + local`
			: "disabled",
	});
}

const invokedDirectly = process.argv[1] && /daemon\.(ts|js)$/.test(process.argv[1]);
if (invokedDirectly) {
	runDaemon().catch((err) => {
		log.error("daemon fatal", { error: (err as Error).message });
		process.exit(1);
	});
}
