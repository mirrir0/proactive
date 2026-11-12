/**
 * The door: a client lists threads, opens one, reads it, says into it, and is
 * told when something goes wrong — over the real socket, with the real framing.
 *
 * The brain behind it is scripted, which is the point of `BrainHost`: the API's
 * behaviour is the API's, not the Router's.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BrainServer } from "../src/api/server.ts";
import { BrainClient } from "../src/api/client.ts";
import { BRAIN_API_VERSION, type BrainHost } from "../src/api/protocol.ts";
import { ThreadLog, newThreadId, ulid, type ThreadEntry, type ThreadSummary } from "../src/threadlog.ts";
import { AnomalousChannel } from "../src/channels/anomalous.ts";
import { MirStore } from "../src/store.ts";
import { createLogger } from "../src/telemetry.ts";
import { FrameDecoder, encodeFrame } from "../src/hands/protocol.ts";
import { rmDir, tmpDir, waitFor } from "./helpers/fakes.ts";

const silentLog = createLogger({ level: "error", format: "json", write: () => {} });
const TOKEN = "test-token-0123456789";

/** A host whose behaviour a test writes down, and which records what it was asked. */
function scriptedHost(entries: ThreadEntry[] = []) {
	const said: Array<{ threadId: string; content: string }> = [];
	const stopped: string[] = [];
	const watched: Array<{ threadId: string; watching: boolean }> = [];
	const host: BrainHost & {
		readonly said: typeof said;
		readonly stopped: typeof stopped;
		readonly watched: typeof watched;
	} = {
		said,
		stopped,
		watched,
		listThreads: (filter): ThreadSummary[] => {
			const threads: ThreadSummary[] = [
				{ id: "t1", name: "first", channelId: "anomalous", status: "running", seq: 3, lastEventAt: 2 },
				{ id: "t2", name: "second", channelId: "anomalous", status: "idle", seq: 0, lastEventAt: 1 },
			];
			return filter?.status === undefined ? threads : threads.filter((t) => t.status === filter.status);
		},
		chatThread: (chatId) => `chat-thread-of-${chatId}`,
		entries: (threadId, since) => entries.filter((e) => e.seq > since && threadId === "t1"),
		status: (threadId) => (threadId === "t1" ? "running" : "idle"),
		say: (threadId, content) => {
			said.push({ threadId, content });
		},
		stop: (threadId) => {
			stopped.push(threadId);
		},
		hands: () => [],
		watch: (threadId, watching) => {
			watched.push({ threadId, watching });
		},
	};
	return host;
}

async function withServer(
	run: (ctx: { socketPath: string; server: BrainServer; host: ReturnType<typeof scriptedHost> }) => Promise<void>,
	entries: ThreadEntry[] = [],
): Promise<void> {
	const dir = tmpDir();
	const socketPath = path.join(dir, "brain.sock");
	const host = scriptedHost(entries);
	const server = new BrainServer({ socketPath, token: TOKEN, host, log: silentLog });
	await server.start();
	try {
		await run({ socketPath, server, host });
	} finally {
		await server.stop();
		rmDir(dir);
	}
}

function entriesFixture(): ThreadEntry[] {
	return [
		{ seq: 1, at: 1, kind: "status", status: "running", note: "dispatched" },
		{ seq: 2, at: 2, kind: "text", role: "assistant", text: "working on it" },
		{ seq: 3, at: 3, kind: "tool_call", toolCallId: "c1", toolName: "read_file", args: { path: "a" } },
	];
}

test("api: a client connects, lists threads, opens one and reads its entries", async () => {
	await withServer(async ({ socketPath }) => {
		const client = new BrainClient({ socketPath, token: TOKEN, agent: "test" });
		const ready = await client.connect();
		assert.equal(ready.agent, "test");
		assert.deepEqual(ready.hands, []);

		const threads = await client.listThreads();
		assert.deepEqual(
			threads.map((t) => t.id),
			["t1", "t2"],
		);

		const opened = await client.open("t1");
		assert.equal(opened.seq, 3);
		assert.equal(opened.status, "running");
		assert.deepEqual(
			opened.entries.map((e) => e.kind),
			["status", "text", "tool_call"],
		);

		client.disconnect();
	}, entriesFixture());
});

