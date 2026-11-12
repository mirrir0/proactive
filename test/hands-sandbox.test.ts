/**
 * Sandbox integration tests.
 *
 * These run the real Anthropic Sandbox Runtime, so they live in their own file:
 * `srt` holds one session per process, and node's test runner gives each file a
 * process of its own.
 *
 * They are hermetic where it matters — the "outside" path is a temp file the
 * test owns, and the network assertion is about *denial*, which needs no
 * internet.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HandExecutor } from "../src/hands/executor.ts";
import { SecretRegistry } from "../src/security.ts";
import { createLogger } from "../src/telemetry.ts";
import { HandPolicyError, normalizePolicy } from "../src/hands/policy.ts";
import {
	buildSandboxConfig,
	createSrtSandbox,
	sandboxSupported,
	shellQuote,
	type SandboxWrapper,
} from "../src/hands/sandbox.ts";
import type { HandPolicy } from "../src/hands/protocol.ts";
import { rmDir, tmpDir } from "./helpers/fakes.ts";

const log = createLogger({ level: "error", format: "json", write: () => {} });

const root = tmpDir("mir-srt-root-");
const outside = tmpDir("mir-srt-outside-");
const secretsDir = path.join(root, "secrets");
fs.mkdirSync(secretsDir, { recursive: true });
fs.writeFileSync(path.join(secretsDir, "id_rsa"), "-----BEGIN PRIVATE KEY-----\nsecret\n");

function policy(overrides: Partial<HandPolicy> = {}): HandPolicy {
	return normalizePolicy({
		roots: [root],
		allow: ["node", "curl"],
		sandbox: "srt",
		maxOutputBytes: 8192,
		defaultTimeoutMs: 20_000,
		maxTimeoutMs: 30_000,
		denyReadPaths: [secretsDir],
		network: {
			allowedDomains: [],
			deniedDomains: ["example.org"],
			allowLocalBinding: false,
			allowUnixSockets: [],
		},
		...overrides,
	});
}

let sandbox: SandboxWrapper | null = null;
let executor: HandExecutor | null = null;

after(async () => {
	await sandbox?.dispose();
	rmDir(root);
	rmDir(outside);
});

test("sandbox config: policy maps onto the runtime's filesystem and network rules", () => {
	const config = buildSandboxConfig(
		policy({
			roots: ["/srv/work"],
			denyReadPaths: ["/home/u/.ssh"],
			denyWritePaths: ["/srv/work/.env"],
			network: {
				allowedDomains: ["github.com", "*.npmjs.org"],
				deniedDomains: ["evil.example"],
				allowLocalBinding: true,
				allowUnixSockets: ["/tmp/ssh-agent.sock"],
			},
		}),
	);
	assert.ok(config.filesystem.allowWrite?.includes("/srv/work"));
	assert.deepEqual(config.filesystem.denyRead, ["/home/u/.ssh"]);
	assert.deepEqual(config.filesystem.denyWrite, ["/srv/work/.env"]);
	assert.deepEqual(config.network.allowedDomains, ["github.com", "*.npmjs.org"]);
	assert.deepEqual(config.network.deniedDomains, ["evil.example"]);
	assert.equal(config.network.allowLocalBinding, true);
	assert.deepEqual(config.network.allowUnixSockets, ["/tmp/ssh-agent.sock"]);
	// Scratch paths the runtime itself needs stay writable.
	assert.ok((config.filesystem.allowWrite ?? []).length > 1);
});

test("shellQuote: an argument can never become a second command", () => {
	assert.equal(shellQuote(["echo", "hi"]), "'echo' 'hi'");
	assert.equal(shellQuote(["echo", "a; rm -rf /"]), "'echo' 'a; rm -rf /'");
	assert.equal(shellQuote(["echo", "it's"]), "'echo' 'it'\\''s'");
	assert.equal(shellQuote(["echo", "$(id)"]), "'echo' '$(id)'");
});

test("sandbox: a hand that claims to be sandboxed refuses to run without one", async () => {
	const bare = new HandExecutor({
		policy: policy(),
		capabilities: { exec: true, shell: false, fs: "rw", git: true },
		secrets: new SecretRegistry(),
		log,
	});
	const result = await bare.run("exec", { argv: ["node", "-e", "console.log(1)"] });
	assert.equal(result.ok, false);
	assert.match(result.error ?? "", /sandbox-required/);
});

test("sandbox: initializes when the platform supports it", async () => {
	if (!sandboxSupported()) {
		// The contract still holds: asking for a sandbox that cannot exist throws.
		await assert.rejects(() => createSrtSandbox(policy(), log), /does not support/);
		return;
	}
	sandbox = await createSrtSandbox(policy(), log);
	executor = new HandExecutor({
		policy: policy(),
		capabilities: { exec: true, shell: false, fs: "rw", git: true },
		secrets: new SecretRegistry(),
		log,
		sandbox,
	});
	assert.equal(sandbox.kind, "srt");
});

test("sandbox: a write inside the roots succeeds", async () => {
	if (!executor) return;
	const target = path.join(root, "inside.txt");
	const result = await executor.run("exec", {
		argv: ["node", "-e", `require("fs").writeFileSync(${JSON.stringify(target)}, "ok"); console.log("wrote")`],
	});
	assert.equal(result.ok, true, result.error);
	assert.equal(fs.readFileSync(target, "utf8"), "ok");
});

test("sandbox: a write outside the roots is blocked and reported as policy", async () => {
	if (!executor) return;
	const target = path.join(outside, "escape.txt");
	const result = await executor.run("exec", {
		argv: ["node", "-e", `require("fs").writeFileSync(${JSON.stringify(target)}, "nope")`],
	});
	assert.equal(result.ok, false);
	assert.equal(result.blocked, true, "the result must say it was the sandbox, not a bug");
	assert.equal(fs.existsSync(target), false);
	assert.match(result.error ?? "", /blocked by sandbox policy/i);
});

test("sandbox: reading a denied path is blocked", async () => {
	if (!executor) return;
	const result = await executor.run("exec", {
		argv: [
			"node",
			"-e",
			`try { require("fs").readFileSync(${JSON.stringify(path.join(secretsDir, "id_rsa"))}); console.log("read it") } catch (e) { console.log("denied", e.code) }`,
		],
	});
	assert.match(result.stdout ?? "", /denied/);
	assert.ok(!(result.stdout ?? "").includes("PRIVATE KEY"));
});

test("sandbox: network is mediated and denied hosts are refused", async () => {
	if (!executor) return;
	// The proxy is what the child talks to; its presence proves mediation.
	const env = await executor.run("exec", {
		argv: ["node", "-e", "console.log(Boolean(process.env.HTTPS_PROXY || process.env.https_proxy))"],
	});
	assert.equal(env.ok, true, env.error);
	assert.match(env.stdout ?? "", /true/);

	const denied = await executor.run("exec", {
		argv: [
			"node",
			"-e",
			`fetch("https://example.org").then(r => console.log("status", r.status)).catch(e => console.log("denied"))`,
		],
	});
	assert.match(denied.stdout ?? "", /denied/);
});
