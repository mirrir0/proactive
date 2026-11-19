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
import { renderPage, renderSection, setLinkToken, type DashboardEntry, type DashboardView } from "./html.ts";
import type { ChartId } from "./charts.ts";

/** Everything the page draws. Assembled per request, so it is never stale. */
export interface DashboardState {
	readonly agent: string;
	readonly identity?: string;
	readonly startedAt: number;
	readonly threads: ReadonlyArray<{
		id: string;
		name: string;
		status: string;
		/** The channel this conversation came from: http, terminal, queue, anomalous. */
		channelId?: string;
		seq: number;
		lastEventAt: number;
	}>;
	readonly tasks: ReadonlyArray<{
		id: string;
		title: string;
		description: string;
		status: string;
		threadId?: string;
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
		policy: { maxConcurrent?: number; roots: string[] };
	}>;
	readonly metrics: { counters: Record<string, number>; gauges: Record<string, number> };
	/** Samples this server took, oldest first — what the line and area charts read. */
	readonly history: ReadonlyArray<{ at: number; inFlight: number; threads: number; turns: number }>;
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
	/** A thread's entries from `since`, for the pane that follows one. */
	entries: (threadId: string, since: number, limit: number) => ReadonlyArray<unknown>;
	/** A thread's status, for the pane's header. */
	threadStatus: (threadId: string) => string | undefined;
	/** How often to push state while a client is listening. */
	pushMs?: number;
}

export class DashboardServer {
	private server: Server | null = null;
	private readonly options: DashboardOptions;
	/** One listener: the response, and the thread it is following (if any). */
	private readonly clients = new Map<ServerResponse, { threadId?: string; since: number }>();
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
		for (const client of this.clients.keys()) client.end();
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

		const route = routeOf(url.pathname);
		if (req.method === "GET" && route !== null) {
			const state = this.sample();
			const threadId = route.threadId;
			const selectedTask = url.searchParams.get("task") ?? undefined;
			// A panel a person closed stays closed across a reload, because it is in
			// the URL rather than in a variable.
			const workersOpen = url.searchParams.get("workers") !== "0";
			const entries = threadId === undefined ? [] : (this.options.entries(threadId, 0, 300) as DashboardEntry[]);
			setLinkToken(this.options.token);
			const html = renderPage({
				agent: this.options.agent,
				view: route.view,
				...(threadId === undefined ? {} : { threadId }),
				...(selectedTask === null || selectedTask === undefined ? {} : { selectedTask }),
				workersOpen,
				...(route.chart === undefined ? {} : { chart: route.chart as ChartId }),
				state,
				entries,
			});
			res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
			res.end(html);
			return;
		}

		// The section on its own, for the live swap: the same renderer, so a swapped
		// section and a reloaded one are identical.
		const partial = /^\/partial\/(work|threads|hands|scratchpad|metrics)$/.exec(url.pathname);
		if (req.method === "GET" && partial !== null) {
			setLinkToken(this.options.token);
			const html = renderSection({
				agent: this.options.agent,
				view: partial[1] as DashboardView,
				state: this.sample(),
			});
			res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
			res.end(html);
			return;
		}

		if (req.method === "GET" && url.pathname === "/api/state") {
			this.json(res, 200, this.sample());
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
			const threadId = url.searchParams.get("thread") ?? undefined;
			const since = Number(url.searchParams.get("since") ?? "0");
			res.write(": connected\n\n");
			this.clients.set(res, {
				...(threadId === undefined || threadId === "" ? {} : { threadId }),
				since: Number.isFinite(since) ? since : 0,
			});
			this.send(res, this.options.state());
			if (threadId !== undefined && threadId !== "") this.sendThread(res, threadId);
			req.on("close", () => this.clients.delete(res));
			return;
		}

		const thread = /^\/api\/threads\/([^/]+)\/entries$/.exec(url.pathname);
		if (req.method === "GET" && thread !== null) {
			const threadId = decodeURIComponent(thread[1]!);
			const since = Number(url.searchParams.get("since") ?? "0");
			const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit") ?? "200")));
			this.json(res, 200, {
				threadId,
				status: this.options.threadStatus(threadId) ?? "unknown",
				entries: this.options.entries(threadId, Number.isFinite(since) ? since : 0, limit),
			});
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

	/**
	 * The state, with the samples this server has taken.
	 *
	 * The registry is counters and gauges — no history, because a metric with a
	 * timestamp per point is a time-series database. A line chart needs a window, so
	 * this keeps the last 60 samples (two minutes at the push interval).
	 */
	private readonly samples: Array<{ at: number; inFlight: number; threads: number; turns: number }> = [];

	private sample(): DashboardState {
		const state = this.options.state();
		const inFlight = state.tasks.filter((task) => task.status === "running" || task.status === "queued").length;
		const turns = state.metrics.counters["mir_router_turns_total"] ?? 0;
		const last = this.samples.at(-1);
		if (last === undefined || Date.now() - last.at >= 1500) {
			this.samples.push({ at: Date.now(), inFlight, threads: state.threads.length, turns });
			if (this.samples.length > 60) this.samples.shift();
		}
		return { ...state, history: this.samples };
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
			state = this.sample();
		} catch (err) {
			this.options.log.warn("dashboard: could not assemble state", { error: (err as Error).message });
			return;
		}
		metrics.counter("mir_dashboard_pushes_total");
		for (const client of this.clients.keys()) this.send(client, state);
	}

	/**
	 * Tell the panes following a thread about the entry that just happened.
	 *
	 * Called from the brain's own publish path, so a thread pane is as live as the
	 * thread log: no polling interval, no "refresh to see more". A client that
	 * reconnects sends the `since` it has and gets exactly what it missed.
	 */
	publish(threadId: string, entry: { seq: number }): void {
		metrics.counter("mir_dashboard_entry_pushes_total");
		for (const [res, client] of this.clients) {
			if (client.threadId !== threadId) continue;
			if (entry.seq <= client.since) continue;
			client.since = entry.seq;
			res.write(`event: entry\ndata: ${JSON.stringify({ threadId, entry })}\n\n`);
		}
	}

	/** The pane's first frame: everything after its cursor. */
	private sendThread(res: ServerResponse, threadId: string): void {
		const client = this.clients.get(res);
		if (client === undefined) return;
		const entries = this.options.entries(threadId, client.since, 200);
		const last = entries.at(-1) as { seq?: number } | undefined;
		if (typeof last?.seq === "number") client.since = last.seq;
		res.write(
			`event: thread\ndata: ${JSON.stringify({
				threadId,
				status: this.options.threadStatus(threadId) ?? "unknown",
				entries,
			})}\n\n`,
		);
	}
}

/** `/`, `/threads`, `/threads/<id>`, `/hands`, `/scratchpad`, `/metrics`. */
function routeOf(pathname: string): { view: DashboardView; threadId?: string; chart?: string } | null {
	const clean = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
	if (clean === "/" || clean === "/index.html" || clean === "/work") return { view: "work" };
	if (clean === "/threads") return { view: "threads" };
	const thread = /^\/threads\/([^/]+)$/.exec(clean);
	if (thread !== null) return { view: "thread", threadId: decodeURIComponent(thread[1]!) };
	if (clean === "/hands") return { view: "hands" };
	if (clean === "/scratchpad") return { view: "scratchpad" };
	if (clean === "/metrics") return { view: "metrics" };
	const chart = /^\/metrics\/([a-z]+)$/.exec(clean);
	if (chart !== null) return { view: "metrics", chart: chart[1] };
	return null;
}
