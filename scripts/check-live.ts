/**
 * Drive one real conversation through a running brain and print the wire with timings, so
 * "nothing is happening" and "it is thinking" look different. Each step has its own
 * deadline; the overall one is the backstop.
 *
 *     node scripts/check-live.ts --socket <path> --secret <token> --say "…" [--hand space:id]
 *
 * Exit 0 when every expectation holds, 1 when one does not, 2 when the brain is unreachable.
 */

import net from "node:net";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

interface Args {
	socket: string;
	secret: string;
	say: string;
	hand?: string;
	member: string;
	timeoutMs: number;
	db?: string;
}

function parse(argv: string[]): Args {
	const get = (name: string): string | undefined => {
		const index = argv.indexOf(`--${name}`);
		return index >= 0 ? argv[index + 1] : undefined;
	};
	const socket = get("socket");
	const secret = get("secret");
	const say = get("say");
	if (socket === undefined || secret === undefined || say === undefined) {
		console.error("usage: check-live.ts --socket <path> --secret <token> --say <text> [--hand <id>] [--db <path>]");
		process.exit(2);
	}
	const hand = get("hand");
	return {
		socket,
		secret,
		say,
		...(hand === undefined ? {} : { hand }),
		member: get("member") ?? "dev-user",
		timeoutMs: Number(get("timeout-ms") ?? 45_000),
		...(get("db") === undefined ? {} : { db: get("db")! }),
	};
}

function memberToken(secret: string, member: string): string {
	const signature = createHmac("sha256", secret).update(`v1.${member}`).digest("base64url");
	return `v1.${Buffer.from(member, "utf8").toString("base64url")}.${signature}`;
}

const started = Date.now();
const since = (): string => `${String(Date.now() - started).padStart(5)}ms`;

function wire(direction: "<" | ">" | "·", text: string): void {
	console.log(`${since()} ${direction} ${text}`);
}