test("api: opening with a sequence sends only what came after it", async () => {
	await withServer(async ({ socketPath }) => {
		const client = new BrainClient({ socketPath, token: TOKEN, agent: "test" });
		await client.connect();
		const opened = await client.open("t1", 2);
		assert.deepEqual(
			opened.entries.map((e) => e.seq),
			[3],
			"a reconnecting client asks for what it missed, not for everything",
		);
		client.disconnect();
	}, entriesFixture());
});

test("api: entries reach a watcher as they are published", async () => {
	await withServer(async ({ socketPath, server }) => {
		const seen: ThreadEntry[] = [];
		const client = new BrainClient({
			socketPath,
			token: TOKEN,
			agent: "test",
			onEntry: (_threadId, entry) => seen.push(entry),
		});
		await client.connect();
		await client.open("t1");

		server.publish("t1", { seq: 4, at: 4, kind: "text", role: "assistant", text: "done" });
		server.publish("t2", { seq: 1, at: 5, kind: "text", role: "assistant", text: "not watched" });
		await waitFor(() => seen.length === 1);

		assert.deepEqual(
			seen.map((e) => (e.kind === "text" ? e.text : e.kind)),
			["done"],
			"a watcher is sent its thread's entries and nobody else's",
		);
		client.disconnect();
	});
});

test("api: a closed thread stops reaching the client that closed it", async () => {
	await withServer(async ({ socketPath, server }) => {
		const seen: ThreadEntry[] = [];
		const client = new BrainClient({ socketPath, token: TOKEN, agent: "test", onEntry: (_t, e) => seen.push(e) });
		await client.connect();
		await client.open("t1");
		await client.close("t1");
		server.publish("t1", { seq: 9, at: 9, kind: "text", role: "assistant", text: "after close" });
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.deepEqual(seen, []);
		client.disconnect();
	});
});

test("api: say and stop reach the brain, and a refusal is words a client can show", async () => {
	await withServer(async ({ socketPath, host }) => {
		const client = new BrainClient({ socketPath, token: TOKEN, agent: "test" });
		await client.connect();
		await client.say("t1", "hello from the product");
		await client.stop("t1");
		assert.deepEqual(host.said, [{ threadId: "t1", content: "hello from the product" }]);
		assert.deepEqual(host.stopped, ["t1"]);

		await assert.rejects(() => client.say("t1", "   "), /say needs some content/);
		client.disconnect();
	});
});

test("api: the first frame must be hello, and a wrong token is refused", async () => {
	await withServer(async ({ socketPath }) => {
		// A raw connection, because a client that greets correctly cannot test this.
		const net = await import("node:net");
		const socket = net.createConnection(socketPath);
		const frames: any[] = [];
		const decoder = new FrameDecoder<any>((frame) => frames.push(frame));
		socket.on("data", (chunk) => decoder.push(chunk));
		await new Promise<void>((resolve) => socket.once("connect", resolve));

		socket.write(encodeFrame({ type: "threads", id: "x" }));
		await waitFor(() => frames.length > 0);
		assert.equal(frames[0].type, "error");
		assert.equal(frames[0].code, "auth");

		const second = net.createConnection(socketPath);
		const frames2: any[] = [];
		const decoder2 = new FrameDecoder<any>((frame) => frames2.push(frame));
		second.on("data", (chunk) => decoder2.push(chunk));
		await new Promise<void>((resolve) => second.once("connect", resolve));
		second.write(encodeFrame({ type: "hello", v: BRAIN_API_VERSION, token: "not-the-token", agent: "x" }));
		await waitFor(() => frames2.length > 0);
		assert.equal(frames2[0].code, "auth");
		assert.match(frames2[0].message, /invalid token/);

		socket.destroy();
		second.destroy();
	});
});

