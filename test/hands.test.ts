import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { MirStore } from "../src/store.ts";
import { buildConfig } from "../src/daemon.ts";
import { mirPaths } from "../src/paths.ts";
import { SecretRegistry } from "../src/security.ts";
import { createLogger } from "../src/telemetry.ts";
import { HandExecutor } from "../src/hands/executor.ts";
import { HandsHub } from "../src/hands/hub.ts";
import { HandsServer } from "../src/hands/server.ts";
import { HandsClient } from "../src/hands/client.ts";
import { InProcessHand } from "./helpers/in-process-hand.ts";
import { EndpointDaemon, parseEndpointArgs } from "../src/endpoint/main.ts";
import { SuperAgent } from "../src/superagent.ts";
import { createHandTools, formatHandResult } from "../src/hands/tools.ts";
import {
	FrameDecoder,
	HANDS_PROTOCOL_VERSION,
	hashToken,
	type HandPolicy,
} from "../src/hands/protocol.ts";
import {
	HandPolicyError,
	filteredEnv,
	matchName,
	normalizePolicy,
	policySummary,
	resolveInRoots,
	validateExec,
} from "../src/hands/policy.ts";
import { rmDir, tmpDir, waitFor, tick } from "./helpers/fakes.ts";

const silentLog = createLogger({ level: "error", format: "json", write: () => {} });

function policy(overrides: Partial<HandPolicy> = {}): HandPolicy {
	return normalizePolicy({
		roots: [process.cwd()],
		allow: ["echo", "cat", "node", "git", "ls"],
		maxConcurrent: 2,
		defaultTimeoutMs: 5000,
		maxTimeoutMs: 10_000,
		maxOutputBytes: 4096,
		sandbox: "none" as const,
		...overrides,
	});
}

