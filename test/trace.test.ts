/**
 * The trace tool, tested on rows rather than on a running brain.
 *
 * A trace is what someone reads to decide how to change the brain, so the thing
 * it must get right is the reading: which words belong to which turn, which task
 * a dispatch line is, and whether a worker's conclusion reached the chat. Those
 * are properties of rows, so they are tested with rows.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { assemble, findingsFor, formatSpan, type AssembleInput } from "../scripts/trace/assemble.ts";
import { brainContext, findState, openState, type EntryRow, type TaskRow, type ThreadRow } from "../scripts/trace/read.ts";
import { renderChatList, renderTrace } from "../scripts/trace/render.ts";

const CHAT = "chat-1";
const THREAD = "thread-chat";
const WORK_THREAD = "thread-work";
const TASK = "task-1";

const thread = (over: Partial<ThreadRow> & { id: string }): ThreadRow => ({
	name: over.id,
	chatId: undefined,
	status: "idle",
	seq: 0,
	lastEventAt: 0,
	...over,
});

const entry = (seq: number, at: number, kind: string, payload: Record<string, unknown>): EntryRow => ({
	threadId: THREAD,
	seq,
	at,
	kind,
	payload,
});

const task = (over: Partial<TaskRow> & { id: string }): TaskRow => ({
	title: "a task",
	description: "do it",
	instructions: undefined,
	threadId: undefined,
	reportThreadId: undefined,
	parentTaskId: undefined,
	depth: 0,
	status: "done",
	result: undefined,
	error: undefined,
	createdAt: 0,
	updatedAt: 0,
	fast: false,
	...over,
});

/** A chat that dispatched once, then answered the person with nothing at all. */
function fixture(): AssembleInput {
	const entries: EntryRow[] = [
		entry(1, 1_000, "text", { role: "user", text: "find the vision doc" }),
		entry(2, 1_500, "status", { status: "running", note: "dispatched: Find the vision document on space:01M3" }),
		entry(3, 1_500, "text", { role: "assistant", text: "On it." }),
		entry(4, 1_500, "tool_call", {
			toolCallId: "call-1",
			toolName: "dispatch_task",
			args: { title: "Find the vision document", description: "search the space" },
		}),
		entry(5, 1_500, "tool_result", {
			toolCallId: "call-1",
			isError: false,
			result: { details: { taskId: TASK } },
		}),
		entry(6, 2_000, "status", { status: "idle", note: "turn finished" }),
		// A turn that says it is doing something and does nothing.
		entry(7, 3_000, "text", { role: "user", text: "is it done yet" }),
		entry(8, 3_100, "text", { role: "assistant", text: "Already searching — I'll report back." }),
		entry(9, 3_200, "status", { status: "idle", note: "turn finished" }),
		// The conclusion, delivered by the brain without a model turn.
		entry(10, 5_000, "text", { role: "assistant", text: "It is at anomalous/blog/visions.md" }),
		entry(11, 5_000, "status", { status: "idle", note: "the worker finished" }),
		// A rename is recorded and is not a line of the conversation.
		entry(12, 5_100, "title", { title: "Vision document" }),
		// A stop is its own entry, and it closes the turn it ended.
		entry(13, 6_000, "text", { role: "user", text: "stop" }),
		entry(14, 6_100, "stop", { note: "the person pressed stop" }),
		// The worker's own thread: a refusal, a repeated call, and a conclusion.
		{
			threadId: WORK_THREAD,
			seq: 1,
			at: 1_400,
			kind: "status",
			payload: { status: "running", note: `task ${TASK}: search the space` },
		},
		{
			threadId: WORK_THREAD,
			seq: 2,
			at: 1_800,
			kind: "tool_call",
			payload: { toolCallId: "w1", toolName: "mcp__linear__get_document", args: { id: "a" } },
		},
		{
			threadId: WORK_THREAD,
			seq: 3,
			at: 1_900,
			kind: "tool_result",
			payload: {
				toolCallId: "w1",
				isError: true,
				result: { content: [{ type: "text", text: "This assistant may not use mcp.call:linear/get_document" }] },
			},
		},
		{
			threadId: WORK_THREAD,
			seq: 4,
			at: 2_100,
			kind: "tool_call",
			payload: { toolCallId: "w2", toolName: "list_dir", args: { path: "." } },
		},
		{
			threadId: WORK_THREAD,
			seq: 5,
			at: 2_200,
			kind: "tool_result",
			payload: { toolCallId: "w2", isError: false, result: { content: [{ type: "text", text: "ok" }] } },
		},
		{
			threadId: WORK_THREAD,
			seq: 6,
			at: 2_300,
			kind: "tool_call",
			payload: { toolCallId: "w3", toolName: "list_dir", args: { path: "." } },
		},
		{
			threadId: WORK_THREAD,
			seq: 7,
			at: 2_400,
			kind: "tool_result",
			payload: { toolCallId: "w3", isError: false, result: { content: [{ type: "text", text: "ok" }] } },
		},
		{
			threadId: WORK_THREAD,
			seq: 8,
			at: 4_900,
			kind: "text",
			payload: { role: "assistant", text: "It is at anomalous/blog/visions.md" },
		},
		{
			threadId: WORK_THREAD,
			seq: 9,
			at: 4_950,
			kind: "status",
			payload: { status: "done", note: "worker worker-1 finished" },
		},
	];
	return {
		statePath: "/tmp/state/mir.sqlite",
		thread: thread({ id: THREAD, name: "Vision document", chatId: CHAT, seq: 14 }),
		entries,
		tasks: [
			task({
				id: TASK,
				title: "Find the vision document",
				threadId: WORK_THREAD,
				reportThreadId: THREAD,
				createdAt: 1_450,
				updatedAt: 4_950,
				result: "It is at anomalous/blog/visions.md",
			}),
		],
		threads: [
			thread({ id: THREAD, name: "Vision document", chatId: CHAT }),
			thread({ id: WORK_THREAD, name: "Find the vision document" }),
		],
		busy: () => ({ entries: 0, threads: [] }),
	};
}

