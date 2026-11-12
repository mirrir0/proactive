import { test } from "node:test";
import assert from "node:assert/strict";
import { Metrics, createLogger } from "../src/telemetry.ts";
import { secrets } from "../src/security.ts";

test("logger: JSON records carry level, msg and fields", () => {
	const lines: string[] = [];
	const log = createLogger({ level: "debug", format: "json", write: (l) => lines.push(l) });
	log.info("hello", { task: "t1" });
	const record = JSON.parse(lines[0]!);
	assert.equal(record.level, "info");
	assert.equal(record.msg, "hello");
	assert.equal(record.task, "t1");
	assert.ok(record.ts);
});

test("logger: level filtering", () => {
	const lines: string[] = [];
	const log = createLogger({ level: "warn", format: "json", write: (l) => lines.push(l) });
	log.debug("nope");
	log.info("nope");
	log.warn("yes");
	assert.equal(lines.length, 1);
	assert.equal(JSON.parse(lines[0]!).level, "warn");
});

test("logger: secrets are redacted from messages and fields", () => {
	secrets.add("TEST_SECRET", "super-secret-value");
	const lines: string[] = [];
	const log = createLogger({ level: "debug", format: "json", write: (l) => lines.push(l) });
	log.error("failed with super-secret-value", { header: "Bearer super-secret-value" });
	const line = lines[0]!;
	assert.ok(!line.includes("super-secret-value"));
	assert.match(line, /redacted:TEST_SECRET/);
});

test("logger: child loggers inherit fields", () => {
	const lines: string[] = [];
	const log = createLogger({ level: "debug", format: "json", write: (l) => lines.push(l) });
	log.child({ task: "t9" }).info("scoped");
	assert.equal(JSON.parse(lines[0]!).task, "t9");
});

test("metrics: counters, gauges and labelled series", () => {
	const m = new Metrics();
	m.counter("requests");
	m.counter("requests");
	m.counter("replies", 1, { channel: "http" });
	m.gauge("queue", 3);

	const snap = m.snapshot();
	assert.equal(snap.counters.requests, 2);
	assert.equal(snap.counters['replies{channel="http"}'], 1);
	assert.equal(snap.gauges.queue, 3);
});

test("metrics: histogram percentiles", () => {
	const m = new Metrics();
	for (const v of [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) m.observe("turn_ms", v);
	const h = m.snapshot().histograms.turn_ms!;
	assert.equal(h.count, 10);
	assert.equal(h.sum, 550);
	assert.equal(h.p50, 50);
	assert.equal(h.p95, 100);
	assert.equal(h.max, 100);
});

test("metrics: Prometheus rendering includes counts and quantiles", () => {
	const m = new Metrics();
	m.counter("mir_turns_total", 4);
	m.observe("mir_turn_ms", 25);
	const text = m.renderPrometheus();
	assert.match(text, /mir_turns_total 4/);
	assert.match(text, /quantile="0.5"/);
	assert.match(text, /_count 1/);
});

