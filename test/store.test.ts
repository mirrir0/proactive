import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MirStore } from "../src/store.ts";
import { ThreadManager } from "../src/thread.ts";
import { rmDir, tmpDir } from "./helpers/fakes.ts";
import type { Task } from "../src/types.ts";

function task(overrides: Partial<Task> = {}): Task {
	return {
		id: overrides.id ?? "task-1",
		title: overrides.title ?? "fix the bug",
		description: overrides.description ?? "reproduce and fix",
		status: overrides.status ?? "running",
		createdAt: overrides.createdAt ?? 1000,
		updatedAt: overrides.updatedAt ?? 1000,
		threadId: overrides.threadId,
		channelId: overrides.channelId,
		replyTo: overrides.replyTo,
		workerId: overrides.workerId,
		fast: overrides.fast,
		result: overrides.result,
		error: overrides.error,
	};
}

test("events: the trigger log is idempotent by event id", () => {
	const dir = tmpDir();
	const store = MirStore.open(dir);
	const event = {
		id: "evt-1",
		channelId: "http",
		threadId: "thread-1",
		text: "hello",
		receivedAt: 100,
		status: "pending" as const,
		attempts: 0,
	};
	assert.equal(store.insertEvent(event), true);
	assert.equal(store.insertEvent(event), false, "a re-delivered event must be deduped");
	assert.equal(store.counts().events, 1);
	store.close();
	rmDir(dir);
});

test("events: pending events survive a reopen and can be replayed", () => {
	const dir = tmpDir();
	let store = MirStore.open(dir);
	store.insertEvent({
		id: "evt-1",
		channelId: "http",
		threadId: "t",
		text: "unfinished work",
		receivedAt: 1,
		status: "pending",
		attempts: 0,
	});
	store.insertEvent({
		id: "evt-2",
		channelId: "http",
		threadId: "t",
		text: "already handled",
		receivedAt: 2,
		status: "delivered",
		attempts: 0,
	});
	store.close();

	store = MirStore.open(dir);
	const pending = store.listPendingEvents();
	assert.deepEqual(
		pending.map((e) => e.id),
		["evt-1"],
	);
	assert.equal(store.getEvent("evt-2")?.status, "delivered");
	store.close();
	rmDir(dir);
});

test("events: attempts and terminal status are recorded", () => {
	const dir = tmpDir();
	const store = MirStore.open(dir);
	store.insertEvent({
		id: "evt-1",
		channelId: "http",
		threadId: "t",
		text: "x",
		receivedAt: 1,
		status: "pending",
		attempts: 0,
	});
	store.bumpEventAttempts("evt-1");
	store.markEvent("evt-1", "failed", "model unavailable");
	const event = store.getEvent("evt-1");
	assert.equal(event?.attempts, 1);
	assert.equal(event?.status, "failed");
	assert.equal(event?.error, "model unavailable");
	store.close();
	rmDir(dir);
});

test("tasks: upsert, read back, filter by status", () => {
	const dir = tmpDir();
	const store = MirStore.open(dir);
	store.upsertTask(task());
	store.upsertTask(task({ id: "task-2", status: "queued", fast: true }));

	assert.equal(store.listTasks().length, 2);
	assert.equal(store.listTasksByStatus("queued").length, 1);
	assert.equal(store.getTask("task-2")?.fast, true);

	store.upsertTask(task({ status: "done", result: "fixed" }));
	assert.equal(store.getTask("task-1")?.status, "done");
	assert.equal(store.getTask("task-1")?.result, "fixed");
	store.close();
	rmDir(dir);
});

test("workers: registry persists and can be cleared", () => {
	const dir = tmpDir();
	const store = MirStore.open(dir);
	store.upsertWorker({
		id: "worker-1",
		taskId: "task-1",
		status: "busy",
		threadIds: ["thread-1", "thread-2"],
		channelId: "http",
		replyTo: "evt-1",
		lastHeartbeat: 500,
		progress: "reading files",
	});

	const [worker] = store.listWorkers();
	assert.equal(worker?.id, "worker-1");
	assert.deepEqual(worker?.threadIds, ["thread-1", "thread-2"]);

	store.deleteWorker("worker-1");
	assert.equal(store.listWorkers().length, 0);
	store.close();
	rmDir(dir);
});

