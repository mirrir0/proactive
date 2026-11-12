/**
 * A brain client — the other end of `BrainServer`.
 *
 * Kept here, beside the server, so the two halves of the wire cannot drift: a
 * change to a frame breaks this file and the server's handler in the same
 * commit. The product's host mirrors this shape in its own package (it may not
 * import the brain — see the anomalous proposal §11), and a test here is what
 * says the mirror is right.
 *
 * Two behaviours worth stating, because both are how a display stays honest:
 *
 *   - **`open` resolves with the snapshot and then streams.** `onEntry` is the
 *     subscription; `open` returns once the snapshot has landed, so a caller can
 *     render history and then append, with no gap between them.
 *   - **A dropped connection rejects every request in flight** rather than
 *     leaving promises pending forever. A display that cannot reach its brain
 *     says so; it does not hang.
 */

import net from "node:net";
import { BRAIN_API_VERSION, type BrainToClient, type ClientToBrain, type ThreadFilter } from "./protocol.ts";
import { FrameDecoder, encodeFrame } from "../hands/protocol.ts";
import type { HandStatus } from "../hands/protocol.ts";
import type { ThreadEntry, ThreadStatus, ThreadSummary } from "../threadlog.ts";

export interface BrainClientOptions {
	socketPath: string;
	token: string;
	/** Who this client is, for the brain's log. */
	agent: string;
	/** One thread's entry, as it happens. */
	onEntry?: (threadId: string, entry: ThreadEntry) => void;
	/** A thread's status moved. */
	onStatus?: (threadId: string, status: ThreadStatus) => void;
	/** The connection ended, with why. Every request in flight has already been rejected. */
	onDisconnect?: (reason: string) => void;
}

interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
}

export class BrainClient {
	private socket: net.Socket | null = null;
	private readonly pending = new Map<string, Pending>();
	private readonly options: BrainClientOptions;
	private seq = 0;
	private closed = false;

	constructor(options: BrainClientOptions) {
		this.options = options;
	}

	/** Connect and greet. Resolves with the brain's `ready`, so a caller learns what it can do. */
	async connect(): Promise<{ agent: string; hands: HandStatus[] }> {
		if (this.socket !== null) throw new Error("brain client: already connected");
		const socket = net.createConnection(this.options.socketPath);
		this.socket = socket;
		socket.setNoDelay(true);

		const decoder = new FrameDecoder<BrainToClient>((frame) => this.receive(frame));
		socket.on("data", (chunk: Buffer) => decoder.push(chunk));
		socket.on("error", (err) => this.disconnect(err.message));
		socket.on("close", () => this.disconnect("connection closed"));

		await new Promise<void>((resolve, reject) => {
			socket.once("connect", resolve);
			socket.once("error", reject);
		});

		const ready = await this.request<{ agent: string; hands: HandStatus[] }>({
			type: "hello",
			v: BRAIN_API_VERSION,
			token: this.options.token,
			agent: this.options.agent,
		});
		return ready;
	}

	/** Every thread, newest activity first. */
	listThreads(filter?: ThreadFilter): Promise<ThreadSummary[]> {
		return this.request<{ threads: ThreadSummary[] }>({
			type: "threads",
			id: this.nextId(),
			...(filter === undefined ? {} : { filter }),
		}).then((answer) => answer.threads);
	}

	/**
	 * Open a thread: its entries after `since`, then every new one through
	 * `onEntry`. Resolves once the snapshot has landed.
	 */
	async open(
		threadId: string,
		since = 0,
	): Promise<{ seq: number; status: ThreadStatus; entries: ThreadEntry[] }> {
		const answer = await this.request<{
			seq: number;
			status: ThreadStatus;
			entries: ThreadEntry[];
		}>({ type: "open", id: this.nextId(), threadId, since });
		return { seq: answer.seq, status: answer.status, entries: answer.entries };
	}

	/**
	 * Open the thread a chat shows, minting it on first use.
	 *
	 * The one call a chat driver makes: it has a chat id, not a thread id, and
	 * this is where the two become one.
	 */
	async openChat(
		chatId: string,
		since = 0,
	): Promise<{ threadId: string; seq: number; status: ThreadStatus; entries: ThreadEntry[] }> {
		const frame = await this.request<{
			threadId: string;
			seq: number;
			status: ThreadStatus;
			entries: ThreadEntry[];
		}>({ type: "chat", id: this.nextId(), chatId, since });
		return { threadId: frame.threadId, seq: frame.seq, status: frame.status, entries: frame.entries };
	}

	async close(threadId: string): Promise<void> {
		await this.request({ type: "close", id: this.nextId(), threadId });
	}

	/** Say something in a thread. Resolves when the brain has accepted it. */
	async say(threadId: string, content: string): Promise<void> {
		await this.request({ type: "say", id: this.nextId(), threadId, content });
	}

	/** Stop what is running in a thread. */
	async stop(threadId: string): Promise<void> {
		await this.request({ type: "stop", id: this.nextId(), threadId });
	}

	async hands(): Promise<HandStatus[]> {
		const answer = await this.request<{ hands: HandStatus[] }>({ type: "hands", id: this.nextId() });
		return answer.hands;
	}

	disconnect(reason = "client closed"): void {
		if (this.closed) return;
		this.closed = true;
		const socket = this.socket;
		this.socket = null;
		socket?.destroy();
		for (const pending of this.pending.values()) pending.reject(new Error(`brain disconnected: ${reason}`));
		this.pending.clear();
		this.options.onDisconnect?.(reason);
	}

	get connected(): boolean {
		return this.socket !== null && !this.closed;
	}

	// ----- wire -----

	private nextId(): string {
		this.seq += 1;
		return `c${String(this.seq)}`;
	}

	/**
	 * Send one request and wait for its answer.
	 *
	 * The hello frame has no `id` the server echoes, so `connect` passes a frame
	 * without one and the `ready` frame — which is also the answer to hello — is
	 * matched here by being the first frame of all.
	 */
	private request<T = unknown>(frame: ClientToBrain): Promise<T> {
		const socket = this.socket;
		if (socket === null || this.closed) return Promise.reject(new Error("brain client is not connected"));
		const id = "id" in frame && typeof frame.id === "string" ? frame.id : null;
		return new Promise<T>((resolve, reject) => {
			if (id !== null) this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
			else this.readyWaiter = { resolve: resolve as (value: unknown) => void, reject };
			socket.write(encodeFrame(frame));
		});
	}

	private readyWaiter: Pending | null = null;

	private receive(frame: BrainToClient): void {
		switch (frame.type) {
			case "ready": {
				const waiter = this.readyWaiter;
				this.readyWaiter = null;
				waiter?.resolve({ agent: frame.agent, hands: frame.hands });
				return;
			}
			case "threads":
			case "hands":
			case "snapshot": {
				const pending = this.pending.get(frame.id);
				if (pending === undefined) return;
				this.pending.delete(frame.id);
				pending.resolve(frame);
				return;
			}
			case "reply": {
				const pending = this.pending.get(frame.id);
				if (pending === undefined) return;
				this.pending.delete(frame.id);
				if (frame.ok) pending.resolve(undefined);
				else pending.reject(new Error(frame.error));
				return;
			}
			case "entry":
				this.options.onEntry?.(frame.threadId, frame.entry);
				return;
			case "status":
				this.options.onStatus?.(frame.threadId, frame.status);
				return;
			case "error": {
				const reason = `${frame.code}: ${frame.message}`;
				this.readyWaiter?.reject(new Error(reason));
				this.readyWaiter = null;
				this.disconnect(reason);
				return;
			}
		}
	}
}
