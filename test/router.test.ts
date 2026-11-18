import { test } from "node:test";
import assert from "node:assert/strict";
import { RouterLayer } from "../src/router.ts";
import { MirStore } from "../src/store.ts";
import { ThreadManager } from "../src/thread.ts";
import { ContextManager } from "../src/context.ts";
import { DEFAULT_CONFIG, type SuperAgentConfig } from "../src/types.ts";
import { RecordingChannel, FakeSpawner, makeTrigger, rmDir, tmpDir, waitFor, tick } from "./helpers/fakes.ts";
import { scriptedFactory, type Script } from "./helpers/scripted-session.ts";
import { ThreadLog } from "../src/threadlog.ts";
import type { ThreadEntry } from "../src/threadlog.ts";
import { createLogger } from "../src/telemetry.ts";

interface Harness {
	router: RouterLayer;
	store: MirStore;
	threads: ThreadManager;
	context: ContextManager;
	channel: RecordingChannel;
	spawner: FakeSpawner;
	config: SuperAgentConfig;
	sessions: ReturnType<typeof scriptedFactory>["sessions"];
	published: Array<{ threadId: string; entry: ThreadEntry }>;
	threadLog: ThreadLog | undefined;
	dir: string;
	cleanup: () => Promise<void>;
}

async function makeRouter(
	options: {
		script?: Script;
		detached?: boolean;
		maxConcurrentWorkers?: number;
		batchWindowMs?: number;
		maxTriggerAttempts?: number;
		seed?: (store: MirStore) => void;
		hands?: { socketPath: string; listHands: () => any[] };
		/** Give the router a thread log, and collect what it publishes. */
		threadLog?: boolean;
	} = {},
): Promise<Harness> {
	const dir = tmpDir();
	const store = MirStore.open(dir);
	options.seed?.(store);
	const threads = new ThreadManager(store);
	const context = new ContextManager({ store });
	const channel = new RecordingChannel("terminal");
	const published: Array<{ threadId: string; entry: ThreadEntry }> = [];
	const threadLog = options.threadLog === true
		? new ThreadLog({ store, log: createLogger({ level: "error", format: "json", write: () => {} }) })
		: undefined;
	const spawner = new FakeSpawner();
	const config: SuperAgentConfig = {
		...DEFAULT_CONFIG,
		sessionDir: "",
		stateDir: dir,
		socketPath: `${dir}/daemon.sock`,
		workerSessionDir: `${dir}/workers`,
		queueDir: `${dir}/queue`,
		batchWindowMs: options.batchWindowMs ?? 0,
		maxConcurrentWorkers: options.maxConcurrentWorkers ?? 4,
		maxTriggerAttempts: options.maxTriggerAttempts ?? 3,
		routerRetryBackoffMs: 1,
		objectRetention: 1000,
	};
	const { factory, sessions } = scriptedFactory({
		script: options.script ?? (() => []),
		detached: options.detached,
	});
	const router = await RouterLayer.create({
		modelRuntime: {} as any,
		model: {} as any,
		config,
		context,
		threads,
		channels: [channel],
		processManager: spawner,
		store,
		onTurnComplete: () => {},
		sessionFactory: factory,
		hands: options.hands,
		threadLog,
		publishEntry: (threadId, entry) => published.push({ threadId, entry }),
	});
	return {
		router,
		store,
		threads,
		context,
		channel,
		spawner,
		config,
		sessions,
		published,
		threadLog,
		dir,
		cleanup: async () => {
			await router.dispose();
			store.close();
			rmDir(dir);
		},
	};
}

test("reply attribution: a plain-text answer is delivered exactly once", async () => {
	const h = await makeRouter({ script: () => [{ type: "text", text: "here is the answer" }] });
	try {
		const trigger = makeTrigger();
		h.router.submitTrigger(trigger);
		await waitFor(() => h.channel.replies.length === 1, 2000, "one reply");

		assert.equal(h.channel.replies[0]!.text, "here is the answer");
		assert.equal(h.channel.replies[0]!.ctx.eventId, trigger.id);
		// Give the layer a chance to double-post before asserting.
		await tick(30);
		assert.equal(h.channel.replies.length, 1);
	} finally {
		await h.cleanup();
	}
});

