/** Both layers search with it: a Worker over its live manager, the Router over the cached catalog. */

import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { formatMcpQueryResult, type McpCatalogEntry } from "./mcp-catalog.ts";

export function createMcpQueryTool(getCatalog: () => McpCatalogEntry[]): ToolDefinition {
	return defineTool({
		name: "mcp_query",
		label: "MCP query",
		description:
			"Search the MCP tools currently available to you. MCP tools appear as `mcp__<server>__<tool>` and are also callable from codemode scripts. " +
			"Pass `query` with space-separated terms matched against tool name, server, and description (every term must match). " +
			"Omit `query` to list all available MCP tools grouped by server. When MCP servers are hot-reloaded after a config change, this reflects the new set.",
		parameters: Type.Object({
			query: Type.Optional(
				Type.String({ description: "Search terms, e.g. 'filesystem read' or 'github issues'. Omit to list everything." }),
			),
			limit: Type.Optional(
				Type.Number({ description: "Max results (default 15, max 50)." }),
			),
		}),
		exposure: "direct",
		async execute(_id, params) {
			const entries = getCatalog();
			const text = formatMcpQueryResult(entries, params.query, params.limit);
			return {
				content: [{ type: "text", text }],
				details: {
					query: params.query ?? null,
					total: entries.length,
					servers: [...new Set(entries.map((e) => e.server))],
				},
			};
		},
	});
}
