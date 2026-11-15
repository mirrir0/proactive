/**
 * trace/render.ts — a trace, as a person reads it.
 *
 * The order is the order it happened: what the person said, how long nothing
 * happened, what was dispatched, what each worker did, what came back. A worker
 * is drawn under the dispatch that started it, indented, because it is not a
 * parallel story — it is what that line did.
 *
 * Every line carries a time relative to the turn, so a gap is visible as a
 * number rather than inferred from two clock readings.
 */

import { clip, formatSpan, resultText, type DispatchTrace, type Finding, type Trace, type TurnTrace } from "./assemble.ts";

export interface RenderOptions {
	readonly color: boolean;
	/** Show whole arguments and results instead of one line of each. */
	readonly full: boolean;
	/** Only the last N turns of the chat. */
	readonly turns?: number | undefined;
	/** Only this worker's calls, when tracing one subagent. */
	readonly onlyTask?: string | undefined;
}

const CODES = {
	dim: "2",
	bold: "1",
	red: "31",
	yellow: "33",
	green: "32",
	blue: "34",
	magenta: "35",
	cyan: "36",
} as const;

const paint = (text: string, code: keyof typeof CODES, color: boolean): string =>
	color ? `\u001b[${CODES[code]}m${text}\u001b[0m` : text;