function makeExecutor(overrides: Partial<HandPolicy> = {}, secrets = new SecretRegistry()) {
	return new HandExecutor({
		policy: policy(overrides),
		capabilities: { exec: true, shell: false, fs: "rw", git: true },
		secrets,
		log: silentLog,
	});
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

test("policy: paths resolve inside a root and escape attempts are refused", () => {
	const roots = [path.resolve("/srv/work")];
	assert.equal(resolveInRoots(roots, "src/a.ts"), "/srv/work/src/a.ts");
	assert.equal(resolveInRoots(roots, "./a/../b"), "/srv/work/b");
	assert.throws(() => resolveInRoots(roots, "../etc/passwd"), HandPolicyError);
	assert.throws(() => resolveInRoots(roots, "/etc/passwd"), HandPolicyError);
	assert.throws(() => resolveInRoots([], "a"), HandPolicyError);
});

test("policy: exec is an argv allowlist, deny wins", () => {
	const caps = { exec: true, shell: false, fs: "rw" as const, git: true };
	const pol = policy({ allow: ["git", "echo"], deny: ["git"] });
	assert.throws(() => validateExec({ argv: ["git", "status"] }, pol, caps), /denied/);
	assert.throws(() => validateExec({ argv: ["rm", "-rf", "/"] }, pol, caps), /not in this hand's allowlist/);
	assert.doesNotThrow(() => validateExec({ argv: ["echo", "hi"] }, pol, caps));
	assert.throws(() => validateExec({ argv: [] }, pol, caps), /non-empty argv/);
});

test("policy: shell needs an explicit grant and an explicit `sh` allowlist entry", () => {
	const pol = policy({ allow: ["echo"] });
	assert.throws(
		() => validateExec({ argv: ["echo", "hi"], shell: true }, pol, { exec: true, shell: false, fs: "rw", git: true }),
		/shell execution is not granted/,
	);
	assert.throws(
		() => validateExec({ argv: ["echo", "hi"], shell: true }, pol, { exec: true, shell: true, fs: "rw", git: true }),
		/sh" in the allowlist/,
	);
	const withSh = policy({ allow: ["echo", "sh"] });
	assert.doesNotThrow(() =>
		validateExec({ argv: ["echo", "hi"], shell: true }, withSh, { exec: true, shell: true, fs: "rw", git: true }),
	);
});

test("policy: the child environment never carries secret-shaped vars", () => {
	const env = filteredEnv(policy({ envAllow: ["MY_TOKEN", "NODE_ENV"] }), { ALSO_SECRET: "x", NODE_ENV: "test" }, {
		PATH: "/usr/bin",
		HOME: "/home/u",
		AWS_SECRET_ACCESS_KEY: "secret",
		MY_TOKEN: "tok",
		NODE_ENV: "production",
	});
	assert.equal(env.PATH, "/usr/bin");
	assert.equal(env.HOME, "/home/u");
	assert.equal(env.NODE_ENV, "test");
	assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
	assert.equal(env.MY_TOKEN, undefined);
	assert.equal(env.ALSO_SECRET, undefined);
});

test("policy: glob matching for executable names", () => {
	assert.equal(matchName("git", "git"), true);
	assert.equal(matchName("n*", "node"), true);
	assert.equal(matchName("n*", "npm"), true);
	assert.equal(matchName("git", "node"), false);
});

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

test("executor: runs an argv command and returns its output", async () => {
	const executor = makeExecutor();
	const result = await executor.run("exec", { argv: ["echo", "hello hand"] });
	assert.equal(result.ok, true);
	assert.equal(result.exitCode, 0);
	assert.match(result.stdout ?? "", /hello hand/);
	assert.equal(result.truncated, false);
});

test("executor: refuses an executable outside the allowlist", async () => {
	const executor = makeExecutor();
	const result = await executor.run("exec", { argv: ["rm", "-rf", "/tmp/nope"] });
	assert.equal(result.ok, false);
	assert.match(result.error ?? "", /not in this hand's allowlist/);
});

test("executor: a non-zero exit is a result, not a throw", async () => {
	const executor = makeExecutor({ allow: ["node"] });
	const result = await executor.run("exec", { argv: ["node", "-e", "process.exit(3)"] });
	assert.equal(result.ok, false);
	assert.equal(result.exitCode, 3);
	assert.match(result.error ?? "", /exited with code 3/);
});

test("executor: output is capped and flagged", async () => {
	const executor = makeExecutor({ maxOutputBytes: 1024, allow: ["node"] });
	const result = await executor.run("exec", {
		argv: ["node", "-e", "console.log('x'.repeat(100000))"],
	});
	assert.equal(result.ok, true);
	assert.equal(result.truncated, true);
	assert.ok((result.stdout ?? "").length <= 1024);
});

test("executor: a hung command is killed at its deadline", async () => {
	const executor = makeExecutor({ allow: ["node"], maxTimeoutMs: 1500 });
	const started = Date.now();
	const result = await executor.run("exec", {
		argv: ["node", "-e", "setTimeout(() => {}, 60000)"],
		timeoutMs: 1000,
	});
	const elapsed = Date.now() - started;
	assert.equal(result.ok, false);
	assert.ok(elapsed < 8000, `expected the command to be killed, took ${elapsed}ms`);
});

test("executor: cancellation aborts a running command", async () => {
	const executor = makeExecutor({ allow: ["node"] });
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 100).unref();
	const result = await executor.run(
		"exec",
		{ argv: ["node", "-e", "setTimeout(() => {}, 60000)"], timeoutMs: 10_000 },
		{ signal: controller.signal },
	);
	assert.equal(result.ok, false);
	assert.match(result.error ?? "", /cancelled/);
});

test("executor: file ops stay inside the roots", async () => {
	const dir = tmpDir();
	const executor = makeExecutor({ roots: [dir] });
	try {
		const write = await executor.run("writeFile", { path: "notes/a.txt", content: "hello" });
		assert.equal(write.ok, true);
		const read = await executor.run("readFile", { path: "notes/a.txt" });
		assert.equal(read.ok, true);
		assert.equal((read.data as any).content, "hello");
		const list = await executor.run("listDir", { path: "notes" });
		assert.equal(list.ok, true);
		assert.deepEqual(
			(list.data as any).entries.map((e: any) => e.name),
			["a.txt"],
		);
		const escape = await executor.run("readFile", { path: "../../etc/passwd" });
		assert.equal(escape.ok, false);
		assert.match(escape.error ?? "", /path-outside-roots/);
	} finally {
		rmDir(dir);
	}
});

test("executor: deny lists apply to the hand's own file tools", async () => {
	const dir = tmpDir();
	const denied = path.join(dir, "secrets");
	fs.mkdirSync(denied, { recursive: true });
	fs.writeFileSync(path.join(denied, "id_rsa"), "PRIVATE");
	const executor = makeExecutor({ roots: [dir], denyReadPaths: [denied], denyWritePaths: [path.join(dir, "no-write")] });
	try {
		const read = await executor.run("readFile", { path: "secrets/id_rsa" });
		assert.equal(read.ok, false);
		assert.match(read.error ?? "", /may not read/);

		const list = await executor.run("listDir", { path: "secrets" });
		assert.equal(list.ok, false);

		const write = await executor.run("writeFile", { path: "no-write/x.txt", content: "x" });
		assert.equal(write.ok, false);
		assert.match(write.error ?? "", /may not write/);

		// A sibling path is still fine.
		const ok = await executor.run("writeFile", { path: "fine.txt", content: "x" });
		assert.equal(ok.ok, true, ok.error);
	} finally {
		rmDir(dir);
	}
});

test("executor: read-only filesystem refuses writes", async () => {
	const dir = tmpDir();
	const executor = new HandExecutor({
		policy: policy({ roots: [dir] }),
		capabilities: { exec: true, shell: false, fs: "ro", git: true },
		secrets: new SecretRegistry(),
		log: silentLog,
	});
	try {
		const result = await executor.run("writeFile", { path: "x.txt", content: "nope" });
		assert.equal(result.ok, false);
		assert.match(result.error ?? "", /read-only/);
	} finally {
		rmDir(dir);
	}
});

test("executor: secrets are redacted from output", async () => {
	const secrets = new SecretRegistry();
	secrets.add("TEST_TOKEN", "super-secret-token-value");
	const executor = makeExecutor({ allow: ["node"] }, secrets);
	const result = await executor.run("exec", {
		argv: ["node", "-e", "console.log('super-secret-token-value')"],
	});
	assert.equal(result.ok, true);
	assert.ok(!(result.stdout ?? "").includes("super-secret-token-value"));
	assert.match(result.stdout ?? "", /redacted:TEST_TOKEN/);
});

// ---------------------------------------------------------------------------
// Hub + server + client
// ---------------------------------------------------------------------------

async function makeHub() {
	const dir = tmpDir();
	const store = MirStore.open(dir);
	const hub = new HandsHub({ store, log: silentLog, heartbeatMs: 200, offlineGraceMs: 5000 });
	hub.start();
	const localPolicy = policy({ roots: [dir] });
	const executor = new HandExecutor({
		policy: localPolicy,
		capabilities: { exec: true, shell: false, fs: "rw", git: true },
		secrets: new SecretRegistry(),
		log: silentLog,
	});
	const local = new InProcessHand(executor, (message) => hub.handleEndpointMessage("local", message));
	hub.registerEndpoint(local);

	const server = new HandsServer({
		hub,
		store,
		log: silentLog,
		host: "127.0.0.1",
		port: 0,
		enabled: true,
		socketPath: path.join(dir, "hands.sock"),
	});
	await server.start();

	const client = new HandsClient({ socketPath: path.join(dir, "hands.sock"), agent: "test" });
	await client.connect();

	return {
		dir,
		store,
		hub,
		server,
		client,
		cleanup: async () => {
			client.close();
			await server.stop();
			hub.dispose();
			store.close();
			rmDir(dir);
		},
	};
}

test("hub: a brain reaches the local hand over the client socket", async () => {
	const h = await makeHub();
	try {
		const hands = await h.client.refreshHands();
		assert.deepEqual(
			hands.map((hand) => hand.endpointId),
			["local"],
		);

		const result = await h.client.exec({ argv: ["echo", "from the brain"] });
		assert.equal(result.ok, true);
		assert.equal(result.endpointId, "local");
		assert.match(result.stdout ?? "", /from the brain/);

		const write = await h.client.writeFile("out.txt", "written by the hand");
		assert.equal(write.ok, true);
		const read = await h.client.readFile("out.txt");
		assert.equal((read.data as any).content, "written by the hand");
	} finally {
		await h.cleanup();
	}
});

test("executor: readFile pages by line, and says what window it gave", async () => {
	const dir = tmpDir();
	fs.writeFileSync(path.join(dir, "lines.txt"), "one\ntwo\nthree\nfour\n");
	const executor = makeExecutor({ roots: [dir] });
	try {
		const all = await executor.run("readFile", { path: "lines.txt" });
		assert.equal((all.data as any).content, "one\ntwo\nthree\nfour\n");
		assert.equal((all.data as any).lines, undefined, "no window asked for, none reported");

		const window = await executor.run("readFile", { path: "lines.txt", offset: 2, limit: 2 });
		assert.equal((window.data as any).content, "two\nthree");
		assert.deepEqual((window.data as any).lines, { start: 2, end: 3, total: 4 });
		assert.equal(window.truncated, true, "a window short of the file is truncated");
	} finally {
		rmDir(dir);
	}
});

test("executor: editFile applies exact-text edits all or nothing", async () => {
	const dir = tmpDir();
	fs.writeFileSync(path.join(dir, "a.txt"), "alpha beta gamma\n");
	const executor = makeExecutor({ roots: [dir] });
	try {
		const ok = await executor.run("editFile", {
			path: "a.txt",
			edits: [{ oldText: "beta", newText: "BETA" }],
		});
		assert.equal(ok.ok, true, ok.error);
		assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "alpha BETA gamma\n");

		// An oldText that is not there writes nothing.
		const missing = await executor.run("editFile", {
			path: "a.txt",
			edits: [{ oldText: "delta", newText: "DELTA" }],
		});
		assert.equal(missing.ok, false);
		assert.match(missing.error ?? "", /does not occur/);
		assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "alpha BETA gamma\n");

		// An ambiguous oldText is refused rather than guessed at.
		fs.writeFileSync(path.join(dir, "b.txt"), "x x\n");
		const ambiguous = await executor.run("editFile", {
			path: "b.txt",
			edits: [{ oldText: "x", newText: "y" }],
		});
		assert.equal(ambiguous.ok, false);
		assert.match(ambiguous.error ?? "", /more than once/);

		// One bad edit in a list means none of them land.
		const partial = await executor.run("editFile", {
			path: "a.txt",
			edits: [
				{ oldText: "alpha", newText: "ALPHA" },
				{ oldText: "nothing here", newText: "x" },
			],
		});
		assert.equal(partial.ok, false);
		assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "alpha BETA gamma\n");
	} finally {
		rmDir(dir);
	}
});

