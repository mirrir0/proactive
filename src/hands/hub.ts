/**
 * Hands hub — the routing core that turns "run this on a machine" into a call.
 *
 * The hub knows nothing about transports: an endpoint connection is anything
 * that can `send` a `HubToEndpoint` message and hand back `EndpointToHub`
 * messages. That is what lets the same code serve a remote laptop over TLS, a
 * container over TCP, and the daemon's own machine in-process — which is exactly
 * the "the harness doesn't know whether the sandbox is a container, a phone, or
 * a Pokémon emulator" property.
 *
 * Failure model: a hand dying is a **tool error**, never a hung brain. Every
 * pending call is rejected when its endpoint disconnects, and every call has a
 * deadline after which the hub cancels and returns an error the model can react
 * to.
 */

import crypto from "node:crypto";
import type { MirStore } from "../store.ts";
import { metrics, type Logger } from "../telemetry.ts";
import type {
	EndpointToHub,
	HandCall,
	HandCallResult,
	HandCapabilities,
	HandPolicy,
	HandPolicySummary,
	HandStatus,
	HubToEndpoint,
	WorkItem,
} from "./protocol.ts";
import { handSupports } from "./protocol.ts";

export interface EndpointConnection {
	readonly endpointId: string;
	readonly kind: "local" | "remote";
	readonly name: string;
	capabilities: HandCapabilities;
	policy: HandPolicy;
	/** What the hand says it enforces, for display only. Never a decision. */
	policySummary?: HandPolicySummary;
	meta?: Record<string, string>;
	lastSeen: number;
	running: number;
	connected: boolean;
	send(message: HubToEndpoint): void;
	close(reason?: string): void;
}

interface PendingCall {
	workId: string;
	endpointId: string;
	op: string;
	startedAt: number;
	timer: NodeJS.Timeout;
	onChunk?: (stream: "stdout" | "stderr", data: string) => void;
	resolve: (result: HandCallResult) => void;
}

export interface HandsHubOptions {
	store?: MirStore;
	log: Logger;
	/** Default per-call deadline when the caller does not set one. */
	requestTimeoutMs?: number;
	/** How long an endpoint may go without a heartbeat before it is dropped. */
	offlineGraceMs?: number;
	heartbeatMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_OFFLINE_GRACE_MS = 90_000;
const DEFAULT_HEARTBEAT_MS = 15_000;

export class HandsHub {
	private readonly endpoints = new Map<string, EndpointConnection>();
	private readonly pending = new Map<string, PendingCall>();
	private readonly options: Required<Pick<HandsHubOptions, "requestTimeoutMs" | "offlineGraceMs" | "heartbeatMs">> &
		HandsHubOptions;
	private reaper: NodeJS.Timeout | null = null;
	private disposed = false;

	constructor(options: HandsHubOptions) {
		this.options = {
			requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
			offlineGraceMs: DEFAULT_OFFLINE_GRACE_MS,
			heartbeatMs: DEFAULT_HEARTBEAT_MS,
			...options,
		};
	}

	get heartbeatMs(): number {
		return this.options.heartbeatMs;
	}

	start(): void {
		if (this.reaper) return;
		this.reaper = setInterval(() => this.reap(), Math.max(1000, this.options.heartbeatMs));
		this.reaper.unref();
	}

	/** Register (or replace) an endpoint connection. */
	registerEndpoint(connection: EndpointConnection): void {
		if (this.disposed) return;
		const existing = this.endpoints.get(connection.endpointId);
		if (existing && existing !== connection) {
			this.options.log.warn("hand reconnected; dropping the previous connection", {
				endpoint: connection.endpointId,
			});
			existing.connected = false;
			existing.close("replaced by a new connection");
		}
		connection.connected = true;
		connection.lastSeen = Date.now();
		this.endpoints.set(connection.endpointId, connection);
		metrics.gauge("mir_hands_connected", this.endpoints.size);
		this.options.log.info("hand connected", {
			endpoint: connection.endpointId,
			kind: connection.kind,
			name: connection.name,
			capabilities: connection.capabilities,
		});
		this.options.store?.upsertEndpoint({
			id: connection.endpointId,
			name: connection.name,
			kind: connection.kind,
			capabilities: connection.capabilities,
			lastSeen: connection.lastSeen,
			meta: connection.meta,
		});
	}

