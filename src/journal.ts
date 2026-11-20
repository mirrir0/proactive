/**
 * What the Router remembers about a conversation, as files in a git repository:
 * `<data>/journal/threads/<threadId>.md` and `scratchpad.md`.
 *
 * Rewritten, never appended: a journal that only grows is a log, and the log exists.
 * Every write is a commit, so "what did it believe at 14:02" is answerable. Git is
 * best effort — a container without it still gets the files.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import type { Logger } from "./telemetry.ts";

const run = promisify(execFile);

/**
 * Characters, not tokens: the harness has no tokenizer. At the cap the write is refused
 * with an instruction to compact, so the model — the only thing that knows what mattered
 * — does the compacting.
 */
export const JOURNAL_MAX_CHARS = 2400;

export interface JournalStoreOptions {
	/** The git working tree: `<data>/journal`. */
	dir: string;
	log: Logger;
	/** Commit author, for the history. */
	author?: { name: string; email: string };
	/** Off for a test that does not want a repository. */
	git?: boolean;
}

export interface JournalWrite {
	/** The conversation's thread id. */
	threadId: string;
	/** What the chat is called, for the commit message a person will read. */
	label?: string;
	text: string;
}

export interface JournalCommit {
	sha: string;
	message: string;
	at: number;
}

export class Journal {
	private readonly dir: string;
	private readonly log: Logger;
	private readonly author: { name: string; email: string };
	private readonly gitEnabled: boolean;
	/** Set once when git is missing, so the log says it once and not per write. */
	private historyOff = false;
	private initialised = false;
	/** Two writes can land in one tick, and git's index takes a lock: the second would be lost. */
	private commitQueue: Promise<void> = Promise.resolve();

	constructor(options: JournalStoreOptions) {
		this.dir = options.dir;
		this.log = options.log;
		this.author = options.author ?? { name: "mir", email: "mir@localhost" };
		this.gitEnabled = options.git ?? true;
	}

	/** Where a conversation's journal lives. */
	pathFor(threadId: string): string {
		return join(this.dir, "threads", `${safeName(threadId)}.md`);
	}

	/** The scratchpad's rendered copy, in the same repository. */
	get scratchpadPath(): string {
		return join(this.dir, "scratchpad.md");
	}

	/** One conversation's journal, or "" when it has never been written. */
	async read(threadId: string): Promise<string> {
		try {
			return (await readFile(this.pathFor(threadId), "utf8")).trim();
		} catch {
			return "";
		}
	}

	/** Returns the reason when refused, so the tool can say something actionable. */
	async write(input: JournalWrite): Promise<{ ok: true; chars: number } | { ok: false; reason: string }> {
		const text = input.text.trim();
		if (text === "") return { ok: false, reason: "an empty journal says nothing; write what matters or leave it alone" };
		if (text.length > JOURNAL_MAX_CHARS) {
			return {
				ok: false,
				reason: `your journal is ${text.length} characters and the limit is ${JOURNAL_MAX_CHARS}. Compact it: keep the decisions, the open questions and the pointers (paths, ids, task ids), and drop the narration. Write the shorter version.`,
			};
		}
		await this.ensureDir();
		await writeFile(this.pathFor(input.threadId), `${text}\n`, "utf8");
		await this.commit(
			`journal: ${input.label ?? input.threadId} (${text.length} chars)`,
			[join("threads", `${safeName(input.threadId)}.md`)],
		);
		return { ok: true, chars: text.length };
	}

	/** The rendered scratchpad, committed like a journal so the history has it too. */
	async writeScratchpad(text: string, summary: string): Promise<void> {
		await this.ensureDir();
		await writeFile(this.scratchpadPath, `${text}\n`, "utf8");
		await this.commit(`scratchpad: ${summary}`, ["scratchpad.md"]);
	}

	/** Recent commits, for a post-mortem — newest first. */
	async history(limit = 20, path?: string): Promise<JournalCommit[]> {
		if (!(await this.gitReady())) return [];
		const args = ["log", `-${Math.max(1, Math.min(200, limit))}`, "--format=%H%x09%at%x09%s"];
		if (path !== undefined) args.push("--", path);
		try {
			const { stdout } = await run("git", args, { cwd: this.dir });
			return stdout
				.split("\n")
				.filter((line) => line.trim() !== "")
				.map((line) => {
					const [sha = "", at = "0", ...rest] = line.split("\t");
					return { sha, at: Number(at) * 1000, message: rest.join("\t") };
				});
		} catch (err) {
			this.log.warn("journal: could not read the history", { error: (err as Error).message });
			return [];
		}
	}

	private async ensureDir(): Promise<void> {
		await mkdir(join(this.dir, "threads"), { recursive: true });
	}

	/** Init the repository once, and only when git is actually there. */
	private async gitReady(): Promise<boolean> {
		if (!this.gitEnabled || this.historyOff) return false;
		if (this.initialised) return true;
		try {
			if (!existsSync(join(this.dir, ".git"))) {
				mkdirSync(this.dir, { recursive: true });
				await run("git", ["init", "-q", "-b", "main"], { cwd: this.dir });
			}
			this.initialised = true;
			return true;
		} catch (err) {
			this.historyOff = true;
			this.log.warn("journal: git is unavailable, so journal history is off (the files are still written)", {
				dir: this.dir,
				error: (err as Error).message,
			});
			return false;
		}
	}

	private commit(message: string, paths: string[]): Promise<void> {
		const next = this.commitQueue.then(() => this.commitNow(message, paths));
		// A failed commit must not poison the queue for the next one.
		this.commitQueue = next.catch(() => {});
		return next;
	}

	private async commitNow(message: string, paths: string[]): Promise<void> {
		if (!(await this.gitReady())) return;
		try {
			await run("git", ["add", "--", ...paths], { cwd: this.dir });
			// `--allow-empty` is not used: an unchanged journal has nothing to record,
			// and a history full of empty commits is a history nobody reads.
			await run(
				"git",
				[
					"-c", `user.name=${this.author.name}`,
					"-c", `user.email=${this.author.email}`,
					"commit",
					"-q",
					"-m",
					message,
					"--",
					...paths,
				],
				{ cwd: this.dir },
			);
		} catch (err) {
			// "nothing to commit" is the common case (a rewrite that changed nothing),
			// and it is not a failure. Anything else is worth a line.
			const said = String((err as { stdout?: string; stderr?: string }).stderr ?? (err as Error).message);
			if (/nothing to commit|no changes added/i.test(said)) return;
			this.log.warn("journal: could not commit", { error: said.trim().split("\n").at(-1) });
		}
	}
}

/** A thread id is a ULID, but a journal path must never be able to escape. */
export function safeName(threadId: string): string {
	const cleaned = threadId.replace(/[^A-Za-z0-9._-]/g, "_");
	return cleaned === "" ? "unknown" : cleaned.slice(0, 128);
}
