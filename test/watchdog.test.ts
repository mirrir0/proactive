import { test } from "node:test";
import assert from "node:assert/strict";
import { Watchdog, assess, DEFAULT_WATCHDOG_OPTIONS, type WatchdogRouter } from "../src/watchdog.ts";
import { MirStore } from "../src/store.ts";
import { ThreadManager } from "../src/thread.ts";
import { TriggerSystem } from "../src/trigger.ts";
import { DEFAULT_CONFIG, type Task, type WorkerInfo } from "../src/types.ts";
import { rmDir, tmpDir, tick, waitFor } from "./helpers/fakes.ts";
import { scriptedFactory } from "./helpers/scripted-session.ts";

const NOW = 1_000_000;
function routerStatus() {
	return {
		turnCount: 1,
		lastTurnAt: NOW - 1000,
		turnInFlightSince: 0,
		queueDepth: 0,
		draining: false,
		dispatchQueue: 0,
		workers: 0,
		tasks: 0,
	};
}

const options = { ...DEFAULT_WATCHDOG_OPTIONS, stuckMs: 60_000, routerTurnTimeoutMs: 60_000, backlogDepth: 10 };

function healthySnapshot(): {
	now: number;
	workers: WorkerInfo[];
	tasks: Task[];
	router: ReturnType<typeof routerStatus>;
	recentFailures?: Task[];
} {
	return {
		now: NOW,
		workers: [] as WorkerInfo[],
		tasks: [] as Task[],
		router: routerStatus(),
	};
}

test("assess: a healthy system produces no findings", () => {
	assert.deepEqual(assess(healthySnapshot(), options), []);
});

test("assess: a busy worker with a stale heartbeat is stuck", () => {
	const snapshot = healthySnapshot();
	snapshot.workers = [
		{
			id: "worker-1",
			taskId: "task-1",
			status: "busy",
			threadIds: [],
			lastHeartbeat: NOW - 120_000,
			progress: "reading",
		},
	];
	const findings = assess(snapshot, options);
	assert.equal(findings.length, 1);
	assert.equal(findings[0]!.kind, "stuck-worker");
	assert.equal(findings[0]!.taskId, "task-1");
});

test("assess: a fresh heartbeat is not stuck, an idle worker is never stuck", () => {
	const snapshot = healthySnapshot();
	snapshot.workers = [
		{ id: "w1", taskId: "t1", status: "busy", threadIds: [], lastHeartbeat: NOW - 1000 },
		{ id: "w2", taskId: "t2", status: "idle", threadIds: [], lastHeartbeat: NOW - 999_999 },
	];
	assert.deepEqual(assess(snapshot, options), []);
});

test("assess: a Router turn past its budget is hung", () => {
	const snapshot = healthySnapshot();
	snapshot.router.turnInFlightSince = NOW - 120_000;
	const findings = assess(snapshot, options);
	assert.equal(findings.length, 1);
	assert.equal(findings[0]!.kind, "hung-router");
});

test("assess: a deep inbox is a backlog warning", () => {
	const snapshot = healthySnapshot();
	snapshot.router.queueDepth = 11;
	const findings = assess(snapshot, options);
	assert.equal(findings[0]!.kind, "backlog");
	assert.equal(findings[0]!.severity, "warn");
});

test("assess: recently failed tasks are reported", () => {
	const snapshot = healthySnapshot();
	snapshot.recentFailures = [
		{
			id: "task-1",
			title: "x",
			description: "y",
			status: "failed",
			error: "worker crashed",
			createdAt: 0,
			updatedAt: NOW,
		},
	];
	const findings = assess(snapshot, options);
	assert.equal(findings[0]!.kind, "failed-tasks");
	assert.match(findings[0]!.message, /worker crashed/);
});

/** Minimal WatchdogRouter double. */
function fakeRouter(overrides: Partial<WatchdogRouter> = {}) {
	const calls = { stopped: [] as string[], aborted: [] as string[], retried: [] as string[], signals: [] as string[] };
	const router: WatchdogRouter = {
		listWorkers: () => [],
		listTasks: () => [],
		status: () => healthySnapshot().router,
		stopTask: async (taskId: string) => {
			calls.stopped.push(taskId);
			return { id: taskId, title: "", description: "", status: "cancelled", createdAt: 0, updatedAt: 0 };
		},
		retryTask: async (taskId: string) => {
			calls.retried.push(taskId);
			return { id: taskId, title: "", description: "", status: "running", createdAt: 0, updatedAt: 0 };
		},
		abortTurn: async (reason: string) => {
			calls.aborted.push(reason);
		},
		submitSignal: (text: string) => {
			calls.signals.push(text);
		},
		...overrides,
	};
	return { router, calls };
}

