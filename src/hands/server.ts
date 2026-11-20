/**
 * Two listeners: endpoints dial *out* to a TCP (optionally TLS) port, so no inbound port
 * or static address is needed on a member's machine; Workers reach the hub on a local
 * socket, 0600, so the network never carries a brain's tool traffic.
 */

import net from "node:net";
import tls from "node:tls";
import fs from "node:fs";
import path from "node:path";
import type { HandsHub, EndpointConnection } from "./hub.ts";
import type { MirStore } from "../store.ts";
import type { Logger } from "../telemetry.ts";
import { metrics } from "../telemetry.ts";
import {
	FrameDecoder,
	HANDS_PROTOCOL_VERSION,
	encodeFrame,
	hashToken,
	tokensEqual,
	type ClientToHub,
	type EndpointToHub,
	type HandCapabilities,
	type HandPolicy,
	type HubToClient,
	type HubToEndpoint,
} from "./protocol.ts";
import { DEFAULT_HAND_CAPABILITIES, DEFAULT_HAND_POLICY } from "./protocol.ts";

export interface HandsServerOptions {
	hub: HandsHub;
	store: MirStore;
	log: Logger;
	/** Bind address for endpoints. */
	host: string;
	/** Port for endpoints (0 = ephemeral when enabled). */
	port: number;
	/** Start the endpoint listener. Defaults to `port > 0`. */
	enabled?: boolean;
	/** TLS material; when present the endpoint listener speaks TLS. */
	tls?: { cert: string; key: string };
	/** Unix socket workers connect to. */
	socketPath: string;
	/** Per-connection idle timeout for endpoints (ms). */
	idleTimeoutMs?: number;
}

interface RemoteHand extends EndpointConnection {
	socket: net.Socket | tls.TLSSocket;
}

export class HandsServer {
	private endpointServer: net.Server | null = null;
	private clientServer: net.Server | null = null;
	private readonly remoteHands = new Map<string, RemoteHand>();
	private readonly clientSockets = new Set<net.Socket>();
	private stopping = false;

	constructor(private readonly options: HandsServerOptions) {}

	/** Actual bound port for the endpoint listener (0 when disabled). */
	get port(): number {
		const address = this.endpointServer?.address();
		return typeof address === "object" && address ? address.port : 0;
	}

	get tlsEnabled(): boolean {
		return Boolean(this.options.tls);
	}

	async start(): Promise<void> {
		if (this.options.enabled ?? this.options.port > 0) await this.startEndpointListener();
		await this.startClientListener();
		this.options.log.info("hands server listening", {
			endpoints: this.endpointServer ? `${this.options.host}:${this.port}` : "disabled",
			tls: this.tlsEnabled,
			clients: this.options.socketPath,
		});
	}