test("a chat's turns are the person's turns, and the work that answered them", () => {
	const trace = assemble(fixture());

	assert.deepEqual(
		trace.turns.map((turn) => turn.kind),
		["user", "user", "work", "user"],
		"three turns of theirs, one opened by a worker's answer",
	);
	assert.equal(trace.turns[0]?.users[0]?.text, "find the vision doc");
	assert.equal(trace.turns[0]?.reply, "On it.", "the last thing said in the turn");
	assert.equal(trace.turns[2]?.reply, "It is at anomalous/blog/visions.md", "the conclusion is the turn's answer");
	assert.equal(trace.turns[2]?.users.length, 0, "a work turn has nobody's words in it");
	assert.deepEqual(trace.turns[1]?.titles, [], "a rename in another turn is not this turn's");
	assert.equal(trace.turns[3]?.stops, 1, "a stop is counted where it happened");
	assert.equal(trace.turns[3]?.closed, true, "a stop closes the turn it ended");
});

test("a dispatch line is the task it started, and the worker under it is that task's thread", () => {
	const trace = assemble(fixture());

	assert.equal(trace.turns[0]?.dispatches.length, 1, "one dispatch, found by the tool call's result");
	const dispatch = trace.turns[0]?.dispatches[0];
	assert.equal(dispatch?.taskId, TASK);
	assert.equal(dispatch?.title, "Find the vision document");
	assert.equal(dispatch?.worker?.threadId, WORK_THREAD);
	assert.equal(dispatch?.worker?.toolCalls, 3);
	assert.equal(dispatch?.worker?.refused, 1, "a refusal is not an error: the worker was not allowed");
	assert.equal(dispatch?.worker?.errors, 1);
	assert.equal(dispatch?.worker?.conclusion, "It is at anomalous/blog/visions.md");
	assert.equal(dispatch?.delivered, true, "the conclusion is in the chat, so it arrived");
	assert.equal(trace.counters.dispatches, 1);
	assert.equal(trace.counters.refusals, 1);
});

test("a turn that did no work is a finding, and a reply that promised work says so", () => {
	const trace = assemble(fixture());
	const talkOnly = trace.findings.filter((finding) => finding.code === "talk-only-turn");

	assert.equal(talkOnly.length, 1, "the second turn dispatched nothing and called nothing");
	assert.equal(talkOnly[0]?.turn, 2);
	assert.equal(talkOnly[0]?.severity, "high");
	assert.match(talkOnly[0]?.text ?? "", /no work/);
	assert.match(talkOnly[0]?.text ?? "", /Already searching/, "the words that promised it are quoted back");
});

