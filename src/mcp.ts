/**
 * MCP client integration for workers.
 *
 * Loads `mcp.config.json`, connects to each MCP server, lists their tools,
 * and converts them to pi-coding-agent `ToolDefinition` objects that can be
 * passed as `customTools` to `createAgentSession`. When the model calls an
 * MCP tool, the call is forwarded to the corresponding MCP server via
 * `McpClient.callTool()`.
 *
 * This gives workers access to external MCP servers (filesystem, database,
 * GitHub, etc.) while keeping the Router clean — only Workers get MCP tools.
 */

import { McpClient, StdioTransport, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import { McpOAuthAuthorizationRequiredError } from "@earendil-works/pi-mcp/oauth";
import type { TSchema } from "typebox";
import { defineTool, type ToolDefinition, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { type CodemodeTool } from "@earendil-works/pi-codemode";
import { getOAuthManager } from "./mcp-oauth.ts";
import { readFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveSecretRefs, secrets } from "./security.ts";
import {
	buildCatalogEntry,
	diffMcpConfigs,
	type McpCatalogEntry,
	type McpConfigLike,
	type McpDiff,
	type McpServerReport,
} from "./mcp-catalog.ts";

/** Shape of mcp.config.json. */
export interface McpConfig {
	mcpServers: Record<string, McpServerConfig>;
}

export interface McpServerConfig {
	command?: string;
	args?: string[];
	cwd?: string;
	url?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
	exposure?: "direct" | "codemode" | "deferred" | "hidden";
	inheritEnv?: boolean;
}

/** A connected MCP server with its client and discovered tools. */
interface ConnectedServer {
	name: string;
	client: McpClient;
	tools: any[]; // MCP Tool[]
	transport: any;
}

export type { McpCatalogEntry, McpDiff, McpServerReport } from "./mcp-catalog.ts";

/**
 * Manager for MCP client connections. One instance per Worker process.
 * Loads mcp.config.json, connects to servers, and exposes their tools.
 */
export interface McpManagerOptions {
	/**
	 * Where a server's tool list is remembered between Workers. A Worker is a
	 * fresh process, so without this every Worker pays a connect and a
	 * `tools/list` per server before it can do anything — seconds, when a server
	 * lists eighty tools over the network. The list is the same list.
	 */
	readonly cacheDir?: string;
}

/** What is remembered of a server's tools: enough to offer them, nothing that expires badly. */
interface CachedTools {
	readonly tools: unknown[];
	readonly at: number;
}

export class McpManager {
	private readonly options: McpManagerOptions;
	private servers = new Map<string, ConnectedServer>();
	/**
	 * Every server's tools, connected or remembered. This is what the model is
	 * offered: a server whose list is remembered has its tools from the first
	 * millisecond, and is dialled when one of them is called.
	 */
	private tools = new Map<string, any[]>();
	/** Servers known from the config but not dialled yet. */
	private pending = new Map<string, McpServerConfig>();
	/** One dial per server, however many callers ask at once. */
	private connecting = new Map<string, Promise<void>>();
	private started = false;

	constructor(options: McpManagerOptions = {}) {
		this.options = options;
	}
	/** Last config this manager applied (baseline for diffing). */
	private lastConfig: McpConfig = { mcpServers: {} };
	/** Per-server health: ok=false when a connection attempt fails. */
	private serverStatus = new Map<string, { ok: boolean; error?: string }>();

	/** Load MCP config from the given path. Returns empty config if file doesn't exist. */
	static loadConfig(configPath: string): McpConfig {
		if (!existsSync(configPath)) {
			return { mcpServers: {} };
		}
		const raw = readFileSync(configPath, "utf8");
		return JSON.parse(raw) as McpConfig;
	}

	/** Connect to all servers defined in the config. */
	async start(rawConfig: McpConfig): Promise<void> {
		if (this.started) return;
		this.started = true;
		// Credential broker: `${env:NAME}` refs are resolved here, at connect time,
		// and registered as secrets so they are redacted from logs and prompts.
		const config = resolveSecretRefs(rawConfig);
		registerServerSecrets(config);
		this.lastConfig = snapshotConfig(config);

		for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
			const remembered = this.remembered(serverConfig);
			if (remembered !== null) {
				// The model can call these now; the connection is made when it does,
				// or by the warm pass below, whichever comes first.
				this.tools.set(name, remembered);
				this.pending.set(name, serverConfig);
				continue;
			}
			try {
				await this.connectServer(name, serverConfig);
			} catch (err) {
				console.error(`[mcp] failed to connect to server "${name}":`, (err as Error).message);
				this.serverStatus.set(name, { ok: false, error: (err as Error).message });
			}
		}
		// Dial what was remembered, without holding the Worker's boot on it: the
		// tools are already offered, and a server that is slow to answer must not
		// delay the first turn.
		void this.warm();
	}

	/** Connect the servers whose tools were remembered, one at a time, in the background. */
	private async warm(): Promise<void> {
		for (const name of [...this.pending.keys()]) {
			await this.ensureConnected(name).catch(() => {});
		}
	}

	/**
	 * A server's tools as they were last listed, when the config still names the
	 * same target. Keyed by URL (a rename keeps the list); a server whose command
	 * or URL changed is a different server and is dialled afresh.
	 */
	private remembered(config: McpServerConfig): any[] | null {
		if (config.url === undefined) return null;
		const cache = this.readCache();
		const entry = cache[config.url];
		return entry !== undefined && Array.isArray(entry.tools) && entry.tools.length > 0 ? entry.tools : null;
	}

	private cachePath(): string | null {
		return this.options.cacheDir === undefined ? null : join(this.options.cacheDir, "mcp-tools.json");
	}

	private readCache(): Record<string, CachedTools> {
		const path = this.cachePath();
		if (path === null || !existsSync(path)) return {};
		try {
			return JSON.parse(readFileSync(path, "utf8")) as Record<string, CachedTools>;
		} catch {
			return {};
		}
	}

	private writeCache(url: string, tools: unknown[]): void {
		const path = this.cachePath();
		if (path === null) return;
		try {
			const cache = this.readCache();
			cache[url] = { tools, at: Date.now() };
			mkdirSync(this.options.cacheDir!, { recursive: true });
			// Written whole and renamed: several Workers of one brain share the file.
			const temp = `${path}.${process.pid}.tmp`;
			writeFileSync(temp, JSON.stringify(cache));
			renameSync(temp, path);
		} catch {
			// A cache that cannot be written costs a slow boot, not a broken one.
		}
	}

	/** The connection for `name`, dialled now if it was remembered. */
	private async ensureConnected(name: string): Promise<void> {
		if (this.servers.has(name)) return;
		const config = this.pending.get(name);
		if (config === undefined) throw new Error(`MCP server "${name}" is not configured`);
		const inFlight = this.connecting.get(name);
		if (inFlight !== undefined) return await inFlight;
		const dialling = this.connectServer(name, config)
			.then(() => {
				this.pending.delete(name);
			})
			.finally(() => {
				this.connecting.delete(name);
			});
		this.connecting.set(name, dialling);
		return await dialling;
	}


	/**
	 * Diff `config` against the last applied config, disconnect removed/changed
	 * servers, connect added/changed ones. Servers whose (re)connect fails are
	 * reported in `failed` and their tools disappear from the catalog.
	 * A no-op when nothing changed.
	 */
	async sync(rawConfig: McpConfig): Promise<McpDiff> {
		const config = resolveSecretRefs(rawConfig);
		registerServerSecrets(config);
		const diff = diffMcpConfigs(this.lastConfig as McpConfigLike, config as McpConfigLike);

		for (const name of diff.removed) {
			await this.disconnectServer(name);
		}
		for (const name of diff.changed) {
			await this.disconnectServer(name);
		}
		for (const name of [...diff.added, ...diff.changed]) {
			const serverConfig = config.mcpServers[name];
			if (!serverConfig) continue;
			try {
				await this.connectServer(name, serverConfig);
			} catch (err) {
				console.error(`[mcp] failed to connect to server "${name}":`, (err as Error).message);
				this.serverStatus.set(name, { ok: false, error: (err as Error).message });
				diff.failed.push(name);
			}
		}

		this.lastConfig = snapshotConfig(config);
		return diff;
	}

	/** Disconnect and forget one server (no-op when not connected). */
	private async disconnectServer(name: string): Promise<void> {
		const server = this.servers.get(name);
		if (server) {
			try {
				await server.client.close();
			} catch {
				// ignore — we're dropping it anyway
			}
			this.servers.delete(name);
			console.error(`[mcp] disconnected from server "${name}"`);
		}
		this.tools.delete(name);
		this.pending.delete(name);
		this.serverStatus.delete(name);
	}

	/** Flat catalog of every tool on every connected server (for mcp_query / daemon cache). */
	getToolCatalog(): McpCatalogEntry[] {
		const entries: McpCatalogEntry[] = [];
		for (const [name, tools] of this.tools) {
			for (const mcpTool of tools) {
				entries.push(buildCatalogEntry(name, mcpTool));
			}
		}
		return entries;
	}

	/** Per-server health report for the daemon's catalog cache. */
	getServerReports(): McpServerReport[] {
		const names = new Set<string>([
			...Object.keys(this.lastConfig.mcpServers),
			...this.tools.keys(),
			...this.servers.keys(),
		]);
		const reports: McpServerReport[] = [];
		for (const name of [...names].sort()) {
			const connected = this.servers.get(name);
			const status = this.serverStatus.get(name);
			// A remembered server is not dialled yet, and that is not a fault: its
			// tools are offered and the connection is made on the first call.
			const remembered = this.pending.has(name);
			reports.push({
				name,
				ok: connected != null || remembered,
				error: connected || remembered ? undefined : status?.error ?? "not connected",
				toolCount: this.tools.get(name)?.length ?? 0,
			});
		}
		return reports;
	}

	/** Disconnect from all servers. */
	async stop(): Promise<void> {
		for (const [name, server] of this.servers) {
			try {
				await server.client.close();
			} catch {
				// ignore
			}
			console.error(`[mcp] disconnected from server "${name}"`);
		}
		this.servers.clear();
		this.tools.clear();
		this.pending.clear();
		this.connecting.clear();
		this.serverStatus.clear();
		this.started = false;
	}

	/** Get all tool definitions from all connected servers, converted for pi-coding-agent. */
	getToolDefinitions(): ToolDefinition[] {
		const defs: ToolDefinition[] = [];
		for (const [name, tools] of this.tools) {
			for (const mcpTool of tools) {
				defs.push(mcpToolToToolDefinition(name, mcpTool, this));
			}
		}
		return defs;
	}

	/** Get all MCP tools as CodemodeTool[] for use as codemode sandbox globals. */
	getCodemodeTools(): CodemodeTool[] {
		const mcp = this;
		const tools: CodemodeTool[] = [];
		for (const [name, offered] of this.tools) {
			for (const mcpTool of offered) {
				tools.push({
					name: `mcp__${name}__${mcpTool.name}`,
					description: mcpTool.description ?? `Call ${mcpTool.name} on MCP server ${name}`,
					inputSchema: mcpTool.inputSchema ?? { type: "object", properties: {}, additionalProperties: false },
					async execute(args: unknown) {
						const result = await mcp.callMcpTool(`mcp__${name}__${mcpTool.name}`, args as Record<string, unknown>);
						return result.content.map((c: any) => (c.type === "text" ? c.text : JSON.stringify(c))).join("\n");
					},
				} as CodemodeTool);
			}
		}
		return tools;
	}

	/** Call a tool on a specific MCP server. Used by the tool execute handler. */
	async callMcpTool(toolName: string, args: Record<string, unknown>): Promise<AgentToolResult<any>> {
		// toolName is `mcp__<server>__<tool>`, split to get server and tool
		const parts = toolName.split("__");
		if (parts.length < 3) {
			return { content: [{ type: "text", text: `Invalid MCP tool name: ${toolName}` }], details: {}, isError: true };
		}
		// The tool name might contain underscores, so rejoin everything after "mcp__" except the last part
		// Format: mcp__{server}__{tool} — but server names could have underscores too
		// We need to find which server this belongs to
		let serverName: string | undefined;
		let mcpToolName: string | undefined;

		for (const name of this.tools.keys()) {
			const prefix = `mcp__${name}__`;
			if (toolName.startsWith(prefix)) {
				serverName = name;
				mcpToolName = toolName.slice(prefix.length);
				break;
			}
		}

		if (!serverName || !mcpToolName) {
			return { content: [{ type: "text", text: `MCP server not found for tool: ${toolName}` }], details: {}, isError: true };
		}

		// A server whose list was remembered is dialled here, on the call that
		// needs it, rather than before the Worker could do anything at all.
		try {
			await this.ensureConnected(serverName);
		} catch (err) {
			return {
				content: [{ type: "text", text: `MCP server "${serverName}" could not be reached: ${(err as Error).message}` }],
				details: { server: serverName },
				isError: true,
			};
		}
		const server = this.servers.get(serverName);
		if (!server) {
			return { content: [{ type: "text", text: `MCP server "${serverName}" not connected` }], details: {}, isError: true };
		}

		try {
			const result = await server.client.callTool(mcpToolName, args);
			const content: { type: "text"; text: string }[] = result.content?.map((c: any) => ({
				type: "text" as const,
				text: typeof c.text === "string" ? c.text : JSON.stringify(c),
			})) ?? [{ type: "text", text: "(no content)" }];
			return {
				content,
				details: { server: serverName, tool: mcpToolName, isError: result.isError },
				isError: result.isError === true,
			};
		} catch (err) {
			return {
				content: [{ type: "text", text: `MCP tool error: ${(err as Error).message}` }],
				details: { server: serverName, tool: mcpToolName },
				isError: true,
			};
		}
	}

	private async connectServer(name: string, config: McpServerConfig): Promise<void> {
		let client: McpClient;
		let transport: any;

		if (config.url) {
			const serverUrl = config.url;
			const oauth = getOAuthManager();
			// A server the config already carries a credential for is not one we run
			// an OAuth flow against: the header is the whole of the authentication,
			// and asking for a protected resource would discover the wrong address.
			const authProvider =
				config.headers?.authorization === undefined ? oauth.getAuthProvider(serverUrl) : undefined;

			// Try connecting; if the server requires OAuth, we'll get a 401 on listTools
			// and need to run the interactive flow.
			let connected = false;
			for (let attempt = 0; attempt < 2; attempt++) {
				try {
					transport = new StreamableHttpTransport({
						url: serverUrl,
						authProvider,
						// A server reached through a proxy that already knows who is calling
						// is authenticated by this header, not by an OAuth flow of its own:
						// without it, the client sees the 401, tries to discover a protected
						// resource and fails on an address that was never the target.
						...(config.headers === undefined ? {} : { headers: config.headers }),
					});
					client = new McpClient({ name, version: "1.0.0" });
					await client.connect(transport);
					const tools = await client.listTools();
					this.servers.set(name, { name, client, tools, transport });
					this.tools.set(name, tools);
					if (config.url !== undefined) this.writeCache(config.url, tools);
					this.serverStatus.set(name, { ok: true });
					console.error(`[mcp] connected to server "${name}" with ${tools.length} tools`);
					connected = true;
					break;
				} catch (err) {
					if (err instanceof McpOAuthAuthorizationRequiredError && attempt === 0) {
						// Run interactive OAuth flow, then retry.
						const ok = await oauth.authorize(serverUrl);
						if (!ok) {
							throw new Error(`OAuth authorization required for ${serverUrl} but not granted`);
						}
						continue; // retry with new tokens
					}
					throw err;
				}
			}
			if (!connected) {
				throw new Error(`Failed to connect to MCP server "${name}"`);
			}
		} else if (config.command) {
			transport = new StdioTransport({
				command: config.command,
				args: config.args,
				cwd: config.cwd,
				env: config.env,
				inheritEnv: config.inheritEnv !== false,
				stderr: "pipe",
			});
			client = new McpClient({ name, version: "1.0.0" });
			await client.connect(transport);

			const tools = await client.listTools();
			this.servers.set(name, { name, client, tools, transport });
			this.serverStatus.set(name, { ok: true });
			console.error(`[mcp] connected to server "${name}" with ${tools.length} tools`);
		} else {
			throw new Error(`MCP server "${name}" has no command or url`);
		}
	}
}

/** Register resolved credential values so they never reach a log or a prompt. */
function registerServerSecrets(config: McpConfig): void {
	for (const [name, server] of Object.entries(config.mcpServers ?? {})) {
		for (const [key, value] of Object.entries(server.env ?? {})) secrets.add(`${name}.${key}`, value);
		for (const [key, value] of Object.entries(server.headers ?? {})) {
			// "Bearer abc123" → register the credential part too.
			secrets.add(`${name}.${key}`, value);
			const bearer = /^\s*(?:Bearer|Basic|Token)\s+(.+)$/i.exec(value ?? "");
			if (bearer) secrets.add(`${name}.${key}`, bearer[1]!.trim());
		}
	}
}

/** Deep copy a config so later mutations by the caller don't corrupt the diff baseline. */
function snapshotConfig(config: McpConfig): McpConfig {
	return JSON.parse(JSON.stringify(config ?? { mcpServers: {} })) as McpConfig;
}

/** Convert an MCP Tool to a pi-coding-agent ToolDefinition. */
function mcpToolToToolDefinition(serverName: string, mcpTool: any, mcp: McpManager): ToolDefinition {
	const params = parametersOf(mcpTool.inputSchema);

	const fullToolName = `mcp__${serverName}__${mcpTool.name}`;

	return defineTool({
		name: fullToolName,
		label: `MCP: ${mcpTool.name}`,
		description: mcpTool.description ?? `Call ${mcpTool.name} on MCP server ${serverName}`,
		parameters: params as any,
		namespace: (`mcp__${serverName}` as any),
		exposure: "direct",
		async execute(_id, args, _signal, _onUpdate, _ctx) {
			return mcp.callMcpTool(fullToolName, args as Record<string, unknown>);
		},
	});
}

/**
 * A tool's parameters, as the server declared them.
 *
 * MCP `inputSchema` is JSON Schema already, and a TypeBox schema *is* JSON
 * Schema, so it is passed through rather than rebuilt. Rebuilding lost what the
 * server said: every property came back required (TypeBox marks all of them so
 * unless each is wrapped), and `enum`, `minLength`, `$ref` and friends were
 * dropped. A model reading that believed it had to supply every optional filter
 * on every call — Linear's `list_issues` declares sixteen and needs none — and
 * then reported the tool as unusable rather than calling it.
 *
 * A server that declares no object schema gets the permissive one.
 */
function parametersOf(inputSchema: unknown): TSchema {
	const schema = inputSchema as { readonly type?: unknown; readonly properties?: unknown } | null | undefined;
	const usable =
		schema !== null &&
		schema !== undefined &&
		typeof schema === "object" &&
		(schema.type === "object" || schema.properties !== undefined);
	return (usable ? schema : { type: "object", properties: {}, additionalProperties: false }) as TSchema;
}

