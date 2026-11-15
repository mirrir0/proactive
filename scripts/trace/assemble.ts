/**
 * trace/assemble.ts — one chat's flow, out of the rows a brain kept.
 *
 * A chat's thread records what the person said, what the Router did, and what
 * each dispatch did in its own thread; the tasks table records what was asked
 * for and what came back. This module turns those rows into turns a person
 * would recognise ("they said this, it did that") and into findings — facts,
 * counted, not judgements. The judgement is the reader's job; the instrument's
 * job is to make the facts impossible to miss.
 *
 * Nothing here reads a file or a clock: it takes rows and returns a trace, so a
 * fixture is a test.
 */

import type { BrainContext, BusyWindow, EntryRow, TaskRow, ThreadRow } from "./read.ts";

/** One entry, as the trace carries it. */
export interface TraceEntry {
	readonly seq: number;
	readonly at: number;
	readonly kind: string;
	readonly payload: Record<string, unknown>;
}

/** A task's own thread: the subagent's work, in its own words and calls. */
export interface WorkerTrace {
	readonly threadId: string;
	readonly name: string;
	readonly entries: readonly TraceEntry[];
	readonly startedAt: number;
	readonly endedAt: number;
	readonly toolCalls: number;
	readonly refused: number;
	readonly errors: number;
	/** The last assistant text: what the parent, or the person, was told. */
	readonly conclusion: string | undefined;
}

/** One dispatch, with the subagents it fanned out to. */
export interface DispatchTrace {
	readonly taskId: string;
	readonly title: string;
	readonly description: string;
	readonly instructions: string | undefined;
	readonly status: string;
	readonly at: number;
	readonly endedAt: number;
	readonly ms: number;
	readonly worker: WorkerTrace | undefined;
	readonly children: readonly DispatchTrace[];
	/** Whether this task's conclusion reached the conversation that dispatched it. */
	readonly delivered: boolean;
	/** What went wrong, when the task failed: the words, not only the status. */
	readonly error: string | undefined;
}

/** One turn: the person's words and everything the brain did about them. */
export interface TurnTrace {
	readonly index: number;
	/** `user` when the person spoke, `work` when a worker's answer opened it. */
	readonly kind: "user" | "work";
	readonly at: number;
	readonly ms: number;
	readonly users: readonly { text: string; at: number }[];
	readonly entries: readonly TraceEntry[];
	/** The last thing said to the person in this turn. */
	readonly reply: string | undefined;
	readonly dispatches: readonly DispatchTrace[];
	readonly stops: number;
	readonly titles: readonly string[];
	/** How long after the person's words anything at all happened. */
	readonly firstActionMs: number | undefined;
	readonly closed: boolean;
}

export type FindingSeverity = "high" | "warn" | "note";

export interface Finding {
	readonly code: string;
	readonly severity: FindingSeverity;
	readonly text: string;
	readonly turn?: number;
	readonly taskId?: string;
}

export interface Counters {
	readonly turns: number;
	readonly userTurns: number;
	readonly workTurns: number;
	readonly talkOnlyTurns: number;
	readonly dispatches: number;
	readonly children: number;
	readonly failed: number;
	readonly stopped: number;
	readonly refusals: number;
	readonly stops: number;
	/** Total time the person spent waiting inside a turn of their own. */
	readonly personWaitMs: number;
	readonly medianFirstActionMs: number | undefined;
}

export interface Trace {
	readonly statePath: string;
	/** The brain around the state: its process and its identity, when it can be read. */
	readonly brain?: BrainContext | undefined;
	readonly thread: ThreadRow;
	readonly span: { from: number; to: number; ms: number };
	readonly turns: readonly TurnTrace[];
	readonly dispatches: readonly DispatchTrace[];
	readonly findings: readonly Finding[];
	readonly counters: Counters;
}

export interface AssembleInput {
	readonly statePath: string;
	readonly thread: ThreadRow;
	readonly entries: readonly EntryRow[];
	readonly tasks: readonly TaskRow[];
	readonly threads: readonly ThreadRow[];
	readonly brain?: BrainContext | undefined;
	/** What the brain was doing between two instants, on threads other than these. */
	readonly busy: (from: number, to: number, exclude: readonly string[]) => BusyWindow;
}

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);
const rec = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;