test("reply attribution: a response-tool answer is not duplicated by the fallback", async () => {
	const h = await makeRouter({
		script: () => [
			{ type: "text", text: "thinking out loud" },
			{ type: "tool", name: "respond_terminal", args: { text: "the real answer" } },
		],
	});
	try {
		h.router.submitTrigger(makeTrigger());
		await waitFor(() => h.channel.replies.length >= 1, 2000, "a reply");
		await tick(30);
		assert.equal(h.channel.replies.length, 1);
		assert.equal(h.channel.replies[0]!.text, "the real answer");
	} finally {
		await h.cleanup();
	}
});

test("reply attribution: a queued (detached) turn cannot cause a premature fallback", async () => {
	// This is the regression test for the original bug: `prompt()` returns as
	// soon as the message is queued, so the reply check used to run against a
	// half-finished turn and post partial text. The fix waits for idle first.
	const h = await makeRouter({
		detached: true,
		script: () => [
			{ type: "text", text: "partial answer" },
			{ type: "sleep", ms: 20 },
			{ type: "tool", name: "respond_terminal", args: { text: "final answer" } },
		],
	});
	try {
		h.router.submitTrigger(makeTrigger());
		await waitFor(() => h.channel.replies.length >= 1, 2000, "a reply");
		await tick(60);
		assert.equal(h.channel.replies.length, 1, "must not post the partial text as well");
		assert.equal(h.channel.replies[0]!.text, "final answer");
	} finally {
		await h.cleanup();
	}
});

test("batching: events arriving inside the window are folded into one turn", async () => {
	const h = await makeRouter({ batchWindowMs: 40, script: () => [{ type: "text", text: "ok" }] });
	try {
		h.router.submitTrigger(makeTrigger({ text: "first request" }));
		h.router.submitTrigger(makeTrigger({ text: "second request" }));
		await waitFor(() => h.sessions[0]!.prompts.length === 1, 2000, "one batched turn");
		const prompt = h.sessions[0]!.lastPrompt;
		assert.match(prompt, /first request/);
		assert.match(prompt, /second request/);
	} finally {
		await h.cleanup();
	}
});

test("batching: a busy turn drains the backlog in the next turn, not a dropped event", async () => {
	const h = await makeRouter({
		script: (_prompt, turn) =>
			turn === 1
				? [
						{ type: "sleep", ms: 30 },
						{ type: "tool", name: "respond_terminal", args: { text: "one" } },
					]
				: [{ type: "tool", name: "respond_terminal", args: { text: "two" } }],
	});
	try {
		h.router.submitTrigger(makeTrigger({ text: "turn one" }));
		await tick(5);
		h.router.submitTrigger(makeTrigger({ text: "turn two" }));
		await waitFor(() => h.sessions[0]!.prompts.length === 2, 2000, "two turns");
		assert.match(h.sessions[0]!.prompts[1]!, /turn two/);
	} finally {
		await h.cleanup();
	}
});

test("conclusions: a worker result is relayed once and the task is marked done", async () => {
	const h = await makeRouter({
		script: () => [{ type: "tool", name: "respond_terminal", args: { text: "all done" } }],
	});
	try {
		const task = await h.router.dispatchTask({
			title: "fix it",
			description: "fix the thing",
			channelId: "terminal",
			replyTo: "evt-origin",
		});
		const workerId = h.router.listWorkers()[0]!.id;
		h.router.handleWorkerHello(workerId);
		h.router.handleWorkerConclusion(workerId, "fixed: changed 3 files");

		await waitFor(() => h.channel.replies.length === 1, 2000, "one relayed reply");
		assert.equal(h.channel.replies[0]!.text, "all done");
		assert.equal(h.router.getTask(task.id)?.status, "done");
		assert.equal(h.router.getTask(task.id)?.result, "fixed: changed 3 files");
		assert.equal(h.store.getTask(task.id)?.status, "done", "durable copy updated");
	} finally {
		await h.cleanup();
	}
});