test("a refusal and a repeated call are findings about the worker, not about the chat", () => {
	const trace = assemble(fixture());
	const codes = trace.findings.map((finding) => finding.code);

	assert.ok(codes.includes("refused-tool"), "a worker that was refused says which tools");
	assert.ok(codes.includes("repeated-call"), "the same call twice is counted");
	const refused = trace.findings.find((finding) => finding.code === "refused-tool");
	assert.equal(refused?.taskId, TASK);
	assert.match(refused?.text ?? "", /mcp__linear__get_document/);
});

test("a conclusion that never reached the chat is a finding", () => {
	const input = fixture();
	const withoutDelivery: AssembleInput = {
		...input,
		tasks: input.tasks.map((held) => ({ ...held, result: "something the chat never saw" })),
	};
	const trace = assemble(withoutDelivery);

	const undelivered = trace.findings.find((finding) => finding.code === "undelivered-conclusion");
	assert.ok(undelivered !== undefined, "a done task whose words are not in the chat is flagged");
	assert.equal(undelivered?.taskId, TASK);
});

test("a turn that waited is measured, and what the brain was busy with is named", () => {
	const input = fixture();
	const waited: AssembleInput = {
		...input,
		// The person speaks, and nothing happens for nearly twelve minutes.
		entries: input.entries.map((row) =>
			row.threadId === THREAD && row.at > 1_000 ? { ...row, at: row.at + 700_000 } : row,
		),
		busy: (from, to) =>
			to - from > 60_000
				? { entries: 9, threads: [{ id: "thread-other", name: "another chat", entries: 9 }] }
				: { entries: 0, threads: [] },
	};
	const trace = assemble(waited);
	const slow = trace.findings.find((finding) => finding.code === "slow-start");

	assert.ok(slow !== undefined, "twelve minutes before anything happened is a finding");
	assert.equal(slow?.severity, "high");
	assert.match(slow?.text ?? "", /11m 4\ds/);
	assert.match(slow?.text ?? "", /another chat \(9\)/, "the trace says what the brain was doing instead");
	assert.equal(trace.turns[0]?.firstActionMs, 700_500, "the person's wait is a number, on the turn it happened");
});

test("the same work dispatched twice is a finding", () => {
	const input = fixture();
	const second = task({
		id: "task-2",
		title: "Find the vision documents",
		threadId: "thread-work-2",
		reportThreadId: THREAD,
		createdAt: 3_000,
		updatedAt: 3_500,
	});
	const trace = assemble({
		...input,
		entries: [
			...input.entries,
			entry(20, 3_000, "tool_call", { toolCallId: "call-2", toolName: "dispatch_task", args: {} }),
			entry(21, 3_000, "tool_result", { toolCallId: "call-2", isError: false, result: { details: { taskId: "task-2" } } }),
		],
		tasks: [...input.tasks, second],
	});

	const duplicate = trace.findings.find((finding) => finding.code === "duplicate-dispatch");
	assert.ok(duplicate !== undefined, "“vision document” twice is the same work twice");
	assert.match(duplicate?.text ?? "", /repeats/);
});