const toTraceEntry = (entry: EntryRow): TraceEntry => ({
	seq: entry.seq,
	at: entry.at,
	kind: entry.kind,
	payload: entry.payload,
});

/** The words in an entry, when it has any: a person's message or an answer. */
function textOf(entry: TraceEntry): string | undefined {
	if (entry.kind !== "text") return undefined;
	const text = str(entry.payload.text);
	return text === undefined ? undefined : text;
}

const isUserText = (entry: TraceEntry): boolean => entry.kind === "text" && entry.payload.role === "user";

/**
 * A turn's last entry: the brain saying it has nothing more to do for now.
 *
 * A chat's turn closes with "turn finished" or "the worker finished"; a worker's
 * own thread closes when the worker exits, which is its last status.
 */
function closesTurn(entry: TraceEntry): boolean {
	if (entry.kind === "stop") return true;
	if (entry.kind !== "status") return false;
	const note = str(entry.payload.note) ?? "";
	return note === "turn finished" || note === "the worker finished" || /^worker \S+ finished$/.test(note);
}

/** Tool results a tool call can be paired with, by the id the model used. */
function resultsById(entries: readonly TraceEntry[]): Map<string, TraceEntry> {
	const byId = new Map<string, TraceEntry>();
	for (const entry of entries) {
		if (entry.kind !== "tool_result") continue;
		const id = str(entry.payload.toolCallId);
		if (id !== undefined) byId.set(id, entry);
	}
	return byId;
}

function toolName(entry: TraceEntry): string | undefined {
	return entry.kind === "tool_call" ? str(entry.payload.toolName) : undefined;
}

/** Whether a tool result was a refusal, and not a tool that ran and failed. */
function isRefusal(entry: TraceEntry): boolean {
	if (entry.kind !== "tool_result" || entry.payload.isError !== true) return false;
	const text = JSON.stringify(entry.payload.result ?? "");
	return /may not use|not permitted|permission|denied|unauthori[sz]ed|forbidden/i.test(text);
}

/** A tool result's first line of text, for a one-line reading of what came back. */
export function resultText(entry: TraceEntry): string | undefined {
	const result = rec(entry.payload.result);
	if (result === undefined) return undefined;
	const content = result.content;
	if (Array.isArray(content)) {
		const parts = content
			.map((part) => {
				const block = rec(part);
				return block === undefined ? "" : (str(block.text) ?? "");
			})
			.filter((part) => part !== "");
		if (parts.length > 0) return parts.join(" ");
	}
	return str(result.text) ?? undefined;
}

/** The conclusion is the last assistant text, which is the contract (worker.ts). */
function conclusionOf(entries: readonly TraceEntry[]): string | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry !== undefined && entry.kind === "text" && entry.payload.role === "assistant") {
			return str(entry.payload.text);
		}
	}
	return undefined;
}

