import { test } from "node:test";
import assert from "node:assert/strict";
import {
	LlmSemanticJudge,
	RateLimiter,
	buildJudgePrompt,
	parseVerdict,
} from "../src/policy.ts";
import { makeTrigger } from "./helpers/fakes.ts";

function fakeRuntime(reply: string | (() => string)) {
	return {
		async completeSimple() {
			const text = typeof reply === "function" ? reply() : reply;
			return { content: [{ type: "text", text }] };
		},
	};
}

test("parseVerdict: plain JSON", () => {
	assert.deepEqual(parseVerdict('{"act": false, "reason": "chat"}'), {
		act: false,
		reason: "chat",
	});
});

test("parseVerdict: JSON inside a fenced block", () => {
	assert.deepEqual(parseVerdict('Here you go:\n```json\n{"act": true, "reason": "ask"}\n```\n'), {
		act: true,
		reason: "ask",
	});
});

test("parseVerdict: JSON surrounded by prose", () => {
	assert.equal(parseVerdict('I think {"act": true, "reason": "x"} is right.')?.act, true);
});

test("parseVerdict: non-boolean act is rejected", () => {
	assert.equal(parseVerdict('{"act": "yes"}'), null);
	assert.equal(parseVerdict("no json here"), null);
});

test("buildJudgePrompt: includes the policies and the message text", () => {
	const prompt = buildJudgePrompt(makeTrigger({ text: "please fix the login test" }), [
		{ name: "work", prompt: "admit work requests" },
	]);
	assert.match(prompt, /admit work requests/);
	assert.match(prompt, /please fix the login test/);
	assert.match(prompt, /terminal/);
});

test("judge: no policies configured admits without a model call", async () => {
	let called = 0;
	const judge = new LlmSemanticJudge({
		modelRuntime: {
			async completeSimple() {
				called++;
				return { content: [{ type: "text", text: '{"act":true,"reason":"x"}' }] };
			},
		},
		model: {},
	});
	const verdict = await judge.judge(makeTrigger(), []);
	assert.equal(verdict.act, true);
	assert.equal(called, 0);
});

test("judge: a rejecting verdict is honoured", async () => {
	const judge = new LlmSemanticJudge({
		modelRuntime: fakeRuntime('{"act": false, "reason": "casual chat"}'),
		model: {},
	});
	const verdict = await judge.judge(makeTrigger(), [{ name: "p", prompt: "admit work" }]);
	assert.equal(verdict.act, false);
	assert.equal(verdict.reason, "casual chat");
});

test("judge: unparseable output fails open by default, closed when configured", async () => {
	const policies = [{ name: "p", prompt: "admit work" }];
	const open = new LlmSemanticJudge({ modelRuntime: fakeRuntime("no idea"), model: {} });
	assert.equal((await open.judge(makeTrigger(), policies)).act, true);

	const closed = new LlmSemanticJudge({
		modelRuntime: fakeRuntime("no idea"),
		model: {},
		failClosed: true,
	});
	assert.equal((await closed.judge(makeTrigger(), policies)).act, false);
});

test("judge: a model error fails open by default", async () => {
	const judge = new LlmSemanticJudge({
		modelRuntime: {
			async completeSimple() {
				throw new Error("429 rate limited");
			},
		},
		model: {},
	});
	const verdict = await judge.judge(makeTrigger(), [{ name: "p", prompt: "admit work" }]);
	assert.equal(verdict.act, true);
	assert.match(verdict.reason, /judge error/);
});

test("judge: the per-minute budget admits rather than dropping work", async () => {
	let calls = 0;
	const judge = new LlmSemanticJudge({
		modelRuntime: {
			async completeSimple() {
				calls++;
				return { content: [{ type: "text", text: '{"act":false,"reason":"chat"}' }] };
			},
		},
		model: {},
		maxPerMinute: 1,
	});
	const policies = [{ name: "p", prompt: "admit work" }];
	assert.equal((await judge.judge(makeTrigger(), policies)).act, false);
	const second = await judge.judge(makeTrigger(), policies);
	assert.equal(second.act, true);
	assert.match(second.reason, /rate limit/);
	assert.equal(calls, 1);
});

test("RateLimiter: refills over its window", () => {
	const limiter = new RateLimiter(2, 1000, 0);
	assert.equal(limiter.take(0), true);
	assert.equal(limiter.take(0), true);
	assert.equal(limiter.take(0), false);
	assert.equal(limiter.take(1000), true);
});
