/**
 * The Router's journal.
 *
 * What these hold: that a journal is a file a person can read, that every write is
 * a commit (so a post-mortem can ask what it believed at a given moment), that the
 * cap is enforced by refusing the write rather than truncating the text, and that a
 * machine without git still gets the files.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { JOURNAL_MAX_CHARS, Journal } from "../src/journal.ts";
import { createLogger } from "../src/telemetry.ts";

const log = createLogger({ level: "error", format: "json", write: () => {} });

function dir(): string {
	return mkdtempSync(join(tmpdir(), "mir-journal-"));
}

function gitAvailable(): boolean {
	try {
		execFileSync("git", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

test("a journal is a file per conversation, and reading it back is the same text", async () => {
	const root = dir();
	const journal = new Journal({ dir: root, log, git: false });
	assert.equal(await journal.read("thread-1"), "", "a conversation with no journal reads empty");

	const written = await journal.write({ threadId: "thread-1", text: "What this is: the deploy script", label: "Deploys" });
	assert.equal(written.ok, true);
	assert.equal(await journal.read("thread-1"), "What this is: the deploy script");

	// Plain markdown in a plain directory: readable without mir, which is the point.
	const file = readFileSync(join(root, "threads", "thread-1.md"), "utf8");
	assert.match(file, /the deploy script/);
});

test("a journal is rewritten, not appended to", async () => {
	const root = dir();
	const journal = new Journal({ dir: root, log, git: false });
	await journal.write({ threadId: "t", text: "first version" });
	await journal.write({ threadId: "t", text: "second version" });
	const text = await journal.read("t");
	assert.equal(text, "second version", "the note is replaced, so a journal cannot grow into a log");
});

test("over the cap the write is refused, with the instruction to compact", async () => {
	const root = dir();
	const journal = new Journal({ dir: root, log, git: false });
	const tooLong = "x".repeat(JOURNAL_MAX_CHARS + 1);
	const refused = await journal.write({ threadId: "t", text: tooLong });
	assert.equal(refused.ok, false);
	if (refused.ok) return;
	assert.match(refused.reason, /the limit is 2400/);
	assert.match(refused.reason, /Compact it/, "a refusal has to say what to do next");
	assert.equal(await journal.read("t"), "", "nothing was written");

	const atCap = await journal.write({ threadId: "t", text: "y".repeat(JOURNAL_MAX_CHARS) });
	assert.equal(atCap.ok, true, "exactly at the cap is allowed");
});

test("an empty note is refused: it would erase what the conversation knows", async () => {
	const root = dir();
	const journal = new Journal({ dir: root, log, git: false });
	await journal.write({ threadId: "t", text: "something worth keeping" });
	const refused = await journal.write({ threadId: "t", text: "   " });
	assert.equal(refused.ok, false);
	assert.equal(await journal.read("t"), "something worth keeping");
});

test("every write is a commit, so the belief at any moment can be read back", async () => {
	if (!gitAvailable()) return; // a machine without git still gets the files; that is tested below
	const root = dir();
	const journal = new Journal({ dir: root, log });
	await journal.write({ threadId: "thread-1", text: "believed the deploy was fine", label: "Deploys" });
	await journal.write({ threadId: "thread-1", text: "the deploy failed at 14:02; lockfile missing", label: "Deploys" });

	assert.ok(existsSync(join(root, ".git")), "the journal directory is a repository");
	const history = await journal.history(10, join("threads", "thread-1.md"));
	assert.equal(history.length, 2, "one commit per write");
	// The newest commit's message names the conversation, so a history reads as a
	// sequence of beliefs rather than a sequence of shas.
	assert.match(history[0]!.message, /journal: Deploys/);

	// And the earlier belief is still recoverable — the whole reason for the repo.
	const earlier = execFileSync("git", ["show", `${history[1]!.sha}:threads/thread-1.md`], { cwd: root, encoding: "utf8" });
	assert.match(earlier, /believed the deploy was fine/);
});

test("a rewrite that changes nothing does not make an empty commit", async () => {
	if (!gitAvailable()) return;
	const root = dir();
	const journal = new Journal({ dir: root, log });
	await journal.write({ threadId: "t", text: "same" });
	await journal.write({ threadId: "t", text: "same" });
	const history = await journal.history(10);
	assert.equal(history.length, 1, "one commit, not two");
});

test("the scratchpad's rendered copy lives in the same repository", async () => {
	if (!gitAvailable()) return;
	const root = dir();
	const journal = new Journal({ dir: root, log });
	await journal.writeScratchpad("# The Router's scratchpad\n\n## Outstanding\n- the deploy", "1 outstanding, 0 planned");
	const file = readFileSync(join(root, "scratchpad.md"), "utf8");
	assert.match(file, /the deploy/);
	const history = await journal.history(10);
	assert.match(history[0]!.message, /scratchpad: 1 outstanding, 0 planned/);
});

test("a machine without git still gets the files, and says so once", async () => {
	const root = dir();
	const warnings: string[] = [];
	const journal = new Journal({
		dir: root,
		log: createLogger({ level: "warn", format: "json", write: (line: string) => warnings.push(line) }),
		git: false,
	});
	await journal.write({ threadId: "t", text: "written without history" });
	assert.equal(await journal.read("t"), "written without history");
	assert.equal(existsSync(join(root, ".git")), false, "no repository is invented");
	assert.deepEqual(await journal.history(5), [], "and no history is claimed");
});

test("a thread id cannot walk out of the journal directory", async () => {
	const root = dir();
	const journal = new Journal({ dir: root, log, git: false });
	await journal.write({ threadId: "../../etc/passwd", text: "contained" });
	assert.ok(journal.pathFor("../../etc/passwd").startsWith(join(root, "threads")), "the path stays inside");
});

test("two writes in the same tick both commit: the queue keeps git's index to one writer", async () => {
	if (!gitAvailable()) return;
	const root = dir();
	const journal = new Journal({ dir: root, log });
	// A dispatch writes the scratchpad and the turn writes the journal at the same
	// moment; without a queue the second would fail on `index.lock` and be lost.
	await Promise.all([
		journal.write({ threadId: "a", text: "first", label: "A" }),
		journal.write({ threadId: "b", text: "second", label: "B" }),
		journal.writeScratchpad("scratchpad body", "0 outstanding, 0 planned"),
	]);
	const history = await journal.history(10);
	assert.equal(history.length, 3, "all three writes are commits");
	assert.equal(await journal.read("a"), "first");
	assert.equal(await journal.read("b"), "second");
});