test("executor: editFile respects a read-only hand and its deny list", async () => {
	const dir = tmpDir();
	fs.writeFileSync(path.join(dir, "a.txt"), "x\n");
	const readOnly = new HandExecutor({
		policy: policy({ roots: [dir] }),
		capabilities: { exec: true, shell: false, fs: "ro", git: false },
		secrets: new SecretRegistry(),
		log: silentLog,
	});
	try {
		const refused = await readOnly.run("editFile", { path: "a.txt", edits: [{ oldText: "x", newText: "y" }] });
		assert.equal(refused.ok, false);
		assert.match(refused.error ?? "", /read-only/);

		const denied = makeExecutor({ roots: [dir], denyWritePaths: [path.join(dir, "a.txt")] });
		const result = await denied.run("editFile", { path: "a.txt", edits: [{ oldText: "x", newText: "y" }] });
		assert.equal(result.ok, false);
		assert.match(result.error ?? "", /may not write/);
		assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "x\n");
	} finally {
		rmDir(dir);
	}
});

test("executor: a shell op needs both the shell grant and sh in the allowlist", async () => {
	const dir = tmpDir();
	// The default makeExecutor has shell: false.
	const noGrant = makeExecutor({ roots: [dir], allow: ["sh", "echo"] });
	const refused = await noGrant.run("shell", { command: "echo hi" });
	assert.equal(refused.ok, false);
	assert.match(refused.error ?? "", /shell-denied/);

	const noSh = new HandExecutor({
		policy: policy({ roots: [dir], allow: ["echo"] }),
		capabilities: { exec: true, shell: true, fs: "rw", git: false },
		secrets: new SecretRegistry(),
		log: silentLog,
	});
	const refusedNoSh = await noSh.run("shell", { command: "echo hi" });
	assert.equal(refusedNoSh.ok, false);
	assert.match(refusedNoSh.error ?? "", /"sh" in the allowlist/);

	const granted = new HandExecutor({
		policy: policy({ roots: [dir], allow: ["sh", "echo"] }),
		capabilities: { exec: true, shell: true, fs: "rw", git: false },
		secrets: new SecretRegistry(),
		log: silentLog,
	});
	const ran = await granted.run("shell", { command: "echo from-a-shell-string" });
	assert.equal(ran.ok, true, ran.error);
	assert.match(ran.stdout ?? "", /from-a-shell-string/);
});

