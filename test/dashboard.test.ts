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
import { renderPage } from "../src/dashboard/html.ts";
import { createLogger } from "../src/telemetry.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MirStore } from "../src/store.ts";
import { ThreadLog } from "../src/threadlog.ts";
import { rmDir } from "./helpers/fakes.ts";

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
				threadId: "t1",
				workerId: "w1",
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
		history: [{ at: Date.now() - 4000, inFlight: 0, threads: 1, turns: 10 }, { at: Date.now(), inFlight: 1, threads: 1, turns: 12 }],
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
		entries: () => [],
		threadStatus: () => "idle",
		pushMs: 50,
	});
	await server.start();
	return { server, port: server.port, stopped, close: () => server.stop() };
}

test("the page is the product's design language, not a new one", () => {
	const html = renderPage({ agent: "mir", view: "work", state: state() });
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
		entries: () => [],
		threadStatus: () => undefined,
	});
	await assert.rejects(() => server.start(), /needs a token/);
});

test("the metrics page draws the six chart forms, server-rendered", () => {
	const html = renderPage({ agent: "mir", view: "metrics", state: state() });
	for (const title of ["Work over time", "Router turns", "What happens most", "By part of the brain", "Shape of the work", "How full"]) {
		assert.match(html, new RegExp(title), `${title} is missing`);
	}
	// SVG on the server, not a chart library on the client.
	assert.match(html, /<svg viewBox="0 0 640 180"/);
	assert.match(html, /<polyline/);
	assert.match(html, /<polygon/);
	assert.match(html, /linearGradient/);
	assert.match(html, /stroke-dasharray="3 6"/, "shadcn's dashed grid");
	assert.match(html, /rx="4"/, "shadcn's bar radius");
	// The palette is shadcn's, in this theme's slots.
	assert.match(html, /--chart-1: oklch\(0\.646 0\.222 41\.116\)/);
});

