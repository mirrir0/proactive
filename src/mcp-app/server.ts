/**
 * server.ts — mir as an MCP server, so a client can render mir's card.
 *
 * mir has always been an MCP *client*: it reaches the member's connected services
 * as a config (ADR 0006). This is the other direction, and it is what makes the
 * card an app rather than a client feature: the client fetches `ui://mir/work` from
 * here, and the view calls `work_status` here. Nothing about a "dispatch" or a
 * "hand" crosses the wire — a tool, a resource, and JSON-RPC.
 *
 * The surface is deliberately the small one in the specification rather than a
 * framework: `initialize`, `tools/list`, `tools/call`, `resources/list`,
 * `resources/read`, `ping`. One POST endpoint, JSON-RPC bodies, JSON responses
 * (streaming responses are optional in the transport, and a card does not stream).
 *
 * **Authorization is the same token the client API uses.** A brain that answers
 * anyone who can open a port is not one to leave running, so the server refuses to
 * start with no token, and every request is checked in constant time.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { Logger } from "../telemetry.ts";
import { metrics } from "../telemetry.ts";
import { CARD_MIME, CARD_URI, renderCard, taskIdFromUri, type CardData } from "./card.ts";

/** The MCP revision this server speaks. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface AppServerOptions {
	host: string;
	port: number;
	/** Bearer token every request must present. Empty = the server refuses to start. */
	token: string;
	log: Logger;
	/** Live state for one task, or undefined when it is not this brain's. */
	workStatus: (taskId: string) => CardData | undefined;
	/** Stop a task, for the card's own button. */
	stopWork: (taskId: string) => Promise<{ ok: boolean; error?: string }>;
	/** What this brain calls itself in `serverInfo`. */
	name?: string;
	version?: string;
}

interface JsonRpcRequest {
	jsonrpc: "2.0";
	id?: string | number;
	method: string;
	params?: Record<string, unknown>;
}

export class AppServer {
	private server: Server | null = null;
	private readonly options: AppServerOptions;

	constructor(options: AppServerOptions) {
		this.options = options;
	}

	get port(): number {
		const address = this.server?.address();
		return typeof address === "object" && address ? address.port : 0;
	}