test("executor: a call it stopped for time says so, apart from a failed exit", async () => {
	const dir = tmpDir();
	const executor = makeExecutor({ roots: [dir], defaultTimeoutMs: 1000, maxTimeoutMs: 2000 });
	try {
		const result = await executor.run("exec", { argv: ["node", "-e", "setTimeout(() => {}, 60000)"] });
		assert.equal(result.ok, false);
		assert.equal(result.timedOut, true, "cut off, not finished with a failure");
		assert.match(result.error ?? "", /timed out after/);
	} finally {
		rmDir(dir);
	}
});

test("hands: a hand reports what it enforces, for display only", async () => {
	const dir = tmpDir();
	const executor = new HandExecutor({
		policy: policy({
			roots: [dir],
			allow: ["node", "sh"],
			sandbox: "none",
			network: { allowedDomains: ["github.com"], deniedDomains: [], allowLocalBinding: false, allowUnixSockets: [] },
			denyReadPaths: ["/home/u/.ssh"],
		}),
		capabilities: { exec: true, shell: true, fs: "rw", git: true },
		secrets: new SecretRegistry(),
		log: silentLog,
	});
	const summary = policySummary(executor.policy, executor.capabilities);
	assert.equal(summary.sandbox, "none");
	assert.deepEqual(summary.roots, [dir]);
	assert.equal(summary.allowCount, 2, "a count, never the list");
	assert.equal(summary.shell, true);
	assert.equal(summary.fs, "rw");
	assert.deepEqual(summary.allowedDomains, ["github.com"]);
	assert.equal(summary.denyReadCount, 1);
});

