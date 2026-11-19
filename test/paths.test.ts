/**
 * Where a mir install keeps its files.
 *
 * These are conventions, so they are testable as values: the XDG variables on
 * Linux, Apple's directories on macOS, `MIR_HOME` over everything, and the
 * per-path variables an existing deployment already sets. The socket limit is
 * the one that bites late — `ENAMETOOLONG` at bind time — so it is checked here
 * rather than discovered in production.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ensurePaths, mirPaths, requiredDirs, socketFits, socketLimit } from "../src/paths.ts";

const home = "/home/ana";

test("macOS keeps data in Application Support, logs in Logs, caches in Caches", () => {
	const paths = mirPaths({ env: {}, platform: "darwin", home: "/Users/ana" });
	assert.equal(paths.home, "/Users/ana/Library/Application Support/mir");
	assert.equal(paths.config, "/Users/ana/Library/Application Support/mir/config");
	assert.equal(paths.data, "/Users/ana/Library/Application Support/mir/data");
	assert.equal(paths.state, "/Users/ana/Library/Application Support/mir/state");
	assert.equal(paths.logs, "/Users/ana/Library/Logs/mir");
	assert.equal(paths.cache, "/Users/ana/Library/Caches/mir");
	// No runtime directory exists on macOS, so sockets live beside the data.
	assert.equal(paths.runtime, "/Users/ana/Library/Application Support/mir/run");
	assert.equal(paths.daemonSocket, "/Users/ana/Library/Application Support/mir/run/daemon.sock");
});

test("Linux follows XDG, including the runtime directory when the session has one", () => {
	const paths = mirPaths({ env: {}, platform: "linux", home });
	assert.equal(paths.config, "/home/ana/.config/mir");
	assert.equal(paths.data, "/home/ana/.local/share/mir");
	assert.equal(paths.state, "/home/ana/.local/state/mir");
	assert.equal(paths.cache, "/home/ana/.cache/mir");
	assert.equal(paths.logs, "/home/ana/.local/state/mir/logs");
	assert.equal(paths.runtime, "/home/ana/.local/state/mir/run");

	const withRuntime = mirPaths({ env: { XDG_RUNTIME_DIR: "/run/user/1000" }, platform: "linux", home });
	assert.equal(withRuntime.runtime, "/run/user/1000/mir");
	assert.equal(withRuntime.daemonSocket, "/run/user/1000/mir/daemon.sock");
});

test("the XDG variables move each directory independently", () => {
	const paths = mirPaths({
		env: { XDG_CONFIG_HOME: "/etc/mir-config", XDG_DATA_HOME: "/srv/mir-data", XDG_CACHE_HOME: "/tmp/mir-cache" },
		platform: "linux",
		home,
	});
	assert.equal(paths.config, "/etc/mir-config/mir");
	assert.equal(paths.data, "/srv/mir-data/mir");
	assert.equal(paths.cache, "/tmp/mir-cache/mir");
	// State was not overridden, so it keeps the specification's default.
	assert.equal(paths.state, "/home/ana/.local/state/mir");
});

test("MIR_HOME puts everything in one directory", () => {
	// What a container and a test want: one mounted volume, no scattered dirs.
	const paths = mirPaths({ env: { MIR_HOME: "/data/mir" }, platform: "darwin", home: "/Users/ana" });
	assert.equal(paths.home, "/data/mir");
	for (const dir of [paths.config, paths.data, paths.state, paths.cache, paths.logs, paths.runtime]) {
		assert.ok(dir.startsWith("/data/mir"), `${dir} escaped MIR_HOME`);
	}
	// Distinct, so `mir init` prints a table a person can read rather than the
	// same directory four times.
	assert.equal(new Set([paths.config, paths.data, paths.state, paths.cache, paths.logs, paths.runtime]).size, 6);
});

test("a per-path variable still wins over the platform default", () => {
	const paths = mirPaths({
		env: { MIR_SOCKET_PATH: "/tmp/short/daemon.sock", MIR_QUEUE_DIR: "/mnt/queue", MIR_STATE_DIR: "/mnt/state" },
		platform: "darwin",
		home: "/Users/ana",
	});
	assert.equal(paths.daemonSocket, "/tmp/short/daemon.sock");
	assert.equal(paths.queueDir, "/mnt/queue");
	assert.equal(paths.state, "/mnt/state");
});

test("an unknown platform falls back to the XDG shape rather than crashing", () => {
	const paths = mirPaths({ env: {}, platform: "freebsd", home });
	assert.equal(paths.data, "/home/ana/.local/share/mir");
});

test("the socket limit is the platform's, and a long path is caught before bind", () => {
	assert.equal(socketLimit("darwin"), 103);
	assert.equal(socketLimit("linux"), 107);
	assert.ok(socketFits("/tmp/daemon.sock", "darwin"));
	const long = `/Users/ana/${"x".repeat(120)}/daemon.sock`;
	assert.equal(socketFits(long, "darwin"), false, "a path over the limit must not be reported as usable");
});

test("the default socket paths fit on both platforms", () => {
	// The layout must not ship a path that cannot bind for a normal home directory.
	for (const platform of ["darwin", "linux"] as const) {
		const paths = mirPaths({ env: {}, platform, home: "/Users/ana" });
		assert.ok(socketFits(paths.daemonSocket, platform), `${platform}: ${paths.daemonSocket}`);
		assert.ok(socketFits(paths.handsSocket, platform), `${platform}: ${paths.handsSocket}`);
	}
});

test("ensurePaths creates the layout, and only reports what was missing", () => {
	const root = mkdtempSync(join(tmpdir(), "mir-paths-"));
	const paths = mirPaths({ env: { MIR_HOME: root }, platform: "linux", home: root });
	const created = ensurePaths(paths);
	assert.equal(created.length, requiredDirs(paths).length, "a fresh home creates every directory");
	for (const dir of requiredDirs(paths)) {
		assert.ok(readdirSync(dir.path), `${dir.name} was not created`);
	}
	assert.deepEqual(ensurePaths(paths), [], "a second init creates nothing");
});

test("the instance record says which mir is running, and a stale one is discarded", async () => {
	// One daemon, not one per client: a stack attaches to the running mir instead of
	// starting a second brain, and a record left by a dead one must not send it to a
	// socket nobody answers.
	const { writeInstance, readInstance, instanceFile, removeInstance } = await import("../src/instance.ts");
	const root = mkdtempSync(join(tmpdir(), "mir-instance-"));
	const paths = mirPaths({ env: { MIR_HOME: root }, platform: "linux", home: root });
	ensurePaths(paths);

	writeInstance(paths, {
		socket: join(paths.runtime, "brain.sock"),
		token: "t-1",
		pid: process.pid,
		startedAt: 1,
		protocol: 1,
		hands: { port: 4700 },
		dashboard: { port: 4788 },
	});
	const found = readInstance(paths);
	assert.equal(found?.token, "t-1");
	assert.equal(found?.hands?.port, 4700, "the hands hub's port travels with the record");
	assert.equal(found?.dashboard?.port, 4788, "and so does the dashboard's");

	// A record whose process is gone is removed, not returned.
	writeInstance(paths, { socket: "/x", token: "t", pid: 999_999, startedAt: 1, protocol: 1 });
	assert.equal(readInstance(paths), undefined);
	assert.equal(existsSync(instanceFile(paths)), false, "the stale record is cleaned up");

	removeInstance(paths);
	assert.equal(readInstance(paths), undefined);
});
