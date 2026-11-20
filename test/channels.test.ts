import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpChannel } from "../src/channels/http.ts";
import { AnomalousChannel } from "../src/channels/anomalous.ts";
import { ReplyBook } from "../src/channels/types.ts";
import { signChannelBody } from "../src/security.ts";
import { makeEvent, tick } from "./helpers/fakes.ts";

async function withChannel(
	options: { token?: string; hmacSecret?: string },
	fn: (channel: HttpChannel, events: any[], baseUrl: string) => Promise<void>,
): Promise<void> {
	const events: any[] = [];
	const channel = new HttpChannel({
		host: "127.0.0.1",
		port: 0,
		token: options.token,
		hmacSecret: options.hmacSecret,
	});
	await channel.start((event) => events.push(event));
	try {
		await fn(channel, events, `http://127.0.0.1:${channel.port}`);
	} finally {
		await channel.stop();
	}
}

test("http channel: a request without the token is rejected before routing", async () => {
	await withChannel({ token: "good-token" }, async (channel, events, baseUrl) => {
		const res = await fetch(`${baseUrl}/channels/http/events`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "spoofed" }),
		});
		assert.equal(res.status, 401);
		assert.equal(events.length, 0);

		const ok = await fetch(`${baseUrl}/channels/http/events`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-mir-token": "good-token" },
			body: JSON.stringify({ text: "real", thread: "t1" }),
		});
		assert.equal(ok.status, 202);
		await tick(10);
		assert.equal(events.length, 1);
		assert.equal(events[0].text, "real");
		assert.equal(events[0].threadId, "t1");
	});
});

test("http channel: an invalid HMAC signature is rejected", async () => {
	const secret = "hmac-secret";
	await withChannel({ hmacSecret: secret }, async (channel, events, baseUrl) => {
		const body = JSON.stringify({ text: "signed" });
		const ts = String(Math.floor(Date.now() / 1000));

		const bad = await fetch(`${baseUrl}/channels/http/events`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-mir-timestamp": ts,
				"x-mir-signature": "sha256=deadbeef",
			},
			body,
		});
		assert.equal(bad.status, 401);
		assert.equal(events.length, 0);

		const good = await fetch(`${baseUrl}/channels/http/events`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-mir-timestamp": ts,
				"x-mir-signature": signChannelBody(secret, ts, body),
			},
			body,
		});
		assert.equal(good.status, 202);
		await tick(10);
		assert.equal(events.length, 1);
	});
});

test("http channel: oversized bodies are refused", async () => {
	await withChannel({}, async (channel, events, baseUrl) => {
		const res = await fetch(`${baseUrl}/channels/http/events`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "x".repeat(300 * 1024) }),
		}).catch(() => null);
		// Either a 413 or a dropped connection is acceptable; nothing may be routed.
		if (res) assert.equal(res.status, 413);
		assert.equal(events.length, 0);
	});
});

test("reply book: resolution by event, then thread, then last", () => {
	const book = new ReplyBook();
	const first = makeEvent({ id: "e1", threadId: "t1" });
	const second = makeEvent({ id: "e2", threadId: "t2" });
	book.remember(first);
	book.remember(second);

	assert.equal(book.resolve({ eventId: "e1" })?.threadId, "t1");
	assert.equal(book.resolve({ threadId: "t1" })?.eventId, "e1");
	assert.equal(book.resolve({})?.eventId, "e2");
});

test("reply book: bounded so a long-running daemon cannot leak", () => {
	const book = new ReplyBook();
	for (let i = 0; i < 1200; i++) book.remember(makeEvent({ id: `e-${i}`, threadId: `t-${i}` }));
	assert.ok(book.size <= 1000, `expected <= 1000 entries, got ${book.size}`);
});

test("a conclusion is delivered to its thread without resolving a chat", async () => {
	const delivered: Array<{ threadId?: string; text: string }> = [];
	const channel = new AnomalousChannel({
		deliver: (target, text) => {
			delivered.push({ ...target, text });
		},
	});
	await channel.start(() => {});
	// The thread is known; nothing may re-resolve it. A turn that heard from no chat
	// through `submit` (an API poke) has an empty reply book, and resolving refused it.
	await channel.deliverTo("thread-1", "the answer");
	assert.deepEqual(delivered, [{ threadId: "thread-1", text: "the answer" }]);
});

test("a reply with no address goes to the turn's own thread, not the last chat heard", async () => {
	const delivered: Array<{ threadId?: string; chatId?: string; text: string }> = [];
	const channel = new AnomalousChannel({
		deliver: (target, text) => {
			delivered.push({ ...target, text });
		},
	});
	await channel.start(() => {});
	// No event ever went through `submit`, so the reply book is empty — which is exactly
	// the case a turn from the API is in.
	const tool = channel.responseTool(undefined, () => ({ threadId: "thread-from-turn" }));
	await (tool as unknown as { execute: (id: string, args: unknown) => Promise<unknown> }).execute("call-1", {
		text: "the answer",
	});
	assert.deepEqual(delivered, [{ threadId: "thread-from-turn", text: "the answer" }]);
});

test("a memoized response tool still answers in the turn's thread", async () => {
	const delivered: Array<{ threadId?: string; chatId?: string }> = [];
	const channel = new AnomalousChannel({
		deliver: (target) => {
			delivered.push({ ...target });
		},
	});
	await channel.start(() => {});
	// Somebody heard from a chat first, so `recent` is not empty and a tool that lost
	// its context would answer *there* — a reply in another conversation.
	await channel.submit({ chatId: "another-chat", threadId: "another-thread", text: "hello" });
	const recorder = { record: () => ({ ok: true as const }) };
	const tool = channel.responseTool(recorder as never, () => ({ threadId: "thread-from-turn" }));
	assert.equal(channel.responseTool(recorder as never, () => ({ threadId: "thread-from-turn" })), tool, "one tool per recorder");
	await (tool as unknown as { execute: (id: string, args: unknown) => Promise<unknown> }).execute("call-1", { text: "the answer" });
	assert.deepEqual(delivered.at(-1), { threadId: "thread-from-turn" }, "the turn's thread, not the last chat heard");
});