export const clock = (at: number): string => {
	const date = new Date(at);
	const pad = (value: number): string => String(value).padStart(2, "0");
	return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

export const day = (at: number): string => {
	const date = new Date(at);
	const pad = (value: number): string => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

/** A worker's own timeline: its calls, refusals, and what it concluded. */
function renderWorker(dispatch: DispatchTrace, options: RenderOptions, indent: string): string[] {
	const worker = dispatch.worker;
	if (worker === undefined) return [`${indent}${paint("(no worker thread recorded)", "dim", options.color)}`];
	const lines: string[] = [];
	const head =
		`${indent}${paint("worker", "magenta", options.color)} ${worker.threadId} · ` +
		`${worker.toolCalls} call(s)` +
		(worker.refused > 0 ? paint(` · ${worker.refused} refused`, "red", options.color) : "") +
		(worker.errors > worker.refused ? ` · ${worker.errors - worker.refused} error(s)` : "");
	lines.push(head);

	const base = worker.startedAt;
	for (const entry of worker.entries) {
		const offset = `+${Math.round((entry.at - base) / 1000)}s`;
		const at = paint(offset.padStart(6), "dim", options.color);
		if (entry.kind === "text") {
			const text = String(entry.payload.text ?? "");
			const role = String(entry.payload.role ?? "");
			lines.push(`${indent}  ${at} ${paint(role === "assistant" ? "says" : role, "cyan", options.color)} ${clip(text, options.full ? 4000 : 200)}`);
			continue;
		}
		if (entry.kind === "tool_call") {
			const args = JSON.stringify(entry.payload.args ?? {});
			lines.push(
				`${indent}  ${at} ${paint(String(entry.payload.toolName ?? "?"), "blue", options.color)} ` +
					paint(clip(args, options.full ? 4000 : 110), "dim", options.color),
			);
			continue;
		}
		if (entry.kind === "tool_result") {
			const failed = entry.payload.isError === true;
			const text = resultText(entry) ?? JSON.stringify(entry.payload.result ?? {});
			lines.push(
				`${indent}  ${at} ${paint(failed ? "  ✗ " : "  → ", failed ? "red" : "dim", options.color)}` +
					clip(text, options.full ? 4000 : 110),
			);
			continue;
		}
		if (entry.kind === "status") {
			const note = String(entry.payload.note ?? "");
			lines.push(`${indent}  ${at} ${paint(`· ${String(entry.payload.status ?? "")}`, "dim", options.color)} ${clip(note, 120)}`);
			continue;
		}
		lines.push(`${indent}  ${at} ${paint(entry.kind, "dim", options.color)} ${clip(JSON.stringify(entry.payload), 120)}`);
	}
	if (worker.conclusion !== undefined) {
		lines.push(
			`${indent}  ${paint("conclusion", "green", options.color)} ${clip(worker.conclusion, options.full ? 4000 : 240)}`,
		);
	}
	return lines;
}

function renderDispatch(dispatch: DispatchTrace, turn: TurnTrace, options: RenderOptions, indent: string): string[] {
	const offset = `+${Math.round((dispatch.at - turn.at) / 1000)}s`;
	const at = paint(offset.padStart(6), "dim", options.color);
	const status =
		dispatch.status === "done"
			? paint("done", "green", options.color)
			: dispatch.status === "failed" || dispatch.status === "error"
				? paint(dispatch.status, "red", options.color)
				: paint(dispatch.status, "yellow", options.color);
	const badges = [
		`${status} in ${formatSpan(dispatch.ms)}`,
		dispatch.worker === undefined ? "no worker" : `${dispatch.worker.toolCalls} calls`,
		dispatch.worker !== undefined && dispatch.worker.refused > 0
			? paint(`${dispatch.worker.refused} refused`, "red", options.color)
			: undefined,
		dispatch.delivered ? undefined : paint("conclusion never reached the chat", "red", options.color),
	]
		.filter((badge): badge is string => badge !== undefined)
		.join(" · ");
	const lines = [
		`${indent}${at} ${paint("dispatch", "magenta", options.color)} ${paint(dispatch.title, "bold", options.color)}`,
		`${indent}         ${badges} · ${dispatch.taskId}`,
	];
	if (options.full) {
		lines.push(`${indent}         ${paint("brief", "dim", options.color)} ${clip(dispatch.description, 800)}`);
		if (dispatch.instructions !== undefined) {
			lines.push(`${indent}         ${paint("instructions", "dim", options.color)} ${clip(dispatch.instructions, 1600)}`);
		}
	}
	if (dispatch.error !== undefined && dispatch.error !== "") {
		lines.push(`${indent}         ${paint("failed:", "red", options.color)} ${clip(dispatch.error, options.full ? 2000 : 160)}`);
	}
	lines.push(...renderWorker(dispatch, options, `${indent}  `));
	for (const child of dispatch.children) {
		lines.push(`${indent}  ${paint("↳ child", "magenta", options.color)} ${clip(child.title, 60)} · ${child.status}`);
		lines.push(...renderWorker(child, options, `${indent}    `));
	}
	return lines;
}

function renderTurn(turn: TurnTrace, previousAt: number | undefined, options: RenderOptions): string[] {
	const lines: string[] = [];
	const heading =
		`turn ${turn.index} · ${turn.kind === "user" ? "you" : "work"} · ${clock(turn.at)} · ` +
		`${formatSpan(turn.ms)}` +
		(turn.closed ? "" : paint(" · still open", "yellow", options.color));
	lines.push("");
	lines.push(paint(heading, "bold", options.color));
	if (previousAt !== undefined) {
		lines.push(`${paint("  idle between turns", "dim", options.color)} ${formatSpan(turn.at - previousAt)}`);
	}
	for (const said of turn.users) {
		lines.push(`  ${paint("you ", "cyan", options.color)} ${clip(said.text, options.full ? 4000 : 300)}`);
	}
	// A dispatch's call and result are drawn from the task, below, with its worker
	// under it: the raw pair here would say the same thing twice and worse.
	const dispatchCalls = new Set(
		turn.entries
			.filter((entry) => entry.kind === "tool_call" && String(entry.payload.toolName ?? "") === "dispatch_task")
			.map((entry) => String(entry.payload.toolCallId ?? "")),
	);
	let lastAt = turn.users.at(-1)?.at;
	for (const entry of turn.entries) {
		if (entry.kind === "text" && entry.payload.role === "user") continue;
		const offset = lastAt === undefined ? 0 : entry.at - lastAt;
		const at = paint(`+${Math.round(offset / 1000)}s`.padStart(7), "dim", options.color);
		if (entry.kind === "text") {
			const text = String(entry.payload.text ?? "");
			const speaker = String(entry.payload.role ?? "") === "assistant" ? "says" : String(entry.payload.role ?? "");
			lines.push(`  ${at} ${paint(speaker, "green", options.color)} ${clip(text, options.full ? 4000 : 400)}`);
			lastAt = entry.at;
			continue;
		}
		if (entry.kind === "tool_call") {
			if (dispatchCalls.has(String(entry.payload.toolCallId ?? ""))) continue;
			const args = JSON.stringify(entry.payload.args ?? {});
			lines.push(
				`  ${at} ${paint(String(entry.payload.toolName ?? "?"), "blue", options.color)} ${paint(clip(args, options.full ? 4000 : 140), "dim", options.color)}`,
			);
			lastAt = entry.at;
			continue;
		}
		if (entry.kind === "tool_result") {
			if (dispatchCalls.has(String(entry.payload.toolCallId ?? ""))) continue;
			const failed = entry.payload.isError === true;
			const text = resultText(entry) ?? "";
			lines.push(
				`  ${at} ${paint(failed ? "  ✗ " : "  → ", failed ? "red" : "dim", options.color)}${clip(text, options.full ? 4000 : 140)}`,
			);
			lastAt = entry.at;
			continue;
		}
		if (entry.kind === "status") {
			const note = String(entry.payload.note ?? "");
			if (note === "turn finished" || note === "the worker finished") {
				lines.push(`  ${at} ${paint("· turn closed", "dim", options.color)} ${paint(note, "dim", options.color)}`);
			} else {
				lines.push(`  ${at} ${paint("·", "dim", options.color)} ${clip(note, 140)}`);
			}
			lastAt = entry.at;
			continue;
		}
		if (entry.kind === "stop") {
			const note = entry.payload.note === undefined ? "" : ` — ${String(entry.payload.note)}`;
			lines.push(`  ${at} ${paint(`■ stopped${note}`, "red", options.color)}`);
			lastAt = entry.at;
			continue;
		}
		if (entry.kind === "title") {
			lines.push(`  ${at} ${paint("· renamed", "dim", options.color)} “${String(entry.payload.title ?? "")}”`);
			lastAt = entry.at;
			continue;
		}
		if (entry.kind === "hand") {
			lines.push(
				`  ${at} ${paint("hand", "magenta", options.color)} ${String(entry.payload.op ?? "")} ` +
					`${String(entry.payload.endpointId ?? "")} ${entry.payload.ok === false ? paint("failed", "red", options.color) : ""}`,
			);
			lastAt = entry.at;
			continue;
		}
		if (entry.kind === "dispatch") {
			lines.push(`  ${at} ${paint("↳ dispatched a child", "magenta", options.color)} ${clip(String(entry.payload.title ?? ""), 60)}`);
			lastAt = entry.at;
			continue;
		}
		lines.push(`  ${at} ${paint(entry.kind, "dim", options.color)} ${clip(JSON.stringify(entry.payload), 140)}`);
		lastAt = entry.at;
	}
	for (const dispatch of turn.dispatches) {
		lines.push(...renderDispatch(dispatch, turn, options, "  "));
	}
	return lines;
}

function renderFinding(finding: Finding, options: RenderOptions): string {
	const badge =
		finding.severity === "high"
			? paint("high", "red", options.color)
			: finding.severity === "warn"
				? paint("warn", "yellow", options.color)
				: paint("note", "dim", options.color);
	return `  ${badge.padEnd(options.color ? 14 : 4)} ${finding.text}`;
}

/** One chat's whole flow, as text. */
export function renderTrace(trace: Trace, options: RenderOptions): string {
	const lines: string[] = [];
	const title = trace.thread.name === "" ? "(unnamed)" : trace.thread.name;
	lines.push(paint(title, "bold", options.color));
	const chat = trace.thread.chatId === undefined ? "a work thread (no chat)" : trace.thread.chatId;
	lines.push(`  ${paint("chat  ", "dim", options.color)} ${chat}`);
	lines.push(`  ${paint("thread", "dim", options.color)} ${trace.thread.id} · ${trace.thread.status} · ${trace.thread.seq} entries`);
	lines.push(`  ${paint("state ", "dim", options.color)} ${trace.statePath}`);
	const brain = trace.brain;
	if (brain !== undefined) {
		const life =
			brain.pid === undefined
				? paint("not running", "yellow", options.color)
				: brain.alive
					? paint(`pid ${brain.pid} running`, "green", options.color)
					: paint(`pid ${brain.pid} gone — this is a copy of its state`, "yellow", options.color);
		const identity =
			brain.identity === undefined
				? ""
				: ` · ${brain.identity.teamId}/${brain.identity.definitionId.slice(-6)}/${brain.identity.sessionId.slice(-6)}`;
		lines.push(`  ${paint("brain ", "dim", options.color)} ${life}${identity}`);
	}
	lines.push(
		`  ${paint("span  ", "dim", options.color)} ${day(trace.span.from)} ${clock(trace.span.from)} → ${clock(trace.span.to)} ` +
			`(${formatSpan(trace.span.ms)})`,
	);
	const counters = trace.counters;
	lines.push(
		`  ${paint("flow  ", "dim", options.color)} ${counters.turns} turns (${counters.userTurns} yours, ${counters.workTurns} from work) · ` +
			`${counters.dispatches} dispatched${counters.children > 0 ? ` + ${counters.children} child` : ""} · ` +
			`${counters.talkOnlyTurns} did no work · ${counters.stops} stop(s) · ` +
			`median ${counters.medianFirstActionMs === undefined ? "n/a" : formatSpan(counters.medianFirstActionMs)} before anything happens`,
	);

	const shown = options.turns === undefined ? trace.turns : trace.turns.slice(-options.turns);
	if (shown.length < trace.turns.length) {
		lines.push("");
		lines.push(paint(`  (${trace.turns.length - shown.length} earlier turn(s) not shown: --turns)`, "dim", options.color));
	}
	for (const [index, turn] of shown.entries()) {
		const previous = index === 0 ? undefined : shown[index - 1]?.entries.at(-1)?.at;
		lines.push(...renderTurn(turn, previous, options));
	}

	lines.push("");
	if (trace.findings.length === 0) {
		lines.push(paint("findings", "bold", options.color));
		lines.push(`  ${paint("nothing to flag", "dim", options.color)}`);
	} else {
		const order = { high: 0, warn: 1, note: 2 } as const;
		const sorted = [...trace.findings].sort((a, b) => order[a.severity] - order[b.severity]);
		lines.push(paint(`findings (${sorted.length})`, "bold", options.color));
		for (const finding of sorted) lines.push(renderFinding(finding, options));
	}
	return lines.join("\n");
}

/** One row per chat, so a reader can pick which flow to trace. */
export interface ChatRow {
	readonly chatId: string;
	readonly threadId: string;
	readonly name: string;
	readonly lastEventAt: number;
	readonly turns: number;
	readonly talkOnlyTurns: number;
	readonly dispatches: number;
	readonly findings: number;
}

export function renderChatList(rows: readonly ChatRow[], options: RenderOptions): string {
	if (rows.length === 0) return "no chats in this brain yet";
	const width = Math.min(46, Math.max(...rows.map((row) => row.name.length), 10));
	const lines = [
		paint(
			`${"chat".padEnd(28)} ${"name".padEnd(width)}  ${"turns".padStart(5)} ${"nowork".padStart(6)} ${"disp".padStart(5)} ${"flags".padStart(5)}  last`,
			"dim",
			options.color,
		),
	];
	for (const row of rows) {
		const flags = row.findings > 0 ? paint(String(row.findings).padStart(5), "yellow", options.color) : "    0";
		const idle =
			row.talkOnlyTurns > 0 ? paint(String(row.talkOnlyTurns).padStart(6), "red", options.color) : "     0";
		lines.push(
			`${row.chatId.padEnd(28)} ${row.name.slice(0, width).padEnd(width)}  ` +
				`${String(row.turns).padStart(5)} ${idle} ${String(row.dispatches).padStart(5)} ${flags}  ${day(row.lastEventAt)} ${clock(row.lastEventAt)}`,
		);
	}
	lines.push("");
	lines.push(paint(`trace one: --chat <id>  (or --latest for the most recent)`, "dim", options.color));
	return lines.join("\n");
}
