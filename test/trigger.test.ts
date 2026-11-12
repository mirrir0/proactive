import { test } from "node:test";
import assert from "node:assert/strict";
import { TriggerSystem, programmaticFilter, resolvePolicies } from "../src/trigger.ts";
import { ThreadManager } from "../src/thread.ts";
import type { SemanticJudge } from "../src/policy.ts";
import { makeTrigger } from "./helpers/fakes.ts";

test("programmatic: a kind set to ignore drops the event", () => {
	const policies = resolvePolicies({ kindPolicy: { http: "ignore" } });
	const result = programmaticFilter(makeTrigger({ kind: "http" }), policies);
	assert.equal(result.pass, false);
	assert.match(result.reason ?? "", /ignore/);
});

test("programmatic: respond_only requires an explicit request", () => {
	const policies = resolvePolicies();
	assert.equal(
		programmaticFilter(makeTrigger({ kind: "terminal", metadata: {} }), policies).pass,
		false,
	);
	assert.equal(
		programmaticFilter(makeTrigger({ kind: "terminal", metadata: { explicit_request: "true" } }), policies).pass,
		true,
	);
});

test("programmatic: allowlist and mention requirements are enforced", () => {
	const policies = resolvePolicies({
		allowedUsers: ["alice"],
		requireMention: ["http"],
	});
	assert.equal(
		programmaticFilter(makeTrigger({ kind: "http", metadata: { user: "bob", mentioned: "true" } }), policies).pass,
		false,
	);
	assert.equal(
		programmaticFilter(makeTrigger({ kind: "http", metadata: { user: "alice" } }), policies).pass,
		false,
	);
	assert.equal(
		programmaticFilter(makeTrigger({ kind: "http", metadata: { user: "alice", mentioned: "true" } }), policies).pass,
		true,
	);
});

test("routing: a subscribed thread fans out to EVERY subscriber", async () => {
	const threads = new ThreadManager();
	threads.subscribe("worker-a", "thread-1");
	threads.subscribe("worker-b", "thread-1");
	const system = new TriggerSystem(threads);

	const route = await system.process(makeTrigger({ threadId: "thread-1" }));

	assert.equal(route.stage, "subscription");
	assert.deepEqual(route.targets.sort(), ["worker:worker-a", "worker:worker-b"]);
});

test("routing: an unsubscribed thread cold-starts at the Router", async () => {
	const threads = new ThreadManager();
	const system = new TriggerSystem(threads);

	const route = await system.process(makeTrigger({ threadId: "thread-new" }));

	assert.equal(route.stage, "cold-start");
	assert.deepEqual(route.targets, ["router"]);
});

test("routing: ignored events produce no targets", async () => {
	const threads = new ThreadManager();
	const system = new TriggerSystem(threads, {
		policies: resolvePolicies({ kindPolicy: { http: "ignore" } }),
	});

	const route = await system.process(makeTrigger({ kind: "http" }));

	assert.equal(route.stage, "programmatic");
	assert.deepEqual(route.targets, []);
});

test("semantic: the slow path is skipped for a subscribed thread", async () => {
	const threads = new ThreadManager();
	threads.subscribe("worker-a", "thread-1");
	let judged = 0;
	const judge: SemanticJudge = {
		async judge() {
			judged++;
			return { act: true, reason: "test" };
		},
	};
	const system = new TriggerSystem(threads, {
		judge,
		semanticEnabled: true,
		semanticPolicies: [{ name: "p", prompt: "admit work requests" }],
	});

	await system.process(makeTrigger({ threadId: "thread-1" }));
	assert.equal(judged, 0, "a follow-up on an owned thread must not pay for a model call");
});

test("semantic: a rejecting judge drops a cold-start event", async () => {
	const threads = new ThreadManager();
	const judge: SemanticJudge = {
		async judge() {
			return { act: false, reason: "casual chat" };
		},
	};
	const system = new TriggerSystem(threads, {
		judge,
		semanticEnabled: true,
		semanticPolicies: [{ name: "p", prompt: "admit work requests" }],
	});

	const route = await system.process(makeTrigger({ threadId: "thread-9" }));

	assert.equal(route.stage, "semantic");
	assert.deepEqual(route.targets, []);
	assert.match(route.reason ?? "", /casual chat/);
});

test("semantic: an admitting judge routes to the Router", async () => {
	const threads = new ThreadManager();
	const judge: SemanticJudge = {
		async judge() {
			return { act: true, reason: "work request" };
		},
	};
	const system = new TriggerSystem(threads, {
		judge,
		semanticEnabled: true,
		semanticPolicies: [{ name: "p", prompt: "admit work requests" }],
	});

	const route = await system.process(makeTrigger({ threadId: "thread-10" }));
	assert.deepEqual(route.targets, ["router"]);
});

test("policies can be adjusted at runtime", async () => {
	const threads = new ThreadManager();
	const system = new TriggerSystem(threads);
	assert.equal(system.getPolicies().kindPolicy.http, "candidate");

	system.updatePolicies({ kindPolicy: { http: "ignore" } });
	assert.equal(system.getPolicies().kindPolicy.http, "ignore");
});
