/**
 * The card as an MCP App.
 *
 * What these hold: that the server speaks the part of MCP a view needs
 * (`initialize`, `tools/list`, `tools/call`, `resources/read`), that it refuses
 * everyone without the token, that the resource is the mime type a host requires,
 * and — the two properties that make a card trustworthy — that its state is read
 * live from the brain rather than baked into an entry, and that its view is
 * self-contained HTML a reload can render with no bridge at all.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { AppServer, MCP_PROTOCOL_VERSION } from "../src/mcp-app/server.ts";
import { CARD_MIME, CARD_URI, cardUriFor, renderCard, type CardData } from "../src/mcp-app/card.ts";
import { createLogger } from "../src/telemetry.ts";

const log = createLogger({ level: "error", format: "json", write: () => {} });
const TOKEN = "test-token";

interface Harness {
	server: AppServer;
	port: number;
	tasks: Map<string, CardData>;
	stopped: string[];
	close: () => Promise<void>;
}

async function makeServer(): Promise<Harness> {
	const tasks = new Map<string, CardData>();
	const stopped: string[] = [];
	const server = new AppServer({
		host: "127.0.0.1",
		port: 0,
		token: TOKEN,
		log,
		workStatus: (taskId) => tasks.get(taskId),
		stopWork: async (taskId) => {
			stopped.push(taskId);
			const task = tasks.get(taskId);
			if (task !== undefined) tasks.set(taskId, { ...task, status: "cancelled" });
			return { ok: true };
		},
	});
	await server.start();
	return { server, port: server.port, tasks, stopped, close: () => server.stop() };
}

async function rpc(port: number, body: unknown, token: string | null = TOKEN): Promise<Response> {
	return await fetch(`http://127.0.0.1:${port}/mcp`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(token === null ? {} : { authorization: `Bearer ${token}` }),
		},
		body: JSON.stringify(body),
	});
}

async function call(port: number, method: string, params?: Record<string, unknown>) {
	const res = await rpc(port, { jsonrpc: "2.0", id: 1, method, params });
	return (await res.json()) as { result?: any; error?: { code: number; message: string } };
}

test("a server with no token refuses to start", async () => {
	const server = new AppServer({
		host: "127.0.0.1",
		port: 0,
		token: "",
		log,
		workStatus: () => undefined,
		stopWork: async () => ({ ok: true }),
	});
	await assert.rejects(() => server.start(), /needs a token/);
});

test("every request needs the bearer token", async () => {
	const h = await makeServer();
	try {
		assert.equal((await rpc(h.port, { jsonrpc: "2.0", id: 1, method: "initialize" }, null)).status, 401);
		assert.equal((await rpc(h.port, { jsonrpc: "2.0", id: 1, method: "initialize" }, "wrong")).status, 401);
		assert.equal((await rpc(h.port, { jsonrpc: "2.0", id: 1, method: "initialize" })).status, 200);
	} finally {
		await h.close();
	}
});

test("initialize says what it speaks, and the tools and the resource are there", async () => {
	const h = await makeServer();
	try {
		const init = await call(h.port, "initialize");
		assert.equal(init.result.protocolVersion, MCP_PROTOCOL_VERSION);
		assert.ok(init.result.capabilities.tools);
		assert.ok(init.result.capabilities.resources);
		assert.equal(init.result.serverInfo.name, "mir");

		const tools = await call(h.port, "tools/list");
		const names = tools.result.tools.map((tool: { name: string }) => tool.name).sort();
		assert.deepEqual(names, ["open_work", "stop_work", "work_status"]);
		// Every tool names the card, so a host that renders on a tool call shows it.
		for (const tool of tools.result.tools) {
			assert.equal(tool._meta.ui.resourceUri, CARD_URI, `${tool.name} does not name the card`);
		}

		const resources = await call(h.port, "resources/list");
		const card = resources.result.resources[0];
		assert.equal(card.uri, CARD_URI);
		assert.equal(card.mimeType, CARD_MIME, "the host requires the mcp-app profile");
		assert.equal(card._meta.ui.prefersBorder, false, "the card is fill and space, not a box");
		assert.deepEqual(card._meta.ui.csp.connectDomains, [], "a card reaches nothing but its server");
	} finally {
		await h.close();
	}
});

test("the resource is self-contained HTML that renders without a bridge", async () => {
	const h = await makeServer();
	try {
		h.tasks.set("task-1", { taskId: "task-1", title: "Write the report", status: "running", description: "write it" });
		// The URI the thread entry carries names the task, so this is the read a
		// reload makes.
		const read = await call(h.port, "resources/read", { uri: cardUriFor("task-1") });
		const html = read.result.contents[0].text as string;

		assert.equal(read.result.contents[0].mimeType, CARD_MIME);
		assert.match(html, /<!doctype html>/i);
		// The state is injected, so the card draws before any handshake — which is
		// what makes a reload show the card rather than an empty frame.
		assert.match(html, /Write the report/);
		assert.match(html, /"taskId":"task-1"/);
		// No bundler, no framework, no network: one document.
		assert.doesNotMatch(html, /<script src=/);
		assert.doesNotMatch(html, /import\s+.*from/);
	} finally {
		await h.close();
	}
});

test("work_status answers with the state now, which is what a reload asks for", async () => {
	const h = await makeServer();
	try {
		h.tasks.set("task-1", { taskId: "task-1", title: "Write the report", status: "running" });
		const running = await call(h.port, "tools/call", { name: "work_status", arguments: { taskId: "task-1" } });
		assert.equal(running.result.structuredContent.status, "running");

		// The task finishes between the entry being written and the card being
		// rendered: the view asks, and gets the answer.
		h.tasks.set("task-1", { taskId: "task-1", title: "Write the report", status: "done", result: "the report is at /tmp/r.md" });
		const done = await call(h.port, "tools/call", { name: "work_status", arguments: { taskId: "task-1" } });
		assert.equal(done.result.structuredContent.status, "done");
		assert.match(done.result.structuredContent.result, /the report is at/);
	} finally {
		await h.close();
	}
});

test("the card's stop button goes through the same path as any other stop", async () => {
	const h = await makeServer();
	try {
		h.tasks.set("task-1", { taskId: "task-1", title: "Write the report", status: "running" });
		const stopped = await call(h.port, "tools/call", { name: "stop_work", arguments: { taskId: "task-1" } });
		assert.equal(stopped.result.isError, undefined);
		assert.deepEqual(h.stopped, ["task-1"]);
	} finally {
		await h.close();
	}
});

test("an unknown task, tool or resource is refused, not invented", async () => {
	const h = await makeServer();
	try {
		const missing = await call(h.port, "tools/call", { name: "work_status", arguments: { taskId: "nope" } });
		assert.equal(missing.error?.code, -32004);

		const unknownTool = await call(h.port, "tools/call", { name: "do_the_thing", arguments: { taskId: "task-1" } });
		assert.equal(unknownTool.error?.code, -32602);

		const unknownResource = await call(h.port, "resources/read", { uri: "ui://mir/other" });
		assert.equal(unknownResource.error?.code, -32002);

		const unknownMethod = await call(h.port, "prompts/list");
		assert.equal(unknownMethod.error?.code, -32601);
	} finally {
		await h.close();
	}
});

test("a notification is accepted with no body, as the transport expects", async () => {
	const h = await makeServer();
	try {
		const res = await rpc(h.port, { jsonrpc: "2.0", method: "notifications/initialized" });
		assert.equal(res.status, 202);
	} finally {
		await h.close();
	}
});

test("a title cannot become markup", () => {
	const html = renderCard({ taskId: "t", title: '</script><img src=x onerror="alert(1)">', status: "running" });
	assert.doesNotMatch(html, /<img src=x/);
	assert.match(html, /\\u003c\/script>/);
});
