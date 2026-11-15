/**
 * trace/read.ts — a brain's state, opened for reading and nothing else.
 *
 * A trace is an instrument, so it must not be able to break the thing it
 * measures: every statement here is a SELECT, and the file is opened read-only
 * where SQLite allows it (it may refuse a WAL database whose writer is gone, so
 * the open falls back to a normal handle and still only selects).
 *
 * The database is the brain's own (`<stateDir>/mir.sqlite`), which is the only
 * place the flow of a chat is recorded: the thread's entries, the tasks a turn
 * dispatched, and what else the brain was doing while this chat waited. The
 * host's Postgres holds the chat's row and the UI's copy of the messages, and
 * neither is needed to see what the brain did — the brain's log is the trace.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** One row of `threads`: a durable thread, with its chat when it has one. */
export interface ThreadRow {
	readonly id: string;
	readonly name: string;
	/** The chat this thread is a window onto; undefined for a task's own thread. */
	readonly chatId: string | undefined;
	readonly status: string;
	readonly seq: number;
	readonly lastEventAt: number;
}

/** One row of `thread_entries`: the entry's own fields are in `payload`. */
export interface EntryRow {
	readonly threadId: string;
	readonly seq: number;
	readonly at: number;
	readonly kind: string;
	readonly payload: Record<string, unknown>;
}

/** One row of `tasks`: a dispatch, top-level or a child of another. */
export interface TaskRow {
	readonly id: string;
	readonly title: string;
	readonly description: string;
	readonly instructions: string | undefined;
	readonly threadId: string | undefined;
	readonly reportThreadId: string | undefined;
	readonly parentTaskId: string | undefined;
	readonly depth: number;
	readonly status: string;
	readonly result: string | undefined;
	readonly error: string | undefined;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly fast: boolean;
}

/** What else the brain was doing in a window: the reason a turn started late. */
export interface BusyWindow {
	readonly entries: number;
	readonly threads: readonly { id: string; name: string; entries: number }[];
}

export interface StateReader {
	readonly path: string;
	threads(): ThreadRow[];
	thread(id: string): ThreadRow | undefined;
	/** A chat's thread, by the chat's id. */
	threadOfChat(chatId: string): ThreadRow | undefined;
	entries(threadId: string, limit?: number): EntryRow[];
	tasks(): TaskRow[];
	/** Entries on other threads between two instants: what the brain was busy with. */
	busyBetween(from: number, to: number, exclude: readonly string[]): BusyWindow;
	close(): void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const asNumber = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);

/** A row as the reader hands it out: tolerant of a column an older build lacked. */
function toThread(row: Record<string, unknown>): ThreadRow {
	return {
		id: String(row.id),
		name: String(row.name ?? ""),
		chatId: asString(row.chat_id) ?? undefined,
		status: String(row.status ?? "idle"),
		seq: asNumber(row.seq) ?? 0,
		lastEventAt: asNumber(row.last_event_at) ?? 0,
	};
}

function toEntry(row: Record<string, unknown>): EntryRow {
	const payload = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
	return {
		threadId: String(row.thread_id),
		seq: asNumber(row.seq) ?? 0,
		at: asNumber(row.at) ?? 0,
		kind: String(row.kind),
		payload: isRecord(payload) ? payload : {},
	};
}

function toTask(row: Record<string, unknown>): TaskRow {
	return {
		id: String(row.id),
		title: String(row.title ?? ""),
		description: String(row.description ?? ""),
		instructions: asString(row.instructions) ?? undefined,
		threadId: asString(row.thread_id) ?? undefined,
		reportThreadId: asString(row.report_thread_id) ?? undefined,
		parentTaskId: asString(row.parent_task_id) ?? undefined,
		depth: asNumber(row.depth) ?? 0,
		status: String(row.status ?? ""),
		result: asString(row.result) ?? undefined,
		error: asString(row.error) ?? undefined,
		createdAt: asNumber(row.created_at) ?? 0,
		updatedAt: asNumber(row.updated_at) ?? 0,
		fast: row.fast === 1 || row.fast === true,
	};
}