async function makeWatchdog(router: WatchdogRouter, script: Parameters<typeof scriptedFactory>[0]["script"]) {
	const dir = tmpDir();
	const store = MirStore.open(dir);
	const threads = new ThreadManager(store);
	const triggerSystem = new TriggerSystem(threads);
	const { factory, sessions } = scriptedFactory({ script });
	const watchdog = await Watchdog.create({
		modelRuntime: { getModel: () => ({}) } as any,
		model: {} as any,
		config: {
			...DEFAULT_CONFIG,
			stateDir: dir,
			sessionDir: "",
			watchdog: {
				...DEFAULT_CONFIG.watchdog,
				stuckMs: 60_000,
				routerTurnTimeoutMs: 60_000,
				checkIntervalMs: 10,
			},
		},
		router,
		store,
		triggerSystem,
		sessionFactory: factory,
		options: { checkIntervalMs: 10 },
	});
	return {
		watchdog,
		sessions,
		dir,
		cleanup: async () => {
			await watchdog.dispose();
			store.close();
			rmDir(dir);
		},
	};
}

test("watchdog: a stuck worker is stopped deterministically, without a model call", async () => {
	const { router, calls } = fakeRouter({
		listWorkers: () => [
			{
				id: "worker-1",
				taskId: "task-1",
				status: "busy",
				threadIds: [],
				lastHeartbeat: Date.now() - 120_000,
			},
		],
	});
	const h = await makeWatchdog(router, () => [{ type: "text", text: "should not run" }]);
	try {
		const findings = await h.watchdog.tick();
		assert.equal(findings[0]!.kind, "stuck-worker");
		assert.deepEqual(calls.stopped, ["task-1"]);
		assert.equal(h.sessions[0]!.prompts.length, 0, "no model call for a mechanical fault");
	} finally {
		await h.cleanup();
	}
});

test("watchdog: a hung Router turn is aborted deterministically", async () => {
	const { router, calls } = fakeRouter({
		status: () => ({ ...healthySnapshot().router, turnInFlightSince: Date.now() - 120_000 }),
	});
	const h = await makeWatchdog(router, () => [{ type: "text", text: "should not run" }]);
	try {
		await h.watchdog.tick();
		assert.equal(calls.aborted.length, 1);
		assert.equal(h.sessions[0]!.prompts.length, 0);
	} finally {
		await h.cleanup();
	}
});

test("watchdog: judgement findings wake its own agent session", async () => {
	const { router, calls } = fakeRouter({
		status: () => ({ ...healthySnapshot().router, queueDepth: 51 }),
	});
	const h = await makeWatchdog(router, () => [
		{ type: "tool", name: "note_incident", args: { summary: "inbox backlog", notify_router: true } },
	]);
	try {
		await h.watchdog.tick();
		await waitFor(() => h.sessions[0]!.prompts.length === 1, 2000, "judgement turn");
		assert.match(h.sessions[0]!.lastPrompt, /backlog/);
		await tick(10);
		assert.deepEqual(calls.signals, ["watchdog: inbox backlog"]);
	} finally {
		await h.cleanup();
	}
});

test("watchdog: a healthy system makes no model calls at all", async () => {
	const { router } = fakeRouter();
	const h = await makeWatchdog(router, () => [{ type: "text", text: "nothing to do" }]);
	try {
		const findings = await h.watchdog.tick();
		assert.deepEqual(findings, []);
		await tick(20);
		assert.equal(h.sessions[0]!.prompts.length, 0);
	} finally {
		await h.cleanup();
	}
});

test("watchdog: the turn budget caps judgement calls", async () => {
	const { router } = fakeRouter({
		status: () => ({ ...healthySnapshot().router, queueDepth: 51 }),
	});
	const h = await makeWatchdog(router, () => [{ type: "text", text: "noted" }]);
	try {
		(h.watchdog as any).options.maxTurnsPerHour = 1;
		await h.watchdog.tick();
		await h.watchdog.tick();
		await tick(20);
		assert.equal(h.sessions[0]!.prompts.length, 1);
	} finally {
		await h.cleanup();
	}
});

test("watchdog: diagnose explains a live worker and a gone one", async () => {
	const { router } = fakeRouter({
		listWorkers: () => [
			{
				id: "worker-1",
				taskId: "task-1",
				status: "busy",
				threadIds: [],
				lastHeartbeat: Date.now() - 5000,
				progress: "reading files",
			},
		],
	});
	const h = await makeWatchdog(router, () => []);
	try {
		assert.match(await h.watchdog.diagnose("worker-1"), /reading files/);
		assert.match(await h.watchdog.diagnose("worker-missing"), /not found/);
	} finally {
		await h.cleanup();
	}
});
