import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
	buildBwrapArgv,
	buildSeatbeltProfile,
	createConfinedSandbox,
} from "../src/hands/sandbox.ts";
import { normalizePolicy } from "../src/hands/policy.ts";
import { DEFAULT_HAND_CAPABILITIES, type HandCapabilities } from "../src/hands/protocol.ts";
import { createLogger } from "../src/telemetry.ts";

const run = promisify(execFile);
const silentLog = createLogger({ level: "error", format: "json", write: () => {} });

function policy(roots: string[]) {
	return normalizePolicy({ roots, sandbox: "confined" });
}

const rw: HandCapabilities = { ...DEFAULT_HAND_CAPABILITIES, exec: true, fs: "rw" };

test("a seatbelt profile denies by default and allows the roots", () => {
	const profile = buildSeatbeltProfile(policy(["/tmp/one", "/tmp/two"]), rw);
	assert.match(profile, /\(deny default\)/);
	assert.match(profile, /\(subpath "\/tmp\/one"\)/);
	assert.match(profile, /\(subpath "\/tmp\/two"\)/);
	// The system toolchain has to be readable or nothing starts at all.
	assert.match(profile, /\(subpath "\/usr\/bin"\)/);
	// No domains allowed and none denied: no network at all.
	assert.match(profile, /\(deny network\*\)/);
});

test("a read-only hand cannot write its root, and denied paths are denied after allowing", () => {
	const ro = buildSeatbeltProfile(policy(["/tmp/ro"]), { ...rw, fs: "ro" });
	const writeSection = ro.slice(ro.indexOf("(allow file-write*"));
	assert.equal(writeSection.includes('/tmp/ro'), false, "a read-only root is not a write root");

	const denied = normalizePolicy({ roots: ["/tmp/x"], sandbox: "confined", denyReadPaths: ["/tmp/x/secret"] });
	const profile = buildSeatbeltProfile(denied, rw);
	const allowIndex = profile.indexOf("(allow file-read*");
	const denyIndex = profile.indexOf("(deny file-read*");
	assert.ok(allowIndex >= 0 && denyIndex > allowIndex, "the deny comes after the allow, so it wins");
	assert.match(profile, /\(subpath "\/tmp\/x\/secret"\)/);
});

test("bwrap binds the roots and unshares the network", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "mir-bwrap-"));
	const rwArgs = buildBwrapArgv(policy([root]), rw, ["/bin/ls"], root);
	assert.deepEqual(rwArgs.slice(-4), ["--chdir", root, "--", "/bin/ls"]);
	assert.ok(rwArgs.includes("--unshare-net"), "no domains allowed means no network");
	assert.ok(rwArgs.join(" ").includes(`--bind ${root} ${root}`), "a read-write hand binds writable");

	const roArgs = buildBwrapArgv(policy([root]), { ...rw, fs: "ro" }, ["/bin/ls"]);
	assert.ok(roArgs.join(" ").includes(`--ro-bind ${root} ${root}`), "a read-only hand binds read-only");
	await fs.rm(root, { recursive: true, force: true });
});

test("a confined hand refuses to exist without the platform primitive", () => {
	assert.throws(
		() => createConfinedSandbox(policy(["/tmp"]), rw, silentLog, { platform: "aix" }),
		/no read-confining sandbox for aix/,
	);
});

test("a confined hand reads its root and nothing else", { skip: process.platform !== "darwin" }, async () => {
	const base = await fs.mkdtemp(path.join(os.tmpdir(), "mir-confined-"));
	const root = path.join(base, "space");
	const outside = path.join(base, "elsewhere");
	await fs.mkdir(root);
	await fs.mkdir(outside);
	await fs.writeFile(path.join(root, "mine.txt"), "mine");
	await fs.writeFile(path.join(outside, "secret.txt"), "not mine");

	const sandbox = createConfinedSandbox(policy([root]), rw, silentLog);
	const inside = await sandbox.wrap(["/bin/cat", path.join(root, "mine.txt")], { commandId: "inside" });
	const insideRun = await run(inside.argv[0]!, inside.argv.slice(1)).then(
		(result) => result.stdout.trim(),
		(err: Error) => `failed: ${err.message}`,
	);
	assert.equal(insideRun, "mine", "the root is readable");

	const out = await sandbox.wrap(["/bin/cat", path.join(outside, "secret.txt")], { commandId: "out" });
	const outRun = await run(out.argv[0]!, out.argv.slice(1)).then(
		(result) => `read: ${result.stdout.trim()}`,
		() => "denied",
	);
	assert.equal(outRun, "denied", "a file outside the root is not readable, even by an allowed binary");

	await fs.rm(base, { recursive: true, force: true });
});

test("a hand can read git's config, but not keys", () => {
	const profile = buildSeatbeltProfile(policy(["/tmp/one"]), rw);
	const home = process.env["HOME"] ?? "";
	// `git status` refuses to start without it, and the failure looks like a broken machine.
	assert.match(profile, new RegExp(`\\(literal "${home}/\\.gitconfig"\\)`));
	assert.match(profile, /\(subpath "\/etc\/gitconfig"\)/);
	// Keys stay denied.
	assert.match(profile, /\(subpath "[^"]*\/\.ssh"\)/);
});
