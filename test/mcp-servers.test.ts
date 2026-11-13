import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { McpServers } from "../src/mcp-servers.ts";

/** A fetch that answers from a queue, and counts what it was asked. */
function scripted(answers: Array<Record<string, unknown> | Error>): {
	fetch: typeof fetch;
	calls: string[];
} {
	const calls: string[] = [];
	let next = 0;
	const fetchImpl = (async (url: string | URL) => {
		calls.push(String(url));
		const answer = answers[Math.min(next++, answers.length - 1)];
		if (answer instanceof Error) throw answer;
		return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
	}) as unknown as typeof fetch;
	return { fetch: fetchImpl, calls };
}

const oneServer = {
	mcpServers: {
		notes: { transport: "http", url: "http://127.0.0.1:1/agent/brain-plugin/notes", headers: { authorization: "Bearer t" } },
	},
};

test("the stack's answer is the config a Worker is spawned with", async () => {
	const { fetch, calls } = scripted([oneServer]);
	const servers = new McpServers({ stackUrl: "http://127.0.0.1:4200", token: "t", fetch });
	assert.deepEqual(servers.current(), { mcpServers: {} }, "nothing before the first ask");
	assert.deepEqual(await servers.refresh(), oneServer);
	assert.deepEqual(servers.current(), oneServer);
	assert.equal(calls[0], "http://127.0.0.1:4200/agent/brain-mcp");
	servers.stop();
});

test("the first answer is not a change: nothing is running to tell", async () => {
	const { fetch } = scripted([oneServer]);
	const servers = new McpServers({ stackUrl: "http://127.0.0.1:4200", token: "t", fetch });
	const changes: unknown[] = [];
	servers.onChange((diff) => changes.push(diff));
	await servers.refresh();
	assert.deepEqual(changes, []);
	servers.stop();
});

test("the same answer again tells nobody; a new one tells everybody once", async () => {
	const { fetch } = scripted([
		oneServer,
		// The same servers, re-serialised in another order: not a change.
		{ mcpServers: { notes: oneServer.mcpServers["notes"] } },
		{ mcpServers: { ...oneServer.mcpServers, ledger: { transport: "http", url: "http://127.0.0.1:1/agent/brain-plugin/ledger" } } },
	]);
	const servers = new McpServers({ stackUrl: "http://127.0.0.1:4200", token: "t", fetch });
	const changes: Array<{ added: string[]; removed: string[] }> = [];
	servers.onChange((diff) => changes.push({ added: diff.added, removed: diff.removed }));
	await servers.refresh();
	await servers.refresh();
	assert.deepEqual(changes, [], "an unchanged answer is silence");
	await servers.refresh();
	assert.deepEqual(changes, [{ added: ["ledger"], removed: [] }]);
	assert.deepEqual(Object.keys(servers.current().mcpServers).sort(), ["ledger", "notes"]);
	servers.stop();
});

test("a stack that is down keeps the last answer, and says so once", async () => {
	const { fetch } = scripted([oneServer, new Error("ECONNREFUSED"), new Error("ECONNREFUSED")]);
	const warnings: string[] = [];
	const servers = new McpServers({
		stackUrl: "http://127.0.0.1:4200",
		token: "t",
		fetch,
		log: { info: () => {}, warn: (msg) => warnings.push(msg) },
	});
	await servers.refresh();
	assert.equal(await servers.refresh(), null);
	assert.deepEqual(servers.current(), oneServer, "the servers it had are still its own");
	assert.equal(await servers.refresh(), null);
	assert.equal(warnings.length, 1, "one outage is one fact, not one a minute");
	servers.stop();
});

test("a brain with no stack asks nobody", async () => {
	// buildConfig only makes one when MIR_STACK_URL names a stack, which is what
	// keeps a brain run by hand on its own mcp.config.json.
	const { buildConfig } = await import("../src/daemon.ts");
	const without = buildConfig({} as NodeJS.ProcessEnv);
	assert.equal(without.mcpServers, undefined);
	const withStack = buildConfig({ MIR_STACK_URL: "http://127.0.0.1:4200" } as NodeJS.ProcessEnv);
	assert.ok(withStack.mcpServers instanceof McpServers);
	withStack.mcpServers?.stop();
});

test("a server's tool list is remembered, so the next Worker offers it at once", async () => {
	const { McpManager } = await import("../src/mcp.ts");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mir-mcp-cache-"));
	const url = "http://127.0.0.1:9/unreachable";
	const tools = [
		{ name: "search", description: "find things", inputSchema: { type: "object", properties: {} } },
		{ name: "fetch", description: "read one", inputSchema: { type: "object", properties: {} } },
	];
	fs.writeFileSync(path.join(dir, "mcp-tools.json"), JSON.stringify({ [url]: { tools, at: Date.now() } }));

	const mcp = new McpManager({ cacheDir: dir });
	const began = Date.now();
	await mcp.start({ mcpServers: { notes: { url } } });
	const elapsed = Date.now() - began;
	try {
		assert.ok(elapsed < 250, `boot must not wait on the network (took ${String(elapsed)}ms)`);
		assert.deepEqual(
			mcp.getToolDefinitions().map((tool) => tool.name),
			["mcp__notes__search", "mcp__notes__fetch"],
			"the model is offered the remembered tools",
		);
		const report = mcp.getServerReports().find((server) => server.name === "notes");
		assert.equal(report?.ok, true, "a remembered server is not a broken one");
		assert.equal(report?.toolCount, 2);
		// Calling one dials it: unreachable here, and the model reads why.
		const result = await mcp.callMcpTool("mcp__notes__search", {});
		assert.equal(result.isError, true);
		assert.match((result.content[0] as { text: string }).text, /could not be reached/);
	} finally {
		await mcp.stop();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("a tool's parameters are the ones its server declared, optionality and all", async () => {
	// Rebuilding a JSON Schema as TypeBox marked every property required and
	// dropped `enum`/`minLength`. Linear's list_issues declares sixteen optional
	// filters and needs none; a model that read them as required reported the tool
	// as unusable instead of calling it.
	const { McpManager } = await import("../src/mcp.ts");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mir-mcp-schema-"));
	const url = "http://127.0.0.1:9/unreachable";
	const inputSchema = {
		type: "object",
		properties: {
			cursor: { type: "string", description: "pagination cursor" },
			limit: { type: "integer", minimum: 1, maximum: 250 },
			customView: { type: "string", minLength: 1 },
			state: { type: "string", enum: ["open", "closed"] },
		},
		required: [],
		additionalProperties: false,
	};
	fs.writeFileSync(
		path.join(dir, "mcp-tools.json"),
		JSON.stringify({ [url]: { tools: [{ name: "list_issues", description: "list", inputSchema }], at: Date.now() } }),
	);
	const mcp = new McpManager({ cacheDir: dir });
	await mcp.start({ mcpServers: { linear: { url } } });
	try {
		const parameters = mcp.getToolDefinitions()[0]?.parameters as Record<string, any>;
		assert.deepEqual(parameters["required"], [], "nothing is required that the server did not require");
		assert.equal(parameters["properties"]["customView"]["minLength"], 1, "a constraint survives");
		assert.deepEqual(parameters["properties"]["state"]["enum"], ["open", "closed"], "an enum survives");
		assert.equal(parameters["properties"]["limit"]["maximum"], 250);
		assert.equal(parameters["additionalProperties"], false);
	} finally {
		await mcp.stop();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
