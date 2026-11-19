/**
 * The brain's client listener.
 *
 * A Unix socket, mode 0600, because the client is a process on this machine: the
 * product's host when the brain is a sidecar, the desktop app's host, or a test.
 * A brain that runs somewhere else puts this behind whatever fronts it (a
 * reverse proxy, an SSH tunnel, `socat`) — the frames do not change, which is
 * the point of the door being one protocol.
 *
 * Three rules, and each one is a way a naive server goes wrong:
 *
 * 1. **The first frame must be `hello`.** Nothing is routed before it, and a
 *    wrong token closes the connection with `1008`-style words rather than
 *    letting a caller discover the API by probing it.
 * 2. **A subscription is per connection.** Opening a thread attaches this
 *    connection to it; closing the connection detaches everything. A client that
 *    dies mid-read leaks nothing, which is what makes a panel that crashes
 *    harmless.
 * 3. **One bad frame never kills a connection.** It is answered (`bad-frame`) or
 *    dropped, never thrown: a long-lived display must not die because one line
 *    was truncated.
 */

import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import {
	BRAIN_API_VERSION,
	BRAIN_CAPABILITIES,
	type BrainHost,
	type BrainToClient,
	type ClientToBrain,
} from "./protocol.ts";
import type { ThreadEntry, ThreadStatus } from "../threadlog.ts";
import { FrameDecoder, encodeFrame, hashToken, tokensEqual } from "../hands/protocol.ts";
import { DEFAULT_MEMBER, verifyMemberToken } from "./tokens.ts";
import type { Logger } from "../telemetry.ts";

export interface BrainServerOptions {
	/** Unix socket path. Created 0600; a stale socket is replaced. */
	socketPath: string;
	/** Shared bearer token. Without one the server refuses to start. */
	token: string;
	/**
	 * The secret signed member tokens are verified with.
	 *
	 * Set when one daemon serves several members: a token then names its member, and
	 * the static `token` is what a single-member install presents. Absent, this is a
	 * one-member daemon and only `token` is accepted.
	 */
	secret?: string;
	/** The member the static token belongs to. Defaults to `local`. */
	member?: string;
	host: BrainHost;
	log: Logger;
}

interface Subscriber {
	/** Threads this connection is watching. */
	readonly threads: Set<string>;
}

export class BrainServer {
	private server: net.Server | null = null;
	/** threadId → the connections watching it, so an entry reaches each once. */
	private readonly watchers = new Map<string, Set<net.Socket>>();
	private readonly subscribers = new Map<net.Socket, Subscriber>();

	/**
	 * The member a token names, or undefined.
	 *
	 * Two ways in, and they are different things: a signed token says *which* member,
	 * and the static token says "the one this install has". The static one is not a
	 * fallback for a failed signature — that would make the secret optional for an
	 * attacker.
	 */
	private memberFor(token: string): string | undefined {
		if (this.options.secret !== undefined && this.options.secret !== "") {
			const member = verifyMemberToken(this.options.secret, token);
			if (member !== undefined) return member;
		}
		if (tokensEqual(hashToken(token), this.tokenHash)) return this.options.member ?? DEFAULT_MEMBER;
		return undefined;
	}
	private readonly tokenHash: string;
	private readonly options: BrainServerOptions;

	constructor(options: BrainServerOptions) {
		if (options.token === "") throw new Error("brain server: a token is required");
		this.options = options;
		this.tokenHash = hashToken(options.token);
	}

	/** The path this server listens on, once started. */
	get socketPath(): string {
		return this.options.socketPath;
	}

