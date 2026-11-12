/**
 * Telemetry: structured logs + metrics.
 *
 * Two rules this module exists to enforce:
 *
 *   1. **stdout belongs to the terminal channel.** Every log line goes to
 *      stderr, so `respond_terminal` output is never interleaved with logs.
 *   2. **One record per event, machine-readable.** `MIR_LOG_FORMAT=json` emits
 *      NDJSON with a stable envelope (ts, level, msg, plus fields), so pm2 logs
 *      can be shipped and queried instead of grepped.
 *
 * Metrics are the numbers the architecture paper measures (task completion
 * p50/p95, router turn latency, batch size, decisions per run, cache tokens).
 * They are exposed as Prometheus text on `MIR_METRICS_PORT` when configured.
 */

import http from "node:http";
import { redactSecrets } from "./security.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, unknown>;

export interface Logger {
	debug(msg: string, fields?: LogFields): void;
	info(msg: string, fields?: LogFields): void;
	warn(msg: string, fields?: LogFields): void;
	error(msg: string, fields?: LogFields): void;
	child(fields: LogFields): Logger;
}

export interface LoggerOptions {
	level?: LogLevel;
	/** "json" emits NDJSON; "text" emits `ts level msg k=v`. Default: json when not a TTY. */
	format?: "json" | "text";
	/** Sink for log lines. Default: process.stderr (stdout is the terminal channel). */
	write?: (line: string) => void;
	base?: LogFields;
}

function envLevel(): LogLevel {
	const raw = (process.env.MIR_LOG_LEVEL ?? "").toLowerCase();
	if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") return raw;
	return "info";
}

function envFormat(): "json" | "text" {
	const raw = (process.env.MIR_LOG_FORMAT ?? "").toLowerCase();
	if (raw === "json" || raw === "text") return raw;
	return process.stderr.isTTY ? "text" : "json";
}

class BaseLogger implements Logger {
	constructor(
		private readonly opts: Required<Pick<LoggerOptions, "level" | "format" | "write">> & { base: LogFields },
	) {}

	private emit(level: LogLevel, msg: string, fields?: LogFields): void {
		if (LEVEL_ORDER[level] < LEVEL_ORDER[this.opts.level]) return;
		const merged = { ...this.opts.base, ...(fields ?? {}) };
		const safeMsg = redactSecrets(msg);
		if (this.opts.format === "json") {
			const record: Record<string, unknown> = {
				ts: new Date().toISOString(),
				level,
				msg: safeMsg,
				...redactFields(merged),
			};
			this.opts.write(JSON.stringify(record) + "\n");
			return;
		}
		const extra = Object.entries(merged)
			.map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
			.join(" ");
		this.opts.write(
			`${new Date().toISOString()} ${level.padEnd(5)} ${safeMsg}${extra ? " " + redactSecrets(extra) : ""}\n`,
		);
	}

	debug(msg: string, fields?: LogFields): void {
		this.emit("debug", msg, fields);
	}
	info(msg: string, fields?: LogFields): void {
		this.emit("info", msg, fields);
	}
	warn(msg: string, fields?: LogFields): void {
		this.emit("warn", msg, fields);
	}
	error(msg: string, fields?: LogFields): void {
		this.emit("error", msg, fields);
	}
	child(fields: LogFields): Logger {
		return new BaseLogger({ ...this.opts, base: { ...this.opts.base, ...fields } });
	}
}

function redactFields(fields: LogFields): LogFields {
	const out: LogFields = {};
	for (const [k, v] of Object.entries(fields)) {
		if (typeof v === "string") out[k] = redactSecrets(v);
		else if (v instanceof Error) out[k] = { name: v.name, message: redactSecrets(v.message) };
		else out[k] = v;
	}
	return out;
}

/** Create a logger. Tests pass an explicit sink so output stays in the test. */
export function createLogger(options: LoggerOptions = {}): Logger {
	return new BaseLogger({
		level: options.level ?? envLevel(),
		format: options.format ?? envFormat(),
		write: options.write ?? ((line: string) => process.stderr.write(line)),
		base: options.base ?? {},
	});
}

/** Process-wide logger. */
export const log: Logger = createLogger();

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export type MetricLabels = Record<string, string | number>;
export type MetricKind = "counter" | "gauge" | "histogram";