test("hub: a call for a missing hand is a tool error, not a hang", async () => {
	const h = await makeHub();
	try {
		const result = await h.client.call({ op: "exec", input: { argv: ["echo", "x"] }, endpointId: "nope" });
		assert.equal(result.ok, false);
		assert.match(result.error ?? "", /unknown hand/);
	} finally {
		await h.cleanup();
	}
});

test("hub: an endpoint disconnect fails every call it owed", async () => {
	const h = await makeHub();
	try {
		const pending = h.client.call(
			{ op: "exec", input: { argv: ["node", "-e", "setTimeout(() => {}, 5000)"] } },
			{ timeoutMs: 8000 },
		);
		await tick(150);
		h.hub.removeEndpoint("local", "test disconnect");
		const result = await pending;
		assert.equal(result.ok, false);
		assert.match(result.error ?? "", /disconnected/);
	} finally {
		await h.cleanup();
	}
});

// ---------------------------------------------------------------------------
// The installable endpoint daemon (remote hand over TCP)
// ---------------------------------------------------------------------------

test("endpoint daemon: registers, executes and reports results", async () => {
	const h = await makeHub();
	const token = "test-token-abcdefghijklmnop";
	h.store.createEndpoint({ id: "remote-box", name: "Remote Box", tokenHash: hashToken(token) });

	const daemon = new EndpointDaemon({
		hub: { host: "127.0.0.1", port: h.server.port, tls: false },
		id: "remote-box",
		token,
		name: "Remote Box",
		policy: policy({ roots: [h.dir], allow: ["echo", "node"] }),
		capabilities: { exec: true, shell: false, fs: "rw", git: false },
		heartbeatMs: 200,
		log: silentLog,
	});
	daemon.start();
	try {
		await waitFor(
			() => h.hub.listHands().some((hand) => hand.endpointId === "remote-box" && hand.connected),
			4000,
			"remote hand registered",
		);

		const result = await h.client.call(
			{ op: "exec", input: { argv: ["echo", "hello from the remote"] }, endpointId: "remote-box" },
		);
		assert.equal(result.ok, true);
		assert.equal(result.endpointId, "remote-box");
		assert.match(result.stdout ?? "", /hello from the remote/);

		// The hand's policy still applies to work that arrives over the network.
		const denied = await h.client.call(
			{ op: "exec", input: { argv: ["cat", "/etc/passwd"] }, endpointId: "remote-box" },
		);
		assert.equal(denied.ok, false);
		assert.match(denied.error ?? "", /allowlist/);

		// Work is audited.
		const work = h.store.listWork(10);
		assert.ok(work.some((item) => item.endpointId === "remote-box" && item.ok));
	} finally {
		await daemon.stop();
		await h.cleanup();
	}
});

