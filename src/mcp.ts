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
import { Type, type TSchema } from "typebox";
import { defineTool, type ToolDefinition, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { type CodemodeTool } from "@earendil-works/pi-codemode";
import { getOAuthManager } from "./mcp-oauth.ts";
import { readFileSync, existsSync } from "node:fs";
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
export class McpManager {
	private servers = new Map<string, ConnectedServer>();
	private started = false;
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
			try {
				await this.connectServer(name, serverConfig);
			} catch (err) {
				console.error(`[mcp] failed to connect to server "${name}":`, (err as Error).message);
				this.serverStatus.set(name, { ok: false, error: (err as Error).message });
			}
		}
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
		this.serverStatus.delete(name);
	}

	/** Flat catalog of every tool on every connected server (for mcp_query / daemon cache). */
	getToolCatalog(): McpCatalogEntry[] {
		const entries: McpCatalogEntry[] = [];
		for (const [name, server] of this.servers) {
			for (const mcpTool of server.tools) {
				entries.push(buildCatalogEntry(name, mcpTool));
			}
		}
		return entries;
	}

	/** Per-server health report for the daemon's catalog cache. */
	getServerReports(): McpServerReport[] {
		const names = new Set<string>([
			...Object.keys(this.lastConfig.mcpServers),
			...this.servers.keys(),
		]);
		const reports: McpServerReport[] = [];
		for (const name of [...names].sort()) {
			const connected = this.servers.get(name);
			const status = this.serverStatus.get(name);
			reports.push({
				name,
				ok: connected != null,
				error: connected ? undefined : status?.error ?? "not connected",
				toolCount: connected?.tools.length ?? 0,
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
		this.serverStatus.clear();
		this.started = false;
	}

	/** Get all tool definitions from all connected servers, converted for pi-coding-agent. */
	getToolDefinitions(): ToolDefinition[] {
		const defs: ToolDefinition[] = [];
		for (const [name, server] of this.servers) {
			for (const mcpTool of server.tools) {
				defs.push(mcpToolToToolDefinition(name, mcpTool, this));
			}
		}
		return defs;
	}

	/** Get all MCP tools as CodemodeTool[] for use as codemode sandbox globals. */
	getCodemodeTools(): CodemodeTool[] {
		const mcp = this;
		const tools: CodemodeTool[] = [];
		for (const [name, server] of this.servers) {
			for (const mcpTool of server.tools) {
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

		for (const [name] of this.servers) {
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
			const authProvider = oauth.getAuthProvider(serverUrl);

			// Try connecting; if the server requires OAuth, we'll get a 401 on listTools
			// and need to run the interactive flow.
			let connected = false;
			for (let attempt = 0; attempt < 2; attempt++) {
				try {
					transport = new StreamableHttpTransport({ url: serverUrl, authProvider });
					client = new McpClient({ name, version: "1.0.0" });
					await client.connect(transport);
					const tools = await client.listTools();
					this.servers.set(name, { name, client, tools, transport });
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
	const inputSchema = mcpTool.inputSchema ?? { type: "object", properties: {}, additionalProperties: false };
	const params = typeBoxFromJsonSchema(inputSchema);

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

/** Convert a JSON Schema object to a TypeBox schema. */
function typeBoxFromJsonSchema(schema: any): TSchema {
	const type = schema.type;
	const properties = schema.properties ?? {};
	const required = schema.required ?? [];

	if (type === "object") {
		const props: Record<string, any> = {};
		for (const [key, value] of Object.entries(properties)) {
			props[key] = typeBoxFromJsonSchema(value);
		}
		return Type.Object(props, {
			description: schema.description,
			...(required.length ? { required } : {}),
			additionalProperties: schema.additionalProperties ?? false,
		});
	}
	if (type === "string") {
		return Type.String({ description: schema.description });
	}
	if (type === "number") {
		return Type.Number({ description: schema.description });
	}
	if (type === "integer") {
		return Type.Integer({ description: schema.description });
	}
	if (type === "boolean") {
		return Type.Boolean({ description: schema.description });
	}
	if (type === "array") {
		const items = schema.items ? typeBoxFromJsonSchema(schema.items) : Type.Any();
		return Type.Array(items, { description: schema.description });
	}
	return Type.Any({ description: schema.description });
}
