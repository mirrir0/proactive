/**
 * The dashboard.
 *
 * What these hold: that it is the product's design language rather than a new one
 * (the soft-corner radii, the Between surfaces, the status fills), that it refuses
 * everyone without the token, that a reload asks for the state and gets it, and
 * that a listener is told when the state changes instead of polling.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { DashboardServer, type DashboardState } from "../src/dashboard/server.ts";
import { renderDashboard } from "../src/dashboard/html.ts";
import { createLogger } from "../src/telemetry.ts";

const log = createLogger({ level: "error", format: "json", write: () => {} });
const TOKEN = "dash-token";

function state(overrides: Partial<DashboardState> = {}): DashboardState {
	return {
		agent: "mir",
		identity: "brain",
		startedAt: Date.now() - 60_000,
		threads: [{ id: "t1", name: "Deploys", status: "idle", seq: 4, lastEventAt: Date.now() }],
		tasks: [
			{
				id: "task-1",
				title: "Write the report",
				description: "write it",
				status: "running",
				endpointId: "studio-mac",
				createdAt: Date.now() - 30_000,
				updatedAt: Date.now(),
			},
		],
		scratchpad: [{ id: "pad-1", kind: "outstanding", text: "waiting on the deploy", createdAt: Date.now() }],
		hands: [
			{
				endpointId: "studio-mac",
				name: "Studio",
				connected: true,
				running: 1,
				capabilities: { exec: true, fs: "rw", git: true },
				policy: { maxConcurrent: 4, roots: ["/Users/ana/work"] },
			},
		],
		metrics: { counters: { mir_router_turns_total: 12 }, gauges: { mir_hands_connected: 1 } },
		...overrides,
	};
}

async function makeServer(current: () => DashboardState = () => state()) {
	const stopped: string[] = [];
	const server = new DashboardServer({
		host: "127.0.0.1",
		port: 0,
		token: TOKEN,
		log,
		agent: "mir",
		state: current,
		stopTask: async (taskId) => {
			stopped.push(taskId);
		},
		pushMs: 50,
	});
	await server.start();
	return { server, port: server.port, stopped, close: () => server.stop() };
}

test("the page is the product's design language, not a new one", () => {
	const html = renderDashboard({ agent: "mir" });
	// Soft corners and the surface knobs are the theme's own vocabulary.
	assert.match(html, /data-radius="soft"/);
	assert.match(html, /--box-radius: 7px/);
	assert.match(html, /--radius: 10px/);
	assert.match(html, /--ground: oklch\(0\.972 0\.0015 var\(--surface-hue\)\)/);
	assert.match(html, /--card: oklch\(0\.978/);
	assert.match(html, /--accent: oklch\(0\.66 0\.19 45\)/);
	assert.match(html, /--working-soft/);
	// A filled box, never a border: the language is fill and space.
	assert.doesNotMatch(html, /border:\s*1px solid/);
	// Live by stream, not by polling.
	assert.match(html, /EventSource/);
	assert.match(html, /\/api\/events/);
});

test("the dashboard refuses everyone without the token", async () => {
	const h = await makeServer();
	try {
		assert.equal((await fetch(`http://127.0.0.1:${h.port}/`)).status, 401);
		assert.equal((await fetch(`http://127.0.0.1:${h.port}/api/state`)).status, 401);
		assert.equal((await fetch(`http://127.0.0.1:${h.port}/api/state?token=wrong`)).status, 401);
		// A browser cannot send a header for a navigation, so the page takes the
		// token in the query — and the same rule applies to the API.
		assert.equal((await fetch(`http://127.0.0.1:${h.port}/?token=${TOKEN}`)).status, 200);
	} finally {
		await h.close();
	}
});

test("a reload asks for the state and gets the state now", async () => {
	let current = state();
	const h = await makeServer(() => current);
	try {
		const first = (await (await fetch(`http://127.0.0.1:${h.port}/api/state?token=${TOKEN}`)).json()) as DashboardState;
		assert.equal(first.tasks[0].status, "running");
		assert.equal(first.threads[0].name, "Deploys");

		// The task finishes between two loads: the second load is the truth, because
		// the state is assembled per request rather than cached in the page.
		current = state({
			tasks: [{ ...state().tasks[0]!, status: "done", result: "the report is at /tmp/r.md" }],
		});
		const second = (await (await fetch(`http://127.0.0.1:${h.port}/api/state?token=${TOKEN}`)).json()) as DashboardState;
		assert.equal(second.tasks[0].status, "done");
		assert.match(second.tasks[0].result ?? "", /the report is at/);
	} finally {
		await h.close();
	}
});

test("a listener is pushed the state, and the push carries the whole picture", async () => {
	const h = await makeServer();
	try {
		const controller = new AbortController();
		const res = await fetch(`http://127.0.0.1:${h.port}/api/events?token=${TOKEN}`, { signal: controller.signal });
		assert.equal(res.status, 200);
		assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);

		const reader = res.body!.getReader();
		const decoder = new TextDecoder();
		let text = "";
		const deadline = Date.now() + 3000;
		while (Date.now() < deadline && !text.includes("event: state")) {
			const chunk = await reader.read();
			if (chunk.done) break;
			text += decoder.decode(chunk.value, { stream: true });
		}
		controller.abort();
		assert.match(text, /event: state/, "the stream names its event");
		assert.match(text, /"title":"Write the report"/, "and the first frame is the state");
	} finally {
		await h.close();
	}
});

test("the stop button on the page is the same stop as anywhere else", async () => {
	const h = await makeServer();
	try {
		const res = await fetch(`http://127.0.0.1:${h.port}/api/tasks/task-1/stop?token=${TOKEN}`, { method: "POST" });
		assert.equal(res.status, 200);
		assert.deepEqual(h.stopped, ["task-1"]);
		const missing = await fetch(`http://127.0.0.1:${h.port}/api/tasks/nope/stop?token=${TOKEN}`, { method: "POST" });
		assert.equal(missing.status, 200, "the server's stop decides; a missing task is the stop's error to report");
	} finally {
		await h.close();
	}
});

test("a server with no token refuses to start", async () => {
	const server = new DashboardServer({
		host: "127.0.0.1",
		port: 0,
		token: "",
		log,
		agent: "mir",
		state: () => state(),
		stopTask: async () => {},
	});
	await assert.rejects(() => server.start(), /needs a token/);
});
