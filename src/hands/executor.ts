/**
 * The thing a hand actually does.
 *
 * One implementation, used by the installable endpoint daemon *and* by the
 * daemon's built-in local hand, so a task behaves identically whether it runs on
 * someone's laptop or next to the Router.
 *
 * Guarantees this module provides to the rest of the system:
 *
 *   - a command that hangs is killed (process group, TERM then KILL);
 *   - a command that floods is capped, not buffered forever;
 *   - a path that escapes the roots is refused before it is touched;
 *   - the child never sees a secret-shaped env var, and secrets are redacted
 *     from everything that leaves the hand;
 *   - failure is a *result* (`ok: false`), never a thrown exception across the
 *     wire, so the brain sees a tool error and can decide what to do.
 */

import { spawn } from "node:child_process";
import { readFile, writeFile, readdir, stat, mkdir } from "node:fs/promises";
import path from "node:path";
import type {
	EditInput,
	ExecInput,
	GitInput,
	HandCapabilities,
	HandOp,
	HandPolicy,
	HandResult,
	ListDirInput,
	ReadFileInput,
	ShellInput,
	StatInput,
	StreamName,
	WriteFileInput,
} from "./protocol.ts";
import {
	HandPolicyError,
	filteredEnv,
	isPathDenied,
	resolveInRoots,
	validateExec,
	validateShell,
} from "./policy.ts";
import type { SandboxWrapper } from "./sandbox.ts";
import type { SecretRegistry } from "../security.ts";
import type { Logger } from "../telemetry.ts";

export interface ExecutorRunContext {
	signal?: AbortSignal;
	onChunk?: (stream: StreamName, data: string) => void;
	maxOutputBytes?: number;
}

export interface HandExecutorOptions {
	policy: HandPolicy;
	capabilities: HandCapabilities;
	secrets: SecretRegistry;
	log: Logger;
	/**
	 * The OS-level sandbox for `exec`. Required when `policy.sandbox === "srt"`:
	 * a hand that says it is sandboxed but is not must refuse to run.
	 */
	sandbox?: SandboxWrapper;
}

/** A process a hand started and does not wait for. */
interface RunningJob {
	jobId: string;
	argv: string[];
	pid: number | undefined;
	startedAt: number;
	child: import("node:child_process").ChildProcess;
	stdout: string;
	stderr: string;
	exited: boolean;
	exitCode?: number | null;
	signal?: string | null;
	killTree: (signal: NodeJS.Signals) => void;
}

/** How much of a background job's output is kept for a later read. */
const JOB_OUTPUT_CAP = 64 * 1024;

export class HandExecutor {
	private running = 0;
	/**
	 * Commands started with `background: true`, still owned by this hand.
	 *
	 * They outlive the call that started them — that is the point — and they die
	 * with the hand, so a brain that stops does not leave a server on a port.
	 */
	private readonly jobs = new Map<string, RunningJob>();

	constructor(private readonly options: HandExecutorOptions) {}

	get load(): number {
		return this.running;
	}

	get policy(): HandPolicy {
		return this.options.policy;
	}

	get capabilities(): HandCapabilities {
		return this.options.capabilities;
	}

