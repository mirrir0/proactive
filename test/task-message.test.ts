/**
 * What a Worker is told when it starts.
 *
 * The shape, not the prose: the person's line and the Worker's brief are
 * different fields and must not be swapped, the capabilities and the hand are
 * facts the Worker cannot get anywhere else, and the procedure (how to use a
 * hand, when to reach for a service, how to end) is a skill rather than a
 * paragraph repeated in every task.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { taskMessage, type TaskSpec } from "../src/task-message.ts";

const base: TaskSpec = {
	taskId: "task-1",
	title: "Find the visions",
	description: "Find the visions for why the document was rejected.",
	instructions: "Look in ~/notes first, then the report in the repo.",
	capabilities: { net: false, fs: "rw", mcp: false, codemode: false },
	endpointId: "desk-1",
	hasHands: true,
};

test("the brief and the person's line are separate, and both are there", () => {
	const text = taskMessage(base);
	assert.match(text, /^Task: Find the visions/);
	assert.match(text, /What this is for: Find the visions for why the document was rejected\./);
	assert.match(text, /Look in ~\/notes first, then the report in the repo\./);
	// The brief is the Worker's; the description is the person's. Swapping them is
	// the bug this shape exists to prevent.
	const descriptionAt = text.indexOf("What this is for:");
	const briefAt = text.indexOf("Look in ~/notes");
	assert.ok(descriptionAt < briefAt, "the person's line comes before the brief");
});

test("a task with no brief still says what it is for", () => {
	const text = taskMessage({ ...base, instructions: undefined });
	assert.match(text, /Description: Find the visions for why the document was rejected\./);
	assert.doesNotMatch(text, /What this is for:/);
});

test("the Worker is told what it may touch, and which hand", () => {
	const text = taskMessage(base);
	assert.match(text, /Capabilities granted to you: \{"net":false,"fs":"rw","mcp":false,"codemode":false\}\./);
	assert.match(text, /You are on: "desk-1"|You are on: .*desk-1/);
});

test("a Worker with no hand is told so, rather than left to guess", () => {
	const text = taskMessage({ ...base, hasHands: false, endpointId: undefined });
	assert.match(text, /No hand is configured: use your local tools\./);
	assert.doesNotMatch(text, /pinned to/);
});

test("an unpinned Worker is told the hub picks the hand", () => {
	const text = taskMessage({ ...base, endpointId: undefined });
	assert.match(text, /the hub's least-loaded capable hand/);
});

test("the procedure is not in the message: it is a skill", () => {
	// If any of this comes back here, it is a second copy of a skill that will
	// drift — and a task message that grows with every rule we learn.
	const text = taskMessage(base);
	assert.doesNotMatch(text, /exec\(\{ argv \}\)/, "how to use a hand belongs to the `hands` skill");
	assert.doesNotMatch(text, /mcp_query/, "when to reach a service belongs to `connected-services`");
	assert.doesNotMatch(text, /concise conclusion \(what you did/, "how to end belongs to `conclusion`");
	assert.doesNotMatch(text, /You are a Worker/, "the role is the system prompt's, not the task's");
});

test("an event that is not this task's is released, not answered", () => {
	// The one control fact that is not a skill: answering it would put this
	// Worker's words into a conversation it is not part of.
	assert.match(taskMessage(base), /call release_event instead of answering it/);
});
