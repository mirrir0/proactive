#!/usr/bin/env node
/**
 * trace.ts — one chat, end to end: what the person said, what the Router did,
 * what each worker it dispatched did, and what came back.
 *
 * This is the instrument for the question "why did the assistant do that?".
 * It reads the brain's own state, read-only, and prints the flow in the order
 * it happened, with the waiting visible and the pathologies counted:
 *
 *   npm run trace                          # the chats this brain has, newest first
 *   npm run trace -- --latest              # the most recent chat, in full
 *   npm run trace -- --chat <chatId>       # one chat
 *   npm run trace -- --thread <threadId>   # one thread, chat or a worker's
 *   npm run trace -- --task <taskId>       # one dispatch's worker, in full
 *   npm run trace -- --chat <id> --json    # the same, for a program
 *
 * Flags: --state <path> (the database, a member's home, or the brains root),
 * --turns <n> (the last n turns), --full (whole arguments, results and briefs),
 * --no-color.
 */

import { assemble, clip, formatSpan, type Trace } from "./trace/assemble.ts";
import {
	brainContext,
	describeStatePath,
	findState,
	openState,
	type EntryRow,
	type StateReader,
	type ThreadRow,
} from "./trace/read.ts";
import { renderChatList, renderTrace, type ChatRow } from "./trace/render.ts";

interface Args {
	readonly chat?: string | undefined;
	readonly thread?: string | undefined;
	readonly task?: string | undefined;
	readonly state?: string | undefined;
	readonly turns?: number | undefined;
	readonly json: boolean;
	readonly full: boolean;
	readonly latest: boolean;
	readonly help: boolean;
	readonly color: boolean;
}

function parseArgs(argv: readonly string[]): Args {
	const value = (name: string): string | undefined => {
		const index = argv.indexOf(`--${name}`);
		return index === -1 ? undefined : argv[index + 1];
	};
	const has = (name: string): boolean => argv.includes(`--${name}`);
	const turns = value("turns");
	return {
		chat: value("chat"),
		thread: value("thread"),
		task: value("task"),
		state: value("state"),
		turns: turns === undefined ? undefined : Number.parseInt(turns, 10),
		json: has("json"),
		full: has("full"),
		latest: has("latest"),
		help: has("help") || has("h"),
		color: !has("no-color") && process.stdout.isTTY === true,
	};
}

const USAGE = `trace — one chat's flow through the brain, read-only

  npm run trace                       the chats this brain has, newest first
  npm run trace -- --latest           the most recent chat, in full
  npm run trace -- --chat <chatId>    one chat
  npm run trace -- --thread <id>      one thread (a chat's, or a worker's)
  npm run trace -- --task <taskId>    one dispatch's worker, in full

  --state <path>   the database, a member's home, or the brains root
  --turns <n>      only the last n turns
  --full           whole arguments, results and briefs
  --json           the trace as data
  --no-color       no ANSI`;

/** Every entry the trace could need: this chat's, and every task's own thread. */
function loadEntries(reader: StateReader, threadId: string): EntryRow[] {
	const tasks = reader.tasks();
	const threads = new Set<string>([threadId]);
	for (const task of tasks) if (task.threadId !== undefined) threads.add(task.threadId);
	// One query per thread is a millisecond each and a trace is read while
	// debugging: being right matters more than being fast here.
	const rows: EntryRow[] = [];
	for (const id of threads) rows.push(...reader.entries(id));
	return rows;
}

function traceThread(reader: StateReader, thread: ThreadRow): Trace {
	return assemble({
		statePath: reader.path,
		brain: brainContext(reader.path),
		thread,
		entries: loadEntries(reader, thread.id),
		tasks: reader.tasks(),
		threads: reader.threads(),
		busy: (from, to, exclude) => reader.busyBetween(from, to, exclude),
	});
}

/** The chat threads, newest first: a person's chats, not every task's thread. */
function chatThreads(reader: StateReader): ThreadRow[] {
	return reader
		.threads()
		.filter((thread) => thread.chatId !== undefined)
		.sort((a, b) => b.lastEventAt - a.lastEventAt);
}

function main(): number {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		process.stdout.write(`${USAGE}\n`);
		return 0;
	}
	const statePath = findState(args.state);
	const reader = openState(statePath);
	try {
		const where = describeStatePath(statePath);

		if (args.chat === undefined && args.thread === undefined && args.task === undefined && !args.latest) {
			const rows: ChatRow[] = chatThreads(reader).map((thread) => {
				const trace = traceThread(reader, thread);
				return {
					chatId: thread.chatId ?? "",
					threadId: thread.id,
					name: thread.name,
					lastEventAt: thread.lastEventAt,
					turns: trace.counters.turns,
					talkOnlyTurns: trace.counters.talkOnlyTurns,
					dispatches: trace.counters.dispatches,
					findings: trace.findings.filter((finding) => finding.severity !== "note").length,
				};
			});
			if (args.json) {
				process.stdout.write(`${JSON.stringify({ state: statePath, member: where.member, chats: rows }, null, 2)}\n`);
			} else {
				process.stdout.write(`${renderChatList(rows, { color: args.color, full: false })}\n`);
			}
			return 0;
		}

		let thread: ThreadRow | undefined;
		if (args.task !== undefined) {
			// A task id is long; the first segment is enough to name one.
			const task = reader
				.tasks()
				.find((candidate) => candidate.id === args.task || candidate.id.startsWith(args.task!));
			if (task === undefined) throw new Error(`no task ${args.task}`);
			thread = task.threadId === undefined ? undefined : reader.thread(task.threadId);
			if (thread === undefined) throw new Error(`task ${task.id} has no thread`);
		} else if (args.chat !== undefined) {
			thread = reader.threadOfChat(args.chat);
			if (thread === undefined) throw new Error(`no chat ${args.chat} in ${statePath}`);
		} else if (args.thread !== undefined) {
			thread = reader.thread(args.thread);
			if (thread === undefined) throw new Error(`no thread ${args.thread} in ${statePath}`);
		} else {
			thread = chatThreads(reader)[0];
			if (thread === undefined) throw new Error(`no chats in ${statePath}`);
		}

		const trace = traceThread(reader, thread);
		if (args.task !== undefined) {
			// A worker's thread is a task's: say what it was asked before showing
			// what it did, because the brief is the thing most worth judging.
			const task = reader.tasks().find((candidate) => candidate.threadId === thread!.id);
			if (task !== undefined) {
				const lines = [
					`task ${task.id} · ${task.status} · ${formatSpan(Math.max(0, task.updatedAt - task.createdAt))}`,
					`  brief     ${clip(task.description, args.full ? 4000 : 300)}`,
				];
				if (task.instructions !== undefined) {
					lines.push(`  instruct  ${clip(task.instructions, args.full ? 4000 : 300)}`);
				}
				if (task.error !== undefined) lines.push(`  error     ${clip(task.error, 300)}`);
				process.stdout.write(`${lines.join("\n")}\n\n`);
			}
		}
		if (args.json) {
			process.stdout.write(
				`${JSON.stringify({ state: statePath, member: where.member, host: where.host, ...trace }, null, 2)}\n`,
			);
			return 0;
		}
		process.stdout.write(`${renderTrace(trace, { color: args.color, full: args.full, turns: args.turns })}\n`);
		return 0;
	} finally {
		reader.close();
	}
}

try {
	process.exitCode = main();
} catch (err) {
	process.stderr.write(`trace: ${(err as Error).message}\n`);
	process.exitCode = 1;
}
