/**
 * Control channel between the daemon and Worker processes (ADR 0001).
 *
 * A local Unix-domain socket carrying newline-delimited JSON.
 *
 *   worker → daemon:  hello { v, workerId, taskId }, status { status, progress? },
 *                     heartbeat { status, progress? }, conclusion { text },
 *                     delta { text }, mcp_catalog { servers, tools },
 *                     release { eventId, reason }   — "not mine, re-route"
 *                     unsubscribe { threadId, reason } — "stop sending this thread"
 *   daemon → worker:  event { event }, abort { reason? },
 *                     system { kind: "mcp_changed", ... } — signal: hot-reload MCP
 *
 * Workers are pure clients: they connect to the daemon and never listen.
 *
 * The protocol carries a version (`PROTOCOL_VERSION`). ADR 0001 flagged that
 * the control channel is a protocol with its own compatibility surface; a
 * mismatched worker is refused rather than allowed to half-work.
 */

import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import type { ChannelEvent } from "./channels/types.ts";
import type { McpCatalogEntry, McpServerReport } from "./mcp-catalog.ts";
import type { McpConfig } from "./mcp.ts";
import { log } from "./telemetry.ts";

/** Bump when a message shape changes incompatibly. */
export const PROTOCOL_VERSION = 1;

export type WorkerToDaemon =
	| { type: "hello"; v: number; workerId: string; taskId: string }
	| { type: "status"; status: string; progress?: string }
	| { type: "heartbeat"; status: string; progress?: string }
	| { type: "conclusion"; text: string; taskId?: string }
	| { type: "delta"; text: string }
	| { type: "mcp_catalog"; servers: McpServerReport[]; tools: McpCatalogEntry[] }
	| { type: "release"; eventId: string; reason?: string }
	| { type: "unsubscribe"; threadId: string; reason?: string };

export type DaemonToWorker =
	| { type: "event"; event: ChannelEvent }
	| { type: "abort"; reason?: string }
	/** System signal: MCP server set changed; workers should hot-reload their MCP connections. */
	| {
			type: "system";
			kind: "mcp_changed";
			/** Preformatted one/two-line human text (also injected into the worker session). */
			text: string;
			added: string[];
			removed: string[];
			changed: string[];
			failed: string[];
			/** The config to load, when the daemon holds it rather than a file on disk. */
			config?: McpConfig;
	  };

export interface WorkerConnection {
	workerId: string;
	taskId: string;
	send(msg: DaemonToWorker): void;
	close(): void;
}

export interface ControlServerHandlers {
	onWorkerMessage(workerId: string, msg: WorkerToDaemon): void;
	onWorkerDisconnect(workerId: string): void;
}

/** Daemon side: accepts worker connections on a Unix socket. */
export class ControlServer {
	private server: net.Server | null = null;
	private readonly conns = new Map<string, net.Socket>();
	private readonly handlers: ControlServerHandlers;

	constructor(
		private readonly socketPath: string,
		handlers: ControlServerHandlers,
	) {
		this.handlers = handlers;
	}

	async start(): Promise<void> {
		fs.mkdirSync(path.dirname(this.socketPath), { recursive: true });
		try {
			fs.unlinkSync(this.socketPath);
		} catch {
			/* no stale socket */
		}
		this.server = net.createServer((socket) => this.accept(socket));
		await new Promise<void>((resolve, reject) => {
			this.server!.once("error", reject);
			this.server!.listen(this.socketPath, () => resolve());
		});
		// Only the owning user may talk to the control channel.
		try {
			fs.chmodSync(this.socketPath, 0o600);
		} catch {
			/* best effort (some filesystems ignore modes) */
		}
	}