	async start(): Promise<void> {
		if (this.options.token === "") {
			// The same rule as `mir serve`: no token, no listener.
			throw new Error("the MCP app server needs a token (MIR_API_TOKEN)");
		}
		const server = createServer((req, res) => {
			void this.handle(req, res).catch((err: unknown) => {
				this.options.log.warn("mcp-app: request failed", { error: (err as Error).message });
				this.fail(res, 500, -32603, "internal error");
			});
		});
		this.server = server;
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(this.options.port, this.options.host, () => resolve());
		});
		this.options.log.info("mcp app server listening", {
			address: `${this.options.host}:${this.port}`,
			resource: CARD_URI,
		});
	}

	async stop(): Promise<void> {
		const server = this.server;
		if (server === null) return;
		this.server = null;
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	// ----- transport ------------------------------------------------------

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", "http://localhost");
		if (!this.authorized(req, url)) {
			this.fail(res, 401, -32001, "unauthorized");
			return;
		}
		// A browser (or a person debugging) can read the view directly; the card is
		// not a secret, it is the same HTML the resource returns.
		if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/card")) {
			const taskId = url.searchParams.get("taskId") ?? "";
			const data = this.options.workStatus(taskId) ?? { taskId, title: "Work", status: "unknown" };
			res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
			res.end(renderCard(data));
			return;
		}
		if (req.method !== "POST" || url.pathname !== "/mcp") {
			this.fail(res, 404, -32601, "not found");
			return;
		}
		const body = await readBody(req);
		let message: JsonRpcRequest;
		try {
			message = JSON.parse(body) as JsonRpcRequest;
		} catch {
			this.fail(res, 400, -32700, "parse error");
			return;
		}
		const result = await this.dispatch(message);
		if (result === undefined) {
			// A notification: accepted, nothing to say.
			res.writeHead(202, { "cache-control": "no-store" });
			res.end();
			return;
		}
		res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
		res.end(JSON.stringify({ jsonrpc: "2.0", ...(message.id === undefined ? {} : { id: message.id }), ...result }));
	}

	private authorized(req: IncomingMessage, url?: URL): boolean {
		const header = req.headers.authorization ?? "";
		// A browser cannot send a header for a navigation, so the view accepts the
		// token in the query too — the same rule the dashboard follows. The API calls
		// a view makes still use the header.
		const fromHeader = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
		const presented = fromHeader === "" ? (url?.searchParams.get("token") ?? "") : fromHeader;
		if (presented === "") return false;
		const a = createHash("sha256").update(presented).digest();
		const b = createHash("sha256").update(this.options.token).digest();
		return a.length === b.length && timingSafeEqual(a, b);
	}

	private fail(res: ServerResponse, status: number, code: number, message: string): void {
		res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
		res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code, message } }));
	}

	// ----- the protocol ---------------------------------------------------

	private async dispatch(message: JsonRpcRequest): Promise<{ result?: unknown; error?: { code: number; message: string } } | undefined> {
		switch (message.method) {
			case "initialize":
				metrics.counter("mir_mcp_app_initialize_total");
				return {
					result: {
						protocolVersion: MCP_PROTOCOL_VERSION,
						capabilities: { tools: {}, resources: {} },
						serverInfo: { name: this.options.name ?? "mir", version: this.options.version ?? "1.0.0" },
					},
				};
			case "notifications/initialized":
			case "notifications/cancelled":
				return undefined;
			case "ping":
				return { result: {} };
			case "tools/list":
				return { result: { tools: this.tools() } };
			case "tools/call":
				return await this.callTool(message.params ?? {});
			case "resources/list":
				return { result: { resources: [this.resource()] } };
			case "resources/read":
				return this.readResource(message.params ?? {});
			default:
				return { error: { code: -32601, message: `method not found: ${message.method}` } };
		}
	}

	private tools(): unknown[] {
		const card = { ui: { resourceUri: CARD_URI } };
		return [
			{
				name: "work_status",
				title: "Work status",
				description: "The current state of one piece of work: what it is, whether it is running, and its answer when it has one.",
				inputSchema: {
					type: "object",
					properties: { taskId: { type: "string", description: "The task this card is about." } },
					required: ["taskId"],
				},
				// The view asks; the model has `list_tasks` for the same question.
				_meta: { ui: { ...card.ui, visibility: ["app"] } },
			},
			{
				name: "stop_work",
				title: "Stop work",
				description: "Stop one piece of work. The person pressed the card's stop.",
				inputSchema: {
					type: "object",
					properties: { taskId: { type: "string" } },
					required: ["taskId"],
				},
				_meta: { ui: { ...card.ui, visibility: ["app"] } },
			},
			{
				name: "open_work",
				title: "Open work",
				description: "Show the card for one piece of work, and return its current state.",
				inputSchema: {
					type: "object",
					properties: { taskId: { type: "string" } },
					required: ["taskId"],
				},
				_meta: { ui: { ...card.ui, visibility: ["model", "app"] } },
			},
		];
	}

	private resource(): unknown {
		return {
			uri: CARD_URI,
			name: "Work card",
			description: "One piece of work: what it is, where it runs, and its answer.",
			mimeType: CARD_MIME,
			_meta: {
				ui: {
					// A card talks to its own server through the host and nothing else.
					csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
					// Fill and space, never a border: the client's own frame is enough.
					prefersBorder: false,
				},
			},
		};
	}

	private readResource(params: Record<string, unknown>): { result?: unknown; error?: { code: number; message: string } } {
		const uri = typeof params.uri === "string" ? params.uri : "";
		const base = uri.includes("?") ? uri.slice(0, uri.indexOf("?")) : uri;
		if (base !== CARD_URI) {
			return { error: { code: -32002, message: `unknown resource: ${uri}` } };
		}
		// The URI names the task, so a client that stored the entry re-reads *this*
		// card and gets the state now — which is what makes a reload correct.
		const taskId = taskIdFromUri(uri) ?? (typeof params.taskId === "string" ? params.taskId : "");
		const data = this.options.workStatus(taskId) ?? { taskId, title: "Work", status: "unknown" };
		return {
			result: { contents: [{ uri, mimeType: CARD_MIME, text: renderCard(data) }] },
		};
	}

	private async callTool(params: Record<string, unknown>): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
		const name = typeof params.name === "string" ? params.name : "";
		const args = (params.arguments ?? {}) as Record<string, unknown>;
		const taskId = typeof args.taskId === "string" ? args.taskId : "";
		if (taskId === "") return { error: { code: -32602, message: "taskId is required" } };

		switch (name) {
			case "work_status":
			case "open_work": {
				const data = this.options.workStatus(taskId);
				if (data === undefined) return { error: { code: -32004, message: `no work with id ${taskId}` } };
				metrics.counter("mir_mcp_app_status_total");
				return {
					result: {
						content: [{ type: "text", text: JSON.stringify(data) }],
						structuredContent: data,
						_meta: { ui: { resourceUri: CARD_URI } },
					},
				};
			}
			case "stop_work": {
				const stopped = await this.options.stopWork(taskId);
				metrics.counter("mir_mcp_app_stop_total", 1, { ok: String(stopped.ok) });
				if (!stopped.ok) {
					return {
						result: { content: [{ type: "text", text: stopped.error ?? "could not stop it" }], isError: true },
					};
				}
				const data = this.options.workStatus(taskId);
				return {
					result: {
						content: [{ type: "text", text: "stopped" }],
						...(data === undefined ? {} : { structuredContent: data }),
						_meta: { ui: { resourceUri: CARD_URI } },
					},
				};
			}
			default:
				return { error: { code: -32602, message: `unknown tool: ${name}` } };
		}
	}
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let body = "";
		req.on("data", (chunk: Buffer) => {
			body += chunk.toString("utf8");
			// A card's JSON-RPC is small; anything larger is not one.
			if (body.length > 1_000_000) {
				reject(new Error("request body too large"));
				req.destroy();
			}
		});
		req.on("end", () => resolve(body));
		req.on("error", reject);
	});
}