	private async startEndpointListener(): Promise<void> {
		const handler = (socket: net.Socket) => this.acceptEndpoint(socket);
		const server = this.options.tls
			? tls.createServer(
					{
						cert: fs.readFileSync(this.options.tls.cert),
						key: fs.readFileSync(this.options.tls.key),
					},
					handler,
				)
			: net.createServer(handler);
		this.endpointServer = server;
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(this.options.port, this.options.host, () => resolve());
		});
		if (!this.options.tls && this.options.host !== "127.0.0.1" && this.options.host !== "::1") {
			this.options.log.warn("hands endpoint listener is unencrypted on a non-loopback address", {
				host: this.options.host,
				hint: "configure MIR_HANDS_TLS_CERT / MIR_HANDS_TLS_KEY before exposing it",
			});
		}
	}

	private async startClientListener(): Promise<void> {
		const socketPath = this.options.socketPath;
		fs.mkdirSync(path.dirname(socketPath), { recursive: true });
		try {
			fs.unlinkSync(socketPath);
		} catch {
			/* no stale socket */
		}
		this.clientServer = net.createServer((socket) => this.acceptClient(socket));
		await new Promise<void>((resolve, reject) => {
			this.clientServer!.once("error", reject);
			this.clientServer!.listen(socketPath, () => resolve());
		});
		// Only the owning user may ask this daemon to run work.
		try {
			fs.chmodSync(socketPath, 0o600);
		} catch {
			/* best effort */
		}
	}

	// ----- endpoint side -----

	private acceptEndpoint(socket: net.Socket): void {
		socket.setNoDelay(true);
		if (this.options.idleTimeoutMs) socket.setTimeout(this.options.idleTimeoutMs);

		let endpointId: string | null = null;
		const decoder = new FrameDecoder<EndpointToHub>((message) => {
			if (!endpointId) {
				if (message.type !== "hello") {
					socket.write(encodeFrame({ type: "reject", code: "expected-hello", message: "first frame must be hello" }));
					socket.destroy();
					return;
				}
				const verdict = this.authenticate(message);
				if (!verdict.ok) {
					this.options.log.warn("rejected hand", { endpoint: message.endpointId, reason: verdict.reason });
					metrics.counter("mir_hands_rejected_total");
					socket.write(encodeFrame({ type: "reject", code: "unauthorized", message: verdict.reason }));
					socket.destroy();
					return;
				}
				endpointId = message.endpointId;
				const hand = this.makeRemoteHand(message, socket);
				this.remoteHands.set(endpointId, hand);
				this.options.hub.registerEndpoint(hand);
				socket.write(
					encodeFrame({
						type: "welcome",
						v: HANDS_PROTOCOL_VERSION,
						endpointId,
						heartbeatMs: this.options.hub.heartbeatMs,
					}),
				);
				return;
			}
			this.options.hub.handleEndpointMessage(endpointId, message);
		});

		socket.on("data", (chunk) => {
			const result = decoder.push(chunk);
			if (!result.ok) {
				this.options.log.warn("hand sent an oversized frame; closing", {
					endpoint: endpointId ?? "unknown",
					error: result.error,
				});
				socket.destroy();
			}
		});
		const drop = (reason: string) => {
			if (!endpointId) return;
			const hand = this.remoteHands.get(endpointId);
			if (!hand || hand.socket !== socket) return;
			this.remoteHands.delete(endpointId);
			this.options.hub.removeEndpoint(endpointId, reason);
		};
		socket.on("close", () => drop("socket closed"));
		socket.on("error", (err) => drop(err.message));
		socket.on("timeout", () => {
			socket.destroy();
			drop("idle timeout");
		});
	}

	private authenticate(message: Extract<EndpointToHub, { type: "hello" }>): {
		ok: boolean;
		reason?: string;
	} {
		if (message.v !== HANDS_PROTOCOL_VERSION) {
			return { ok: false, reason: `protocol version ${message.v} != ${HANDS_PROTOCOL_VERSION}` };
		}
		if (!message.endpointId || typeof message.token !== "string") {
			return { ok: false, reason: "missing endpoint id or token" };
		}
		const record = this.options.store.getEndpoint(message.endpointId);
		if (!record) return { ok: false, reason: `unknown hand "${message.endpointId}" (run: mir hands add)` };
		if (record.revokedAt) return { ok: false, reason: "hand has been revoked" };
		if (!record.tokenHash) return { ok: false, reason: "hand has no token; re-add it" };
		const presented = hashToken(message.token);
		if (!tokensEqual(presented, record.tokenHash)) return { ok: false, reason: "invalid token" };
		return { ok: true };
	}

	private makeRemoteHand(
		hello: Extract<EndpointToHub, { type: "hello" }>,
		socket: net.Socket | tls.TLSSocket,
	): RemoteHand {
		const hand: RemoteHand = {
			endpointId: hello.endpointId,
			kind: "remote",
			name: hello.name || hello.endpointId,
			capabilities: normalizeCapabilities(hello.capabilities),
			// A remote hand's policy lives on the hand; the hub keeps a placeholder
			// it can use for scheduling decisions (load, output caps). What the hand
			// says it enforces is carried beside it, for a person to read and never
			// for a decision.
			policy: { ...DEFAULT_HAND_POLICY },
			...(hello.policySummary === undefined ? {} : { policySummary: hello.policySummary }),
			meta: hello.meta,
			lastSeen: Date.now(),
			running: 0,
			connected: true,
			socket,
			send: (message: HubToEndpoint) => {
				if (!socket.destroyed) socket.write(encodeFrame(message));
			},
			close: (reason?: string) => {
				if (!socket.destroyed) {
					socket.write(encodeFrame({ type: "reject", code: "closed", message: reason ?? "closed" }));
					socket.end();
				}
			},
		};
		return hand;
	}

	// ----- client (brain) side -----

	private acceptClient(socket: net.Socket): void {
		socket.setNoDelay(true);
		this.clientSockets.add(socket);
		let greeted = false;

		const send = (message: HubToClient) => {
			if (!socket.destroyed) socket.write(encodeFrame(message));
		};

		const decoder = new FrameDecoder<ClientToHub>((message) => {
			if (!greeted) {
				if (message.type !== "hello") {
					send({ type: "error", code: "expected-hello", message: "first frame must be hello" });
					socket.destroy();
					return;
				}
				if (message.v !== HANDS_PROTOCOL_VERSION) {
					send({
						type: "error",
						code: "protocol-mismatch",
						message: `protocol version ${message.v} != ${HANDS_PROTOCOL_VERSION}`,
					});
					socket.destroy();
					return;
				}
				greeted = true;
				send({ type: "ready", v: HANDS_PROTOCOL_VERSION, hands: this.options.hub.listHands() });
				return;
			}
			if (message.type === "call") {
				const id = message.id;
				void this.options.hub
					.call(message.call, {
						onChunk: (stream, data) => send({ type: "stream", id, stream, data }),
					})
					.then((result) => send({ type: "reply", id, result }))
					.catch((err) =>
						send({ type: "error", id, code: "internal", message: (err as Error).message }),
					);
				return;
			}
			if (message.type === "hands") {
				send({ type: "hands", id: message.id, hands: this.options.hub.listHands() });
				return;
			}
			if (message.type === "cancel") {
				// Cancellation is best-effort at this layer: the hub's deadline still
				// guarantees the call settles, so a client that gives up never leaks.
				this.options.log.debug("client cancelled a call", { id: message.id });
			}
		});

		socket.on("data", (chunk) => {
			const result = decoder.push(chunk);
			if (!result.ok) socket.destroy();
		});
		socket.on("close", () => this.clientSockets.delete(socket));
		socket.on("error", () => this.clientSockets.delete(socket));
	}

	async stop(): Promise<void> {
		if (this.stopping) return;
		this.stopping = true;
		for (const hand of this.remoteHands.values()) hand.close("server shutting down");
		this.remoteHands.clear();
		for (const socket of this.clientSockets) socket.destroy();
		this.clientSockets.clear();
		await Promise.all([
			new Promise<void>((resolve) => {
				if (!this.endpointServer) return resolve();
				this.endpointServer.close(() => resolve());
				this.endpointServer = null;
			}),
			new Promise<void>((resolve) => {
				if (!this.clientServer) return resolve();
				this.clientServer.close(() => resolve());
				this.clientServer = null;
			}),
		]);
		try {
			fs.unlinkSync(this.options.socketPath);
		} catch {
			/* already gone */
		}
	}
}

function normalizeCapabilities(raw: Partial<HandCapabilities> | undefined): HandCapabilities {
	return {
		exec: raw?.exec ?? DEFAULT_HAND_CAPABILITIES.exec,
		shell: raw?.shell ?? DEFAULT_HAND_CAPABILITIES.shell,
		fs: raw?.fs === "none" || raw?.fs === "ro" || raw?.fs === "rw" ? raw.fs : DEFAULT_HAND_CAPABILITIES.fs,
		git: raw?.git ?? DEFAULT_HAND_CAPABILITIES.git,
	};
}