/** Cut a long string for a one-line display, saying how much was cut. */
export function clip(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max)}… (+${flat.length - max})`;
}

/** Text compared loosely: what a chat was told, against what a task concluded. */
const normalize = (text: string): string => text.replace(/\s+/g, " ").trim().toLowerCase();

export function assemble(input: AssembleInput): Trace {
	// One pass over every thread the input carries, so a chat with a hundred
	// workers is a lookup per worker rather than a scan per worker.
	const byThread = new Map<string, TraceEntry[]>();
	for (const row of input.entries) {
		const held = byThread.get(row.threadId) ?? [];
		held.push(toTraceEntry(row));
		byThread.set(row.threadId, held);
	}
	const entries = byThread.get(input.thread.id) ?? [];
	const tasksById = new Map(input.tasks.map((task) => [task.id, task]));
	const childrenOf = new Map<string, TaskRow[]>();
	for (const task of input.tasks) {
		if (task.parentTaskId === undefined) continue;
		const held = childrenOf.get(task.parentTaskId) ?? [];
		held.push(task);
		childrenOf.set(task.parentTaskId, held);
	}
	const threadName = (id: string | undefined): string =>
		input.threads.find((thread) => thread.id === id)?.name ?? (id ?? "?");

	/** A worker's thread, read as work: calls, refusals, and the last thing it said. */
	const workerFor = (task: TaskRow): WorkerTrace | undefined => {
		if (task.threadId === undefined) return undefined;
		const held = byThread.get(task.threadId) ?? [];
		if (held.length === 0) return undefined;
		const calls = held.filter((entry) => entry.kind === "tool_call");
		return {
			threadId: task.threadId,
			name: threadName(task.threadId),
			entries: held,
			startedAt: held[0]?.at ?? task.createdAt,
			endedAt: held[held.length - 1]?.at ?? task.updatedAt,
			toolCalls: calls.length,
			refused: held.filter(isRefusal).length,
			errors: held.filter((entry) => entry.kind === "tool_result" && entry.payload.isError === true).length,
			conclusion: conclusionOf(held),
		};
	};

	/** A thread's assistant texts, for asking whether a conclusion arrived in it. */
	const saidCache = new Map<string, string>();
	const saidIn = (threadId: string): string => {
		const held = saidCache.get(threadId);
		if (held !== undefined) return held;
		const text = normalize(
			(byThread.get(threadId) ?? [])
				.filter((entry) => entry.kind === "text" && entry.payload.role === "assistant")
				.map((entry) => textOf(entry) ?? "")
				.join(" "),
		);
		saidCache.set(threadId, text);
		return text;
	};

	const dispatchFor = (task: TaskRow, depth = 0): DispatchTrace => {
		const worker = workerFor(task);
		// A conclusion belongs in the conversation the task reported into. When
		// that is not this one — a task replayed into a second thread, a chat
		// copied — its words are not missing, they are somewhere else, which is a
		// different fact and must not be reported as a lost answer.
		const reportedInto = task.reportThreadId ?? input.thread.id;
		const delivered =
			task.result === undefined
				? false
				: depth > 0
					? true // a child answers its parent through the tool call, not the chat
					: saidIn(reportedInto).includes(normalize(task.result).slice(0, 80));
		return {
			taskId: task.id,
			title: task.title,
			description: task.description,
			instructions: task.instructions,
			status: task.status,
			at: task.createdAt,
			endedAt: task.updatedAt,
			ms: Math.max(0, task.updatedAt - task.createdAt),
			worker,
			children: (childrenOf.get(task.id) ?? []).map((child) => dispatchFor(child, depth + 1)),
			delivered,
			error: task.error,
		};
	};

	// ----- turns -----
	const turns: TurnTrace[] = [];
	let current: TraceEntry[] = [];
	let closed = true;

	const finish = (): void => {
		if (current.length === 0) return;
		const held = current;
		current = [];
		closed = true;
		const users = held
			.filter(isUserText)
			.map((entry) => ({ text: textOf(entry) ?? "", at: entry.at }));
		const results = resultsById(held);
		const dispatches: DispatchTrace[] = [];
		const seen = new Set<string>();
		for (const entry of held) {
			if (toolName(entry) !== "dispatch_task") continue;
			const callId = str(entry.payload.toolCallId);
			const result = callId === undefined ? undefined : results.get(callId);
			const details = rec(rec(result?.payload.result)?.details);
			const taskId = str(details?.taskId);
			if (taskId === undefined || seen.has(taskId)) continue;
			const task = tasksById.get(taskId);
			if (task === undefined) continue;
			seen.add(taskId);
			dispatches.push(dispatchFor(task));
		}
		// A top-level dispatch also leaves a status line before the call, and a
		// brain that recorded the line and not the call still dispatched: match the
		// task by its title, within a minute of the line.
		for (const entry of held) {
			if (entry.kind !== "status") continue;
			const note = str(entry.payload.note) ?? "";
			if (!note.startsWith("dispatched: ")) continue;
			const title = note.slice("dispatched: ".length).split(" on ")[0] ?? "";
			for (const task of input.tasks) {
				if (seen.has(task.id) || task.title !== title) continue;
				if (Math.abs(task.createdAt - entry.at) > 60_000) continue;
				// A task that reported into another conversation is that one's: two
				// chats dispatching the same title a minute apart are not each other's.
				if (task.reportThreadId !== undefined && task.reportThreadId !== input.thread.id) continue;
				seen.add(task.id);
				dispatches.push(dispatchFor(task));
			}
		}
		const replies = held.filter((entry) => entry.kind === "text" && entry.payload.role === "assistant");
		const lastUser = users.at(-1);
		const afterUser = lastUser === undefined ? [] : held.filter((entry) => entry.at >= lastUser.at && !isUserText(entry));
		const firstAction = afterUser.find((entry) => entry.kind !== "text" || entry.payload.role !== "assistant");
		const at = held[0]?.at ?? 0;
		turns.push({
			index: turns.length + 1,
			kind: users.length > 0 ? "user" : "work",
			at,
			ms: Math.max(0, (held[held.length - 1]?.at ?? at) - at),
			users,
			entries: held,
			reply: replies.length === 0 ? undefined : textOf(replies[replies.length - 1]!),
			dispatches,
			stops: held.filter((entry) => entry.kind === "stop").length,
			titles: held
				.filter((entry) => entry.kind === "title")
				.map((entry) => str(entry.payload.title) ?? "")
				.filter((title) => title !== ""),
			firstActionMs: firstAction === undefined || lastUser === undefined ? undefined : firstAction.at - lastUser.at,
			closed: held.length > 0 && closesTurn(held[held.length - 1]!),
		});
	};

	for (const entry of entries) {
		if (isUserText(entry) && closed) finish();
		if (current.length === 0) closed = false;
		current.push(entry);
		if (closesTurn(entry)) finish();
	}
	finish();

	const topLevel = turns.flatMap((turn) => turn.dispatches);
	const allDispatches = (held: readonly DispatchTrace[]): DispatchTrace[] =>
		held.flatMap((dispatch) => [dispatch, ...allDispatches(dispatch.children)]);
	const everyDispatch = allDispatches(topLevel);
	const workers = everyDispatch.map((dispatch) => dispatch.worker).filter((worker) => worker !== undefined);

	const userTurns = turns.filter((turn) => turn.kind === "user");
	const talkOnly = userTurns.filter(
		(turn) =>
			turn.dispatches.length === 0 &&
			!turn.entries.some((entry) => entry.kind === "tool_call") &&
			turn.reply !== undefined,
	);
	const firstActions = userTurns
		.map((turn) => turn.firstActionMs)
		.filter((ms): ms is number => ms !== undefined)
		.sort((a, b) => a - b);
	const median = firstActions.length === 0 ? undefined : firstActions[Math.floor(firstActions.length / 2)];

	const from = entries[0]?.at ?? input.thread.lastEventAt;
	const to = entries[entries.length - 1]?.at ?? from;

	const trace: Trace = {
		statePath: input.statePath,
		brain: input.brain,
		thread: input.thread,
		span: { from, to, ms: Math.max(0, to - from) },
		turns,
		dispatches: topLevel,
		findings: [],
		counters: {
			turns: turns.length,
			userTurns: userTurns.length,
			workTurns: turns.length - userTurns.length,
			talkOnlyTurns: talkOnly.length,
			dispatches: topLevel.length,
			children: everyDispatch.length - topLevel.length,
			failed: everyDispatch.filter((dispatch) => dispatch.status === "failed" || dispatch.status === "error").length,
			stopped: everyDispatch.filter((dispatch) => dispatch.status === "cancelled" || dispatch.status === "stopped").length,
			refusals: workers.reduce((total, worker) => total + (worker?.refused ?? 0), 0),
			stops: turns.reduce((total, turn) => total + turn.stops, 0),
			personWaitMs: userTurns.reduce((total, turn) => total + turn.ms, 0),
			medianFirstActionMs: median,
		},
	};
	return { ...trace, findings: findingsFor(trace, input.busy, input.tasks) };
}

/** Words that say nothing about what the work was. */
const STOPWORDS = new Set([
	"the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "that", "this", "it", "its", "is", "are",
	"be", "was", "were", "any", "all", "some", "my", "me", "i", "you", "your", "please", "about", "from", "at", "by",
]);

/**
 * The words a title is about: no stopwords, and plurals folded, so "vision
 * documents" and "vision document" are the same work said twice.
 */
const significantWords = (text: string): Set<string> =>
	new Set(
		text
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter((word) => word.length > 2 && !STOPWORDS.has(word))
			.map((word) => (word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word)),
	);

const overlap = (a: Set<string>, b: Set<string>): number => {
	let shared = 0;
	for (const word of a) if (b.has(word)) shared += 1;
	return shared;
};

/**
 * What the trace makes impossible to miss.
 *
 * Facts with a code, never a verdict: "four of nine turns did no work" is a
 * measurement, and what to do about it is the reader's. Heuristics that are
 * genuinely guesses — a reply that promised work — are named as such in the
 * text, so a reader knows which lines are counted and which are read.
 */
export function findingsFor(
	trace: Trace,
	busy: AssembleInput["busy"],
	tasks: readonly TaskRow[] = [],
): Finding[] {
	const tasksById = new Map(tasks.map((task) => [task.id, task]));
	const findings: Finding[] = [];
	for (const turn of trace.turns) {
		const didNothing =
			turn.kind === "user" && turn.dispatches.length === 0 && !turn.entries.some((entry) => entry.kind === "tool_call");
		if (didNothing && turn.reply !== undefined) {
			const promise = /report back|let you know|i'll|i will|already (searching|running|finished|sent)|on it/i.exec(
				turn.reply,
			);
			findings.push({
				code: "talk-only-turn",
				severity: "high",
				turn: turn.index,
				text:
					`turn ${turn.index}: ${turn.ms === 0 ? "no time at all" : `${Math.round(turn.ms / 1000)}s`} and no work — ` +
					`nothing dispatched, no tool called${promise === null ? "" : `, and the reply says “${promise[0]}”`}`,
			});
		}
		if (turn.firstActionMs !== undefined && turn.firstActionMs > 60_000) {
			const window = busy(turn.at, turn.at + turn.firstActionMs, [trace.thread.id]);
			const behind =
				window.entries >= 3
					? ` — during it the brain wrote ${window.entries} entries on ${window.threads.length} other thread(s): ` +
						`${window.threads
							.slice(0, 3)
							.map((thread) => `${clip(thread.name, 28)} (${thread.entries})`)
							.join(", ")}`
					: "";
			findings.push({
				code: "slow-start",
				severity: turn.firstActionMs > 600_000 ? "high" : "warn",
				turn: turn.index,
				text: `turn ${turn.index}: ${formatSpan(turn.firstActionMs)} after the person spoke before anything happened${behind}`,
			});
		}
		if (turn.kind === "user" && turn.ms > 120_000) {
			findings.push({
				code: "long-turn",
				severity: "warn",
				turn: turn.index,
				text: `turn ${turn.index}: open for ${formatSpan(turn.ms)} — the person could not type until it closed`,
			});
		}
		if (turn.stops > 0) {
			findings.push({
				code: "stopped",
				severity: "note",
				turn: turn.index,
				text: `turn ${turn.index}: the person stopped it`,
			});
		}
	}

	// Which turn a dispatch was made in, so a repeat can say who repeated it: the
	// person asking again and the brain re-dispatching itself look identical in a
	// task list and are opposite problems.
	const turnOf = new Map<string, TurnTrace>();
	for (const turn of trace.turns) for (const dispatch of turn.dispatches) turnOf.set(dispatch.taskId, turn);

	// The same thing dispatched twice is work paid for twice.
	const seen: { title: string; words: Set<string>; taskId: string }[] = [];
	for (const dispatch of trace.dispatches) {
		const words = significantWords(dispatch.title);
		const near = seen.find((earlier) => overlap(earlier.words, words) >= Math.min(3, words.size));
		if (near !== undefined) {
			const turn = turnOf.get(dispatch.taskId);
			const who =
				turn === undefined
					? "dispatched twice"
					: turn.users.length > 0
						? `the person asked again in turn ${turn.index}`
						: `dispatched again in turn ${turn.index} without being asked`;
			findings.push({
				code: "duplicate-dispatch",
				severity: "warn",
				taskId: dispatch.taskId,
				text: `“${clip(dispatch.title, 48)}” repeats “${clip(near.title, 48)}” — ${who}`,
			});
		}
		seen.push({ title: dispatch.title, words, taskId: dispatch.taskId });
	}

	const every: DispatchTrace[] = [];
	const walk = (held: readonly DispatchTrace[]): void => {
		for (const dispatch of held) {
			every.push(dispatch);
			walk(dispatch.children);
		}
	};
	walk(trace.dispatches);

	for (const dispatch of every) {
		if (dispatch.status === "failed" || dispatch.status === "error") {
			findings.push({
				code: "failed-task",
				severity: "high",
				taskId: dispatch.taskId,
				text: `“${clip(dispatch.title, 48)}” failed: ${clip(dispatch.worker?.conclusion ?? "no conclusion", 120)}`,
			});
		}
		if ((dispatch.status === "cancelled" || dispatch.status === "stopped") && dispatch.children.length === 0) {
			findings.push({
				code: "stopped-task",
				severity: "note",
				taskId: dispatch.taskId,
				text: `“${clip(dispatch.title, 48)}” was stopped after ${formatSpan(dispatch.ms)}`,
			});
		}
		const task = tasksById.get(dispatch.taskId);
		if (task !== undefined && task.reportThreadId !== undefined && task.reportThreadId !== trace.thread.id) {
			findings.push({
				code: "conclusion-elsewhere",
				severity: "note",
				taskId: dispatch.taskId,
				text: `“${clip(dispatch.title, 48)}” reported into another conversation (${task.reportThreadId})`,
			});
		}
		if (
			dispatch.status === "done" &&
			dispatch.children.length === 0 &&
			!dispatch.delivered &&
			dispatch.description !== "" &&
			(task === undefined || task.reportThreadId === undefined || task.reportThreadId === trace.thread.id)
		) {
			// Verbatim, because that is the contract: the conclusion *is* the answer
			// and is delivered as it was written. A model's restatement of it does
			// not count, and is exactly what this is here to catch.
			findings.push({
				code: "undelivered-conclusion",
				severity: "high",
				taskId: dispatch.taskId,
				text: `“${clip(dispatch.title, 48)}” finished, and its own words never reached the chat — what the person was told about it was written by someone else`,
			});
		}
		const worker = dispatch.worker;
		if (worker !== undefined && worker.refused > 0) {
			const refusedTools = [
				...new Set(
					worker.entries
						.filter(isRefusal)
						.map((entry) => {
							const callId = str(entry.payload.toolCallId);
							const call = worker.entries.find(
								(candidate) => candidate.kind === "tool_call" && str(candidate.payload.toolCallId) === callId,
							);
							return call === undefined ? "a tool" : (toolName(call) ?? "a tool");
						}),
				),
			];
			findings.push({
				code: "refused-tool",
				severity: "high",
				taskId: dispatch.taskId,
				text: `${refusedTools.join(", ")} refused ${worker.refused}× in “${clip(dispatch.title, 40)}” — the worker was not granted what it tried to use`,
			});
		}
		if (worker !== undefined && worker.toolCalls > 0) {
			const counts = new Map<string, number>();
			for (const entry of worker.entries) {
				if (entry.kind !== "tool_call") continue;
				const key = `${toolName(entry) ?? "?"} ${JSON.stringify(entry.payload.args ?? {})}`;
				counts.set(key, (counts.get(key) ?? 0) + 1);
			}
			const repeated = [...counts.entries()].filter(([, count]) => count > 1);
			if (repeated.length > 0) {
				findings.push({
					code: "repeated-call",
					severity: "warn",
					taskId: dispatch.taskId,
					text:
						`${repeated.length} identical call(s) repeated in “${clip(dispatch.title, 40)}”: ` +
						repeated
							.slice(0, 3)
							.map(([key, count]) => `${clip(key, 60)} ×${count}`)
							.join("; "),
				});
			}
		}
	}
	return findings;
}

/** A duration a person reads: 45s, 3m 12s, 1h 25m. */
export function formatSpan(ms: number): string {
	const total = Math.round(ms / 1000);
	if (total < 60) return `${total}s`;
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	if (minutes < 60) return `${minutes}m ${seconds}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}