	/** Drop an endpoint, failing every call it owed. */
	removeEndpoint(endpointId: string, reason = "disconnected"): void {
		const connection = this.endpoints.get(endpointId);
		if (!connection) return;
		connection.connected = false;
		this.endpoints.delete(endpointId);
		metrics.gauge("mir_hands_connected", this.endpoints.size);
		this.options.log.warn("hand disconnected", { endpoint: endpointId, reason });
		for (const pending of [...this.pending.values()]) {
			if (pending.endpointId !== endpointId) continue;
			this.settle(pending.workId, {
				ok: false,
				error: `hand ${endpointId} disconnected before finishing (${reason})`,
				durationMs: Date.now() - pending.startedAt,
				endpointId,
			});
		}
	}

	/** Handle a frame from an endpoint. */
	handleEndpointMessage(endpointId: string, message: EndpointToHub): void {
		const connection = this.endpoints.get(endpointId);
		if (!connection) return;
		connection.lastSeen = Date.now();
		switch (message.type) {
			case "heartbeat":
				// The endpoint's own count can lag a just-dispatched item; never let a
				// heartbeat reduce the hub's in-flight count below what it knows about.
				connection.running = Math.max(connection.running, message.load?.running ?? 0);
				break;
			case "accepted":
				break;
			case "chunk": {
				const pending = this.pending.get(message.workId);
				pending?.onChunk?.(message.stream, message.data);
				break;
			}
			case "result": {
				const pending = this.pending.get(message.workId);
				this.settle(message.workId, { ...message.result, endpointId });
				if (pending) {
					metrics.counter("mir_hands_work_total", 1, {
						op: pending.op,
						endpoint: endpointId,
						ok: String(message.result.ok),
					});
					metrics.observe("mir_hands_work_ms", message.result.durationMs, { endpoint: endpointId });
					this.options.store?.recordWork({
						workId: message.workId,
						endpointId,
						op: pending.op,
						startedAt: Date.now() - message.result.durationMs,
						durationMs: message.result.durationMs,
						ok: message.result.ok,
						error: message.result.error,
						truncated: message.result.truncated,
					});
				}
				break;
			}
			case "error": {
				this.options.log.warn("hand reported an error", {
					endpoint: endpointId,
					code: message.code,
					message: message.message,
				});
				if (message.workId) {
					const pending = this.pending.get(message.workId);
					if (pending) {
						this.settle(message.workId, {
							ok: false,
							error: `${message.code}: ${message.message}`,
							durationMs: Date.now() - pending.startedAt,
							endpointId,
						});
					}
				}
				break;
			}
			case "bye":
				this.removeEndpoint(endpointId, message.reason ?? "said goodbye");
				break;
			case "pong":
			case "hello":
				break;
		}
	}

	listHands(): HandStatus[] {
		return [...this.endpoints.values()].map((connection) => ({
			endpointId: connection.endpointId,
			name: connection.name,
			connected: connection.connected,
			capabilities: connection.capabilities,
			policy: {
				roots: connection.policy.roots,
				allow: connection.policy.allow,
				maxConcurrent: connection.policy.maxConcurrent,
			},
			...(connection.policySummary === undefined
				? {}
				: { policySummary: connection.policySummary }),
			running: connection.running,
			lastSeen: connection.lastSeen,
			meta: connection.meta,
			kind: connection.kind,
		}));
	}

	hasHands(): boolean {
		return this.endpoints.size > 0;
	}

	/** Pick a hand for an op, honouring an explicit pin and current load. */
	select(op: HandCall["op"], endpointId?: string): EndpointConnection {
		if (endpointId) {
			const connection = this.endpoints.get(endpointId);
			if (!connection) throw new Error(`unknown hand "${endpointId}"`);
			if (!connection.connected) throw new Error(`hand "${endpointId}" is not connected`);
			const support = handSupports(connection.capabilities, op);
			if (!support.ok) throw new Error(`hand "${endpointId}" cannot ${op}: ${support.reason}`);
			return connection;
		}
		const candidates = [...this.endpoints.values()]
			.filter((connection) => connection.connected)
			.filter((connection) => handSupports(connection.capabilities, op).ok)
			// A hand with no cap is always available: the machine decides, not the brain.
			.filter((connection) => {
				const cap = connection.policy.maxConcurrent ?? 0;
				return cap <= 0 || connection.running < cap;
			})
			// Least loaded first, then most recently seen; local hands win ties so a
			// task does not leave the machine for no reason.
			.sort(
				(a, b) =>
					a.running - b.running ||
					Number(b.kind === "local") - Number(a.kind === "local") ||
					b.lastSeen - a.lastSeen,
			);
		if (candidates.length === 0) {
			const reason = this.endpoints.size === 0 ? "no hands are connected" : `no hand can ${op} right now`;
			throw new Error(reason);
		}
		return candidates[0]!;
	}