test("worker death: the task fails and the Router is told", async () => {
	const h = await makeRouter({ script: () => [{ type: "text", text: "the worker died, sorry" }] });
	try {
		const task = await h.router.dispatchTask({
			title: "long job",
			description: "do it",
			channelId: "terminal",
		});
		const workerId = h.router.listWorkers()[0]!.id;
		h.router.handleWorkerDisconnect(workerId);

		await waitFor(() => h.channel.replies.length === 1, 2000, "a reply about the death");
		assert.equal(h.router.getTask(task.id)?.status, "failed");
		assert.match(h.sessions[0]!.lastPrompt, /exited without a conclusion/);
		assert.ok(h.spawner.killed.includes(task.id), "the pm2 app is cleaned up");
	} finally {
		await h.cleanup();
	}
});

test("capacity: tasks beyond the worker limit queue instead of failing", async () => {
	const h = await makeRouter({ maxConcurrentWorkers: 1, script: () => [] });
	try {
		const first = await h.router.dispatchTask({ title: "a", description: "a" });
		const second = await h.router.dispatchTask({ title: "b", description: "b" });

		assert.equal(first.status, "running");
		assert.equal(second.status, "queued");
		assert.equal(h.spawner.spawned.length, 1);
		assert.equal(h.store.getTask(second.id)?.status, "queued");

		const firstWorker = h.router.listWorkers()[0]!.id;
		await h.router.reapWorker(firstWorker);

		await waitFor(() => h.spawner.spawned.length === 2, 2000, "queued task spawned");
		assert.equal(h.router.getTask(second.id)?.status, "running");
	} finally {
		await h.cleanup();
	}
});

test("capacity: a full dispatch queue rejects rather than growing without bound", async () => {
	const h = await makeRouter({ maxConcurrentWorkers: 1, script: () => [] });
	h.config.maxDispatchQueue = 1;
	try {
		await h.router.dispatchTask({ title: "a", description: "a" });
		await h.router.dispatchTask({ title: "b", description: "b" });
		await assert.rejects(
			() => h.router.dispatchTask({ title: "c", description: "c" }),
			/dispatch queue full/,
		);
	} finally {
		await h.cleanup();
	}
});

test("spawn failure: the task is marked failed instead of throwing at the Router", async () => {
	const h = await makeRouter({ script: () => [] });
	try {
		h.spawner.failNextWith = "pm2 exploded";
		const task = await h.router.dispatchTask({ title: "doomed", description: "x" });
		assert.equal(task.status, "failed");
		assert.match(task.error ?? "", /pm2 exploded/);
		assert.equal(h.store.getTask(task.id)?.status, "failed");
		assert.equal(h.router.listWorkers().length, 0);
	} finally {
		await h.cleanup();
	}
});

test("recovery: tasks interrupted by a restart are failed and reported", async () => {
	const h = await makeRouter({
		script: () => [{ type: "text", text: "the daemon restarted mid-task" }],
		seed: (store) => {
			store.upsertTask({
				id: "task-orphan",
				title: "half-finished",
				description: "was running",
				status: "running",
				channelId: "terminal",
				createdAt: 1,
				updatedAt: 1,
			});
			store.upsertWorker({
				id: "worker-orphan",
				taskId: "task-orphan",
				status: "busy",
				threadIds: [],
				channelId: "terminal",
				lastHeartbeat: 1,
				progress: "working",
			});
		},
	});
	try {
		await waitFor(() => h.channel.replies.length === 1, 2000, "recovery notice");
		assert.equal(h.router.getTask("task-orphan")?.status, "failed");
		assert.match(h.router.getTask("task-orphan")?.error ?? "", /restarted/);
		assert.match(h.sessions[0]!.lastPrompt, /restarted/);
		assert.equal(h.router.listWorkers().length, 0);
	} finally {
		await h.cleanup();
	}
});

