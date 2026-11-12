/**
 * Durable state for the daemon (superagent.md §5.1: compute is stateless,
 * session state must persist).
 *
 * Everything the Router knows that must survive a restart lives here:
 *
 *   - **events**      the trigger log. `id` is the primary key, so re-delivery
 *                     of the same event is idempotent (at-least-once input).
 *                     Events left `pending` by a crash are replayed on boot.
 *   - **tasks**       dispatch → running → done/failed/cancelled, with results.
 *   - **workers**     the live worker registry, so a restarted daemon can adopt
 *                     (or fail) workers instead of forgetting them.
 *   - **threads**     threads plus their many-to-many worker subscriptions.
 *   - **objects**     the spilled-object reference graph behind Chain of Recall.
 *
 * One SQLite file, shared with the per-task state that Workers write
 * (`task_state`, see worker.ts). WAL + a busy timeout because several OS
 * processes hold the same file open.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SpilledObject } from "./context.ts";
import type { Task, TaskStatus, Thread, WorkerInfo } from "./types.ts";
import type { ThreadSummary } from "./threadlog.ts";

export type EventStatus = "pending" | "routed" | "ignored" | "delivered" | "failed";

export interface StoredEvent {
	id: string;
	channelId: string;
	threadId: string;
	from?: string;
	text: string;
	payload?: unknown;
	replyTo?: string;
	receivedAt: number;
	status: EventStatus;
	attempts: number;
	error?: string;
}

export interface EndpointRecord {
	id: string;
	name: string;
	kind: "local" | "remote";
	tokenHash: string | null;
	capabilities: Record<string, unknown>;
	meta?: Record<string, string>;
	lastSeen: number;
	createdAt: number;
	revokedAt?: number;
}

export interface WorkRecord {
	workId: string;
	endpointId: string;
	op: string;
	startedAt: number;
	durationMs: number;
	ok: boolean;
	error?: string;
	truncated?: boolean;
}

export interface StoredWorker extends WorkerInfo {
	channelId?: string;
	replyTo?: string;
}

interface EventRow {
	id: string;
	channel_id: string;
	thread_id: string;
	from_: string | null;
	text: string;
	payload: string | null;
	reply_to: string | null;
	received_at: number;
	status: string;
	attempts: number;
	error: string | null;
}

interface TaskRow {
	id: string;
	title: string;
	description: string;
	thread_id: string | null;
	channel_id: string | null;
	reply_to: string | null;
	status: string;
	worker_id: string | null;
	fast: number;
	result: string | null;
	error: string | null;
	created_at: number;
	updated_at: number;
}

interface EntryRow {
	thread_id: string;
	seq: number;
	at: number;
	kind: string;
	payload: string;
}

interface ThreadRow {
	id: string;
	name: string;
	channel_id: string;
	last_event_at: number;
}

interface WorkerRow {
	id: string;
	task_id: string;
	status: string;
	thread_ids: string;
	channel_id: string | null;
	reply_to: string | null;
	last_heartbeat: number;
	progress: string | null;
}

interface EndpointRow {
	id: string;
	name: string;
	kind: string;
	token_hash: string | null;
	capabilities: string;
	meta: string | null;
	last_seen: number;
	created_at: number;
	revoked_at: number | null;
}

interface WorkRow {
	work_id: string;
	endpoint_id: string;
	op: string;
	started_at: number;
	duration_ms: number;
	ok: number;
	error: string | null;
	truncated: number;
}

interface ObjectRow {
	id: string;
	type: string;
	summary: string;
	ref: string;
	inline_ids: string;
	created_at: number;
}

function parseJson<T>(raw: string | null, fallback: T): T {
	if (!raw) return fallback;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return fallback;
	}
}

export class MirStore {
	private constructor(private readonly db: DatabaseSync) {
		this.migrate();
	}

	/** Open (or create) the daemon state database under `<stateDir>/mir.sqlite`. */
	static open(stateDir: string): MirStore {
		mkdirSync(stateDir, { recursive: true });
		const db = new DatabaseSync(join(stateDir, "mir.sqlite"));
		// WAL: concurrent readers (daemon) + writers (workers). Busy timeout so a
		// short write lock is waited out instead of surfacing SQLITE_BUSY.
		db.exec("PRAGMA journal_mode = WAL");
		db.exec("PRAGMA synchronous = NORMAL");
		db.exec("PRAGMA busy_timeout = 5000");
		db.exec("PRAGMA foreign_keys = ON");
		return new MirStore(db);
	}

	private migrate(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS events (
				id          TEXT PRIMARY KEY,
				channel_id  TEXT NOT NULL,
				thread_id   TEXT NOT NULL,
				from_       TEXT,
				text        TEXT NOT NULL,
				payload     TEXT,
				reply_to    TEXT,
				received_at REAL NOT NULL,
				status      TEXT NOT NULL DEFAULT 'pending',
				attempts    INTEGER NOT NULL DEFAULT 0,
				error       TEXT
			);
			CREATE INDEX IF NOT EXISTS events_status_idx ON events (status, received_at);

			CREATE TABLE IF NOT EXISTS tasks (
				id          TEXT PRIMARY KEY,
				title       TEXT NOT NULL,
				description TEXT NOT NULL,
				thread_id   TEXT,
				channel_id  TEXT,
				reply_to    TEXT,
				status      TEXT NOT NULL,
				worker_id   TEXT,
				fast        INTEGER NOT NULL DEFAULT 0,
				result      TEXT,
				error       TEXT,
				created_at  REAL NOT NULL,
				updated_at  REAL NOT NULL
			);
			CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks (status);

			CREATE TABLE IF NOT EXISTS workers (
				id             TEXT PRIMARY KEY,
				task_id        TEXT NOT NULL,
				status         TEXT NOT NULL,
				thread_ids     TEXT NOT NULL DEFAULT '[]',
				channel_id     TEXT,
				reply_to       TEXT,
				last_heartbeat REAL NOT NULL,
				progress       TEXT
			);

			CREATE TABLE IF NOT EXISTS threads (
				id            TEXT PRIMARY KEY,
				name          TEXT NOT NULL,
				channel_id    TEXT NOT NULL,
				last_event_at REAL NOT NULL,
				status        TEXT NOT NULL DEFAULT 'idle',
				seq           INTEGER NOT NULL DEFAULT 0
			);

			-- One thread's log: append-only, sequenced per thread. The entry's own
			-- fields live in the payload column, so an entry shape can grow without
			-- a migration; kind is lifted out because every reader filters on it.
			CREATE TABLE IF NOT EXISTS thread_entries (
				thread_id TEXT NOT NULL,
				seq       INTEGER NOT NULL,
				at        REAL NOT NULL,
				kind      TEXT NOT NULL,
				payload   TEXT NOT NULL,
				PRIMARY KEY (thread_id, seq)
			);

			CREATE TABLE IF NOT EXISTS subscriptions (
				thread_id TEXT NOT NULL,
				worker_id TEXT NOT NULL,
				PRIMARY KEY (thread_id, worker_id)
			);
			CREATE INDEX IF NOT EXISTS subscriptions_worker_idx ON subscriptions (worker_id);

			CREATE TABLE IF NOT EXISTS objects (
				id         TEXT PRIMARY KEY,
				type       TEXT NOT NULL,
				summary    TEXT NOT NULL,
				ref        TEXT NOT NULL,
				inline_ids TEXT NOT NULL DEFAULT '[]',
				created_at REAL NOT NULL
			);
			CREATE INDEX IF NOT EXISTS objects_type_idx ON objects (type, created_at);

			CREATE TABLE IF NOT EXISTS endpoints (
				id           TEXT PRIMARY KEY,
				name         TEXT NOT NULL,
				kind         TEXT NOT NULL DEFAULT 'remote',
				token_hash   TEXT,
				capabilities TEXT NOT NULL DEFAULT '{}',
				meta         TEXT,
				last_seen    REAL NOT NULL DEFAULT 0,
				created_at   REAL NOT NULL,
				revoked_at   REAL
			);

			CREATE TABLE IF NOT EXISTS work_items (
				work_id     TEXT PRIMARY KEY,
				endpoint_id TEXT NOT NULL,
				op          TEXT NOT NULL,
				started_at  REAL NOT NULL,
				duration_ms REAL NOT NULL,
				ok          INTEGER NOT NULL,
				error       TEXT,
				truncated   INTEGER NOT NULL DEFAULT 0
			);
			CREATE INDEX IF NOT EXISTS work_items_endpoint_idx ON work_items (endpoint_id, started_at);
		`);
		// `CREATE TABLE IF NOT EXISTS` leaves a database made by an earlier build
		// alone, so a column added to `threads` is added here. One statement per
		// column, skipped when it is already there.
		this.ensureColumn("threads", "chat_id", "TEXT");
		this.ensureColumn("threads", "status", "TEXT NOT NULL DEFAULT 'idle'");
		this.ensureColumn("threads", "seq", "INTEGER NOT NULL DEFAULT 0");
	}

	/** Add `column` to `table` when an older database does not have it. */
	private ensureColumn(table: string, column: string, definition: string): void {
		const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
		if (columns.some((entry) => entry.name === column)) return;
		this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
	}

	// ----- events (trigger log + dedupe) -----

	/**
	 * Append an event. Returns false when the id was already seen — that is the
	 * dedupe path, and the caller must not process the event again.
	 */
	insertEvent(event: StoredEvent): boolean {
		const stmt = this.db.prepare(
			`INSERT OR IGNORE INTO events
			 (id, channel_id, thread_id, from_, text, payload, reply_to, received_at, status, attempts, error)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		const res = stmt.run(
			event.id,
			event.channelId,
			event.threadId,
			event.from ?? null,
			event.text,
			event.payload === undefined ? null : JSON.stringify(event.payload),
			event.replyTo ?? null,
			event.receivedAt,
			event.status,
			event.attempts,
			event.error ?? null,
		);
		return Number(res.changes) > 0;
	}

	markEvent(id: string, status: EventStatus, error?: string): void {
		this.db
			.prepare(`UPDATE events SET status = ?, error = ? WHERE id = ?`)
			.run(status, error ?? null, id);
	}

	bumpEventAttempts(id: string): void {
		this.db.prepare(`UPDATE events SET attempts = attempts + 1 WHERE id = ?`).run(id);
	}

	getEvent(id: string): StoredEvent | undefined {
		const row = this.db.prepare(`SELECT * FROM events WHERE id = ?`).get(id) as EventRow | undefined;
		return row ? rowToEvent(row) : undefined;
	}

	/** Events left unprocessed by a crash, oldest first. */
	listPendingEvents(limit = 200): StoredEvent[] {
		const rows = this.db
			.prepare(`SELECT * FROM events WHERE status = 'pending' ORDER BY received_at ASC LIMIT ?`)
			.all(limit) as unknown as EventRow[];
		return rows.map(rowToEvent);
	}

	/** Drop terminal events older than `olderThanMs`. Returns rows deleted. */
	pruneEvents(olderThanMs: number, now = Date.now()): number {
		const res = this.db
			.prepare(`DELETE FROM events WHERE status != 'pending' AND received_at < ?`)
			.run(now - olderThanMs);
		return Number(res.changes);
	}

	// ----- tasks -----

	upsertTask(task: Task): void {
		this.db
			.prepare(
				`INSERT INTO tasks
				 (id, title, description, thread_id, channel_id, reply_to, status, worker_id, fast, result, error, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET
					title = excluded.title,
					description = excluded.description,
					thread_id = excluded.thread_id,
					channel_id = excluded.channel_id,
					reply_to = excluded.reply_to,
					status = excluded.status,
					worker_id = excluded.worker_id,
					fast = excluded.fast,
					result = excluded.result,
					error = excluded.error,
					updated_at = excluded.updated_at`,
			)
			.run(
				task.id,
				task.title,
				task.description,
				task.threadId ?? null,
				task.channelId ?? null,
				task.replyTo ?? null,
				task.status,
				task.workerId ?? null,
				task.fast ? 1 : 0,
				task.result ?? null,
				task.error ?? null,
				task.createdAt,
				task.updatedAt,
			);
	}

	getTask(id: string): Task | undefined {
		const row = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as TaskRow | undefined;
		return row ? rowToTask(row) : undefined;
	}

	listTasks(): Task[] {
		const rows = this.db.prepare(`SELECT * FROM tasks ORDER BY created_at ASC`).all() as unknown as TaskRow[];
		return rows.map(rowToTask);
	}

	listTasksByStatus(status: TaskStatus): Task[] {
		const rows = this.db
			.prepare(`SELECT * FROM tasks WHERE status = ? ORDER BY created_at ASC`)
			.all(status) as unknown as TaskRow[];
		return rows.map(rowToTask);
	}

	// ----- workers -----

	upsertWorker(worker: StoredWorker): void {
		this.db
			.prepare(
				`INSERT INTO workers (id, task_id, status, thread_ids, channel_id, reply_to, last_heartbeat, progress)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET
					task_id = excluded.task_id,
					status = excluded.status,
					thread_ids = excluded.thread_ids,
					channel_id = excluded.channel_id,
					reply_to = excluded.reply_to,
					last_heartbeat = excluded.last_heartbeat,
					progress = excluded.progress`,
			)
			.run(
				worker.id,
				worker.taskId,
				worker.status,
				JSON.stringify(worker.threadIds),
				worker.channelId ?? null,
				worker.replyTo ?? null,
				worker.lastHeartbeat,
				worker.progress ?? null,
			);
	}

	deleteWorker(id: string): void {
		this.db.prepare(`DELETE FROM workers WHERE id = ?`).run(id);
	}

	listWorkers(): StoredWorker[] {
		const rows = this.db.prepare(`SELECT * FROM workers`).all() as unknown as WorkerRow[];
		return rows.map((r) => ({
			id: r.id,
			taskId: r.task_id,
			status: r.status as WorkerInfo["status"],
			threadIds: parseJson<string[]>(r.thread_ids, []),
			channelId: r.channel_id ?? undefined,
			replyTo: r.reply_to ?? undefined,
			lastHeartbeat: r.last_heartbeat,
			progress: r.progress ?? undefined,
		}));
	}

	// ----- threads + subscriptions -----

	upsertThread(thread: Thread): void {
		this.db
			.prepare(
				`INSERT INTO threads (id, name, channel_id, last_event_at) VALUES (?, ?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET
					name = excluded.name,
					channel_id = excluded.channel_id,
					last_event_at = excluded.last_event_at`,
			)
			.run(thread.id, thread.name, thread.channelId, thread.lastEventAt);
	}

	getThread(id: string): Thread | undefined {
		const row = this.db.prepare(`SELECT * FROM threads WHERE id = ?`).get(id) as ThreadRow | undefined;
		if (!row) return undefined;
		return {
			id: row.id,
			name: row.name,
			channelId: row.channel_id,
			lastEventAt: row.last_event_at,
			subscriberWorkerIds: this.listSubscribers(row.id),
		};
	}

	listThreads(): Thread[] {
		const rows = this.db.prepare(`SELECT * FROM threads ORDER BY last_event_at DESC`).all() as unknown as ThreadRow[];
		return rows.map((row) => ({
			id: row.id,
			name: row.name,
			channelId: row.channel_id,
			lastEventAt: row.last_event_at,
			subscriberWorkerIds: this.listSubscribers(row.id),
		}));
	}

	/**
	 * Append one entry and return its sequence.
	 *
	 * The bump and the insert are one transaction, so the sequence a writer gets
	 * back is the one its row carries: two writers cannot both be told `n`.
	 */
	appendThreadEntry(threadId: string, at: number, kind: string, payload: string): number {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.db
				.prepare(
					`INSERT INTO threads (id, name, channel_id, last_event_at, status, seq)
					 VALUES (?, ?, ?, ?, 'idle', 1)
					 ON CONFLICT(id) DO UPDATE SET seq = seq + 1, last_event_at = excluded.last_event_at`,
				)
				.run(threadId, threadId, "local", at);
			const row = this.db.prepare(`SELECT seq FROM threads WHERE id = ?`).get(threadId) as
				| { seq: number }
				| undefined;
			const seq = row?.seq ?? 1;
			this.db
				.prepare(`INSERT INTO thread_entries (thread_id, seq, at, kind, payload) VALUES (?, ?, ?, ?, ?)`)
				.run(threadId, seq, at, kind, payload);
			this.db.exec("COMMIT");
			return seq;
		} catch (err) {
			this.db.exec("ROLLBACK");
			throw err;
		}
	}

	listThreadEntries(threadId: string, since: number, limit: number): EntryRow[] {
		return this.db
			.prepare(
				`SELECT * FROM thread_entries WHERE thread_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
			)
			.all(threadId, since, limit) as unknown as EntryRow[];
	}

	/** Keep the newest `keep` entries of one thread. */
	pruneThreadEntries(threadId: string, keep: number): void {
		this.db
			.prepare(
				`DELETE FROM thread_entries WHERE thread_id = ?
				   AND seq <= (SELECT seq FROM thread_entries WHERE thread_id = ?
				                ORDER BY seq DESC LIMIT 1 OFFSET ?)`,
			)
			.run(threadId, threadId, keep);
	}

	setThreadStatus(threadId: string, status: string): void {
		this.db
			.prepare(
				`INSERT INTO threads (id, name, channel_id, last_event_at, status, seq)
				 VALUES (?, ?, ?, ?, ?, 0)
				 ON CONFLICT(id) DO UPDATE SET status = excluded.status`,
			)
			.run(threadId, threadId, "local", Date.now(), status);
	}

	getThreadStatus(threadId: string): "running" | "waiting" | "idle" | "done" | "failed" | "stopped" {
		const row = this.db.prepare(`SELECT status FROM threads WHERE id = ?`).get(threadId) as
			| { status: string }
			| undefined;
		const status = row?.status;
		if (status === "running" || status === "waiting" || status === "idle" || status === "done" || status === "failed" || status === "stopped") {
			return status;
		}
		return "idle";
	}

	/**
	 * The thread a chat shows, minting one the first time the chat is seen.
	 *
	 * A chat is a window onto a thread, so the mapping has to live somewhere and
	 * survive a restart. It lives here, with the thread: the product's chat row
	 * carries no brain id, which is what keeps the brain replaceable.
	 */
	/** The chat a thread shows, if it shows one. */
	chatForThread(threadId: string): string | undefined {
		const row = this.db.prepare(`SELECT chat_id FROM threads WHERE id = ?`).get(threadId) as
			| { chat_id: string | null }
			| undefined;
		return row?.chat_id ?? undefined;
	}

	threadForChat(chatId: string, mint: () => string): string {
		const row = this.db.prepare(`SELECT id FROM threads WHERE chat_id = ?`).get(chatId) as
			| { id: string }
			| undefined;
		if (row !== undefined) return row.id;
		const id = mint();
		this.db
			.prepare(
				`INSERT INTO threads (id, name, channel_id, last_event_at, status, seq, chat_id)
				 VALUES (?, ?, 'anomalous', ?, 'idle', 0, ?)`,
			)
			.run(id, chatId, Date.now(), chatId);
		return id;
	}

	listThreadSummaries(limit: number): ThreadSummary[] {
		const rows = this.db
			.prepare(`SELECT * FROM threads ORDER BY last_event_at DESC LIMIT ?`)
			.all(limit) as unknown as Array<ThreadRow & { status: string; seq: number }>;
		return rows.map((row) => ({
			id: row.id,
			name: row.name,
			channelId: row.channel_id,
			status: row.status as ThreadSummary["status"],
			seq: row.seq,
			lastEventAt: row.last_event_at,
		}));
	}

	subscribe(threadId: string, workerId: string): void {
		this.db
			.prepare(`INSERT OR IGNORE INTO subscriptions (thread_id, worker_id) VALUES (?, ?)`)
			.run(threadId, workerId);
	}

	unsubscribe(threadId: string, workerId: string): void {
		this.db
			.prepare(`DELETE FROM subscriptions WHERE thread_id = ? AND worker_id = ?`)
			.run(threadId, workerId);
	}

	unsubscribeWorker(workerId: string): void {
		this.db.prepare(`DELETE FROM subscriptions WHERE worker_id = ?`).run(workerId);
	}

	listSubscribers(threadId: string): string[] {
		const rows = this.db
			.prepare(`SELECT worker_id FROM subscriptions WHERE thread_id = ? ORDER BY worker_id`)
			.all(threadId) as { worker_id: string }[];
		return rows.map((r) => r.worker_id);
	}

	listWorkerSubscriptions(workerId: string): string[] {
		const rows = this.db
			.prepare(`SELECT thread_id FROM subscriptions WHERE worker_id = ? ORDER BY thread_id`)
			.all(workerId) as { thread_id: string }[];
		return rows.map((r) => r.thread_id);
	}

	// ----- hands (endpoints) -----

	/** Register a hand and its token hash (CLI: `mir hands add`). */
	createEndpoint(input: {
		id: string;
		name: string;
		tokenHash: string | null;
		kind?: "local" | "remote";
		createdAt?: number;
	}): void {
		this.db
			.prepare(
				`INSERT INTO endpoints (id, name, kind, token_hash, capabilities, meta, last_seen, created_at)
				 VALUES (?, ?, ?, ?, '{}', NULL, 0, ?)
				 ON CONFLICT(id) DO UPDATE SET
					name = excluded.name,
					kind = excluded.kind,
					token_hash = excluded.token_hash,
					revoked_at = NULL`,
			)
			.run(input.id, input.name, input.kind ?? "remote", input.tokenHash, input.createdAt ?? Date.now());
	}

	getEndpoint(id: string): EndpointRecord | undefined {
		const row = this.db.prepare(`SELECT * FROM endpoints WHERE id = ?`).get(id) as unknown as
			| EndpointRow
			| undefined;
		return row ? rowToEndpoint(row) : undefined;
	}

	listEndpoints(): EndpointRecord[] {
		const rows = this.db
			.prepare(`SELECT * FROM endpoints ORDER BY created_at ASC`)
			.all() as unknown as EndpointRow[];
		return rows.map(rowToEndpoint);
	}

	/** Runtime presence update. Never touches the token hash. */
	upsertEndpoint(input: {
		id: string;
		name: string;
		kind: "local" | "remote";
		capabilities: object;
		lastSeen: number;
		meta?: Record<string, string>;
	}): void {
		this.db
			.prepare(
				`INSERT INTO endpoints (id, name, kind, token_hash, capabilities, meta, last_seen, created_at)
				 VALUES (?, ?, ?, NULL, ?, ?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET
					name = excluded.name,
					kind = excluded.kind,
					capabilities = excluded.capabilities,
					meta = excluded.meta,
					last_seen = excluded.last_seen`,
			)
			.run(
				input.id,
				input.name,
				input.kind,
				JSON.stringify(input.capabilities ?? {}),
				input.meta ? JSON.stringify(input.meta) : null,
				input.lastSeen,
				Date.now(),
			);
	}

	revokeEndpoint(id: string, now = Date.now()): boolean {
		const res = this.db.prepare(`UPDATE endpoints SET revoked_at = ? WHERE id = ?`).run(now, id);
		return Number(res.changes) > 0;
	}

	deleteEndpoint(id: string): boolean {
		const res = this.db.prepare(`DELETE FROM endpoints WHERE id = ?`).run(id);
		return Number(res.changes) > 0;
	}

	// ----- work audit -----

	recordWork(input: WorkRecord): void {
		this.db
			.prepare(
				`INSERT INTO work_items (work_id, endpoint_id, op, started_at, duration_ms, ok, error, truncated)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(work_id) DO UPDATE SET
					duration_ms = excluded.duration_ms,
					ok = excluded.ok,
					error = excluded.error,
					truncated = excluded.truncated`,
			)
			.run(
				input.workId,
				input.endpointId,
				input.op,
				input.startedAt,
				input.durationMs,
				input.ok ? 1 : 0,
				input.error ?? null,
				input.truncated ? 1 : 0,
			);
	}

	listWork(limit = 50): WorkRecord[] {
		const rows = this.db
			.prepare(`SELECT * FROM work_items ORDER BY started_at DESC LIMIT ?`)
			.all(limit) as unknown as WorkRow[];
		return rows.map((row) => ({
			workId: row.work_id,
			endpointId: row.endpoint_id,
			op: row.op,
			startedAt: row.started_at,
			durationMs: row.duration_ms,
			ok: row.ok === 1,
			error: row.error ?? undefined,
			truncated: row.truncated === 1,
		}));
	}

	pruneWork(olderThanMs: number, now = Date.now()): number {
		const res = this.db.prepare(`DELETE FROM work_items WHERE started_at < ?`).run(now - olderThanMs);
		return Number(res.changes);
	}

	// ----- spilled objects (Chain of Recall) -----

	putObject(obj: SpilledObject, createdAt = Date.now()): void {
		this.db
			.prepare(
				`INSERT INTO objects (id, type, summary, ref, inline_ids, created_at)
				 VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET
					type = excluded.type,
					summary = excluded.summary,
					ref = excluded.ref,
					inline_ids = excluded.inline_ids`,
			)
			.run(obj.id, obj.type, obj.summary, obj.ref, JSON.stringify(obj.inlineIds), createdAt);
	}

	getObject(id: string): SpilledObject | undefined {
		const row = this.db.prepare(`SELECT * FROM objects WHERE id = ?`).get(id) as ObjectRow | undefined;
		return row ? rowToObject(row) : undefined;
	}

	searchObjects(query: string, type?: string, limit = 10): SpilledObject[] {
		const like = `%${query.replace(/[%_]/g, (m) => `\\${m}`)}%`;
		const rows = type
			? (this.db
					.prepare(
						`SELECT * FROM objects WHERE type = ? AND (summary LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\')
						 ORDER BY created_at DESC LIMIT ?`,
					)
					.all(type, like, like, limit) as unknown as ObjectRow[])
			: (this.db
					.prepare(
						`SELECT * FROM objects WHERE summary LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\'
						 ORDER BY created_at DESC LIMIT ?`,
					)
					.all(like, like, limit) as unknown as ObjectRow[]);
		return rows.map(rowToObject);
	}

	listObjectsByType(type: string, limit = 20): SpilledObject[] {
		const rows = this.db
			.prepare(`SELECT * FROM objects WHERE type = ? ORDER BY created_at DESC LIMIT ?`)
			.all(type, limit) as unknown as ObjectRow[];
		return rows.map(rowToObject);
	}

	/** Keep the newest `keep` objects overall; drop the rest. Returns rows deleted. */
	pruneObjects(keep: number): number {
		const res = this.db
			.prepare(
				`DELETE FROM objects WHERE id NOT IN (
					SELECT id FROM objects ORDER BY created_at DESC LIMIT ?
				)`,
			)
			.run(keep);
		return Number(res.changes);
	}

	/** Cheap counts for metrics/health. */
	counts(): { events: number; tasks: number; workers: number; threads: number; objects: number } {
		const one = (sql: string): number => {
			const row = this.db.prepare(sql).get() as { n: number } | undefined;
			return row?.n ?? 0;
		};
		return {
			events: one(`SELECT COUNT(*) AS n FROM events`),
			tasks: one(`SELECT COUNT(*) AS n FROM tasks`),
			workers: one(`SELECT COUNT(*) AS n FROM workers`),
			threads: one(`SELECT COUNT(*) AS n FROM threads`),
			objects: one(`SELECT COUNT(*) AS n FROM objects`),
		};
	}

	close(): void {
		try {
			this.db.close();
		} catch {
			/* already closed */
		}
	}
}

function rowToEvent(row: EventRow): StoredEvent {
	return {
		id: row.id,
		channelId: row.channel_id,
		threadId: row.thread_id,
		from: row.from_ ?? undefined,
		text: row.text,
		payload: row.payload ? parseJson<unknown>(row.payload, undefined) : undefined,
		replyTo: row.reply_to ?? undefined,
		receivedAt: row.received_at,
		status: row.status as EventStatus,
		attempts: row.attempts,
		error: row.error ?? undefined,
	};
}

function rowToTask(row: TaskRow): Task {
	return {
		id: row.id,
		title: row.title,
		description: row.description,
		threadId: row.thread_id ?? undefined,
		channelId: row.channel_id ?? undefined,
		replyTo: row.reply_to ?? undefined,
		status: row.status as TaskStatus,
		workerId: row.worker_id ?? undefined,
		fast: row.fast === 1,
		result: row.result ?? undefined,
		error: row.error ?? undefined,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function rowToEndpoint(row: EndpointRow): EndpointRecord {
	return {
		id: row.id,
		name: row.name,
		kind: row.kind === "local" ? "local" : "remote",
		tokenHash: row.token_hash,
		capabilities: parseJson<Record<string, unknown>>(row.capabilities, {}),
		meta: row.meta ? parseJson<Record<string, string>>(row.meta, {}) : undefined,
		lastSeen: row.last_seen,
		createdAt: row.created_at,
		revokedAt: row.revoked_at ?? undefined,
	};
}

function rowToObject(row: ObjectRow): SpilledObject {
	return {
		id: row.id,
		type: row.type as SpilledObject["type"],
		summary: row.summary,
		ref: row.ref,
		inlineIds: parseJson<string[]>(row.inline_ids, []),
	};
}
