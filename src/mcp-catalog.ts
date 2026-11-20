/** Shared types and pure helpers for the tool catalog. Nothing here imports MCP client code. */

/** One searchable MCP tool entry. */
export interface McpCatalogEntry {
	/** Full tool name as exposed to agents: `mcp__<server>__<tool>`. */
	name: string;
	/** MCP server name from mcp.config.json. */
	server: string;
	/** Bare tool name on the server. */
	tool: string;
	description: string;
	/** Compact argument summary, e.g. `path: string, encoding?: string`. */
	args: string;
}

/** Per-server health report sent by workers to the daemon. */
export interface McpServerReport {
	name: string;
	ok: boolean;
	/** Present when ok is false. */
	error?: string;
	toolCount: number;
}

/** Which servers a config reload added / removed / changed / failed to apply. */
export interface McpDiff {
	added: string[];
	removed: string[];
	/** Same name, different server config (command/args/url/env/...). */
	changed: string[];
	/** Attempted (added or changed) but the connection failed. */
	failed: string[];
}

/** Minimal structural shape of an MCP config (both McpManager and the watcher use this). */
export interface McpConfigLike {
	mcpServers: Record<string, unknown>;
}

/** Recursively sort object keys so JSON.stringify is stable for diffing. */
export function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const obj = value as Record<string, unknown>;
	const keys = Object.keys(obj).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** Diff two MCP config snapshots by server name. */
export function diffMcpConfigs(prev: McpConfigLike, next: McpConfigLike): McpDiff {
	const names = new Set([...Object.keys(prev.mcpServers), ...Object.keys(next.mcpServers)]);
	const diff: McpDiff = { added: [], removed: [], changed: [], failed: [] };
	for (const name of [...names].sort()) {
		const a = prev.mcpServers[name];
		const b = next.mcpServers[name];
		if (a && !b) diff.removed.push(name);
		else if (!a && b) diff.added.push(name);
		else if (stableStringify(a) !== stableStringify(b)) diff.changed.push(name);
	}
	return diff;
}

/** True when a diff contains no server-level changes. */
export function isEmptyDiff(diff: McpDiff): boolean {
	return diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0 && diff.failed.length === 0;
}

const MAX_ARGS_LISTED = 8;

/** Build a compact `args` summary from a JSON Schema object. */
export function summarizeArgs(inputSchema: unknown): string {
	const schema = (inputSchema ?? {}) as {
		properties?: Record<string, { type?: string | string[]; items?: { type?: string } }>;
		required?: string[];
	};
	const props = schema.properties ?? {};
	const required = new Set(Array.isArray(schema.required) ? schema.required : []);
	const names = Object.keys(props);
	if (names.length === 0) return "(no arguments)";
	const parts = names.slice(0, MAX_ARGS_LISTED).map((key) => {
		const p = props[key] ?? {};
		const t = Array.isArray(p.type) ? p.type.join("|") : (p.type ?? "any");
		const arr = t === "array" && p.items?.type ? `${p.items.type}[]` : t;
		const opt = required.has(key) ? "" : "?";
		return `${key}${opt}: ${arr}`;
	});
	if (names.length > MAX_ARGS_LISTED) parts.push(`… +${names.length - MAX_ARGS_LISTED} more`);
	return parts.join(", ");
}

/** Build a catalog entry from a raw MCP tool object. */
export function buildCatalogEntry(server: string, mcpTool: { name: string; description?: string; inputSchema?: unknown }): McpCatalogEntry {
	return {
		name: `mcp__${server}__${mcpTool.name}`,
		server,
		tool: mcpTool.name,
		description: (mcpTool.description ?? "").trim() || `Call ${mcpTool.name} on MCP server ${server}`,
		args: summarizeArgs(mcpTool.inputSchema),
	};
}

/** Score an entry against lowercase search terms. Returns 0 when not all terms match. */
function scoreEntry(entry: McpCatalogEntry, terms: string[]): number {
	const name = entry.name.toLowerCase();
	const server = entry.server.toLowerCase();
	const tool = entry.tool.toLowerCase();
	const desc = entry.description.toLowerCase();
	let score = 0;
	for (const term of terms) {
		let termScore = 0;
		if (tool === term) termScore += 10;
		if (name.includes(term)) termScore += 4;
		if (server.includes(term)) termScore += 3;
		if (desc.includes(term)) termScore += 1;
		if (termScore === 0) return 0; // every term must match somewhere
		score += termScore;
	}
	return score;
}

/** Search the catalog. Empty/blank query returns entries sorted by server then tool. */
export function searchMcpCatalog(entries: McpCatalogEntry[], query: string | undefined, limit: number): McpCatalogEntry[] {
	const cap = Math.max(1, Math.min(50, Math.floor(limit) || 15));
	const terms = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
	if (terms.length === 0) {
		return [...entries]
			.sort((a, b) => a.server.localeCompare(b.server) || a.tool.localeCompare(b.tool))
			.slice(0, cap);
	}
	return entries
		.map((entry) => ({ entry, score: scoreEntry(entry, terms) }))
		.filter((r) => r.score > 0)
		.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
		.slice(0, cap)
		.map((r) => r.entry);
}

/** Render query results as text for the mcp_query tool. */
export function formatMcpQueryResult(entries: McpCatalogEntry[], query: string | undefined, limit?: number): string {
	const cap = limit ?? 15;
	if (entries.length === 0) {
		return "No MCP tools are currently available (no MCP servers connected). If you expected some, the MCP config may be empty or a server failed to connect — check the daemon log.";
	}
	const servers = new Map<string, number>();
	for (const e of entries) servers.set(e.server, (servers.get(e.server) ?? 0) + 1);
	const summary = [...servers.entries()].map(([s, n]) => `${s} (${n})`).join(", ");
	const terms = (query ?? "").trim();
	if (!terms) {
		const lines = [`${entries.length} MCP tool(s) available across servers: ${summary}.`, ""];
		for (const e of searchMcpCatalog(entries, undefined, cap)) {
			lines.push(`${e.name}`);
			lines.push(`    args: ${e.args}`);
		}
		if (entries.length > cap) lines.push("", `… showing first ${cap}; pass a query or raise 'limit' to narrow/see more.`);
		return lines.join("\n");
	}
	const hits = searchMcpCatalog(entries, terms, cap);
	if (hits.length === 0) {
		return `No MCP tools match "${terms}". ${entries.length} tool(s) available across: ${summary}.`;
	}
	const lines = [`${hits.length} match(es) for "${terms}" (of ${entries.length} tool(s) across: ${summary}):`, ""];
	for (const e of hits) {
		lines.push(`${e.name} — ${e.description}`);
		lines.push(`    args: ${e.args}`);
	}
	return lines.join("\n");
}

/** One-line human description of a diff, used in the system signal message. */
export function formatMcpChangedText(diff: McpDiff): string {
	const bits: string[] = [];
	const fmt = (label: string, list: string[]) => {
		if (list.length) bits.push(`${label}: ${list.join(", ")}`);
	};
	fmt("added", diff.added);
	fmt("removed", diff.removed);
	fmt("changed", diff.changed);
	fmt("failed", diff.failed);
	if (bits.length === 0) return "[system] MCP config changed but no servers were added, removed, or modified.";
	return [
		`[system] MCP config changed — ${bits.join("; ")}.`,
		"MCP tools were hot-reloaded to match the new config.",
		"Use mcp_query to search the MCP tools now available to you.",
	].join(" ");
}