test("a chat with nothing wrong says nothing", () => {
	// One turn, one dispatch, one call that worked, one conclusion that arrived:
	// the trace must have the discipline to say nothing about it.
	const clean: AssembleInput = {
		statePath: "/tmp/state/mir.sqlite",
		thread: thread({ id: THREAD, name: "Vision document", chatId: CHAT }),
		entries: [
			entry(1, 1_000, "text", { role: "user", text: "find the vision doc" }),
			entry(2, 1_100, "tool_call", { toolCallId: "c1", toolName: "dispatch_task", args: {} }),
			entry(3, 1_100, "tool_result", { toolCallId: "c1", isError: false, result: { details: { taskId: TASK } } }),
			entry(4, 1_200, "text", { role: "assistant", text: "On it." }),
			entry(5, 1_300, "status", { status: "idle", note: "turn finished" }),
			{ threadId: WORK_THREAD, seq: 1, at: 1_150, kind: "status", payload: { status: "running", note: "go" } },
			{ threadId: WORK_THREAD, seq: 2, at: 1_400, kind: "tool_call", payload: { toolCallId: "w1", toolName: "list_dir", args: { path: "." } } },
			{
				threadId: WORK_THREAD,
				seq: 3,
				at: 1_500,
				kind: "tool_result",
				payload: { toolCallId: "w1", isError: false, result: { content: [{ type: "text", text: "ok" }] } },
			},
			{ threadId: WORK_THREAD, seq: 4, at: 1_600, kind: "text", payload: { role: "assistant", text: "It is at visions.md" } },
			{ threadId: WORK_THREAD, seq: 5, at: 1_650, kind: "status", payload: { status: "done", note: "worker worker-1 finished" } },
			entry(6, 1_700, "text", { role: "assistant", text: "It is at visions.md" }),
			entry(7, 1_800, "status", { status: "idle", note: "the worker finished" }),
		],
		tasks: [
			task({
				id: TASK,
				title: "Find the vision document",
				threadId: WORK_THREAD,
				reportThreadId: THREAD,
				createdAt: 1_100,
				updatedAt: 1_650,
				result: "It is at visions.md",
			}),
		],
		threads: [thread({ id: THREAD, chatId: CHAT }), thread({ id: WORK_THREAD })],
		busy: () => ({ entries: 0, threads: [] }),
	};
	const trace = assemble(clean);
	assert.deepEqual(
		findingsFor(trace, clean.busy),
		[],
		"no findings, and no invented ones",
	);
});

test("a duration is written the way a person says it", () => {
	assert.equal(formatSpan(5_136), "5s");
	assert.equal(formatSpan(185_000), "3m 5s");
	assert.equal(formatSpan(5_100_000), "1h 25m");
});