	private accept(socket: net.Socket): void {
		let buf = "";
		let workerId: string | null = null;
		socket.on("data", (chunk) => {
			buf += chunk.toString("utf8");
			let nl: number;
			while ((nl = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				if (!line.trim()) continue;
				let msg: WorkerToDaemon;
				try {
					msg = JSON.parse(line);
				} catch {
					continue;
				}
				if (msg.type === "hello") {
					if (msg.v !== PROTOCOL_VERSION) {
						log.warn("refusing worker with mismatched protocol", {
							worker: msg.workerId,
							got: msg.v,
							expected: PROTOCOL_VERSION,
						});
						socket.write(
							JSON.stringify({ type: "abort", reason: `protocol mismatch: ${msg.v} != ${PROTOCOL_VERSION}` }) + "\n",
						);
						socket.end();
						return;
					}
					workerId = msg.workerId;
					this.conns.set(workerId, socket);
				}
				if (workerId) this.handlers.onWorkerMessage(workerId, msg);
			}
		});
		const drop = () => {
			if (workerId && this.conns.get(workerId) === socket) {
				this.conns.delete(workerId);
				this.handlers.onWorkerDisconnect(workerId);
			}
		};
		socket.on("close", drop);
		socket.on("error", drop);
	}

	/** Push a follow-up event to a running worker. */
	sendEvent(workerId: string, event: ChannelEvent): boolean {
		return this.send(workerId, { type: "event", event });
	}

	abort(workerId: string, reason?: string): boolean {
		return this.send(workerId, { type: "abort", reason });
	}

	/** Push a message to ALL connected workers. Returns the number sent. */
	broadcast(msg: DaemonToWorker): number {
		let sent = 0;
		const line = JSON.stringify(msg) + "\n";
		for (const socket of this.conns.values()) {
			if (socket.destroyed) continue;
			socket.write(line);
			sent++;
		}
		return sent;
	}

	isConnected(workerId: string): boolean {
		const socket = this.conns.get(workerId);
		return Boolean(socket && !socket.destroyed);
	}

	connectionCount(): number {
		return this.conns.size;
	}

	private send(workerId: string, msg: DaemonToWorker): boolean {
		const socket = this.conns.get(workerId);
		if (!socket || socket.destroyed) return false;
		socket.write(JSON.stringify(msg) + "\n");
		return true;
	}

	async stop(): Promise<void> {
		for (const socket of this.conns.values()) socket.destroy();
		this.conns.clear();
		await new Promise<void>((resolve) => {
			if (!this.server) return resolve();
			this.server.close(() => resolve());
			this.server = null;
		});
		try {
			fs.unlinkSync(this.socketPath);
		} catch {
			/* already gone */
		}
	}
}

/** Worker side: connects to the daemon's control server. */
export type SystemMessage = Extract<DaemonToWorker, { type: "system" }>;

export class ControlClient {
	private socket: net.Socket | null = null;
	private buf = "";
	private readonly eventHandlers = new Set<(e: ChannelEvent) => void>();
	private readonly abortHandlers = new Set<(reason?: string) => void>();
	private readonly systemHandlers = new Set<(msg: SystemMessage) => void>();

	constructor(
		private readonly socketPath: string,
		private readonly workerId: string,
		private readonly taskId: string,
	) {}

	async connect(): Promise<void> {
		this.socket = net.createConnection(this.socketPath);
		await new Promise<void>((resolve, reject) => {
			this.socket!.once("connect", () => resolve());
			this.socket!.once("error", reject);
		});
		this.socket.on("data", (chunk) => {
			this.buf += chunk.toString("utf8");
			let nl: number;
			while ((nl = this.buf.indexOf("\n")) >= 0) {
				const line = this.buf.slice(0, nl);
				this.buf = this.buf.slice(nl + 1);
				if (!line.trim()) continue;
				let msg: DaemonToWorker;
				try {
					msg = JSON.parse(line);
				} catch {
					continue;
				}
				if (msg.type === "event") for (const h of this.eventHandlers) h(msg.event);
				if (msg.type === "abort") for (const h of this.abortHandlers) h(msg.reason);
				if (msg.type === "system") for (const h of this.systemHandlers) h(msg);
			}
		});
		this.send({ type: "hello", v: PROTOCOL_VERSION, workerId: this.workerId, taskId: this.taskId });
	}

	onEvent(h: (e: ChannelEvent) => void): void {
		this.eventHandlers.add(h);
	}
	onAbort(h: (reason?: string) => void): void {
		this.abortHandlers.add(h);
	}
	onSystem(h: (msg: SystemMessage) => void): void {
		this.systemHandlers.add(h);
	}

	/** Report this worker's MCP catalog to the daemon (initial + after every hot-reload). */
	mcpCatalog(servers: McpServerReport[], tools: McpCatalogEntry[]): void {
		this.send({ type: "mcp_catalog", servers, tools });
	}

	status(status: string, progress?: string): void {
		this.send({ type: "status", status, progress });
	}

	/** Independent liveness signal — must not depend on turn progress. */
	heartbeat(status: string, progress?: string): void {
		this.send({ type: "heartbeat", status, progress });
	}

	conclusion(text: string): void {
		this.send({ type: "conclusion", text, taskId: this.taskId });
	}

	delta(text: string): void {
		this.send({ type: "delta", text });
	}

	/** "This follow-up is not mine" — hand the event back to the Router. */
	release(eventId: string, reason?: string): void {
		this.send({ type: "release", eventId, reason });
	}

	/** "Stop routing this thread to me." */
	unsubscribe(threadId: string, reason?: string): void {
		this.send({ type: "unsubscribe", threadId, reason });
	}

	private send(msg: WorkerToDaemon): void {
		if (this.socket && !this.socket.destroyed) {
			this.socket.write(JSON.stringify(msg) + "\n");
		}
	}

	/**
	 * Flush pending writes before exiting. `socket.end()` is asynchronous, and a
	 * `process.exit()` immediately after it can truncate the last message.
	 */
	async flush(timeoutMs = 1000): Promise<void> {
		const socket = this.socket;
		if (!socket || socket.destroyed) return;
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, timeoutMs);
			timer.unref();
			socket.end(() => {
				clearTimeout(timer);
				resolve();
			});
		});
	}

	close(): void {
		this.socket?.destroy();
		this.socket = null;
	}
}
