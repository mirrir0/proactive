/**
 * Hands client — the brain's end of the tool call.
 *
 * A Worker uses this to reach its hands. It speaks the local client protocol
 * (Unix socket) and turns every call into `execute(name, input) → string`:
 * a name, an input, and either a result or a tool error.
 *
 * Two properties matter here:
 *
 *   - **A dead hand is a failed tool call.** The client never hangs; every call
 *     has a deadline and every disconnect settles the calls it owed.
 *   - **Reconnects are invisible.** A daemon restart or a dropped socket is
 *     retried with backoff, so a long turn survives it.
 */

import net from "node:net";
import {
	FrameDecoder,
	HANDS_PROTOCOL_VERSION,
	encodeFrame,
	type ClientToHub,
	type HandCall,
	type HandCallResult,
	type HandOp,
	type HandStatus,
	type HubToClient,
	type StreamName,
} from "./protocol.ts";

export interface HandsClientOptions {
	socketPath: string;
	/** Identifies the brain in hub logs. */
	agent?: string;
	reconnectDelayMs?: number;
	connectTimeoutMs?: number;
}

interface PendingCall {
	resolve: (result: HandCallResult) => void;
	timer: NodeJS.Timeout;
	onChunk?: (stream: StreamName, data: string) => void;
	startedAt: number;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 5000;

export class HandsClient {
	private socket: net.Socket | null = null;
	private connecting: Promise<void> | null = null;
	private readonly pending = new Map<string, PendingCall>();
	private hands: HandStatus[] = [];
	private readonly handRequests = new Map<string, (hands: HandStatus[]) => void>();
	private closed = false;
	private seq = 0;

	constructor(private readonly options: HandsClientOptions) {}

	get available(): HandStatus[] {
		return this.hands;
	}

	get connected(): boolean {
		return Boolean(this.socket && !this.socket.destroyed);
	}

	async connect(): Promise<void> {
		if (this.closed) throw new Error("hands client is closed");
		if (this.connected) return;
		if (this.connecting) return this.connecting;
		this.connecting = this.doConnect().finally(() => {
			this.connecting = null;
		});
		return this.connecting;
	}

