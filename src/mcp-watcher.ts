/**
 * Watches the config file's directory (so atomic saves trigger), debounces bursts, and
 * diffs servers against the last good snapshot. A corrupt or missing file keeps the last
 * good baseline rather than tearing down working connections.
 */

import fs from "node:fs";
import path from "node:path";
import { diffMcpConfigs, isEmptyDiff, type McpDiff } from "./mcp-catalog.ts";
import type { McpConfig } from "./mcp.ts";

export interface McpConfigWatcherOptions {
	/** Debounce window for file events. Default 300ms. */
	debounceMs?: number;
}

export class McpConfigWatcher {
	private readonly configPath: string;
	private readonly debounceMs: number;
	private readonly onChange: (diff: McpDiff, config: McpConfig) => void;
	private watcher: fs.FSWatcher | null = null;
	private timer: NodeJS.Timeout | null = null;
	private lastRaw: string | null = null;
	private lastConfig: McpConfig = { mcpServers: {} };
	private stopped = false;

	constructor(
		configPath: string,
		onChange: (diff: McpDiff, config: McpConfig) => void,
		options: McpConfigWatcherOptions = {},
	) {
		this.configPath = configPath;
		this.onChange = onChange;
		this.debounceMs = options.debounceMs ?? 300;
	}

	/** Establish the baseline snapshot and start watching. Safe to call once. */
	start(): void {
		const resolved = path.resolve(this.configPath);
		this.lastRaw = this.readRaw(resolved);
		this.lastConfig = this.parse(this.lastRaw) ?? { mcpServers: {} };

		const dir = path.dirname(resolved);
		const base = path.basename(resolved);
		try {
			this.watcher = fs.watch(dir, (eventType, filename) => {
				// filename can be null on some platforms — check conservatively.
				if (filename && path.basename(filename.toString()) !== base) return;
				this.scheduleCheck();
			});
			this.watcher.on("error", (err) => {
				console.error(`[mcp-watcher] watch error on ${dir}:`, err.message);
			});
			console.error(`[mcp-watcher] watching ${resolved}`);
		} catch (err) {
			console.error(`[mcp-watcher] failed to watch ${dir}:`, (err as Error).message);
		}
	}

	stop(): void {
		this.stopped = true;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		if (this.watcher) {
			this.watcher.close();
			this.watcher = null;
		}
	}

	private readRaw(resolved: string): string | null {
		try {
			return fs.readFileSync(resolved, "utf8");
		} catch {
			return null;
		}
	}

	private parse(raw: string | null): McpConfig | null {
		if (raw === null) return null;
		try {
			const parsed = JSON.parse(raw) as McpConfig;
			if (!parsed || typeof parsed !== "object" || typeof parsed.mcpServers !== "object" || parsed.mcpServers === null) {
				throw new Error("expected top-level { \"mcpServers\": { ... } }");
			}
			return parsed;
		} catch (err) {
			console.error(`[mcp-watcher] ${this.configPath} does not parse (${(err as Error).message}); keeping last good config`);
			return null;
		}
	}

	private scheduleCheck(): void {
		if (this.stopped) return;
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.timer = null;
			this.check();
		}, this.debounceMs);
		this.timer.unref();
	}

	/** Re-read the file and emit a diff if the server set actually changed. */
	private check(): void {
		if (this.stopped) return;
		const resolved = path.resolve(this.configPath);
		const raw = this.readRaw(resolved);
		if (raw === null) {
			console.error(`[mcp-watcher] ${this.configPath} unreadable (deleted?); keeping last good config`);
			return;
		}
		if (raw === this.lastRaw) return; // event without content change
		const next = this.parse(raw);
		if (!next) return; // parse() already logged; keep old baseline
		const diff = diffMcpConfigs(this.lastConfig, next);
		this.lastRaw = raw;
		this.lastConfig = next;
		if (isEmptyDiff(diff)) {
			console.error(`[mcp-watcher] ${this.configPath} touched; no server changes`);
			return;
		}
		console.error(
			`[mcp-watcher] change detected: added=[${diff.added}] removed=[${diff.removed}] changed=[${diff.changed}]`,
		);
		try {
			this.onChange(diff, next);
		} catch (err) {
			console.error(`[mcp-watcher] onChange handler error:`, (err as Error).message);
		}
	}
}