	async start(): Promise<void> {
		const socketPath = this.options.socketPath;
		fs.mkdirSync(path.dirname(socketPath), { recursive: true });
		try {
			fs.unlinkSync(socketPath);
		} catch {
			/* no stale socket */
		}
		const server = net.createServer((socket) => this.accept(socket));
		this.server = server;
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(socketPath, () => resolve());
		});
		// Only the owning user may drive this brain.
		try {
			fs.chmodSync(socketPath, 0o600);
		} catch {
			/* best effort (some filesystems ignore modes) */
		}
		this.options.log.info("brain api listening", { socket: socketPath });
	}

	/**
	 * Deliver one entry to every connection watching its thread.
	 *
	 * Called by whatever appends to the log (the Router's turn, a worker's
	 * stream). A connection that is gone is dropped here rather than by a
	 * periodic sweep, so the watcher map cannot grow past the live clients.
	 */
	publish(threadId: string, entry: ThreadEntry): void {
		const sockets = this.watchers.get(threadId);
		if (sockets === undefined || sockets.size === 0) return;
		const frame = encodeFrame({ type: "entry", threadId, entry } satisfies BrainToClient);
		for (const socket of sockets) {
			if (socket.destroyed) {
				this.unwatch(threadId, socket);
				continue;
			}
			socket.write(frame);
		}
	}

	/** Tell every watcher of a thread that its status moved. */
	publishStatus(threadId: string, status: ThreadStatus): void {
		const sockets = this.watchers.get(threadId);
		if (sockets === undefined) return;
		const frame = encodeFrame({ type: "status", threadId, status } satisfies BrainToClient);
		for (const socket of sockets) if (!socket.destroyed) socket.write(frame);
	}

	async stop(): Promise<void> {
		for (const socket of this.subscribers.keys()) socket.destroy();
		this.subscribers.clear();
		this.watchers.clear();
		const server = this.server;
		this.server = null;
		if (server === null) return;
		await new Promise<void>((resolve) => server.close(() => resolve()));
		try {
			fs.unlinkSync(this.options.socketPath);
		} catch {
			/* already gone */
		}
	}

	// ----- one connection -----

	private accept(socket: net.Socket): void {
		let greeted = false;
		const send = (frame: BrainToClient): void => {
			if (!socket.destroyed) socket.write(encodeFrame(frame));
		};
		const refuse = (code: "version" | "auth" | "bad-frame", message: string): void => {
			send({ type: "error", code, message });
			socket.end();
		};

		const decoder = new FrameDecoder<ClientToBrain>((message) => {
			if (!greeted) {
				if (message.type !== "hello") {
					refuse("auth", "the first frame must be hello");
					return;
				}
				if (message.v !== BRAIN_API_VERSION) {
					refuse("version", `this brain speaks api v${String(BRAIN_API_VERSION)}; the client speaks v${String(message.v)}`);
					return;
				}
				// Who this is. A signed token names its member; the static token means
				// the one member this install serves. A bad signature is refused — never
				// downgraded to the static token.
				const member = this.memberFor(message.token);
				if (member === undefined) {
					refuse("auth", "invalid token");
					return;
				}
				greeted = true;
				this.subscribers.set(socket, { threads: new Set() });
				this.options.log.info("brain client connected", { agent: message.agent, member });
				send({
					type: "ready",
					v: BRAIN_API_VERSION,
					agent: message.agent,
					hands: this.options.host.hands(),
					capabilities: BRAIN_CAPABILITIES,
				});
				return;
			}
			this.handle(socket, message, send, refuse);
		});

		socket.on("data", (chunk: Buffer) => {
			const outcome = decoder.push(chunk);
			if (!outcome.ok) refuse("bad-frame", outcome.error ?? "bad frame");
		});
		socket.on("error", () => this.drop(socket));
		socket.on("close", () => this.drop(socket));
	}

	private handle(
		socket: net.Socket,
		message: ClientToBrain,
		send: (frame: BrainToClient) => void,
		refuse: (code: "version" | "auth" | "bad-frame", message: string) => void,
	): void {
		const host = this.options.host;
		switch (message.type) {
			case "hello":
				// A second hello on a greeted connection is a client bug, not a re-auth.
				send({ type: "reply", id: "-", ok: false, error: "already greeted" });
				return;

			case "threads": {
				try {
					send({ type: "threads", id: message.id, threads: host.listThreads(message.filter) });
				} catch (err) {
					send({ type: "reply", id: message.id, ok: false, error: (err as Error).message });
				}
				return;
			}

			case "chat": {
				const threadId = host.chatThread(message.chatId, message.title);
				const since = message.since ?? 0;
				const entries = host.entries(threadId, since);
				send({
					type: "snapshot",
					id: message.id,
					threadId,
					seq: entries.length > 0 ? entries[entries.length - 1]!.seq : since,
					status: host.status(threadId),
					entries,
				});
				this.watch(threadId, socket);
				return;
			}

			case "open": {
				const since = message.since ?? 0;
				const entries = host.entries(message.threadId, since);
				const seq = entries.length > 0 ? entries[entries.length - 1]!.seq : since;
				send({
					type: "snapshot",
					id: message.id,
					threadId: message.threadId,
					seq,
					status: host.status(message.threadId),
					entries,
				});
				this.watch(message.threadId, socket);
				return;
			}

			case "close": {
				this.unwatch(message.threadId, socket);
				send({ type: "reply", id: message.id, ok: true });
				return;
			}

			case "say": {
				if (typeof message.content !== "string" || message.content.trim() === "") {
					send({ type: "reply", id: message.id, ok: false, error: "say needs some content" });
					return;
				}
				try {
					host.say(message.threadId, message.content);
					send({ type: "reply", id: message.id, ok: true });
				} catch (err) {
					send({ type: "reply", id: message.id, ok: false, error: (err as Error).message });
				}
				return;
			}

			case "stop": {
				try {
					host.stop(message.threadId);
					send({ type: "reply", id: message.id, ok: true });
				} catch (err) {
					send({ type: "reply", id: message.id, ok: false, error: (err as Error).message });
				}
				return;
			}

			case "hands": {
				send({ type: "hands", id: message.id, hands: host.hands() });
				return;
			}

			case "hand_add": {
				const added = host.addHand({
					handId: message.handId,
					...(message.name === undefined ? {} : { name: message.name }),
					roots: message.roots,
					...(message.fs === undefined ? {} : { fs: message.fs }),
					...(message.exec === undefined ? {} : { exec: message.exec }),
					...(message.shell === undefined ? {} : { shell: message.shell }),
					...(message.git === undefined ? {} : { git: message.git }),
				});
				send({ type: "reply", id: message.id, ok: true, result: added });
				return;
			}

			default:
				refuse("bad-frame", `unknown request ${String((message as { type?: unknown }).type)}`);
		}
	}

	private watch(threadId: string, socket: net.Socket): void {
		const subscriber = this.subscribers.get(socket);
		if (subscriber === undefined) return;
		if (subscriber.threads.has(threadId)) return;
		subscriber.threads.add(threadId);
		let sockets = this.watchers.get(threadId);
		if (sockets === undefined) {
			sockets = new Set();
			this.watchers.set(threadId, sockets);
		}
		sockets.add(socket);
		this.options.host.watch?.(threadId, true);
	}

	private unwatch(threadId: string, socket: net.Socket): void {
		const subscriber = this.subscribers.get(socket);
		if (subscriber === undefined || !subscriber.threads.delete(threadId)) return;
		const sockets = this.watchers.get(threadId);
		sockets?.delete(socket);
		if (sockets !== undefined && sockets.size === 0) this.watchers.delete(threadId);
		this.options.host.watch?.(threadId, false);
	}

	/** A connection is gone: forget every thread it was watching. */
	private drop(socket: net.Socket): void {
		const subscriber = this.subscribers.get(socket);
		this.subscribers.delete(socket);
		if (subscriber === undefined) return;
		for (const threadId of subscriber.threads) {
			const sockets = this.watchers.get(threadId);
			sockets?.delete(socket);
			if (sockets !== undefined && sockets.size === 0) this.watchers.delete(threadId);
			this.options.host.watch?.(threadId, false);
		}
	}
}