	private async doConnect(): Promise<void> {
		const timeoutMs = this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
		const socket = net.createConnection(this.options.socketPath);
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				socket.destroy();
				reject(new Error(`hands socket connect timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			timer.unref();
			socket.once("connect", () => {
				clearTimeout(timer);
				resolve();
			});
			socket.once("error", (err) => {
				clearTimeout(timer);
				reject(err);
			});
		});
		socket.setNoDelay(true);
		this.socket = socket;

		const decoder = new FrameDecoder<HubToClient>((message) => this.handle(message));
		socket.on("data", (chunk) => {
			if (!decoder.push(chunk).ok) socket.destroy();
		});
		socket.on("close", () => this.onDisconnect("hands connection closed"));
		socket.on("error", (err) => this.onDisconnect(err.message));

		this.send({ type: "hello", v: HANDS_PROTOCOL_VERSION, agent: this.options.agent ?? "worker" });
	}

	private handle(message: HubToClient): void {
		switch (message.type) {
			case "ready":
				this.hands = message.hands;
				break;
			case "hands": {
				this.hands = message.hands;
				const resolve = this.handRequests.get(message.id);
				if (resolve) {
					this.handRequests.delete(message.id);
					resolve(message.hands);
				}
				break;
			}
			case "stream": {
				this.pending.get(message.id)?.onChunk?.(message.stream, message.data);
				break;
			}
			case "reply": {
				this.settle(message.id, message.result);
				break;
			}
			case "error": {
				if (message.id) {
					this.settle(message.id, {
						ok: false,
						error: `${message.code}: ${message.message}`,
						durationMs: 0,
						endpointId: "",
					});
				}
				break;
			}
		}
	}

	private onDisconnect(reason: string): void {
		this.socket = null;
		for (const [id, resolve] of [...this.handRequests]) {
			this.handRequests.delete(id);
			resolve(this.hands);
		}
		for (const [id, pending] of [...this.pending]) {
			clearTimeout(pending.timer);
			this.pending.delete(id);
			pending.resolve({
				ok: false,
				error: reason,
				durationMs: Date.now() - pending.startedAt,
				endpointId: "",
			});
		}
	}

	private send(message: ClientToHub): void {
		if (!this.socket || this.socket.destroyed) throw new Error("hands client is not connected");
		this.socket.write(encodeFrame(message));
	}

	private settle(id: string, result: HandCallResult): void {
		const pending = this.pending.get(id);
		if (!pending) return;
		this.pending.delete(id);
		clearTimeout(pending.timer);
		pending.resolve(result);
	}

	/** Refresh the hand list from the hub (correlated request, no sleep). */
	async refreshHands(timeoutMs = 2000): Promise<HandStatus[]> {
		try {
			await this.connect();
		} catch {
			return this.hands;
		}
		const id = `hands-${++this.seq}`;
		return await new Promise<HandStatus[]>((resolve) => {
			const timer = setTimeout(() => {
				this.handRequests.delete(id);
				resolve(this.hands);
			}, timeoutMs);
			timer.unref?.();
			this.handRequests.set(id, (hands) => {
				clearTimeout(timer);
				resolve(hands);
			});
			try {
				this.send({ type: "hands", id });
			} catch {
				clearTimeout(timer);
				this.handRequests.delete(id);
				resolve(this.hands);
			}
		});
	}

	/** One unit of work. Never throws: failures come back as `ok: false`. */
	async call(
		call: HandCall,
		options: {
			onChunk?: (stream: StreamName, data: string) => void;
			timeoutMs?: number;
			/**
			 * Stop the call, and the command behind it.
			 *
			 * The daemon stops a task by aborting its turn; a turn that is waiting
			 * on a shell command on a hand has nothing to abort unless the cancel
			 * travels. This is that path: `cancel` to the hub, which cancels the
			 * work, which signals the executor, which kills the process tree.
			 */
			signal?: AbortSignal;
		} = {},
	): Promise<HandCallResult> {
		try {
			await this.connect();
		} catch (err) {
			return {
				ok: false,
				error: `hands unavailable: ${(err as Error).message}`,
				durationMs: 0,
				endpointId: call.endpointId ?? "",
			};
		}
		const id = `call-${++this.seq}-${Date.now()}`;
		const timeoutMs = options.timeoutMs ?? call.timeoutMs ?? 10 * 60_000;
		return await new Promise<HandCallResult>((resolve) => {
			const timer = setTimeout(() => {
				this.settle(id, {
					ok: false,
					error: `hand call did not settle within ${timeoutMs}ms`,
					durationMs: timeoutMs,
					endpointId: call.endpointId ?? "",
				});
			}, timeoutMs + 5000);
			timer.unref?.();
			const onAbort = (): void => {
				this.send({ type: "cancel", id });
				this.settle(id, {
					ok: false,
					error: "cancelled",
					durationMs: Date.now() - startedAt,
					endpointId: call.endpointId ?? "",
				});
			};
			const startedAt = Date.now();
			if (options.signal?.aborted === true) {
				onAbort();
				return;
			}
			options.signal?.addEventListener("abort", onAbort, { once: true });
			this.pending.set(id, {
				resolve: (result) => {
					options.signal?.removeEventListener("abort", onAbort);
					resolve(result);
				},
				timer,
				onChunk: options.onChunk,
				startedAt,
			});
			try {
				this.send({ type: "call", id, call: { ...call, timeoutMs } });
			} catch (err) {
				this.settle(id, {
					ok: false,
					error: (err as Error).message,
					durationMs: 0,
					endpointId: call.endpointId ?? "",
				});
			}
		});
	}

	exec(
		input: Record<string, unknown>,
		options: { onChunk?: (stream: StreamName, data: string) => void; endpointId?: string; timeoutMs?: number } = {},
	): Promise<HandCallResult> {
		return this.call(
			{ op: "exec", input, endpointId: options.endpointId, timeoutMs: options.timeoutMs },
			options,
		);
	}

	/**
	 * A command string through the hand's shell. Separate from `exec` because it
	 * needs its own grant: `shell` on the hand and `sh` in its allowlist.
	 */
	shell(
		command: string,
		options: { cwd?: string; endpointId?: string; timeoutMs?: number } = {},
	): Promise<HandCallResult> {
		return this.call({
			op: "shell",
			input: { command, cwd: options.cwd, timeoutMs: options.timeoutMs },
			endpointId: options.endpointId,
			timeoutMs: options.timeoutMs,
		});
	}

	readFile(
		path: string,
		options: { endpointId?: string; offset?: number; limit?: number; maxBytes?: number } = {},
	): Promise<HandCallResult> {
		return this.call({
			op: "readFile",
			input: { path, offset: options.offset, limit: options.limit, maxBytes: options.maxBytes },
			endpointId: options.endpointId,
		});
	}

	editFile(
		path: string,
		edits: Array<{ oldText: string; newText: string }>,
		options: { endpointId?: string } = {},
	): Promise<HandCallResult> {
		return this.call({ op: "editFile", input: { path, edits }, endpointId: options.endpointId });
	}

	writeFile(path: string, content: string, options: { endpointId?: string } = {}): Promise<HandCallResult> {
		return this.call({ op: "writeFile", input: { path, content }, endpointId: options.endpointId });
	}

	listDir(path: string, options: { endpointId?: string } = {}): Promise<HandCallResult> {
		return this.call({ op: "listDir", input: { path }, endpointId: options.endpointId });
	}

	stat(path: string, options: { endpointId?: string } = {}): Promise<HandCallResult> {
		return this.call({ op: "stat", input: { path }, endpointId: options.endpointId });
	}

	git(args: string[], options: { cwd?: string; endpointId?: string; timeoutMs?: number } = {}): Promise<HandCallResult> {
		return this.call({
			op: "git",
			input: { args, cwd: options.cwd, timeoutMs: options.timeoutMs },
			endpointId: options.endpointId,
			timeoutMs: options.timeoutMs,
		});
	}

	/** Convenience for a tool that only needs to know which ops are possible. */
	supports(op: HandOp, endpointId?: string): boolean {
		const hand = endpointId
			? this.hands.find((h) => h.endpointId === endpointId)
			: this.hands.find((h) => h.connected);
		if (!hand) return false;
		if (op === "exec") return hand.capabilities.exec;
		if (op === "shell") return hand.capabilities.shell;
		if (op === "git") return hand.capabilities.git;
		if (op === "writeFile" || op === "editFile") return hand.capabilities.fs === "rw";
		return hand.capabilities.fs !== "none";
	}

	close(): void {
		this.closed = true;
		this.onDisconnect("client closed");
		this.socket?.destroy();
		this.socket = null;
	}
}
