/**
 * Smoke: the brain as a service, and a client driving it over the real socket.
 *
 * This starts a real `mir serve` process (no fake host, no in-process server),
 * connects a real `BrainClient`, and checks the door end to end: the handshake,
 * the thread list, opening a thread, saying into it, and Stop. What it does not
 * check is a model turn — that needs a provider key, and the API's behaviour is
 * what this is for.
 *
 * Run: npm run smoke:brain
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BrainClient } from "../src/api/client.ts";
import { MirStore } from "../src/store.ts";
import { ThreadLog } from "../src/threadlog.ts";
import { createLogger } from "../src/telemetry.ts";

const root = mkdtempSync(path.join(tmpdir(), "mir-brain-smoke-"));
const socketPath = path.join(root, "brain.sock");
const stateDir = path.join(root, "state");
const token = `smoke-${Math.random().toString(36).slice(2)}`;

const silentLog = createLogger({ level: "error", format: "json", write: () => {} });

/** The daemon, with the API on and every channel it would otherwise need turned off. */
const daemon = spawn(process.execPath, ["--import", "tsx", "src/index.ts", "serve"], {
	cwd: path.resolve(import.meta.dirname, ".."),
	env: {
		...process.env,
		MIR_API_SOCKET: socketPath,
		MIR_API_TOKEN: token,
		MIR_STATE_DIR: stateDir,
		MIR_SOCKET_PATH: path.join(root, "daemon.sock"),
		MIR_WORKER_STATE_DIR: path.join(root, "workers"),
		MIR_QUEUE_DIR: path.join(root, "queue"),
		MIR_HANDS_PORT: "0",
		MIR_HTTP_PORT: "0",
		MIR_WATCHDOG: "0",
		// A dummy key: the daemon refuses to boot without one, and this smoke never
		// reaches a model — it exercises the door, not a turn.
		OPENROUTER_API_KEY: "sk-or-v1-smoke-not-a-real-key",
	},
	stdio: ["ignore", "pipe", "pipe"],
});

let daemonOut = "";
daemon.stdout.on("data", (chunk: Buffer) => (daemonOut += chunk.toString("utf8")));
daemon.stderr.on("data", (chunk: Buffer) => (daemonOut += chunk.toString("utf8")));

function fail(why: string): never {
	console.error("SMOKE FAIL:", why);
	if (daemonOut.trim() !== "") console.error(daemonOut.slice(-4000));
	daemon.kill("SIGKILL");
	rmSync(root, { recursive: true, force: true });
	process.exit(1);
}

async function waitForSocket(deadlineMs: number): Promise<void> {
	const { existsSync } = await import("node:fs");
	const started = Date.now();
	while (Date.now() - started < deadlineMs) {
		if (existsSync(socketPath)) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	fail(`the brain did not open ${socketPath} within ${String(deadlineMs)}ms`);
}

try {
	await waitForSocket(60_000);

	const client = new BrainClient({ socketPath, token, agent: "smoke" });
	const ready = await client.connect();
	console.log("ready:", { api: ready.agent, hands: ready.hands.length });

	// Seed a thread the way the daemon's own Router would, then read it back.
	const store = MirStore.open(stateDir);
	const log = new ThreadLog({ store, log: silentLog });
	const threadId = "01J0000000000000000000SMOK";
	log.append(threadId, { kind: "text", role: "user", text: "hello from the smoke test" });
	log.setStatus(threadId, "running", "smoke");
	store.close();

	const threads = await client.listThreads();
	console.log("threads:", threads.map((thread) => `${thread.id} ${thread.status}`));

	const opened = await client.open(threadId);
	console.log("opened:", { seq: opened.seq, status: opened.status, entries: opened.entries.length });
	if (opened.entries.length !== 2) fail(`expected 2 entries, saw ${String(opened.entries.length)}`);

	// A watcher subscribes the same way a chat does, so the subscription path is
	// exercised even though nothing is published: what a reply would carry needs
	// a provider, and this smoke reaches no model.
	const watcher = new BrainClient({ socketPath, token, agent: "smoke-watcher" });
	await watcher.connect();
	const watched = await watcher.open(threadId);
	if (watched.entries.length !== opened.entries.length) {
		fail("a second client opening the same thread saw a different log");
	}

	// A message from a client reaches the Router, which is the whole point of the
	// channel. What the Router *answers* needs a provider key — with none, the
	// turn runs and says nothing — so this asserts the delivery, not the answer:
	// the daemon's own log says a turn started because of this message.
	const before = (daemonOut.match(/router turn start/g) ?? []).length;
	await client.say(threadId, "and a second message");
	const deadline = Date.now() + 25_000;
	while ((daemonOut.match(/router turn start/g) ?? []).length === before && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	if ((daemonOut.match(/router turn start/g) ?? []).length === before) {
		fail("the brain never turned a client's message into a turn");
	}
	console.log("say → a Router turn started");
	await client.stop(threadId);

	const hands = await client.hands();
	console.log("hands:", hands.length);

	watcher.disconnect();
	client.disconnect();

	console.log("SMOKE PASS");
	daemon.kill("SIGTERM");
	await new Promise((resolve) => daemon.once("exit", resolve));
	rmSync(root, { recursive: true, force: true });
} catch (err) {
	fail((err as Error).message);
}
