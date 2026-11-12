import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { WorkerRuntime, createWorkerControlTools, WorkerStateStore } from "../src/worker.ts";
import { rmDir, tmpDir, tick, waitFor } from "./helpers/fakes.ts";
import { scriptedFactory } from "./helpers/scripted-session.ts";

interface ReporterLog {
	statuses: Array<{ status: string; progress?: string }>;
	heartbeats: number;
	deltas: string[];
	releases: Array<{ eventId: string; reason?: string }>;
	unsubscribes: Array<{ threadId: string; reason?: string }>;
}

async function makeWorker(options: {
	script?: Parameters<typeof scriptedFactory>[0]["script"];
	heartbeatMs?: number;
	dir?: string;
} = {}) {
	const dir = options.dir ?? tmpDir();
	const log: ReporterLog = {
		statuses: [],
		heartbeats: 0,
		deltas: [],
		releases: [],
		unsubscribes: [],
	};
	const { factory, sessions } = scriptedFactory({
		script: options.script ?? (() => [{ type: "text", text: "done" }]),
	});
	const worker = await WorkerRuntime.create({
		taskId: "task-1",
		modelRuntime: {} as any,
		model: {} as any,
		sessionDir: dir,
		heartbeatMs: options.heartbeatMs,
		sessionFactory: factory,
		reporter: {
			status: (status, progress) => log.statuses.push({ status, progress }),
			delta: (text) => log.deltas.push(text),
			heartbeat: () => {
				log.heartbeats++;
			},
			release: (eventId, reason) => log.releases.push({ eventId, reason }),
			unsubscribe: (threadId, reason) => log.unsubscribes.push({ threadId, reason }),
		},
	});
	return { worker, log, dir, sessions };
}

test("session persistence: a new worker is given a file-backed session", async () => {
	const dir = tmpDir();
	const seen: Array<{ persisted: boolean }> = [];
	const { factory } = scriptedFactory({ script: () => [{ type: "text", text: "done" }] });
	const worker = await WorkerRuntime.create({
		taskId: "task-1",
		modelRuntime: {} as any,
		model: {} as any,
		sessionDir: dir,
		sessionFactory: async (options) => {
			seen.push({ persisted: Boolean(options.sessionManager?.isPersisted?.()) });
			return factory(options);
		},
		reporter: { status: () => {}, delta: () => {} },
	});
	try {
		assert.equal(seen.length, 1);
		assert.equal(
			seen[0]!.persisted,
			true,
			"the session must be file-backed; the old code used inMemory for every new task",
		);
		assert.ok(fs.existsSync(path.join(dir, "sessions")), "the session directory is created");
	} finally {
		await worker.dispose();
		rmDir(dir);
	}
});

test("run: streams deltas and returns the final text", async () => {
	const { worker, log, dir, sessions } = await makeWorker({
		script: () => [
			{ type: "text", text: "working… " },
			{ type: "text", text: "finished" },
		],
	});
	try {
		const result = await worker.run("do the task");
		assert.equal(result, "working… finished");
		assert.equal(sessions[0]!.prompts.length, 1);
		assert.ok(log.deltas.length >= 2);
		assert.equal(log.statuses.at(-1)?.status, "busy");
	} finally {
		await worker.dispose();
		rmDir(dir);
	}
});

test("follow-ups: events arriving mid-turn are queued and drained in order", async () => {
	const { worker, dir, sessions } = await makeWorker({
		script: (prompt) => [
			{ type: "sleep", ms: prompt === "task" ? 30 : 0 },
			{ type: "text", text: "ok" },
		],
	});
	try {
		const initial = worker.run("task");
		// Two follow-ups land while the initial turn is still running.
		worker.enqueueFollowUp("follow-up one", "evt-1");
		worker.enqueueFollowUp("follow-up two", "evt-2");
		await initial;

		await waitFor(() => sessions[0]!.prompts.length === 3, 2000, "all three turns");
		assert.deepEqual(sessions[0]!.prompts, ["task", "follow-up one", "follow-up two"]);
		assert.equal(worker.queuedFollowUps, 0);
	} finally {
		await worker.dispose();
		rmDir(dir);
	}
});

test("follow-ups: a failing turn does not lose the ones behind it", async () => {
	const { worker, dir, sessions } = await makeWorker({
		script: (prompt) => {
			if (prompt === "follow-up one") return [{ type: "throw", message: "boom" }];
			return [{ type: "text", text: "ok" }];
		},
	});
	try {
		worker.enqueueFollowUp("follow-up one", "evt-1");
		worker.enqueueFollowUp("follow-up two", "evt-2");
		await waitFor(() => sessions[0]!.prompts.length === 2, 2000, "both follow-ups");
		assert.deepEqual(sessions[0]!.prompts, ["follow-up one", "follow-up two"]);
	} finally {
		await worker.dispose();
		rmDir(dir);
	}
});

test("heartbeat: fires on a timer independently of turn progress", async () => {
	const { worker, log, dir } = await makeWorker({ heartbeatMs: 10 });
	try {
		await waitFor(() => log.heartbeats >= 2, 2000, "heartbeats");
	} finally {
		await worker.dispose();
		rmDir(dir);
	}
});

test("control tools: release_event reports the current event, unsubscribe_thread reports the thread", async () => {
	const { worker, log, dir } = await makeWorker({
		script: (prompt) => {
			if (prompt.includes("follow-up")) {
				return [{ type: "tool", name: "release_event", args: { reason: "not mine" } }];
			}
			return [{ type: "text", text: "ok" }];
		},
	});
	try {
		worker.addTools(createWorkerControlTools(worker, ["thread-1"]));
		worker.enqueueFollowUp("follow-up on your thread", "evt-9");
		await waitFor(() => log.releases.length === 1, 2000, "release reported");
		assert.deepEqual(log.releases[0], { eventId: "evt-9", reason: "not mine" });

		worker.unsubscribeThread("thread-1", "done here");
		assert.deepEqual(log.unsubscribes[0], { threadId: "thread-1", reason: "done here" });
	} finally {
		await worker.dispose();
		rmDir(dir);
	}
});

test("state store: WAL is enabled and task state is durable", async () => {
	const dir = tmpDir();
	const store = WorkerStateStore.open(dir);
	store.setTaskStatus("task-1", { status: "busy", progress: "reading" });
	store.setTaskStatus("task-1", { status: "done", result: "finished" });
	const state = store.getTaskState("task-1");
	assert.equal(state?.status, "done");
	assert.equal(state?.result, "finished");
	assert.equal(store.listTaskStates().length, 1);
	await store.close();

	const reopened = WorkerStateStore.open(dir);
	assert.equal(reopened.getTaskState("task-1")?.result, "finished");
	await reopened.close();
	rmDir(dir);
});

test("dispose: a disposed worker refuses further turns", async () => {
	const { worker, dir } = await makeWorker();
	await worker.dispose();
	await assert.rejects(() => worker.run("again"), /disposed/);
	rmDir(dir);
});