test("threads + subscriptions survive a restart", () => {
	const dir = tmpDir();
	const store = MirStore.open(dir);
	store.upsertThread({
		id: "thread-1",
		name: "pr-42",
		channelId: "http",
		lastEventAt: 10,
		subscriberWorkerIds: [],
	});
	store.subscribe("thread-1", "worker-a");
	store.subscribe("thread-1", "worker-b");
	store.close();

	const reopened = MirStore.open(dir);
	assert.deepEqual(reopened.listSubscribers("thread-1").sort(), ["worker-a", "worker-b"]);

	// ThreadManager hydrates from the store.
	const threads = new ThreadManager(reopened);
	assert.deepEqual(threads.getSubscribers("thread-1").sort(), ["worker-a", "worker-b"]);

	threads.unsubscribe("worker-a", "thread-1");
	assert.deepEqual(reopened.listSubscribers("thread-1"), ["worker-b"]);
	reopened.close();
	rmDir(dir);
});

test("objects: spilled context is durable and searchable", () => {
	const dir = tmpDir();
	let store = MirStore.open(dir);
	store.putObject({
		id: "task:task-1",
		type: "task",
		summary: "fix the flaky login test",
		ref: "mir://task/task-1",
		inlineIds: ["thread:thread-1"],
	});
	store.close();

	store = MirStore.open(dir);
	const found = store.getObject("task:task-1");
	assert.equal(found?.summary, "fix the flaky login test");
	assert.deepEqual(found?.inlineIds, ["thread:thread-1"]);
	assert.equal(store.searchObjects("flaky").length, 1);
	assert.equal(store.searchObjects("nothing-here").length, 0);
	store.close();
	rmDir(dir);
});

test("objects: retention keeps only the newest entries", () => {
	const dir = tmpDir();
	const store = MirStore.open(dir);
	for (let i = 0; i < 10; i++) {
		store.putObject(
			{ id: `o-${i}`, type: "message", summary: `note ${i}`, ref: `r-${i}`, inlineIds: [] },
			1000 + i,
		);
	}
	const deleted = store.pruneObjects(4);
	assert.equal(deleted, 6);
	assert.equal(store.counts().objects, 4);
	store.close();
	rmDir(dir);
});

test("search escapes LIKE wildcards", () => {
	const dir = tmpDir();
	const store = MirStore.open(dir);
	store.putObject({ id: "o-1", type: "message", summary: "100% done", ref: "r", inlineIds: [] });
	assert.equal(store.searchObjects("100%").length, 1);
	assert.equal(store.searchObjects("%").length, 1);
	store.close();
	rmDir(dir);
});

test("a log search narrows in SQL: kinds and text, newest last, with a total", () => {
	const dir = mkdtempSync(join(tmpdir(), "mir-search-"));
	const store = MirStore.open(dir);
	const thread = "thread-search";
	store.appendThreadEntry(thread, 1, "text", JSON.stringify({ role: "user", text: "the code word is otter" }));
	store.appendThreadEntry(thread, 2, "tool_call", JSON.stringify({ toolName: "exec", args: { argv: ["ls"] } }));
	store.appendThreadEntry(thread, 3, "text", JSON.stringify({ role: "assistant", text: "otter, twice" }));

	const texts = store.searchThreadEntries(thread, { kinds: ["text"], limit: 10 });
	assert.deepEqual(texts.rows.map((row) => row.seq), [1, 3]);
	assert.equal(texts.total, 2, "the total is what matched, not what was returned");

	const otter = store.searchThreadEntries(thread, { like: "otter", limit: 1 });
	assert.deepEqual(otter.rows.map((row) => row.seq), [3], "newest last, one row");
	assert.equal(otter.total, 2);

	store.close();
	rmSync(dir, { recursive: true, force: true });
});