	/** Run one unit of work. Never throws; policy violations become results. */
	async run(op: HandOp, input: unknown, ctx: ExecutorRunContext = {}): Promise<HandResult> {
		const started = Date.now();
		const cap = this.options.policy.maxConcurrent ?? 0;
		if (cap > 0 && this.running >= cap) {
			return {
				ok: false,
				error: `hand is at capacity (${String(cap)} concurrent)`,
				durationMs: 0,
			};
		}
		this.running++;
		try {
			switch (op) {
				case "exec":
					return await this.exec(input as ExecInput, ctx, started);
				case "shell":
					return await this.shell(input as ShellInput, ctx, started);
				case "git":
					return await this.git(input as GitInput, ctx, started);
				case "jobs":
					return this.listJobs(started);
				case "jobOutput":
					return this.jobOutput(input as { jobId?: string; stream?: "stdout" | "stderr" }, started);
				case "killJob":
					return this.killJob(input as { jobId?: string }, started);
				case "readFile":
					return await this.read(input as ReadFileInput, started);
				case "writeFile":
					return await this.write(input as WriteFileInput, started);
				case "editFile":
					return await this.edit(input as EditInput, started);
				case "listDir":
					return await this.list(input as ListDirInput, started);
				case "stat":
					return await this.statPath(input as StatInput, started);
				default:
					return { ok: false, error: `unsupported op: ${String(op)}`, durationMs: 0 };
			}
		} catch (err) {
			const message =
				err instanceof HandPolicyError ? `${err.code}: ${err.message}` : (err as Error).message;
			this.options.log.warn("hand op failed", { op, error: message });
			return { ok: false, error: message, durationMs: Date.now() - started };
		} finally {
			this.running--;
		}
	}

	private redact(text: string): string {
		return this.options.secrets.redact(text);
	}

	/**
	 * A command string, through the hand's shell. Validated as a shell op first —
	 * which is where the `sh` grant and the `shell` capability are checked — then
	 * run by the same code as `exec`, so timeouts, output caps, redaction and the
	 * sandbox are identical.
	 */
	private async shell(
		input: ShellInput,
		ctx: ExecutorRunContext,
		started: number,
	): Promise<HandResult> {
		const { argv, cwd } = validateShell(input, this.options.policy, this.options.capabilities);
		return await this.exec(
			{ argv, cwd, timeoutMs: input.timeoutMs, env: input.env },
			ctx,
			started,
		);
	}