test("the reader opens a brain's state, and finds a chat's thread by its chat", () => {
	const dir = mkdtempSync(join(tmpdir(), "trace-"));
	const path = join(dir, "mir.sqlite");
	const db = new DatabaseSync(path);
	db.exec(`
		CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT NOT NULL, channel_id TEXT NOT NULL DEFAULT '',
			last_event_at REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'idle', seq INTEGER NOT NULL DEFAULT 0, chat_id TEXT);
		CREATE TABLE thread_entries (thread_id TEXT NOT NULL, seq INTEGER NOT NULL, at REAL NOT NULL, kind TEXT NOT NULL,
			payload TEXT NOT NULL, PRIMARY KEY (thread_id, seq));
		CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL, instructions TEXT,
			thread_id TEXT, report_thread_id TEXT, parent_task_id TEXT, depth INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL,
			result TEXT, error TEXT, created_at REAL NOT NULL, updated_at REAL NOT NULL, fast INTEGER NOT NULL DEFAULT 0);
	`);
	db.prepare("INSERT INTO threads (id, name, chat_id, last_event_at, status, seq) VALUES (?, ?, ?, ?, ?, ?)").run(
		THREAD,
		"Vision document",
		CHAT,
		5_000,
		"idle",
		2,
	);
	db.prepare("INSERT INTO thread_entries (thread_id, seq, at, kind, payload) VALUES (?, ?, ?, ?, ?)").run(
		THREAD,
		1,
		1_000,
		"text",
		JSON.stringify({ role: "user", text: "hi" }),
	);
	db.prepare("INSERT INTO thread_entries (thread_id, seq, at, kind, payload) VALUES (?, ?, ?, ?, ?)").run(
		THREAD,
		2,
		2_000,
		"status",
		JSON.stringify({ status: "idle", note: "turn finished" }),
	);
	db.prepare(
		"INSERT INTO tasks (id, title, description, thread_id, report_thread_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
	).run(TASK, "Find the vision document", "search", WORK_THREAD, THREAD, "done", 1_450, 4_950);
	db.close();

	try {
		assert.equal(findState(path), path, "an explicit database is used as it is");
		assert.equal(findState(dir), path, "a directory is searched for one");

		const reader = openState(path);
		try {
			assert.equal(reader.threadOfChat(CHAT)?.id, THREAD);
			assert.deepEqual(
				reader.entries(THREAD).map((row) => row.kind),
				["text", "status"],
				"entries come back in the order they were written",
			);
			assert.equal(reader.entries(THREAD)[0]?.payload.text, "hi", "a payload is parsed, not handed out as text");
			assert.equal(reader.tasks()[0]?.reportThreadId, THREAD);
			assert.equal(reader.busyBetween(0, 3_000, [THREAD]).entries, 0, "this thread is not other work");
			assert.equal(reader.busyBetween(0, 3_000, []).entries, 2, "with nothing excluded, it is");
		} finally {
			reader.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the trace reads as the flow it was, in the order it happened", () => {
	const trace = assemble(fixture());
	const text = renderTrace(trace, { color: false, full: false });

	assert.match(text, /Vision document/, "the chat's name heads it");
	assert.match(text, /chat\s+chat-1/, "and its id, so a reader can find it again");
	assert.match(text, /turn 1 · you/, "a turn of theirs");
	assert.match(text, /turn 3 · work/, "and a turn a worker's answer opened");
	assert.match(text, /you\s+find the vision doc/, "what they said, as they said it");
	assert.match(text, /dispatch Find the vision document/, "the dispatch, by its title");
	assert.match(text, /worker thread-work · 3 call\(s\) · 1 refused/, "the worker under it, with what went wrong");
	assert.match(text, /conclusion It is at anomalous\/blog\/visions\.md/, "and what it concluded");
	assert.match(text, /■ stopped — the person pressed stop/, "a stop is a line of its own");
	assert.match(text, /findings \(/, "the facts are counted at the end");
	assert.match(text, /talk-only-turn|no work/, "including the turn that did nothing");
	// The chat's transcript hides a rename (a name is not something anyone said);
	// the trace draws it, because when the brain named the chat is part of the flow.
	assert.match(text, /· renamed “Vision document”/);
});

test("the list is a way in: one line per chat, with what is wrong with it", () => {
	const text = renderChatList(
		[
			{
				chatId: "chat-1",
				threadId: THREAD,
				name: "Vision document",
				lastEventAt: 5_000,
				turns: 4,
				talkOnlyTurns: 1,
				dispatches: 1,
				findings: 2,
			},
		],
		{ color: false, full: false },
	);

	assert.match(text, /chat-1\s+Vision document/, "the chat and its name");
	assert.match(text, /nowork/, "the column that says a turn did nothing");
	assert.match(text, /trace one: --chat <id>/, "and how to go deeper");
});

test("the brain around the state is named: running, gone, or a copy of a dead one", () => {
	const dir = mkdtempSync(join(tmpdir(), "trace-brain-"));
	const home = join(dir, "5c11813e996f3cdf9b99520cbd3df34e");
	const state = join(home, "state");
	mkdirSync(state, { recursive: true });
	writeFileSync(join(state, "mir.sqlite"), "");

	try {
		const withoutPid = brainContext(join(state, "mir.sqlite"));
		assert.equal(withoutPid.home, home);
		assert.equal(withoutPid.pid, undefined);
		assert.equal(withoutPid.alive, false, "no pid file is not a running brain");

		writeFileSync(join(home, "brain.pid"), String(process.pid));
		writeFileSync(
			join(home, "identity.json"),
			JSON.stringify({ teamId: "dev-team", definitionId: "def-1", sessionId: "ses-1" }),
		);
		const alive = brainContext(join(state, "mir.sqlite"));
		assert.equal(alive.pid, process.pid);
		assert.equal(alive.alive, true, "the trace's own process is alive");
		assert.deepEqual(alive.identity, { teamId: "dev-team", definitionId: "def-1", sessionId: "ses-1" });

		// A pid nobody has: the state is a copy of a brain that is not running.
		writeFileSync(join(home, "brain.pid"), "999999");
		const gone = brainContext(join(state, "mir.sqlite"));
		assert.equal(gone.pid, 999_999);
		assert.equal(gone.alive, false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a task that reported into another conversation is said so, not called a lost answer", () => {
	const input = fixture();
	const elsewhere = assemble({
		...input,
		tasks: input.tasks.map((held) => ({ ...held, reportThreadId: "thread-another-chat" })),
		threads: [...input.threads, thread({ id: "thread-another-chat", name: "another chat", chatId: "chat-2" })],
	});

	const codes = elsewhere.findings.map((finding) => finding.code);
	assert.ok(codes.includes("conclusion-elsewhere"), "its words are somewhere else, which is a fact of its own");
	assert.ok(!codes.includes("undelivered-conclusion"), "and not a lost answer");
	const note = elsewhere.findings.find((finding) => finding.code === "conclusion-elsewhere");
	assert.equal(note?.severity, "note");
	assert.match(note?.text ?? "", /thread-another-chat/);
});
