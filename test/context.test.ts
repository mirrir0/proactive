import { test } from "node:test";
import assert from "node:assert/strict";
import { ContextManager, DEFAULT_INLINE_BUDGET } from "../src/context.ts";
import { MirStore } from "../src/store.ts";
import { rmDir, tmpDir } from "./helpers/fakes.ts";

test("inline: long summaries are truncated with a spill marker", () => {
	const context = new ContextManager();
	const text = context.inline({
		id: "trigger:evt-1",
		type: "trigger",
		summary: "x".repeat(DEFAULT_INLINE_BUDGET.maxInlineChars + 50),
		relatedIds: [],
	});
	assert.match(text, /\[spilled\]/);
});

test("inline: related ids are capped and rendered as next hops", () => {
	const context = new ContextManager();
	const text = context.inline({
		id: "trigger:evt-1",
		type: "trigger",
		summary: "short",
		relatedIds: ["thread:1", "worker:2", "task:3", "task:4", "task:5", "task:6"],
	});
	const hops = text.split("\n").filter((line) => line.includes("→"));
	assert.equal(hops.length, DEFAULT_INLINE_BUDGET.maxInlineIds);
});

test("recall: a spilled object can be read back by id", () => {
	const context = new ContextManager();
	context.spill({
		id: "task:task-1",
		type: "task",
		summary: "fix the flaky test",
		ref: "mir://task/task-1",
		inlineIds: [],
	});
	assert.equal(context.recall("task:task-1")?.summary, "fix the flaky test");
	assert.equal(context.recall("missing"), undefined);
});

test("chain of recall: hops follow inline ids up to maxHops", () => {
	const context = new ContextManager();
	context.spill({
		id: "trigger:e1",
		type: "trigger",
		summary: "the event",
		ref: "mir://event/e1",
		inlineIds: ["thread:t1"],
	});
	context.spill({
		id: "thread:t1",
		type: "thread",
		summary: "the PR thread",
		ref: "mir://thread/t1",
		inlineIds: ["worker:w1"],
	});
	context.spill({
		id: "worker:w1",
		type: "worker",
		summary: "the worker",
		ref: "mir://worker/w1",
		inlineIds: [],
	});

	const chain = context.recallChain("trigger:e1", 3);
	assert.equal(chain.length, 3);
	assert.match(chain[0]!, /trigger:e1/);
	assert.match(chain[2]!, /worker:w1/);

	const shallow = context.recallChain("trigger:e1", 1);
	assert.equal(shallow.length, 1);
});

test("spill: objects are durable through the store", () => {
	const dir = tmpDir();
	const store = MirStore.open(dir);
	const context = new ContextManager({ store });
	context.spill({
		id: "conclusion:task-1:1",
		type: "conclusion",
		summary: "the worker fixed it",
		ref: "mir://task/task-1",
		inlineIds: ["task:task-1"],
	});
	store.close();

	const reopened = MirStore.open(dir);
	const fresh = new ContextManager({ store: reopened });
	assert.equal(fresh.recall("conclusion:task-1:1")?.summary, "the worker fixed it");
	// Search goes through the store, not the in-memory cache.
	assert.equal(fresh.search("fixed it").length, 1);
	reopened.close();
	rmDir(dir);
});

test("spill: in-memory cache is bounded, the store stays authoritative", () => {
	const dir = tmpDir();
	const store = MirStore.open(dir);
	const context = new ContextManager({ store });
	for (let i = 0; i < 2100; i++) {
		context.spill({
			id: `message:${i}`,
			type: "message",
			summary: `note ${i}`,
			ref: `r-${i}`,
			inlineIds: [],
		});
	}
	// The oldest entry has been evicted from the cache but is still recallable.
	assert.equal(context.recall("message:0")?.summary, "note 0");
	store.close();
	rmDir(dir);
});