	/** Send one unit of work and wait for its result. Never throws. */
	async call(
		call: HandCall,
		options: { onChunk?: (stream: "stdout" | "stderr", data: string) => void } = {},
	): Promise<HandCallResult> {
		let connection: EndpointConnection;
		try {
			connection = this.select(call.op, call.endpointId);
		} catch (err) {
			return { ok: false, error: (err as Error).message, durationMs: 0, endpointId: call.endpointId ?? "" };
		}

		const workId = `work-${crypto.randomUUID()}`;
		const startedAt = Date.now();
		const timeoutMs = Math.min(
			Math.max(1000, call.timeoutMs ?? this.options.requestTimeoutMs),
			this.options.requestTimeoutMs * 4,
		);
		const work: WorkItem = {
			workId,
			op: call.op,
			input: call.input,
			deadlineMs: startedAt + timeoutMs,
			maxOutputBytes: connection.policy.maxOutputBytes,
		};

		return await new Promise<HandCallResult>((resolve) => {
			const timer = setTimeout(() => {
				connection.send({ type: "cancel", workId, reason: "hub deadline exceeded" });
				this.settle(workId, {
					ok: false,
					error: `hand "${connection.endpointId}" did not finish within ${timeoutMs}ms`,
					durationMs: Date.now() - startedAt,
					endpointId: connection.endpointId,
				});
			}, timeoutMs);
			timer.unref?.();

			this.pending.set(workId, {
				workId,
				endpointId: connection.endpointId,
				op: call.op,
				startedAt,
				timer,
				onChunk: options.onChunk,
				resolve,
			});
			connection.running++;
			metrics.gauge("mir_hands_running", connection.running, { endpoint: connection.endpointId });
			metrics.counter("mir_hands_calls_total", 1, { op: call.op, endpoint: connection.endpointId });
			try {
				connection.send({ type: "work", work });
			} catch (err) {
				this.settle(workId, {
					ok: false,
					error: `failed to dispatch to hand: ${(err as Error).message}`,
					durationMs: Date.now() - startedAt,
					endpointId: connection.endpointId,
				});
			}
		});
	}

	private settle(workId: string, result: HandCallResult): void {
		const pending = this.pending.get(workId);
		if (!pending) return;
		this.pending.delete(workId);
		clearTimeout(pending.timer);
		const connection = this.endpoints.get(pending.endpointId);
		if (connection) {
			connection.running = Math.max(0, connection.running - 1);
			metrics.gauge("mir_hands_running", connection.running, { endpoint: connection.endpointId });
		}
		pending.resolve(result);
	}

	/** Drop endpoints that stopped heartbeating. */
	private reap(): void {
		const now = Date.now();
		for (const connection of [...this.endpoints.values()]) {
			if (!connection.connected) continue;
			const age = now - connection.lastSeen;
			if (age > this.options.offlineGraceMs) {
				metrics.counter("mir_hands_reaped_total");
				connection.close("heartbeat timeout");
				this.removeEndpoint(connection.endpointId, `no heartbeat for ${Math.round(age / 1000)}s`);
			}
		}
	}

	dispose(): void {
		this.disposed = true;
		if (this.reaper) {
			clearInterval(this.reaper);
			this.reaper = null;
		}
		for (const pending of [...this.pending.values()]) {
			this.settle(pending.workId, {
				ok: false,
				error: "hub is shutting down",
				durationMs: Date.now() - pending.startedAt,
				endpointId: pending.endpointId,
			});
		}
		for (const connection of this.endpoints.values()) connection.close("hub shutdown");
		this.endpoints.clear();
		metrics.gauge("mir_hands_connected", 0);
	}
}