	private async exec(
		input: ExecInput,
		ctx: ExecutorRunContext,
		started: number,
	): Promise<HandResult> {
		const policy = this.options.policy;
		const { argv, shell, cwd } = validateExec(input, policy, this.options.capabilities);
		const timeoutMs = Math.min(
			Math.max(1000, input.timeoutMs ?? policy.defaultTimeoutMs),
			policy.maxTimeoutMs,
		);
		const cap = Math.min(ctx.maxOutputBytes ?? policy.maxOutputBytes, policy.maxOutputBytes);

		const sandbox = this.options.sandbox;
		if (policy.sandbox !== "none" && !sandbox) {
			// A hand that says it is sandboxed and is not must refuse: the difference
			// between "confined to this folder" and "whatever the account can reach" is
			// not one to discover later.
			return {
				ok: false,
				error: `sandbox-required: this hand is configured for ${policy.sandbox} execution but no sandbox is initialized`,
				durationMs: Date.now() - started,
			};
		}

		const rawArgv = shell ? ["/bin/sh", "-c", argv.join(" ")] : argv;
		const baseEnv = filteredEnv(policy, input.env);
		const detached = process.platform !== "win32";
		let timedOut = false;
		const commandId = `exec-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

		// The allowlist decides which program may start; the sandbox decides what
		// the whole process tree may read, write and reach.
		let file = rawArgv[0]!;
		let args = rawArgv.slice(1);
		let env: NodeJS.ProcessEnv = baseEnv;
		if (sandbox) {
			try {
				const wrapped = await sandbox.wrap(rawArgv, { cwd, commandId });
				file = wrapped.argv[0]!;
				args = wrapped.argv.slice(1);
				// On POSIX the proxy env is baked into the wrapped command, so the
				// filtered env stays authoritative. Elsewhere the sandbox owns it.
				env =
					process.platform === "win32"
						? { ...wrapped.env, ...baseEnv }
						: { ...baseEnv, NODE_USE_ENV_PROXY: "1" };
			} catch (err) {
				sandbox.cleanup();
				return {
					ok: false,
					error: `sandbox wrap failed: ${(err as Error).message}`,
					durationMs: Date.now() - started,
				};
			}
		}

		this.options.log.info("hand exec", {
			file: path.basename(rawArgv[0]!),
			args: rawArgv.slice(1, 7),
			cwd,
			shell,
			sandbox: sandbox?.kind ?? "none",
		});

		if (input.background === true) {
			return this.startBackground({
				argv: rawArgv,
				cwd: cwd ?? policy.roots[0] ?? process.cwd(),
				env,
				commandId,
				started,
			});
		}

		return await new Promise<HandResult>((resolve) => {
			let stdout = "";
			let stderr = "";
			let bytes = 0;
			let truncated = false;
			let settled = false;
			let killTimer: NodeJS.Timeout | undefined;
			let hardKillTimer: NodeJS.Timeout | undefined;

			const child = spawn(file, args, {
				cwd,
				env,
				shell: false,
				detached,
				stdio: ["ignore", "pipe", "pipe"],
			});

			const killTree = (signal: NodeJS.Signals) => {
				try {
					if (detached && child.pid) process.kill(-child.pid, signal);
					else child.kill(signal);
				} catch {
					try {
						child.kill(signal);
					} catch {
						/* already gone */
					}
				}
			};

			const finish = (result: Omit<HandResult, "durationMs">) => {
				if (settled) return;
				settled = true;
				if (killTimer) clearTimeout(killTimer);
				if (hardKillTimer) clearTimeout(hardKillTimer);
				ctx.signal?.removeEventListener("abort", onAbort);
				resolve({ ...result, durationMs: Date.now() - started });
			};

			const onAbort = () => {
				killTree("SIGTERM");
				finish({
					ok: false,
					error: "cancelled",
					stdout: this.redact(stdout),
					stderr: this.redact(stderr),
					truncated,
					signal: "SIGTERM",
				});
			};
			ctx.signal?.addEventListener("abort", onAbort, { once: true });

			const collect = (stream: StreamName, chunk: Buffer) => {
				const text = chunk.toString("utf8");
				if (bytes >= cap) {
					truncated = true;
					return;
				}
				const remaining = cap - bytes;
				const slice = text.length > remaining ? text.slice(0, remaining) : text;
				bytes += Buffer.byteLength(slice);
				if (stream === "stdout") stdout += slice;
				else stderr += slice;
				if (slice.length < text.length) truncated = true;
				ctx.onChunk?.(stream, this.redact(slice));
			};

			child.stdout?.on("data", (chunk: Buffer) => collect("stdout", chunk));
			child.stderr?.on("data", (chunk: Buffer) => collect("stderr", chunk));

			child.on("error", (err) => {
				finish({ ok: false, error: `spawn failed: ${err.message}` });
			});

			child.on("close", (code, signal) => {
				// Attribute sandbox denials to this invocation: "EPERM" alone reads as
				// a bug, "blocked by sandbox: write outside the allowed paths" reads as
				// policy the model can act on.
				let stderrText = stderr;
				let violations: Array<{ line: string }> = [];
				if (sandbox) {
					try {
						// Annotation and the violation store are best-effort: on macOS the
						// store is fed by an asynchronous log tap, so it may lag this exit.
						stderrText = sandbox.annotate(commandId, stderr);
						violations = sandbox.violations(commandId).map((violation) => ({ line: violation.line }));
					} finally {
						sandbox.cleanup();
					}
				}
				// Decide "blocked" from what the OS told the child, not from the tap:
				// an EPERM under a sandbox is a policy denial, and the model must be
				// able to tell it apart from a bug.
				const osDenial =
					Boolean(sandbox) &&
					code !== 0 &&
					/operation not permitted|permission denied|read-only file system|\bEPERM\b|\bEACCES\b|blocked by/i.test(
						stderr,
					);
				const blocked = osDenial || violations.length > 0;
				finish({
					ok: code === 0,
					exitCode: code,
					signal: signal ?? null,
					stdout: this.redact(stdout),
					stderr: this.redact(stderrText),
					truncated,
					blocked,
					...(timedOut ? { timedOut: true } : {}),
					...(violations.length
						? { data: { sandboxViolations: violations.slice(0, 5) } }
						: {}),
					error: timedOut
						? `timed out after ${String(Math.round(timeoutMs / 1000))}s and was stopped`
						: code === 0
							? undefined
							: blocked
								? `blocked by sandbox policy: ${violations[0]?.line?.slice(0, 300) ?? "denied"}`
								: `exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}`,
				});
			});

			killTimer = setTimeout(() => {
				timedOut = true;
				this.options.log.warn("hand exec timed out; terminating", { timeoutMs });
				killTree("SIGTERM");
				hardKillTimer = setTimeout(() => killTree("SIGKILL"), 2000);
			}, timeoutMs);
			killTimer.unref?.();
		});
	}

	/**
	 * Start a command and return at once.
	 *
	 * Its output is kept in a capped buffer rather than streamed: a server writes
	 * forever, and a caller that has already been answered is not reading. The job
	 * belongs to this hand, so `jobs` and `jobOutput` can find it later and a hand
	 * that closes takes it with it.
	 */
	private startBackground(input: {
		argv: string[];
		cwd: string;
		env: NodeJS.ProcessEnv;
		commandId: string;
		started: number;
	}): HandResult {
		const detached = process.platform !== "win32";
		const jobId = input.commandId;
		const child = spawn(input.argv[0]!, input.argv.slice(1), {
			cwd: input.cwd,
			env: input.env,
			shell: false,
			detached,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const killTree = (signal: NodeJS.Signals): void => {
			try {
				if (detached && child.pid) process.kill(-child.pid, signal);
				else child.kill(signal);
			} catch {
				try {
					child.kill(signal);
				} catch {
					/* already gone */
				}
			}
		};
		const job: RunningJob = {
			jobId,
			argv: input.argv,
			pid: child.pid,
			startedAt: input.started,
			child,
			stdout: "",
			stderr: "",
			exited: false,
			killTree,
		};
		const keep = (stream: "stdout" | "stderr", chunk: Buffer): void => {
			const next = job[stream] + chunk.toString("utf8");
			job[stream] = next.length > JOB_OUTPUT_CAP ? next.slice(next.length - JOB_OUTPUT_CAP) : next;
		};
		child.stdout?.on("data", (chunk: Buffer) => keep("stdout", chunk));
		child.stderr?.on("data", (chunk: Buffer) => keep("stderr", chunk));
		child.on("close", (code, signal) => {
			job.exited = true;
			job.exitCode = code;
			job.signal = signal;
		});
		child.on("error", (err) => {
			job.exited = true;
			job.stderr += `\nspawn failed: ${err.message}`;
		});
		this.jobs.set(jobId, job);
		this.options.log.info("hand exec started in the background", {
			job: jobId,
			file: path.basename(input.argv[0]!),
			pid: child.pid,
		});
		return {
			ok: true,
			durationMs: Date.now() - input.started,
			data: { jobId, pid: child.pid, background: true },
		};
	}

	/** Every job this hand still holds, running or finished. */
	private listJobs(started: number): HandResult {
		return {
			ok: true,
			durationMs: Date.now() - started,
			data: {
				jobs: [...this.jobs.values()].map((job) => ({
					jobId: job.jobId,
					argv: job.argv,
					pid: job.pid,
					startedAt: job.startedAt,
					stdoutBytes: Buffer.byteLength(job.stdout),
					stderrBytes: Buffer.byteLength(job.stderr),
					exited: job.exited,
					...(job.exited ? { exitCode: job.exitCode ?? null, signal: job.signal ?? null } : {}),
				})),
			},
		};
	}

	/** What a job has written, capped. */
	private jobOutput(input: { jobId?: string; stream?: "stdout" | "stderr" }, started: number): HandResult {
		const job = input.jobId === undefined ? undefined : this.jobs.get(input.jobId);
		if (job === undefined) {
			return { ok: false, error: `no job ${input.jobId ?? "(none named)"} on this hand`, durationMs: Date.now() - started };
		}
		const stream = input.stream ?? "stdout";
		return {
			ok: true,
			durationMs: Date.now() - started,
			data: { jobId: job.jobId, stream, output: job[stream], exited: job.exited },
			stdout: job[stream],
		};
	}

	/** Stop a job. Its output stays readable. */
	private killJob(input: { jobId?: string }, started: number): HandResult {
		const job = input.jobId === undefined ? undefined : this.jobs.get(input.jobId);
		if (job === undefined) {
			return { ok: false, error: `no job ${input.jobId ?? "(none named)"} on this hand`, durationMs: Date.now() - started };
		}
		job.killTree("SIGTERM");
		const hard = setTimeout(() => job.killTree("SIGKILL"), 2000);
		hard.unref?.();
		return { ok: true, durationMs: Date.now() - started, data: { jobId: job.jobId, stopped: true } };
	}

	/** Stop every background job. Called when the hand closes. */
	stopJobs(): void {
		for (const job of this.jobs.values()) job.killTree("SIGTERM");
		this.jobs.clear();
	}

	private async git(input: GitInput, ctx: ExecutorRunContext, started: number): Promise<HandResult> {
		if (!Array.isArray(input.args) || input.args.length === 0) {
			throw new HandPolicyError("bad-input", "git requires a non-empty args array");
		}
		return this.exec(
			{ argv: ["git", ...input.args], cwd: input.cwd, timeoutMs: input.timeoutMs },
			ctx,
			started,
		);
	}

	private async read(input: ReadFileInput, started: number): Promise<HandResult> {
		const policy = this.options.policy;
		const target = resolveInRoots(policy.roots, input.path, "path");
		if (isPathDenied(policy.denyReadPaths, target)) {
			throw new HandPolicyError("path-denied", `this hand may not read ${input.path}`);
		}
		const cap = Math.min(input.maxBytes ?? policy.maxFileBytes, policy.maxFileBytes);
		const raw = await readFile(target);
		const byteTruncated = raw.byteLength > cap;
		let content = raw.subarray(0, cap).toString("utf8");
		// Line paging is what a machine's own read tool offers, so a caller that
		// asks for a window gets one; a caller that asks for nothing gets the file
		// as it always did.
		let lines: { start: number; end: number; total: number } | undefined;
		if (input.offset !== undefined || input.limit !== undefined) {
			// A file that ends in a newline has as many lines as it has newlines,
			// not one more: the trailing empty element is the terminator, not a line.
			const body = content.endsWith("\n") ? content.slice(0, -1) : content;
			const all = body === "" ? [] : body.split("\n");
			const start = Math.max(1, Math.floor(input.offset ?? 1));
			const count = input.limit === undefined ? all.length : Math.max(0, Math.floor(input.limit));
			const window = all.slice(start - 1, start - 1 + count);
			content = window.join("\n");
			lines = { start, end: start - 1 + window.length, total: all.length };
		}
		const truncated = byteTruncated || (lines !== undefined && lines.end < lines.total);
		return {
			ok: true,
			data: {
				path: target,
				content: this.redact(content),
				bytes: Buffer.byteLength(content),
				truncated,
				...(lines === undefined ? {} : { lines }),
			},
			durationMs: Date.now() - started,
			truncated,
		};
	}

	private async write(input: WriteFileInput, started: number): Promise<HandResult> {
		const policy = this.options.policy;
		if (this.options.capabilities.fs !== "rw") {
			throw new HandPolicyError("path-outside-roots", "filesystem is read-only on this hand");
		}
		const target = resolveInRoots(policy.roots, input.path, "path");
		if (isPathDenied(policy.denyWritePaths, target)) {
			throw new HandPolicyError("path-denied", `this hand may not write ${input.path}`);
		}
		const content = typeof input.content === "string" ? input.content : "";
		const bytes = Buffer.byteLength(content);
		if (bytes > policy.maxFileBytes) {
			throw new HandPolicyError(
				"bad-input",
				`write of ${bytes} bytes exceeds this hand's ${policy.maxFileBytes} byte limit`,
			);
		}
		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(target, content, "utf8");
		return { ok: true, data: { path: target, bytes }, durationMs: Date.now() - started };
	}

	/**
	 * Exact-text replacements, all or nothing: every `oldText` must occur exactly
	 * once in the file, and nothing is written unless they all apply. Ambiguity is
	 * refused rather than guessed, so a model that meant the second occurrence
	 * gets told instead of silently changing the first.
	 */
	private async edit(input: EditInput, started: number): Promise<HandResult> {
		const policy = this.options.policy;
		if (this.options.capabilities.fs !== "rw") {
			throw new HandPolicyError("path-outside-roots", "filesystem is read-only on this hand");
		}
		const target = resolveInRoots(policy.roots, input.path, "path");
		if (isPathDenied(policy.denyWritePaths, target)) {
			throw new HandPolicyError("path-denied", `this hand may not write ${input.path}`);
		}
		const edits = Array.isArray(input.edits) ? input.edits : [];
		if (edits.length === 0) throw new HandPolicyError("bad-input", "editFile requires at least one edit");
		const raw = await readFile(target, "utf8");
		let next = raw;
		for (const [index, edit] of edits.entries()) {
			if (typeof edit.oldText !== "string" || edit.oldText === "") {
				throw new HandPolicyError("bad-input", `edit ${String(index + 1)} has an empty oldText`);
			}
			if (typeof edit.newText !== "string") {
				throw new HandPolicyError("bad-input", `edit ${String(index + 1)} has a non-string newText`);
			}
			const first = next.indexOf(edit.oldText);
			if (first === -1) {
				throw new HandPolicyError(
					"bad-input",
					`edit ${String(index + 1)}: oldText does not occur in ${input.path}`,
				);
			}
			if (next.indexOf(edit.oldText, first + edit.oldText.length) !== -1) {
				throw new HandPolicyError(
					"bad-input",
					`edit ${String(index + 1)}: oldText occurs more than once in ${input.path}`,
				);
			}
			next = next.slice(0, first) + edit.newText + next.slice(first + edit.oldText.length);
		}
		const bytes = Buffer.byteLength(next);
		if (bytes > policy.maxFileBytes) {
			throw new HandPolicyError(
				"too-many-args",
				`edited file would be ${String(bytes)} bytes, over this hand's ${String(policy.maxFileBytes)} limit`,
			);
		}
		await writeFile(target, next, "utf8");
		return {
			ok: true,
			data: { path: target, edits: edits.length, bytes },
			durationMs: Date.now() - started,
		};
	}

	private async list(input: ListDirInput, started: number): Promise<HandResult> {
		const target = resolveInRoots(this.options.policy.roots, input.path, "path");
		if (isPathDenied(this.options.policy.denyReadPaths, target)) {
			throw new HandPolicyError("path-denied", `this hand may not list ${input.path}`);
		}
		const entries = await readdir(target, { withFileTypes: true });
		const data = entries
			.map((entry) => ({
				name: entry.name,
				type: entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other",
			}))
			.sort((a, b) => a.name.localeCompare(b.name))
			.slice(0, 2000);
		return { ok: true, data: { path: target, entries: data }, durationMs: Date.now() - started };
	}

	private async statPath(input: StatInput, started: number): Promise<HandResult> {
		const target = resolveInRoots(this.options.policy.roots, input.path, "path");
		if (isPathDenied(this.options.policy.denyReadPaths, target)) {
			throw new HandPolicyError("path-denied", `this hand may not stat ${input.path}`);
		}
		const info = await stat(target);
		return {
			ok: true,
			data: {
				path: target,
				size: info.size,
				isFile: info.isFile(),
				isDirectory: info.isDirectory(),
				mtimeMs: info.mtimeMs,
			},
			durationMs: Date.now() - started,
		};
	}
}
