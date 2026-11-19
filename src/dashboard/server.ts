/**
 * server.ts — the dashboard's own HTTP surface.
 *
 * Four endpoints, and no framework: the page, the state it renders, a stream that
 * tells it when the state changed, and the one action a person takes from here
 * (stop a task). The state is assembled from the brain's own readers, so a
 * dashboard and the brain cannot disagree — and a reload asks for it again rather
 * than trusting what the page last saw.
 *
 * **Auth is the client API's token**, in a query string for the page (a browser
 * cannot send a header for a navigation) and as a bearer for the API calls the
 * page makes. A dashboard that answers anyone who can reach the port is a
 * dashboard that shows a member's work to the network.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { Logger } from "../telemetry.ts";
import { metrics } from "../telemetry.ts";
import { renderDashboard } from "./html.ts";

/** Everything the page draws. Assembled per request, so it is never stale. */
export interface DashboardState {
	readonly agent: string;
	readonly identity?: string;
	readonly startedAt: number;
	readonly threads: ReadonlyArray<{
		id: string;
		name: string;
		status: string;
		seq: number;
		lastEventAt: number;
	}>;
	readonly tasks: ReadonlyArray<{
		id: string;
		title: string;
		description: string;
		status: string;
		workerId?: string;
		endpointId?: string;
		result?: string;
		error?: string;
		createdAt: number;
		updatedAt: number;
	}>;
	readonly scratchpad: ReadonlyArray<{
		id: string;
		kind: "outstanding" | "planned";
		text: string;
		threadId?: string;
		createdAt: number;
	}>;
	readonly hands: ReadonlyArray<{
		endpointId: string;
		name: string;
		connected: boolean;
		running: number;
		capabilities: Record<string, unknown>;
		policy: { maxConcurrent: number; roots: string[] };
	}>;
	readonly metrics: { counters: Record<string, number>; gauges: Record<string, number> };
}

export interface DashboardOptions {
	host: string;
	port: number;
	token: string;
	log: Logger;
	agent: string;
	/** Assemble the state now. Called per request and per push. */
	state: () => DashboardState;
	/** Stop one task, for the card's own button. */
	stopTask: (taskId: string) => Promise<void>;
	/** How often to push state while a client is listening. */
	pushMs?: number;
}

export class DashboardServer {
	private server: Server | null = null;
	private readonly options: DashboardOptions;
	private readonly clients = new Set<ServerResponse>();
	private timer: NodeJS.Timeout | null = null;

	constructor(options: DashboardOptions) {
		this.options = options;
	}

	get port(): number {
		const address = this.server?.address();
		return typeof address === "object" && address ? address.port : 0;
	}

	async start(): Promise<void> {
		if (this.options.token === "") {
			throw new Error("the dashboard needs a token (MIR_API_TOKEN)");
		}
		const server = createServer((req, res) => {
			void this.handle(req, res).catch((err: unknown) => {
				this.options.log.warn("dashboard: request failed", { error: (err as Error).message });
				this.json(res, 500, { error: "internal error" });
			});
		});
		this.server = server;
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(this.options.port, this.options.host, () => resolve());
		});
		this.options.log.info("dashboard listening", { address: `${this.options.host}:${this.port}` });

		// One timer for every listener: a dashboard is a page somebody leaves open,
		// and a timer per tab is a timer per tab.
		const every = this.options.pushMs ?? 2000;
		this.timer = setInterval(() => this.push(), every);
		this.timer.unref?.();
	}

	async stop(): Promise<void> {
		if (this.timer !== null) {
			clearInterval(this.timer);
			this.timer = null;
		}
		for (const client of this.clients) client.end();
		this.clients.clear();
		const server = this.server;
		if (server === null) return;
		this.server = null;
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	// ----- transport ------------------------------------------------------

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", "http://localhost");
		if (!this.authorized(req, url)) {
			this.json(res, 401, { error: "unauthorized" });
			return;
		}

		if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
			const html = renderDashboard({ agent: this.options.agent, basePath: "" });
			res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
			res.end(html);
			return;
		}

		if (req.method === "GET" && url.pathname === "/api/state") {
			this.json(res, 200, this.options.state());
			return;
		}

		if (req.method === "GET" && url.pathname === "/api/events") {
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-store",
				connection: "keep-alive",
				// A proxy that buffers an event stream turns it into a poll.
				"x-accel-buffering": "no",
			});
			res.write(": connected\n\n");
			this.clients.add(res);
			this.send(res, this.options.state());
			req.on("close", () => this.clients.delete(res));
			return;
		}

		const stop = /^\/api\/tasks\/([^/]+)\/stop$/.exec(url.pathname);
		if (req.method === "POST" && stop !== null) {
			const taskId = decodeURIComponent(stop[1]!);
			try {
				await this.options.stopTask(taskId);
				this.json(res, 200, { ok: true });
			} catch (err) {
				this.json(res, 404, { ok: false, error: (err as Error).message });
			}
			this.push();
			return;
		}

		this.json(res, 404, { error: "not found" });
	}

	private authorized(req: IncomingMessage, url: URL): boolean {
		const header = req.headers.authorization ?? "";
		const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : (url.searchParams.get("token") ?? "");
		if (presented === "") return false;
		const a = createHash("sha256").update(presented).digest();
		const b = createHash("sha256").update(this.options.token).digest();
		return a.length === b.length && timingSafeEqual(a, b);
	}

	private json(res: ServerResponse, status: number, body: unknown): void {
		res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
		res.end(JSON.stringify(body));
	}

	private send(res: ServerResponse, state: DashboardState): void {
		res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
	}

	private push(): void {
		if (this.clients.size === 0) return;
		let state: DashboardState;
		try {
			state = this.options.state();
		} catch (err) {
			this.options.log.warn("dashboard: could not assemble state", { error: (err as Error).message });
			return;
		}
		metrics.counter("mir_dashboard_pushes_total");
		for (const client of this.clients) this.send(client, state);
	}
}