test("endpoint daemon: an unregistered or wrongly-tokened hand is rejected", async () => {
	const h = await makeHub();
	h.store.createEndpoint({ id: "known", name: "Known", tokenHash: hashToken("right-token") });

	const daemon = new EndpointDaemon({
		hub: { host: "127.0.0.1", port: h.server.port, tls: false },
		id: "known",
		token: "wrong-token",
		name: "Impostor",
		policy: policy({ roots: [h.dir] }),
		capabilities: { exec: true, shell: false, fs: "rw", git: true },
		heartbeatMs: 200,
		log: silentLog,
	});
	daemon.start();
	try {
		await tick(400);
		assert.equal(
			h.hub.listHands().some((hand) => hand.endpointId === "known"),
			false,
			"a bad token must never register a hand",
		);
	} finally {
		await daemon.stop();
		await h.cleanup();
	}
});

// ---------------------------------------------------------------------------
// Wire format and CLI parsing
// ---------------------------------------------------------------------------

test("framing: NDJSON decodes split frames and rejects oversized ones", () => {
	const frames: unknown[] = [];
	const decoder = new FrameDecoder<unknown>((message) => frames.push(message), 128);
	assert.equal(decoder.push('{"a":1}\n{"b"').ok, true);
	assert.equal(decoder.push(":2}\n").ok, true);
	assert.deepEqual(frames, [{ a: 1 }, { b: 2 }]);

	const big = new FrameDecoder<unknown>(() => {}, 16);
	assert.equal(big.push("x".repeat(64)).ok, false);
});

test("tools: a result renders compactly and marks truncation", () => {
	const text = formatHandResult({
		ok: false,
		endpointId: "mac",
		exitCode: 2,
		stdout: "out",
		stderr: "bad",
		error: "exited with code 2",
		durationMs: 12,
		truncated: true,
	});
	assert.match(text, /error \(hand=mac, 12ms\)/);
	assert.match(text, /exit=2/);
	assert.match(text, /--- stdout ---/);
	assert.match(text, /--- stderr ---/);
	assert.match(text, /output truncated/);
});