test("retry: a failed turn is retried and can succeed on the next attempt", async () => {
	const h = await makeRouter({
		maxTriggerAttempts: 3,
		script: (_prompt, turn) => {
			if (turn === 1) return [{ type: "throw", message: "model unavailable" }];
			return [{ type: "tool", name: "respond_terminal", args: { text: "recovered" } }];
		},
	});
	try {
		const trigger = makeTrigger();
		h.router.submitTrigger(trigger);
		await waitFor(() => h.channel.replies.length === 1, 3000, "recovered reply");
		assert.equal(h.channel.replies[0]!.text, "recovered");
		assert.ok(h.sessions[0]!.prompts.length >= 2);
		assert.notEqual(h.store.getEvent(trigger.id)?.status, "failed");
	} finally {
		await h.cleanup();
	}
});

test("retry: exhausted events are marked failed and the human is told", async () => {
	const h = await makeRouter({
		maxTriggerAttempts: 1,
		script: () => [{ type: "throw", message: "model unavailable" }],
	});
	try {
		const trigger = makeTrigger();
		// The trigger log row exists in production (SuperAgent writes it first).
		h.store.insertEvent({
			id: trigger.id,
			channelId: trigger.channelId,
			threadId: "thread-1",
			text: trigger.text,
			receivedAt: trigger.receivedAt,
			status: "routed",
			attempts: 0,
		});
		h.router.submitTrigger(trigger);
		await waitFor(() => h.channel.replies.length === 1, 3000, "failure notice");
		assert.match(h.channel.replies[0]!.text, /couldn't complete/);
		assert.equal(h.store.getEvent(trigger.id)?.status, "failed");
		assert.equal(h.sessions[0]!.prompts.length, 1, "no further attempts after exhaustion");
	} finally {
		await h.cleanup();
	}
});

test("stop_task: cancels the task, aborts the worker and frees the slot", async () => {
	const h = await makeRouter({ script: () => [] });
	try {
		const task = await h.router.dispatchTask({ title: "stop me", description: "x" });
		const stopped = await h.router.stopTask(task.id, "user cancelled");
		assert.equal(stopped.status, "cancelled");
		assert.equal(h.router.getTask(task.id)?.status, "cancelled");
		assert.ok(h.spawner.killed.includes(task.id));
		assert.equal(h.router.listWorkers().length, 0);
	} finally {
		await h.cleanup();
	}
});

test("recall: the Router can read back spilled task context", async () => {
	const h = await makeRouter({
		script: () => [
			{ type: "tool", name: "recall", args: { query: "flaky login test" } },
			{ type: "tool", name: "respond_terminal", args: { text: "found it" } },
		],
	});
	try {
		await h.router.dispatchTask({
			title: "stabilise the flaky login test",
			description: "it fails 1 in 20 runs",
		});
		h.router.submitTrigger(makeTrigger({ text: "what were we doing?" }));
		await waitFor(() => h.channel.replies.length === 1, 2000, "reply");
		const recallCall = h.sessions[0]!.calls.find((c) => c.name === "recall");
		assert.ok(recallCall, "recall tool was called");
		const text = recallCall!.result.content[0].text as string;
		assert.match(text, /flaky login test/);
	} finally {
		await h.cleanup();
	}
});

test("worker hand-back: a released event returns to the Router and the subscription is dropped", async () => {
	const h = await makeRouter({
		script: () => [{ type: "tool", name: "respond_terminal", args: { text: "handled by the router" } }],
	});
	try {
		const task = await h.router.dispatchTask({
			title: "own the thread",
			description: "x",
			threadId: "thread-1",
			channelId: "terminal",
		});
		const workerId = h.router.listWorkers()[0]!.id;
		assert.deepEqual(h.threads.getSubscribers("thread-1"), [workerId]);

		// The event the worker was handed must exist in the trigger log.
		h.store.insertEvent({
			id: "evt-followup",
			channelId: "terminal",
			threadId: "thread-1",
			text: "actually this is someone else's job",
			receivedAt: Date.now(),
			status: "delivered",
			attempts: 0,
		});
		h.router.handleWorkerRelease(workerId, "evt-followup", "not mine");

		await waitFor(() => h.channel.replies.length === 1, 2000, "router reply after hand-back");
		assert.deepEqual(h.threads.getSubscribers("thread-1"), [], "subscription released");
		assert.match(h.sessions[0]!.lastPrompt, /someone else's job/);
		assert.equal(h.router.getTask(task.id)?.status, "running");
	} finally {
		await h.cleanup();
	}
});

test("dispose: a disposed router stops accepting work", async () => {
	const h = await makeRouter({ script: () => [{ type: "text", text: "x" }] });
	await h.router.dispose();
	h.router.submitTrigger(makeTrigger());
	await tick(30);
	assert.equal(h.channel.replies.length, 0);
	await h.cleanup();
});

test("retry: a failed conclusion relay is retried, not dropped", async () => {
	const h = await makeRouter({
		maxTriggerAttempts: 3,
		script: (_prompt, turn) => {
			if (turn === 1) return [{ type: "throw", message: "model unavailable" }];
			return [{ type: "tool", name: "respond_terminal", args: { text: "relayed on retry" } }];
		},
	});
	try {
		await h.router.dispatchTask({ title: "t", description: "d", channelId: "terminal" });
		const workerId = h.router.listWorkers()[0]!.id;
		h.router.handleWorkerConclusion(workerId, "the work is finished");

		await waitFor(() => h.channel.replies.length === 1, 3000, "relayed conclusion");
		assert.equal(h.channel.replies[0]!.text, "relayed on retry");
		assert.ok(h.sessions[0]!.prompts.length >= 2, "the relay was retried");
	} finally {
		await h.cleanup();
	}
});

test("pruneTasks: memory is bounded, the durable store is not", async () => {
	const h = await makeRouter({ script: () => [] });
	try {
		for (let i = 0; i < 6; i++) {
			const task = await h.router.dispatchTask({ title: `t${i}`, description: "d" });
			await h.router.stopTask(task.id, "done for the test");
		}
		assert.equal(h.router.listTasks().length, 6);
		const removed = h.router.pruneTasks(2);
		assert.equal(removed, 4);
		assert.equal(h.router.listTasks().length, 2);
		assert.equal(h.store.listTasks().length, 6, "the store keeps every task");
	} finally {
		await h.cleanup();
	}
});

test("hands: a pinned task carries the hand and hub socket into the worker spec", async () => {
	const handStatus = {
		endpointId: "mac",
		name: "MacBook",
		connected: true,
		capabilities: { exec: true, shell: false, fs: "rw" as const, git: true },
		policy: { roots: ["/work"], allow: ["git"], maxConcurrent: 2 },
		running: 0,
		lastSeen: Date.now(),
		kind: "local" as const,
	};
	const h = await makeRouter({
		script: () => [],
		hands: { socketPath: "/tmp/hands.sock", listHands: () => [handStatus] },
	});
	try {
		await h.router.dispatchTask({ title: "on the mac", description: "x", endpointId: "mac" });
		assert.equal(h.spawner.spawned.length, 1);
		assert.equal(h.spawner.spawned[0]!.endpointId, "mac");
		assert.equal(h.spawner.spawned[0]!.handsSocketPath, "/tmp/hands.sock");
		assert.equal(h.router.getTask(h.router.listTasks()[0]!.id)?.endpointId, "mac");
	} finally {
		await h.cleanup();
	}
});

test("hands: the Router can inspect hands before choosing one", async () => {
	const h = await makeRouter({
		script: () => [
			{ type: "tool", name: "list_hands", args: {} },
			{ type: "tool", name: "respond_terminal", args: { text: "checked" } },
		],
		hands: {
			socketPath: "/tmp/hands.sock",
			listHands: () => [
				{
					endpointId: "build-box",
					name: "Build",
					connected: true,
					capabilities: { exec: true, shell: false, fs: "ro" as const, git: false },
					policy: { roots: ["/srv/build"], allow: ["make"], maxConcurrent: 1 },
					running: 0,
					lastSeen: Date.now(),
					kind: "remote" as const,
				},
			],
		},
	});
	try {
		h.router.submitTrigger(makeTrigger({ text: "where can you run things?" }));
		await waitFor(() => h.channel.replies.length === 1, 2000, "reply");
		const call = h.sessions[0]!.calls.find((c) => c.name === "list_hands");
		assert.ok(call, "list_hands was called");
		assert.match(call!.result.content[0].text as string, /build-box/);
		assert.match(call!.result.content[0].text as string, /fs=ro/);
	} finally {
		await h.cleanup();
	}
});

// ---------------------------------------------------------------------------
// The thread log
// ---------------------------------------------------------------------------

test("thread log: a reply is written to the thread it answered, and published live", async () => {
	const h = await makeRouter({
		threadLog: true,
		script: () => [{ type: "tool", name: "respond_terminal", args: { text: "the answer" } }],
	});
	try {
		const trigger = makeTrigger({ threadId: "thread-1" });
		h.router.submitTrigger(trigger);
		await waitFor(() => h.channel.replies.length === 1, 2000, "the reply");

		const entries = h.threadLog!.entries("thread-1");
		assert.deepEqual(
			// Both sides of the conversation: the member's words are in the log too,
			// because a chat is a projection of its thread.
			entries.map((entry) => (entry.kind === "text" ? `${entry.role}: ${entry.text}` : entry.kind)),
			[`user: ${trigger.text}`, "assistant: the answer"],
			"the thread holds what was said to it, then what it said",
		);
		assert.deepEqual(
			[...new Set(h.published.map((item) => item.threadId))],
			["thread-1"],
			"and a watching client was told of everything written there, without polling",
		);
	} finally {
		await h.cleanup();
	}
});

test("thread log: a dispatch and a worker's conclusion are the work thread's entries", async () => {
	const h = await makeRouter({ threadLog: true, script: () => [] });
	try {
		const task = await h.router.dispatchTask({
			title: "write the report",
			description: "write it",
			threadId: "work-1",
			endpointId: "studio-mac",
		});
		const started = h.threadLog!.entries("work-1");
		assert.equal(started.length, 1);
		assert.equal(started[0]!.kind, "status");
		assert.match((started[0] as { note?: string }).note ?? "", /studio-mac/);

		h.router.handleWorkerConclusion(task.workerId!, "the report is written");
		const after = h.threadLog!.entries("work-1");
		assert.deepEqual(
			after.slice(1).map((entry) => (entry.kind === "text" ? entry.text : entry.kind)),
			["the report is written", "status"],
			"the worker's answer, then that the thread is done",
		);
		assert.equal(h.threadLog!.status("work-1"), "done");
	} finally {
		await h.cleanup();
	}
});

test("thread log: a worker's stream is coalesced, not a line per token", async () => {
	const h = await makeRouter({ threadLog: true, script: () => [] });
	try {
		const task = await h.router.dispatchTask({ title: "t", description: "d", threadId: "work-2" });
		const workerId = task.workerId!;
		h.router.handleWorkerDelta(workerId, "wor");
		h.router.handleWorkerDelta(workerId, "king");
		h.router.handleWorkerDelta(workerId, " on it");
		// The conclusion flushes whatever was buffered, before its own entries.
		h.router.handleWorkerConclusion(workerId, "done");
		const text = h.threadLog!
			.entries("work-2")
			.filter((entry) => entry.kind === "text")
			.map((entry) => (entry as { text: string }).text);
		assert.deepEqual(text, ["working on it", "done"]);
	} finally {
		await h.cleanup();
	}
});

test("the Router can name the chat it is answering, and read the name back", async () => {
	// A chat called "Chat" is one the person cannot find again. The agent knows
	// what the conversation came to be about, so the name is its call — and a call
	// with no title is how it tells a placeholder from a name someone chose.
	const h = await makeRouter({
		threadLog: true,
		script: () => [
			{ type: "tool", name: "chat_title", args: {} },
			{ type: "tool", name: "chat_title", args: { title: "Linear projects in flight" } },
			{ type: "tool", name: "chat_title", args: {} },
			{ type: "tool", name: "respond_terminal", args: { text: "on it" } },
		],
	});
	try {
		h.router.submitTrigger(makeTrigger({ threadId: "thread-9", text: "what is going on with linear" }));
		await waitFor(() => h.channel.replies.length === 1, 2000, "the reply");

		const answers = h.sessions[0]!.calls
			.filter((call) => call.name === "chat_title")
			.map((call) => String(call.result?.content?.[0]?.text ?? ""));
		assert.match(answers[0] ?? "", /^this chat is called "/, "a call with no title answers what the chat was called");
		assert.equal(answers[1], 'renamed this chat to "Linear projects in flight"');
		assert.equal(answers[2], 'this chat is called "Linear projects in flight"', "and the next read agrees");

		const entries = h.threadLog!.entries("thread-9");
		const title = entries.find((entry) => entry.kind === "title");
		assert.ok(title, "the rename is in the conversation's log");
		assert.equal(h.threadLog!.name("thread-9"), "Linear projects in flight", "and the thread's own name moved with it");
		assert.ok(
			h.published.some((item) => item.entry.kind === "title"),
			"a watching client was told, so the header and the list change without a reload",
		);
	} finally {
		await h.cleanup();
	}
});

test("a chat the agent left called \"Chat\" is named from the work it did", async () => {
	// Advice is not a mechanism. A model that never calls chat_title leaves the
	// member with a chat called "Chat" in a list of chats called "Chat" — so the
	// turn's own work names it, from the title the agent already wrote for it.
	const h = await makeRouter({
		threadLog: true,
		script: () => [
			{ type: "tool", name: "dispatch_task", args: { title: "List active Linear projects", description: "run it" } },
			{ type: "tool", name: "respond_terminal", args: { text: "on it" } },
		],
	});
	try {
		const threadId = h.threadLog!.chatThread("chat-7", "Chat");
		h.router.submitTrigger(makeTrigger({ threadId, text: "what is going on with linear" }));
		await waitFor(() => h.channel.replies.length === 1, 2000, "the reply");

		assert.equal(h.threadLog!.name(threadId), "List active Linear projects", "the chat is named after what it did");
		assert.ok(
			h.published.some((item) => item.entry.kind === "title"),
			"and a client is told, so the header and the list change",
		);
	} finally {
		await h.cleanup();
	}
});

test("a greeting does not name the chat: a chat called after \"Hey there\" is no easier to find", async () => {
	const h = await makeRouter({
		threadLog: true,
		script: () => [{ type: "tool", name: "respond_terminal", args: { text: "hey" } }],
	});
	try {
		const threadId = h.threadLog!.chatThread("chat-6", "Chat");
		h.router.submitTrigger(makeTrigger({ threadId, text: "hey there" }));
		await waitFor(() => h.channel.replies.length === 1, 2000, "the reply");

		assert.equal(h.threadLog!.name(threadId), "Chat", "the placeholder stands until there is something to name");
		assert.equal(
			h.threadLog!.entries(threadId).filter((entry) => entry.kind === "title").length,
			0,
			"and nothing was renamed",
		);
	} finally {
		await h.cleanup();
	}
});

test("the procedure is in the skills, not in the turn prompt", async () => {
	// A rule stated twice drifts: the prompt had the five exceptions and the naming
	// rules, and the skills have them too. The prompt keeps what must hold on every
	// turn — the invariants and the deployment's own facts — and points at the skill
	// for the procedure.
	const h = await makeRouter({ script: () => [{ type: "tool", name: "respond_terminal", args: { text: "hi" } }] });
	try {
		h.router.submitTrigger(makeTrigger({ threadId: "the-chat", text: "hello there" }));
		await waitFor(() => (h.sessions[0]?.prompts.length ?? 0) > 0, 3000, "a turn");
		const prompt = h.sessions[0]!.prompts[0] ?? "";

		// Gone: the procedure, now a skill.
		assert.doesNotMatch(prompt, /Dispatch, unless it is one of these five/, "the five exceptions are a skill");
		assert.doesNotMatch(prompt, /If you are unsure whether it is a quick reply/, "the dispatch bias is a skill");
		assert.doesNotMatch(prompt, /Name the chat, and keep naming it/, "naming is a skill");
		assert.doesNotMatch(prompt, /call chat_title with four or five words/, "and so are its rules");

		// Still here: what only this deployment knows, and the pointer at the skill.
		assert.match(prompt, /You do not do work yourself: a Worker does\./);
		assert.match(prompt, /Read the `dispatch` skill before you act/);
		assert.match(prompt, /Read `chat-title` before you end a turn/);
		assert.match(prompt, /Channels: terminal/);
		assert.match(prompt, /use_skill \(read one of your skills\)/);
		// And the invariants are not in the turn at all: they are the system prompt's.
		assert.doesNotMatch(prompt, /Never mention the machinery/, "invariants belong to the system prompt");

		// And the skill has what the prompt no longer says, so nothing was lost in
		// the move.
		const { readSkill } = await import("../src/skills.ts");
		const dispatch = (await readSkill("dispatch")).replace(/\s+/g, " ");
		assert.match(dispatch, /Dispatch, unless it is one of these five/);
		assert.match(dispatch, /If you are unsure whether it is a quick reply, it is not a quick reply/);
		const naming = (await readSkill("chat-title")).replace(/\s+/g, " ");
		assert.match(naming, /four or five words/);
	} finally {
		await h.cleanup();
	}
});

test("the Router is offered use_skill, so the skills it is advertised can be read", async () => {
	// pi advertises a skill's name, description and path; the Router has no file
	// tools by design, so without this the skills are decoration.
	const h = await makeRouter({ script: () => [{ type: "tool", name: "respond_terminal", args: { text: "hi" } }] });
	try {
		h.router.submitTrigger(makeTrigger({ threadId: "the-chat", text: "hello" }));
		await waitFor(() => (h.sessions[0]?.prompts.length ?? 0) > 0, 3000, "a turn");
		const names = h.sessions[0]!.tools.map((tool) => tool.name);
		assert.ok(names.includes("use_skill"), `expected use_skill, saw ${names.join(", ")}`);
	} finally {
		await h.cleanup();
	}
});

test("the invariants go to the system prompt, and the skills go with them", async () => {
	// The system prompt is where a rule that must hold on every turn belongs. What
	// this holds is the hand-over: the loader carries the invariants and the brain's
	// six skills, and pi assembles both into the prompt the model is given.
	const h = await makeRouter({ script: () => [{ type: "tool", name: "respond_terminal", args: { text: "hi" } }] });
	try {
		h.router.submitTrigger(makeTrigger({ threadId: "the-chat", text: "hello" }));
		await waitFor(() => (h.sessions[0]?.prompts.length ?? 0) > 0, 3000, "a turn");
		const loader = h.sessions[0]!.resourceLoader as {
			getAppendSystemPrompt(): string[];
			getSkills(): { skills: Array<{ name: string }> };
		};

		const appended = loader.getAppendSystemPrompt().join("\n");
		assert.match(appended, /Never mention the machinery/);
		assert.match(appended, /Write like a person talking to a person/);
		assert.match(appended, /Never promise to come back/);

		const names = loader.getSkills().skills.map((skill) => skill.name).sort();
		assert.deepEqual(names, ["chat-title", "conclusion", "connected-services", "dispatch", "hands", "subagents"]);
	} finally {
		await h.cleanup();
	}
});