/** Wait for something, and say what was missing when it does not arrive. */
async function until(what: string, deadlineMs: number, ready: () => boolean): Promise<boolean> {
	const at = Date.now() + deadlineMs;
	while (Date.now() < at) {
		if (ready()) return true;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	console.error(`✖ ${what} did not arrive within ${String(deadlineMs)}ms`);
	return false;
}

function databaseFor(socket: string, explicit?: string): string | undefined {
	if (explicit !== undefined) return explicit;
	const candidate = path.join(path.dirname(socket), "data", "mir.sqlite");
	return fs.existsSync(candidate) ? candidate : undefined;
}

async function main(): Promise<number> {
	const args = parse(process.argv.slice(2));
	if (!fs.existsSync(args.socket)) {
		console.error(`✖ no brain at ${args.socket}`);
		return 2;
	}

	const chatId = `check-${String(Date.now())}`;
	const conn = net.createConnection(args.socket);
	let buffer = "";
	let threadId = "";
	let isReady = false;
	let said = false;
	let answered = 0;
	const kinds: string[] = [];
	const failed: string[] = [];
	const expect = (ok: boolean, message: string): void => {
		if (!ok) failed.push(message);
	};

	conn.on("error", (err) => {
		console.error(`✖ socket: ${err.message}`);
		process.exit(2);
	});

	conn.on("data", (chunk: Buffer) => {
		buffer += chunk.toString();
		let index: number;
		while ((index = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, index);
			buffer = buffer.slice(index + 1);
			let frame: Record<string, unknown>;
			try {
				frame = JSON.parse(line) as Record<string, unknown>;
			} catch {
				wire("<", `(unparseable) ${line.slice(0, 120)}`);
				continue;
			}
			const type = String(frame["type"] ?? "?");
			if (type === "ready") {
				isReady = true;
				const hands = (frame["hands"] as Array<{ endpointId: string; name: string; connected: boolean }> | undefined) ?? [];
				wire("<", `ready — ${String(hands.length)} hand(s): ${hands.map((h) => `${h.name}${h.connected ? "" : " (offline)"}`).join(", ")}`);
				continue;
			}
			if (type === "snapshot") {
				threadId = String(frame["threadId"] ?? "");
				wire("<", `snapshot — thread ${threadId} (${String((frame["entries"] as unknown[] | undefined)?.length ?? 0)} entries)`);
				conn.write(
					`${JSON.stringify({
						type: "say",
						id: "say-1",
						threadId,
						content: args.say,
						...(args.hand === undefined ? {} : { hand: args.hand }),
					})}\n`,
				);
				wire(">", `say${args.hand === undefined ? "" : ` hand=${args.hand}`} — "${args.say}"`);
				continue;
			}
			if (type === "reply") {
				wire("<", `reply ${String(frame["id"])} ok=${String(frame["ok"])}${frame["error"] === undefined ? "" : ` (${String(frame["error"])})`}`);
				if (frame["id"] === "say-1") said = true;
				continue;
			}
			if (type === "entry") {
				const entry = frame["entry"] as Record<string, unknown>;
				const kind = String(entry["kind"]);
				kinds.push(kind);
				if (kind === "text" && entry["role"] === "assistant") answered += 1;
				const detail =
					kind === "text"
						? `${String(entry["role"])}: ${String(entry["text"]).slice(0, 90).replace(/\n/g, " ")}`
						: kind === "app"
							? String(entry["uri"])
							: kind === "tool_call"
								? String(entry["toolName"])
								: kind === "hand"
									? `${String(entry["endpointId"])} ${String(entry["op"])}`
									: kind === "status"
										? `${String(entry["status"])}${entry["note"] === undefined ? "" : ` (${String(entry["note"])})`}`
										: "";
				wire("<", `entry ${kind}${detail === "" ? "" : ` — ${detail}`}`);
				continue;
			}
			if (type === "status") {
				wire("<", `status ${String(frame["status"])}`);
			}
		}
	});

	wire(">", `hello member=${args.member}`);
	conn.write(`${JSON.stringify({ type: "hello", v: 1, token: memberToken(args.secret, args.member), agent: { name: "check-live" } })}\n`);

	if (!(await until("ready", 3_000, () => isReady))) return 2;

	wire(">", `chat ${chatId}`);
	conn.write(`${JSON.stringify({ type: "chat", id: "chat-1", chatId, title: "check-live" })}\n`);

	if (!(await until("snapshot", 3_000, () => threadId !== ""))) return 2;
	if (!(await until("the say reply", 3_000, () => said))) return 1;

	// The Router has to dispatch, and the Worker has to finish. Two steps, two deadlines:
	// "it never started" and "it is still running" are different failures.
	const dbPath = databaseFor(args.socket, args.db);
	if (dbPath === undefined) {
		console.error("✖ no mir.sqlite beside the socket; nothing to check against");
		return 2;
	}

	const readTask = (): Record<string, unknown> | undefined => {
		const db = new DatabaseSync(dbPath, { readOnly: true });
		try {
			return db
				.prepare("SELECT id, title, status, endpoint_id, work_thread_id FROM tasks WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1")
				.get(threadId) as Record<string, unknown> | undefined;
		} finally {
			db.close();
		}
	};

	let task: Record<string, unknown> | undefined;
	// A slow provider takes a while to decide: 15s to the first dispatch was measured on a
	// free model. The deadline is generous on purpose — "the Router never dispatched" is
	// the failure this must catch, not "the Router is slow".
	if (!(await until("a dispatch", 45_000, () => (task = readTask()) !== undefined))) return 1;
	wire("·", `task ${String(task!["id"])} — ${String(task!["status"])} on ${String(task!["endpoint_id"] ?? "auto")}`);

	const settled = await until("the task to finish", args.timeoutMs, () => {
		task = readTask();
		return task?.["status"] === "done" || task?.["status"] === "failed";
	});
	if (!settled) {
		console.error(`  last state: ${String(task?.["status"])} — the Worker is still running or stuck`);
		conn.destroy();
		return 1;
	}
	wire("·", `task ${String(task!["status"])}${task!["status"] === "failed" ? " (it failed)" : ""}`);

	const db = new DatabaseSync(dbPath, { readOnly: true });
	try {
		const count = (threadId: string | undefined, kind: string): number =>
			threadId === undefined
				? 0
				: Number((db.prepare("SELECT COUNT(*) AS n FROM thread_entries WHERE thread_id = ? AND kind = ?").get(threadId, kind) as { n: number }).n);
		const cards = count(threadId, "app");
		const work = task!["work_thread_id"] === null ? undefined : String(task!["work_thread_id"]);
		const handOps = count(work, "hand");
		const toolCalls = count(work, "tool_call");
		const texts = count(threadId, "text");

		console.log("");
		console.log(`  thread    ${threadId}`);
		console.log(`  hand      ${String(task!["endpoint_id"] ?? "(none)")}`);
		console.log(`  cards     ${String(cards)}`);
		console.log(`  hand ops  ${String(handOps)} (of ${String(toolCalls)} tool calls)`);
		console.log(`  texts     ${String(texts)}`);
		console.log("");

		expect(task!["status"] === "done", `the task ended ${String(task!["status"])}`);
		if (args.hand !== undefined) {
			expect(task!["endpoint_id"] === args.hand, `expected hand ${args.hand}, ran on ${String(task!["endpoint_id"])}`);
		}
		expect(cards === 1, `expected one card, found ${String(cards)}`);
		expect(handOps > 0, "no hand call was recorded — the panel would say Machines: none");
		expect(answered > 0, "the person was never answered");
		expect(texts <= 2, `expected the question and the answer, found ${String(texts)} texts`);
	} finally {
		db.close();
	}

	for (const message of failed) console.error(`✖ ${message}`);
	if (failed.length === 0) console.log(`✔ every expectation held in ${since()}`);
	conn.destroy();
	return failed.length === 0 ? 0 : 1;
}

main().then(
	(code) => {
		process.exit(code);
	},
	(err: unknown) => {
		console.error(`✖ ${(err as Error).message}`);
		process.exit(2);
	},
);
