/**
 * The member's connected services, fetched from the stack and re-broadcast to live Workers
 * on change, so a server registered mid-run needs no restart.
 *
 * Nothing here is a credential: each `url` is the stack's own proxy and each
 * `authorization` is this brain's token, which names its member and nothing else.
 */

import { diffMcpConfigs, type McpConfigLike, type McpDiff } from "./mcp-catalog.ts";
import type { McpConfig } from "./mcp.ts";

/** How often a running brain re-asks. Registrations are human-paced; a minute is cheap. */
const DEFAULT_REFRESH_MS = 60_000;

export interface McpServersOptions {
	/** This stack's origin, from `MIR_STACK_URL`. */
	readonly stackUrl: string;
	/** This brain's own token, from `MIR_API_TOKEN`: the same one its socket answers. */
	readonly token: string;
	readonly refreshMs?: number;
	readonly fetch?: typeof fetch;
	/** The brain's own logger: message first, fields second (telemetry.ts). */
	readonly log?: { info(msg: string, fields?: Record<string, unknown>): void; warn(msg: string, fields?: Record<string, unknown>): void };
}

/** What the stack answers: an `mcp.config.json`, already shaped for `McpManager`. */
interface BrainMcpAnswer {
	readonly mcpServers?: Record<string, unknown>;
}

export class McpServers {
	private readonly options: McpServersOptions;
	private readonly fetchImpl: typeof fetch;
	private readonly listeners = new Set<(diff: McpDiff, config: McpConfig) => void>();
	private config: McpConfig = { mcpServers: {} };
	private hash = "";
	private timer: NodeJS.Timeout | null = null;
	private inFlight: Promise<McpConfig | null> | null = null;
	private stopped = false;
	private loggedUnreachable = false;

	constructor(options: McpServersOptions) {
		this.options = options;
		this.fetchImpl = options.fetch ?? fetch;
	}

	/** The config as it stands: what a Worker spawned right now should be given. */
	current(): McpConfig {
		return this.config;
	}

	/** Ask the stack, and tell every listener when the answer differs from the last one. */
	async refresh(): Promise<McpConfig | null> {
		if (this.inFlight !== null) return await this.inFlight;
		this.inFlight = this.ask().finally(() => {
			this.inFlight = null;
		});
		return await this.inFlight;
	}

	/** Called with each change, in order. Returns an unsubscribe. */
	onChange(listener: (diff: McpDiff, config: McpConfig) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Re-ask on a timer until stopped. Safe to call once. */
	start(): void {
		if (this.timer !== null || this.stopped) return;
		this.timer = setInterval(() => {
			void this.refresh();
		}, this.options.refreshMs ?? DEFAULT_REFRESH_MS);
		this.timer.unref?.();
	}

	stop(): void {
		this.stopped = true;
		if (this.timer !== null) clearInterval(this.timer);
		this.timer = null;
		this.listeners.clear();
	}

	private async ask(): Promise<McpConfig | null> {
		const url = new URL("/agent/brain-mcp", this.options.stackUrl).toString();
		let answer: BrainMcpAnswer;
		try {
			const res = await this.fetchImpl(url, {
				headers: { authorization: `Bearer ${this.options.token}` },
			});
			if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
			answer = (await res.json()) as BrainMcpAnswer;
		} catch (err) {
			// Once per outage, not once a minute: a stack that is down is one fact.
			if (!this.loggedUnreachable) {
				this.loggedUnreachable = true;
				this.options.log?.warn("mir: the stack did not say what this member may reach; keeping the last answer", { err, url });
			}
			return null;
		}
		this.loggedUnreachable = false;
		const next: McpConfig = { mcpServers: (answer.mcpServers ?? {}) as McpConfig["mcpServers"] };
		const hash = hashOf(next);
		if (hash === this.hash) return next;
		const diff = diffMcpConfigs(this.config as McpConfigLike, next as McpConfigLike);
		const first = this.hash === "";
		this.config = next;
		this.hash = hash;
		// The first answer is what a Worker is spawned with, so there is nothing to
		// tell a listener that is not there yet; every later one is a change.
		if (first) {
			this.options.log?.info("mir: this member's connected services are reachable", { servers: Object.keys(next.mcpServers).length });
			return next;
		}
		for (const listener of this.listeners) {
			try {
				listener(diff, next);
			} catch (err) {
				this.options.log?.warn("mir: an MCP change listener failed", { err });
			}
		}
		return next;
	}
}

/** A stable hash of a config: key order is the stack's, not ours, so sort before comparing. */
function hashOf(config: McpConfig): string {
	const servers = Object.keys(config.mcpServers)
		.sort()
		.map((name) => [name, config.mcpServers[name]] as const);
	return JSON.stringify(servers);
}
