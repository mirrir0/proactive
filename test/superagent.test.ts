import { test } from "node:test";
import assert from "node:assert/strict";
import { SuperAgent } from "../src/superagent.ts";
import { MirStore } from "../src/store.ts";
import { DEFAULT_CONFIG, type SuperAgentConfig } from "../src/types.ts";
import { FakeSpawner, RecordingChannel, makeEvent, rmDir, tmpDir, waitFor, tick } from "./helpers/fakes.ts";
import { scriptedFactory, type Script } from "./helpers/scripted-session.ts";

async function makeAgent(options: { script?: Script; seed?: (store: MirStore) => void; config?: Partial<SuperAgentConfig> } = {}) {
	const dir = tmpDir();
	const channel = new RecordingChannel("http", "http");
	const spawner = new FakeSpawner();
	const { factory, sessions } = scriptedFactory({
		script: options.script ?? (() => [{ type: "tool", name: "respond_http", args: { text: "ok" } }]),
	});
	const config: Partial<SuperAgentConfig> = {
		...DEFAULT_CONFIG,
		sessionDir: "",
		stateDir: `${dir}/state`,
		workerSessionDir: `${dir}/workers`,
		queueDir: `${dir}/queue`,
		socketPath: `${dir}/daemon.sock`,
		batchWindowMs: 0,
		metricsPort: 0,
		semanticFilter: { enabled: false, policies: [] },
		watchdog: { ...DEFAULT_CONFIG.watchdog, enabled: false },
		hands: {
			...DEFAULT_CONFIG.hands,
			port: 0,
			enabled: true,
			socketPath: `${dir}/hands.sock`,
			localPolicy: { ...DEFAULT_CONFIG.hands.localPolicy, roots: [dir] },
		},
		...options.config,
	};
	// Seed before the agent opens the store.
	if (options.seed) {
		const store = MirStore.open(config.stateDir!);
		options.seed(store);
		store.close();
	}
	const agent = new SuperAgent(config, {
		channels: [channel],
		processManager: spawner,
		modelRuntime: { getModel: () => ({}) } as any,
		model: {} as any,
		sessionFactory: factory,
	});
	await agent.init();
	await agent.start();
	return {
		agent,
		channel,
		spawner,
		sessions,
		dir,
		cleanup: async () => {
			await agent.stop();
			rmDir(dir);
		},
	};
}

test("dedupe: re-delivering the same event id processes it once", async () => {
	const h = await makeAgent();
	try {
		const event = makeEvent({ id: "evt-1", text: "do the thing" });
		await h.agent.submitEvent(event);
		await h.agent.submitEvent(event);
		await waitFor(() => h.sessions[0]!.prompts.length >= 1, 2000, "first turn");
		await tick(40);
		assert.equal(h.sessions[0]!.prompts.length, 1, "the duplicate must not produce a second turn");
		assert.equal(h.channel.replies.length, 1);
	} finally {
		await h.cleanup();
	}
});

test("stale subscriptions: an unreachable worker falls back to the Router and is unsubscribed", async () => {
	const h = await makeAgent();
	try {
		// A subscription to a worker that is not connected (e.g. from a prior run).
		h.agent.getThreads().subscribe("worker-ghost", "thread-1");
		await h.agent.submitEvent(makeEvent({ id: "evt-1", threadId: "thread-1", text: "follow-up" }));

		await waitFor(() => h.channel.replies.length === 1, 2000, "router handled it");
		assert.match(h.sessions[0]!.lastPrompt, /follow-up/);
		assert.deepEqual(h.agent.getThreads().getSubscribers("thread-1"), []);
	} finally {
		await h.cleanup();
	}
});

test("admission: a programmatically ignored event never reaches the Router", async () => {
	const h = await makeAgent({
		config: { triggerPolicies: { kindPolicy: { http: "ignore" } } },
	});
	try {
		await h.agent.submitEvent(makeEvent({ id: "evt-ignored" }));
		await tick(40);
		assert.equal(h.sessions[0]!.prompts.length, 0);
		assert.equal(h.agent.getStore().getEvent("evt-ignored")?.status, "ignored");
	} finally {
		await h.cleanup();
	}
});

test("recovery: events left pending by a crash are replayed on boot", async () => {
	const h = await makeAgent({
		seed: (store) => {
			store.insertEvent({
				id: "evt-pending",
				channelId: "http",
				threadId: "thread-1",
				text: "unfinished work from before the restart",
				receivedAt: Date.now() - 1000,
				status: "pending",
				attempts: 0,
			});
		},
	});
	try {
		await waitFor(() => h.sessions[0]!.prompts.length >= 1, 2000, "replayed turn");
		assert.match(h.sessions[0]!.lastPrompt, /unfinished work from before the restart/);
		await waitFor(
			() => h.agent.getStore().getEvent("evt-pending")?.status !== "pending",
			2000,
			"event status updated",
		);
	} finally {
		await h.cleanup();
	}
});

test("durable tasks: a dispatched task is visible in the store immediately", async () => {
	const h = await makeAgent();
	try {
		const taskId = await h.agent.dispatchTask("ship it", "make the change");
		const stored = h.agent.getStore().getTask(taskId);
		assert.equal(stored?.title, "ship it");
		assert.equal(stored?.status, "running");
		assert.equal(h.spawner.spawned.length, 1);
		// Spilled into the recall graph too.
		assert.match(h.agent.getContext().recall(`task:${taskId}`)?.summary ?? "", /ship it/);
	} finally {
		await h.cleanup();
	}
});

test("stop: closes the store and the control socket", async () => {
	const h = await makeAgent();
	await h.agent.stop();
	assert.equal(h.spawner.disconnected, true);
	// A second stop is a no-op rather than a throw.
	await h.agent.stop();
	rmDir(h.dir);
});