/** Open a brain's state for reading. The only write it can do is a WAL checkpoint by the OS. */
export function openState(path: string): StateReader {
	const open = (readOnly: boolean): DatabaseSync => {
		const db = new DatabaseSync(path, readOnly ? { readOnly: true } : {});
		// A reader must not fail because the brain is mid-write: wait, do not error.
		db.exec("PRAGMA busy_timeout = 2000");
		return db;
	};
	let db: DatabaseSync;
	try {
		db = open(true);
	} catch {
		db = open(false);
	}

	const threads = (): ThreadRow[] =>
		db
			.prepare("SELECT id, name, chat_id, status, seq, last_event_at FROM threads")
			.all()
			.map((row) => toThread(row as Record<string, unknown>));

	const entries = (threadId: string, limit?: number): EntryRow[] => {
		const rows =
			limit === undefined
				? db
						.prepare("SELECT thread_id, seq, at, kind, payload FROM thread_entries WHERE thread_id = ? ORDER BY seq")
						.all(threadId)
				: db
						.prepare(
							"SELECT thread_id, seq, at, kind, payload FROM thread_entries WHERE thread_id = ? ORDER BY seq DESC LIMIT ?",
						)
						.all(threadId, limit)
						.reverse();
		return rows.map((row) => toEntry(row as Record<string, unknown>));
	};

	return {
		path,
		threads,
		thread(id) {
			return threads().find((thread) => thread.id === id);
		},
		threadOfChat(chatId) {
			return threads().find((thread) => thread.chatId === chatId);
		},
		entries,
		tasks() {
			return db
				.prepare(
					"SELECT id, title, description, instructions, thread_id, report_thread_id, parent_task_id, depth, status, result, error, created_at, updated_at, fast FROM tasks",
				)
				.all()
				.map((row) => toTask(row as Record<string, unknown>));
		},
		busyBetween(from, to, exclude) {
			const rows = db
				.prepare(
					`SELECT thread_id, COUNT(*) AS n FROM thread_entries
					 WHERE at > ? AND at < ? GROUP BY thread_id ORDER BY n DESC`,
				)
				.all(from, to) as Record<string, unknown>[];
			const names = new Map(threads().map((thread) => [thread.id, thread.name]));
			const others = rows
				.map((row) => ({
					id: String(row.thread_id),
					name: names.get(String(row.thread_id)) ?? String(row.thread_id),
					entries: asNumber(row.n) ?? 0,
				}))
				.filter((thread) => !exclude.includes(thread.id));
			return { entries: others.reduce((total, thread) => total + thread.entries, 0), threads: others };
		},
		close() {
			db.close();
		},
	};
}

/**
 * Where a member's brain keeps its state.
 *
 * Derived rather than stored, so the tool works against a live brain, a
 * developer's `mir serve`, and a state directory copied off a machine. An
 * explicit path may be the database, the state directory, a member's home, or
 * the brains root; the rest is found under it.
 */
export function findState(explicit?: string): string {
	const isFile = (path: string): boolean => {
		try {
			return statSync(path).isFile();
		} catch {
			return false;
		}
	};
	const isDir = (path: string): boolean => {
		try {
			return statSync(path).isDirectory();
		} catch {
			return false;
		}
	};
	const databasesUnder = (root: string, depth: number): string[] => {
		if (!isDir(root)) return [];
		const found: string[] = [];
		for (const name of readdirSync(root)) {
			const child = join(root, name);
			if (isFile(child) && name === "mir.sqlite") found.push(child);
			else if (depth > 1 && isDir(child)) found.push(...databasesUnder(child, depth - 1));
		}
		return found;
	};
	const newest = (paths: string[]): string | undefined =>
		paths.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];

	if (explicit !== undefined) {
		if (isFile(explicit)) return explicit;
		const found = databasesUnder(explicit, 4);
		const pick = newest(found);
		if (pick === undefined) throw new Error(`no brain state under ${explicit}`);
		return pick;
	}

	const roots = [
		process.env.MIR_BRAIN_DIR,
		join(homedir(), ".anomalous", "data", "brains"),
		join(homedir(), ".local", "share", "mir", "state"),
	].filter((root): root is string => root !== undefined && root !== "");

	for (const root of roots) {
		if (!existsSync(root)) continue;
		const found = isFile(join(root, "mir.sqlite")) ? [join(root, "mir.sqlite")] : databasesUnder(root, 4);
		const pick = newest(found);
		if (pick !== undefined) return pick;
	}
	throw new Error(
		"no brain state found: pass --state <dir>, or set MIR_BRAIN_DIR (looked in ~/.anomalous/data/brains)",
	);
}

/** The brain the state belongs to: its home, whether its process is alive, and who it is. */
export interface BrainContext {
	readonly home: string;
	readonly pid: number | undefined;
	readonly alive: boolean;
	readonly identity: { teamId: string; definitionId: string; sessionId: string } | undefined;
}

/**
 * The brain around the state: the process that writes it, and the identity it
 * runs as on the stack.
 *
 * A trace is about a brain as much as about a chat, and "is this a running
 * brain or a copy of a dead one" changes how a gap in the log reads. Signal 0
 * asks the kernel whether the pid exists and sends nothing.
 */
export function brainContext(statePath: string): BrainContext {
	const home = dirname(dirname(statePath));
	const read = (name: string): string | undefined => {
		try {
			return readFileSync(join(home, name), "utf8");
		} catch {
			return undefined;
		}
	};
	const pidText = (read("brain.pid") ?? "").trim();
	const pid = pidText === "" ? undefined : Number.parseInt(pidText, 10);
	let alive = false;
	if (pid !== undefined && Number.isFinite(pid)) {
		try {
			process.kill(pid, 0);
			alive = true;
		} catch {
			alive = false;
		}
	}
	const raw = read("identity.json");
	let identity: BrainContext["identity"];
	if (raw !== undefined) {
		try {
			const parsed = JSON.parse(raw) as Record<string, unknown>;
			if (typeof parsed.teamId === "string" && typeof parsed.definitionId === "string" && typeof parsed.sessionId === "string") {
				identity = { teamId: parsed.teamId, definitionId: parsed.definitionId, sessionId: parsed.sessionId };
			}
		} catch {
			identity = undefined;
		}
	}
	return { home, pid, alive, identity };
}

/** The member a state file belongs to, from where it sits: `<root>/<host>/<member>/state/mir.sqlite`. */
export function describeStatePath(path: string): { member: string; host: string } {
	const parts = dirname(dirname(path)).split("/");
	return { member: parts.at(-1) ?? "?", host: parts.at(-2) ?? "?" };
}