export interface HistogramSummary {
	count: number;
	sum: number;
	p50: number;
	p95: number;
	max: number;
}

export interface MetricsSnapshot {
	counters: Record<string, number>;
	gauges: Record<string, number>;
	histograms: Record<string, HistogramSummary>;
}

/** Bounded histogram: keeps the last N samples per series (memory-safe). */
const HISTOGRAM_CAPACITY = 512;

function labelKey(name: string, labels?: MetricLabels): string {
	if (!labels) return name;
	const parts = Object.keys(labels)
		.sort()
		.map((k) => `${k}="${String(labels[k]).replace(/"/g, '\\"')}"`);
	return parts.length ? `${name}{${parts.join(",")}}` : name;
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
	return sorted[idx]!;
}

export class Metrics {
	private readonly counters = new Map<string, number>();
	private readonly gauges = new Map<string, number>();
	private readonly histograms = new Map<string, { count: number; sum: number; max: number; values: number[] }>();

	counter(name: string, value = 1, labels?: MetricLabels): void {
		const key = labelKey(name, labels);
		this.counters.set(key, (this.counters.get(key) ?? 0) + value);
	}

	gauge(name: string, value: number, labels?: MetricLabels): void {
		this.gauges.set(labelKey(name, labels), value);
	}

	observe(name: string, value: number, labels?: MetricLabels): void {
		const key = labelKey(name, labels);
		let h = this.histograms.get(key);
		if (!h) {
			h = { count: 0, sum: 0, max: 0, values: [] };
			this.histograms.set(key, h);
		}
		h.count++;
		h.sum += value;
		h.max = Math.max(h.max, value);
		h.values.push(value);
		if (h.values.length > HISTOGRAM_CAPACITY) h.values.shift();
	}

	snapshot(): MetricsSnapshot {
		const histograms: Record<string, HistogramSummary> = {};
		for (const [key, h] of this.histograms) {
			const sorted = [...h.values].sort((a, b) => a - b);
			histograms[key] = {
				count: h.count,
				sum: h.sum,
				p50: percentile(sorted, 50),
				p95: percentile(sorted, 95),
				max: h.max,
			};
		}
		return {
			counters: Object.fromEntries(this.counters),
			gauges: Object.fromEntries(this.gauges),
			histograms,
		};
	}

	/** Prometheus text exposition (histograms render as quantile gauges). */
	renderPrometheus(): string {
		const lines: string[] = [];
		for (const [key, value] of this.counters) lines.push(`${key} ${value}`);
		for (const [key, value] of this.gauges) lines.push(`${key} ${value}`);
		for (const [key, h] of this.histograms) {
			const sorted = [...h.values].sort((a, b) => a - b);
			const base = key.replace("{", "_").replace(/[{}"=,]/g, "_");
			lines.push(`${base}_count ${h.count}`);
			lines.push(`${base}_sum ${h.sum}`);
			lines.push(`${base}{quantile="0.5"} ${percentile(sorted, 50)}`);
			lines.push(`${base}{quantile="0.95"} ${percentile(sorted, 95)}`);
			lines.push(`${base}_max ${h.max}`);
		}
		return lines.join("\n") + "\n";
	}

	reset(): void {
		this.counters.clear();
		this.gauges.clear();
		this.histograms.clear();
	}
}

/** Process-wide metrics registry. */
export const metrics = new Metrics();

export interface MetricsServerHandle {
	close(): Promise<void>;
	readonly port: number;
}

/**
 * Serve `/metrics` (Prometheus text) and `/healthz` (JSON snapshot).
 * Bound to localhost by default — never expose this publicly without auth.
 */
export async function startMetricsServer(
	port: number,
	host: string,
	registry: Metrics = metrics,
): Promise<MetricsServerHandle> {
	const server = http.createServer((req, res) => {
		const url = req.url ?? "/";
		if (url.startsWith("/metrics")) {
			res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
			res.end(registry.renderPrometheus());
			return;
		}
		if (url.startsWith("/healthz")) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true, metrics: registry.snapshot() }));
			return;
		}
		res.writeHead(404, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: "not found" }));
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => resolve());
	});
	const address = server.address();
	const boundPort = typeof address === "object" && address ? address.port : port;
	return {
		port: boundPort,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
			}),
	};
}
