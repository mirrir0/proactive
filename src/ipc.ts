/**
 * Control channel between the daemon and Worker processes (ADR 0001).
 *
 * A local Unix-domain socket carrying newline-delimited JSON.
 *
 *   worker → daemon:  hello { workerId, taskId }, status { status, progress? },
 *                     conclusion { text }, delta { text }
 *   daemon → worker:  event { event }, abort { reason? }
 *
 * Workers are pure clients: they connect to the daemon and never listen.
 */

import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import type { ChannelEvent } from "./channels/types.ts";

export type WorkerToDaemon =
	| { type: "hello"; workerId: string; taskId: string }
	| { type: "status"; status: string; progress?: string }
	| { type: "conclusion"; text: string }
	| { type: "delta"; text: string };

export type DaemonToWorker =
	| { type: "event"; event: ChannelEvent }
	| { type: "abort"; reason?: string };

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
export class ControlClient {
	private socket: net.Socket | null = null;
	private buf = "";
	private readonly eventHandlers = new Set<(e: ChannelEvent) => void>();
	private readonly abortHandlers = new Set<(reason?: string) => void>();

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
			}
		});
		this.send({ type: "hello", workerId: this.workerId, taskId: this.taskId });
	}

	onEvent(h: (e: ChannelEvent) => void): void {
		this.eventHandlers.add(h);
	}
	onAbort(h: (reason?: string) => void): void {
		this.abortHandlers.add(h);
	}

	status(status: string, progress?: string): void {
		this.send({ type: "status", status, progress });
	}
	conclusion(text: string): void {
		this.send({ type: "conclusion", text });
	}
	delta(text: string): void {
		this.send({ type: "delta", text });
	}

	private send(msg: WorkerToDaemon): void {
		if (this.socket && !this.socket.destroyed) {
			this.socket.write(JSON.stringify(msg) + "\n");
		}
	}

	close(): void {
		this.socket?.end();
		this.socket?.destroy();
		this.socket = null;
	}
}