test("api: a client from another version is refused, not half-understood", async () => {
	await withServer(async ({ socketPath }) => {
		const net = await import("node:net");
		const socket = net.createConnection(socketPath);
		const frames: any[] = [];
		const decoder = new FrameDecoder<any>((frame) => frames.push(frame));
		socket.on("data", (chunk) => decoder.push(chunk));
		await new Promise<void>((resolve) => socket.once("connect", resolve));
		socket.write(encodeFrame({ type: "hello", v: 99, token: TOKEN, agent: "future" }));
		await waitFor(() => frames.length > 0);
		assert.equal(frames[0].code, "version");
		socket.destroy();
	});
});

test("api: a client that dies is forgotten, and the brain keeps serving", async () => {
	await withServer(async ({ socketPath, host }) => {
		const first = new BrainClient({ socketPath, token: TOKEN, agent: "one" });
		await first.connect();
		await first.open("t1");
		first.disconnect();
		await waitFor(() => host.watched.some((w) => w.threadId === "t1" && !w.watching));

		const second = new BrainClient({ socketPath, token: TOKEN, agent: "two" });
		const ready = await second.connect();
		assert.equal(ready.agent, "two");
		second.disconnect();
	});
});

// ---------------------------------------------------------------------------
// The log itself
// ---------------------------------------------------------------------------

function openLog(): { log: ThreadLog; store: MirStore; dir: string } {
	const dir = tmpDir();
	const store = MirStore.open(dir);
	return { log: new ThreadLog({ store, log: silentLog }), store, dir };
}

test("thread log: sequences are per thread and strictly increasing", () => {
	const { log, store, dir } = openLog();
	try {
		const a = log.append("t1", { kind: "text", role: "user", text: "one" });
		const b = log.append("t1", { kind: "text", role: "assistant", text: "two" });
		const c = log.append("t2", { kind: "text", role: "user", text: "other thread" });
		assert.equal(a.seq, 1);
		assert.equal(b.seq, 2);
		assert.equal(c.seq, 1, "a second thread counts from its own first entry");
		assert.deepEqual(
			log.entries("t1").map((e) => (e.kind === "text" ? e.text : e.kind)),
			["one", "two"],
		);
	} finally {
		store.close();
		rmDir(dir);
	}
});

test("thread log: an entry is never rewritten — a result is its own entry", () => {
	const { log, store, dir } = openLog();
	try {
		log.append("t1", { kind: "tool_call", toolCallId: "c1", toolName: "read_file" });
		log.append("t1", { kind: "tool_result", toolCallId: "c1", isError: false, result: "text" });
		const entries = log.entries("t1");
		assert.equal(entries.length, 2);
		assert.equal(entries[0]!.kind, "tool_call");
		assert.equal(entries[1]!.kind, "tool_result");
	} finally {
		store.close();
		rmDir(dir);
	}
});

test("thread log: entries survive a reopen, and status is remembered", () => {
	const dir = tmpDir();
	const first = MirStore.open(dir);
	const log = new ThreadLog({ store: first, log: silentLog });
	log.append("t1", { kind: "text", role: "assistant", text: "kept" });
	log.setStatus("t1", "waiting", "on a consent prompt");
	first.close();

	const reopened = MirStore.open(dir);
	try {
		const again = new ThreadLog({ store: reopened, log: silentLog });
		assert.deepEqual(
			again.entries("t1").map((e) => (e.kind === "text" ? e.text : e.kind === "status" ? e.status : e.kind)),
			["kept", "waiting"],
		);
		assert.equal(again.status("t1"), "waiting");
		const [summary] = again.summaries();
		assert.equal(summary?.id, "t1");
		assert.equal(summary?.seq, 2);
	} finally {
		reopened.close();
		rmDir(dir);
	}
});