test("endpoint CLI: parses flags and env fallbacks", () => {
	const parsed = parseEndpointArgs(
		[
			"--hub",
			"127.0.0.1:4700",
			"--id",
			"laptop",
			"--token",
			"tok",
			"--root",
			"/tmp/work",
			"--allow",
			"git,ls",
			"--fs",
			"ro",
			"--max-concurrent",
			"3",
		],
		{},
	);
	assert.equal(parsed.id, "laptop");
	assert.equal(parsed.hub.port, 4700);
	assert.deepEqual(parsed.policy.roots, ["/tmp/work"]);
	assert.deepEqual(parsed.policy.allow, ["git", "ls"]);
	assert.equal(parsed.capabilities.fs, "ro");
	assert.equal(parsed.policy.maxConcurrent, 3);
	assert.equal(parsed.capabilities.shell, false);

	const fromEnv = parseEndpointArgs([], {
		MIR_HANDS_HUB: "hub.example.com:5000",
		MIR_HANDS_ID: "box",
		MIR_HANDS_TOKEN: "tok2",
		MIR_HANDS_ROOTS: "/a,/b",
		MIR_HANDS_FS: "none",
		MIR_HANDS_TLS: "1",
	});
	assert.equal(fromEnv.hub.host, "hub.example.com");
	assert.equal(fromEnv.hub.port, 5000);
	assert.equal(fromEnv.hub.tls, true);
	assert.deepEqual(fromEnv.policy.roots, ["/a", "/b"]);
	assert.equal(fromEnv.capabilities.fs, "none");
});

test("endpoint CLI: missing required flags fail loudly", () => {
	assert.throws(() => parseEndpointArgs([], {}), /missing --hub/);
	assert.throws(() => parseEndpointArgs(["--hub", "h:1"], {}), /missing --id/);
	assert.throws(() => parseEndpointArgs(["--hub", "h:1", "--id", "x"], {}), /missing --token/);
	// v2 added `shell`, `editFile` and read paging: the ops a machine's own tools need.
	assert.equal(HANDS_PROTOCOL_VERSION, 2);
});

test("the daemon offers no hand of its own", () => {
	// A brain's own directory is not a place anyone asked about. Offering it meant a
	// Worker that named no hand read the brain's journal and task specs and reported
	// them as the space's files — a wrong answer that looked like a right one.
	const config = buildConfig();
	assert.equal("local" in config.hands, false);
});

test("a daemon that starts settles what the last one left running", async () => {
	const dir = await tmpDir("mir-settle-");
	const store = MirStore.open(dir);
	store.upsertTask({
		id: "task-stranded",
		title: "left running by a kill",
		description: "",
		threadId: "thread-stranded",
		channelId: "api",
		status: "running",
		createdAt: Date.now() - 1000,
		updatedAt: Date.now() - 1000,
	} as never);
	store.setThreadStatus("thread-stranded", "running");

	assert.equal(store.settleInterrupted(), 1, "one task was stranded");
	assert.equal(store.getTask("task-stranded")?.status, "failed", "not running, and not done");
	assert.equal(store.getTask("task-stranded")?.error, "the daemon stopped while this ran");
	assert.equal(store.getThreadStatus("thread-stranded"), "idle", "the chat is usable again");
	assert.equal(store.settleInterrupted(), 0, "and settling twice settles nothing");
	store.close();
	await rmDir(dir);
});

test("a symlink out of a root is refused, not followed", async () => {
	const outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mir-outside-"));
	await fs.promises.writeFile(path.join(outside, "secret.txt"), "not yours");
	const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mir-root-"));
	await fs.promises.symlink(outside, path.join(root, "link"));
	// The lexical path is inside the root; the file it names is not.
	assert.throws(() => resolveInRoots([root], "link/secret.txt"), /out of the allowed roots|escapes/);
	// And a plain read still works.
	await fs.promises.writeFile(path.join(root, "ok.txt"), "mine");
	assert.equal(resolveInRoots([root], "ok.txt"), path.join(root, "ok.txt"));
	await fs.promises.rm(outside, { recursive: true, force: true });
	await fs.promises.rm(root, { recursive: true, force: true });
});
test("the default deny list covers keys and the brain's own state", () => {
	const policy = normalizePolicy({ roots: [process.cwd()] });
	const denied = policy.denyReadPaths.join(" ");
	for (const path of [".ssh", ".aws", ".anomalous", ".netrc"]) {
		assert.ok(denied.includes(path), `${path} is denied by default`);
	}
});