test("a thread is a real URL, with its entries rendered into it", () => {
	const withThread = state();
	const html = renderPage({
		agent: "mir",
		view: "thread",
		threadId: "t1",
		state: withThread,
		entries: [
			{ seq: 1, at: Date.now(), kind: "text", role: "user", text: "the deploy failed" },
			{ seq: 2, at: Date.now(), kind: "text", role: "assistant", text: "which branch?" },
			{ seq: 3, at: Date.now(), kind: "tool_call", toolName: "dispatch_task" },
		],
	});
	assert.match(html, /Deploys/, "the thread's name is the page's heading");
	assert.match(html, /them<\/span>the deploy failed/);
	assert.match(html, /mir<\/span>which branch\?/);
	// The chat is the conversation: no tool calls in it, and none in the fixture
	// either, because the server filters them out before rendering.
	assert.doesNotMatch(html, /dispatch_task/);
	// The chat is the main area; the workers are on the right.
	assert.match(html, /aria-label="Workers"/, "the workers panel is there");
	assert.match(html, /class="worker"/, "and it lists the thread's workers");
	// A worker is a real URL, so one worker's state can be sent to somebody.
	assert.match(html, /href="\/threads\/t1\?task=/, "a worker is a link with a task");
	// And no client-side router: nothing rewrites history.
	assert.doesNotMatch(html, /pushState|history\.replaceState/);
});

test("a thread's status follows its log: idle when the turn ends, stopped when stopped", async () => {
	// The bug this holds shut: the column a list reads only ever went up, so every
	// thread showed "running" from its first dispatch until something stopped it.
	const dir = mkdtempSync(join(tmpdir(), "mir-threadstatus-"));
	const store = MirStore.open(dir);
	const log = new ThreadLog({ store, log: createLogger({ level: "error", format: "json", write: () => {} }) });
	try {
		const threadId = log.chatThread("chat-1", "Deploys");
		log.setStatus(threadId, "running", "dispatched");
		assert.equal(log.status(threadId), "running");
		log.append(threadId, { kind: "status", status: "idle", note: "turn finished" });
		assert.equal(log.status(threadId), "idle", "an idle entry is an idle thread");
		log.append(threadId, { kind: "stop", note: "the person stopped it" });
		assert.equal(log.status(threadId), "stopped");
	} finally {
		store.close();
		rmDir(dir);
	}
});

test("a chart is never stretched to its container", () => {
	// The bug this holds shut: `preserveAspectRatio="none"` squashed every glyph,
	// circle and bar to whatever width the card had, so the charts read as warped.
	const html = renderPage({ agent: "mir", view: "metrics", state: state() });
	assert.doesNotMatch(html, /preserveAspectRatio/);
	// And the height follows the width, rather than being pinned against it.
	assert.match(html, /\.chart svg \{ width: 100%; height: auto;/);
});

test("a worker is reachable from the chat, and the panel can be closed from the URL", () => {
	const entries = [
		{ seq: 1, at: Date.now(), kind: "app", data: { taskId: "task-9", title: "List files", status: "running" } },
	];
	const open = renderPage({ agent: "mir", view: "thread", threadId: "t1", state: state(), entries, workersOpen: true });
	// The card in the chat is the way in: clicking it opens that worker.
	assert.match(open, /<a class="entry work" data-seq="1" href="\/threads\/t1\?task=task-9&token=/, "the card links to its worker");
	assert.match(open, /aria-label="Hide workers"/, "the panel can be collapsed");
	assert.match(open, /class="frame open"/);

	const closed = renderPage({ agent: "mir", view: "thread", threadId: "t1", state: state(), entries, workersOpen: false });
	assert.match(closed, /class="frame"/, "closed is two columns, not three");
	assert.doesNotMatch(closed, /aria-label="Workers"/);
	assert.match(closed, /← workers \(1\)/, "and the way to reopen it is in the chat's header");
});

test("a worker's activity is the tools it called, the skills it read and the hands it used", () => {
	const entries = [
		{ seq: 1, at: Date.now(), kind: "app", data: { taskId: "task-9", title: "List files" }, workerId: "w1" },
		{ seq: 2, at: Date.now(), kind: "tool_call", toolName: "use_skill", args: { name: "hands" }, workerId: "w1" },
		{ seq: 3, at: Date.now(), kind: "tool_call", toolName: "list_dir", workerId: "w1" },
		{ seq: 4, at: Date.now(), kind: "hand", op: "listDir", endpointId: "studio-mac", ok: true, workerId: "w1" },
		{ seq: 5, at: Date.now(), kind: "tool_call", toolName: "not_this_worker" },
	];
	const html = renderPage({
		agent: "mir",
		view: "thread",
		threadId: "t1",
		state: state(),
		entries,
		selectedTask: "task-1",
	});
	assert.match(html, /read skill “hands”/, "a skill load says which skill");
	assert.match(html, /called list_dir/);
	assert.match(html, /listDir on studio-mac/, "a hand call says where it ran");
	assert.doesNotMatch(html, /called not_this_worker/, "another worker's calls are not this worker's activity");
});

test("a thread says which channel it came from, and what opened it", () => {
	const withChannel = state({
		threads: [{ id: "t1", name: "Deploys", status: "idle", channelId: "http", seq: 4, lastEventAt: Date.now() }],
	});
	const html = renderPage({
		agent: "mir",
		view: "thread",
		threadId: "t1",
		state: withChannel,
		entries: [{ seq: 1, at: Date.now(), kind: "text", role: "user", text: "the deploy failed" }],
	});
	assert.match(html, /class="pill">http</, "the channel is on the thread");
	assert.match(html, /“the deploy failed”/, "and the words that opened it");
});

test("the chat is the conversation with the person, not the worker's log", () => {
	const entries = [
		{ seq: 1, at: Date.now(), kind: "text", role: "user", text: "list two entries" },
		{ seq: 2, at: Date.now(), kind: "app", data: { taskId: "task-9", title: "List two entries", status: "running" } },
		{ seq: 3, at: Date.now(), kind: "tool_call", toolName: "dispatch_task" },
		{ seq: 4, at: Date.now(), kind: "status", note: "dispatched: List two entries" },
		{ seq: 5, at: Date.now(), kind: "text", role: "assistant", text: "the worker's answer", workerId: "w1" },
		{ seq: 6, at: Date.now(), kind: "status", note: "worker w1 finished" },
		{ seq: 7, at: Date.now(), kind: "text", role: "assistant", text: "two entries, and here they are" },
	];
	const html = renderPage({ agent: "mir", view: "thread", threadId: "t1", state: state(), entries });
	// The conversation: the person, the card, the assistant's answer.
	assert.match(html, /them<\/span>list two entries/);
	assert.match(html, /class="entry work"/);
	assert.match(html, /mir<\/span>two entries, and here they are/);
	// Not the worker's: its words, its calls, and the machinery around it.
	assert.doesNotMatch(html, /the worker's answer/);
	assert.doesNotMatch(html, /dispatch_task/);
	assert.doesNotMatch(html, /dispatched: List two entries/);
	assert.doesNotMatch(html, /worker w1 finished/);
});