test("thread log: a thread with no entries still lists, and an old database gains its columns", () => {
	const dir = tmpDir();
	// A database from before the log existed: `threads` without status or seq.
	const legacy = new DatabaseSync(path.join(dir, "mir.sqlite"));
	legacy.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT NOT NULL, channel_id TEXT NOT NULL, last_event_at REAL NOT NULL)`);
	legacy.exec(`INSERT INTO threads VALUES ('old', 'old thread', 'http', 1)`);
	legacy.close();

	const store = MirStore.open(dir);
	try {
		const log = new ThreadLog({ store, log: silentLog });
		const summaries = log.summaries();
		assert.equal(summaries.length, 1);
		assert.equal(summaries[0]?.id, "old");
		assert.equal(summaries[0]?.status, "idle", "an older row reads as idle, not as a crash");
		assert.deepEqual(log.entries("old"), []);
		const appended = log.append("old", { kind: "text", role: "user", text: "after the upgrade" });
		assert.equal(appended.seq, 1);
	} finally {
		store.close();
		rmDir(dir);
	}
});

test("thread ids are ULIDs: sortable by time, 26 Crockford characters", () => {
	const early = ulid(1_000_000_000_000);
	const late = ulid(1_000_000_001_000);
	assert.equal(early.length, 26);
	assert.match(early, /^[0-9A-HJKMNP-TV-Z]{26}$/);
	assert.ok(early < late, "a thread id sorts by when it was made");
	assert.notEqual(newThreadId(), newThreadId());
});

// ---------------------------------------------------------------------------
// The product's channel
// ---------------------------------------------------------------------------

test("anomalous channel: a reply goes to the chat it was addressed to", async () => {
	const delivered: Array<{ target: { threadId?: string; chatId?: string }; text: string }> = [];
	const channel = new AnomalousChannel({ deliver: (target, text) => void delivered.push({ target, text }) });
	const events: unknown[] = [];
	await channel.start((event) => events.push(event));

	channel.submit({ chatId: "chat-a", text: "hello", eventId: "e1" });
	assert.equal(events.length, 1, "a message from the host becomes an event the Router sees");
	await channel.respond("hi there", { replyTo: "chat-a" });
	assert.deepEqual(delivered, [{ target: { chatId: "chat-a" }, text: "hi there" }]);
});

test("anomalous channel: one chat in play may be answered without naming it", async () => {
	const delivered: Array<string | undefined> = [];
	const channel = new AnomalousChannel({ deliver: (target) => void delivered.push(target.chatId) });
	await channel.start(() => {});
	channel.submit({ chatId: "chat-a", text: "hello", eventId: "e1" });
	await channel.respond("an answer", {});
	assert.deepEqual(delivered, ["chat-a"]);
});

test("anomalous channel: a batch spanning two chats must be answered with reply_to", async () => {
	const delivered: Array<string | undefined> = [];
	const channel = new AnomalousChannel({ deliver: (target) => void delivered.push(target.chatId) });
	await channel.start(() => {});
	channel.submit({ chatId: "chat-a", text: "one", eventId: "e1" });
	channel.submit({ chatId: "chat-b", text: "two", eventId: "e2" });

	await assert.rejects(
		() => channel.respond("an unaddressed answer", {}),
		/needs reply_to: this turn heard from 2 chats \(chat-a, chat-b\)/,
		"an unaddressed reply would go into the wrong conversation",
	);
	assert.deepEqual(delivered, [], "and nothing was posted while it was ambiguous");

	await channel.respond("for b", { replyTo: "chat-b" });
	assert.deepEqual(delivered, ["chat-b"]);
});

test("anomalous channel: a reply with no chat to answer says so, rather than guessing", async () => {
	const channel = new AnomalousChannel({ deliver: () => {} });
	await channel.start(() => {});
	await assert.rejects(() => channel.respond("hello", {}), /no chat to answer/);
});

test("anomalous channel: a thread that shows a chat is what a client's say reaches", async () => {
	// The chat id a reply resolves to comes from the thread's own row, which is
	// what makes `say(threadId, …)` able to answer into the right conversation.
	const { log, store, dir } = openLog();
	try {
		const threadId = log.chatThread("chat-42");
		assert.equal(log.chatOf(threadId), "chat-42");
		assert.equal(log.chatThread("chat-42"), threadId, "the same chat keeps the same thread");
		assert.equal(log.chatOf("a-work-thread"), undefined, "a work thread shows no chat");
	} finally {
		store.close();
		rmDir(dir);
	}
});
