/**
 * Hands protocol — the wire contract between brains (cloud) and hands
 * (execution environments).
 *
 * This is the "decouple the brain from the hands" interface: a hand is a name,
 * an input and a string back. Everything here is deliberately small, versioned,
 * and free of assumptions about what the hand *is* — a laptop, a container, a
 * build box, a phone.
 *
 * Two links share these types:
 *
 *   endpoint → hub   (dial-out; NAT-friendly; authenticated with a per-hand token)
 *   worker   → hub   (local Unix socket; the brain's tool calls)
 *
 * Both use newline-delimited JSON so a frame can be inspected, logged and
 * replayed by eye. Every frame is size-capped: an execution environment is
 * untrusted from the hub's point of view, and so is the hub from the endpoint's.
 */

import crypto from "node:crypto";

/**
 * v2 adds `shell` and `editFile` and line paging on `readFile` — the operations
 * a machine's own tools need — and a display-only `policySummary` on `hello`.
 * A v1 endpoint is refused rather than half-understood.
 */
export const HANDS_PROTOCOL_VERSION = 2;

/** Hard cap on one NDJSON frame (both directions). */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Capabilities and policy
// ---------------------------------------------------------------------------

export type HandFsMode = "none" | "ro" | "rw";

/** What a hand says it can do. Advertised on connect; never trusted blindly. */
export interface HandCapabilities {
	exec: boolean;
	/** Whether `exec` may use a shell string instead of an argv array. */
	shell: boolean;
	fs: HandFsMode;
	git: boolean;
}

export const DEFAULT_HAND_CAPABILITIES: HandCapabilities = {
	exec: true,
	shell: false,
	fs: "rw",
	git: true,
};

/** Which hosts this hand's processes may reach. Empty allow list = no network. */
export interface HandNetworkPolicy {
	/** Domain patterns: `example.com`, `*.example.com`, `host:port`. Never `*`. */
	allowedDomains: string[];
	deniedDomains: string[];
	/** Allow binding local ports (dev servers, test harnesses). */
	allowLocalBinding: boolean;
	/** Unix sockets the sandboxed process may connect to (e.g. an ssh-agent). */
	allowUnixSockets: string[];
}

export const DEFAULT_HAND_NETWORK: HandNetworkPolicy = {
	allowedDomains: [],
	deniedDomains: [],
	allowLocalBinding: false,
	allowUnixSockets: [],
};

/**
 * What a hand will actually do. Configured **on the hand**, because the hand is
 * the security principal: the machine's owner decides what may run there. The
 * hub can only narrow this, never widen it.
 */
export interface HandPolicy {
	/** Absolute roots every filesystem operation and cwd must resolve inside. */
	roots: string[];
	/** Executable basenames or globs permitted for `exec`. Empty = deny all. */
	allow: string[];
	deny: string[];
	maxOutputBytes: number;
	maxFileBytes: number;
	maxConcurrent: number;
	defaultTimeoutMs: number;
	maxTimeoutMs: number;
	/** Env var names passed through to child processes (plus a safe base set). */
	envAllow: string[];
	/**
	 * OS-level sandbox for `exec` and its whole process tree.
	 *
	 * "srt"  — enforce filesystem and network policy through the Anthropic
	 *          Sandbox Runtime (seatbelt on macOS, bubblewrap on Linux, WFP on
	 *          Windows). Paths outside `roots` are read/write-restricted per
	 *          `denyReadPaths`/`denyWritePaths`, and network access is limited to
	 *          `network.allowedDomains`.
	 * "none" — the executable allowlist is the only boundary.
	 *
	 * Requested-but-unavailable is an error, never a silent downgrade.
	 */
	sandbox: "none" | "srt" | "confined";
	network: HandNetworkPolicy;
	/** Paths the sandboxed process may not read (e.g. ~/.ssh, ~/.aws). */
	denyReadPaths: string[];
	/** Paths the sandboxed process may not write, even inside a root. */
	denyWritePaths: string[];
}

/**
 * What no hand may read, unless its operator says otherwise.
 *
 * The sandbox's read fence is this list — reads are otherwise open, because a hand
 * that cannot read its own toolchain is useless — so the list is where "this folder
 * and nothing else" has to start: keys, cloud credentials, the brain's own state
 * (which holds its token), and the shell's history.
 */
export const DEFAULT_DENY_READ: readonly string[] = [
	"~/.ssh",
	"~/.aws",
	"~/.gnupg",
	"~/.netrc",
	"~/.config/gh",
	"~/.anomalous",
	"~/Library/Application Support/mir",
	"~/.docker/config.json",
];

export const DEFAULT_HAND_POLICY: HandPolicy = {
	roots: [],
	allow: ["git", "ls", "cat", "pwd", "rg", "node", "npm", "pnpm", "npx", "make", "tsc"],
	deny: [],
	maxOutputBytes: 256 * 1024,
	maxFileBytes: 1024 * 1024,
	maxConcurrent: 2,
	defaultTimeoutMs: 120_000,
	maxTimeoutMs: 15 * 60_000,
	envAllow: [],
	sandbox: "srt",
	network: { ...DEFAULT_HAND_NETWORK },
	denyReadPaths: [...DEFAULT_DENY_READ],
	denyWritePaths: [],
};

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export type HandOp =
	| "exec"
	| "shell"
	| "readFile"
	| "writeFile"
	| "editFile"
	| "listDir"
	| "stat"
	| "git"
	/** Background jobs started by `exec { background: true }`. */
	| "jobs"
	| "jobOutput"
	| "killJob";

export interface ExecInput {
	/** argv form is the default; it is never passed through a shell. */
	argv: string[];
	cwd?: string;
	timeoutMs?: number;
	/** Only honoured when the hand's capabilities allow a shell. */
	shell?: boolean;
	env?: Record<string, string>;
	/**
	 * Start it and return at once, with a job id.
	 *
	 * A server, a watcher, anything that does not exit on its own: waiting for it
	 * would hold the task's turn until the hand's timeout, and the thing it was
	 * meant to serve would never be reachable while it waited.
	 */
	background?: boolean;
}

/** A job started in the background, as `jobs` lists it. */
export interface BackgroundJob {
	jobId: string;
	argv: string[];
	pid: number | undefined;
	startedAt: number;
	/** Bytes kept from stdout/stderr (the buffers are capped). */
	stdoutBytes: number;
	stderrBytes: number;
	exited: boolean;
	exitCode?: number | null;
	signal?: string | null;
}

/**
 * A command string run through the hand's shell.
 *
 * Separate from `exec` on purpose: `exec` takes argv and never involves a shell,
 * which is what makes its allowlist mean something. This op says outright that a
 * shell is involved, so it is gated by the `shell` capability *and* an explicit
 * `sh` in the allowlist, and its command is still confined by the sandbox.
 */
export interface ShellInput {
	command: string;
	cwd?: string;
	timeoutMs?: number;
	env?: Record<string, string>;
}

export interface ReadFileInput {
	path: string;
	/** Max bytes to return; defaults to the policy cap. */
	maxBytes?: number;
	/** 1-based first line to return. Absent means from the first line. */
	offset?: number;
	/** How many lines to return. Absent means to the end (bounded by `maxBytes`). */
	limit?: number;
}

/**
 * One file rewritten by a list of exact-text replacements, as the local agent's
 * edit tool does: each `oldText` must occur exactly once, and nothing is written
 * unless every edit applies.
 */
export interface EditInput {
	path: string;
	edits: Array<{ oldText: string; newText: string }>;
}

export interface WriteFileInput {
	path: string;
	content: string;
}

export interface ListDirInput {
	path: string;
}

export interface StatInput {
	path: string;
}

export interface GitInput {
	/** `git <args…>`; `push`/`pull` use the local remote's own credentials. */
	args: string[];
	cwd?: string;
	timeoutMs?: number;
}

export interface HandInputs {
	exec: ExecInput;
	shell: ShellInput;
	readFile: ReadFileInput;
	writeFile: WriteFileInput;
	editFile: EditInput;
	listDir: ListDirInput;
	stat: StatInput;
	git: GitInput;
}

/** One unit of work sent to a hand. */
export interface WorkItem {
	workId: string;
	op: HandOp;
	input: unknown;
	/** Absolute epoch ms after which the hand must give up. */
	deadlineMs: number;
	maxOutputBytes: number;
}

/** The result of one unit of work. `ok=false` is a tool error, not a crash. */
export interface HandResult {
	ok: boolean;
	exitCode?: number | null;
	signal?: string | null;
	stdout?: string;
	stderr?: string;
	/** Structured payload for non-exec ops (file contents, dir entries, …). */
	data?: unknown;
	error?: string;
	durationMs: number;
	/** True when output was cut at the cap. */
	truncated?: boolean;
	/** True when the sandbox denied something during this call. */
	blocked?: boolean;
	/**
	 * True when the hand ended the call for outrunning its timeout. A caller that
	 * shows this to a person needs it apart from a non-zero exit: the command was
	 * cut off, not finished with a failure.
	 */
	timedOut?: boolean;
}

export type StreamName = "stdout" | "stderr";

// ---------------------------------------------------------------------------
// Endpoint ⇄ hub
// ---------------------------------------------------------------------------

/**
 * What a hand says it enforces, for the operator to read.
 *
 * **Display only.** The hub never uses this to decide anything: the hand is the
 * security principal, and a hub that trusted a summary would be trusting the
 * very machine it is supposed to be bounded by. Counts rather than contents for
 * the allow and deny lists, because a person needs to know whether a hand is
 * narrow, not every program it may run.
 */
export interface HandPolicySummary {
	sandbox: "none" | "srt" | "confined";
	roots: string[];
	allowCount: number;
	shell: boolean;
	fs: HandFsMode;
	git: boolean;
	allowedDomains: string[];
	denyReadCount: number;
	denyWriteCount: number;
}

export interface EndpointHello {
	type: "hello";
	v: number;
	endpointId: string;
	/** Raw token; the hub compares a hash, in constant time. */
	token: string;
	name: string;
	capabilities: HandCapabilities;
	meta?: Record<string, string>;
	/** What this hand enforces, in its own words. Never used for a decision. */
	policySummary?: HandPolicySummary;
}

export type EndpointToHub =
	| EndpointHello
	| { type: "heartbeat"; at: number; load?: { running: number } }
	| { type: "accepted"; workId: string }
	| { type: "chunk"; workId: string; stream: StreamName; data: string }
	| { type: "result"; workId: string; result: HandResult }
	| { type: "pong"; id: string }
	| { type: "error"; code: string; message: string; workId?: string }
	| { type: "bye"; reason?: string };

export type HubToEndpoint =
	| {
			type: "welcome";
			v: number;
			endpointId: string;
			/** Hub-side heartbeat interval the endpoint should match. */
			heartbeatMs: number;
	  }
	| { type: "work"; work: WorkItem }
	| { type: "cancel"; workId: string; reason?: string }
	| { type: "ping"; id: string }
	| { type: "reject"; code: string; message: string };

// ---------------------------------------------------------------------------
// Worker (brain) ⇄ hub
// ---------------------------------------------------------------------------

export interface HandCall {
	op: HandOp;
	input: unknown;
	/** Pin the call to one hand; omitted = the hub picks. */
	endpointId?: string;
	timeoutMs?: number;
}

export interface HandStatus {
	endpointId: string;
	name: string;
	connected: boolean;
	capabilities: HandCapabilities;
	/**
	 * The hub's own narrowing of the hand, never its real policy. A remote hand
	 * keeps its policy to itself; `policySummary` is what it says about it.
	 */
	policy: Pick<HandPolicy, "roots" | "allow" | "maxConcurrent">;
	/** What the hand says it enforces, for a person to read. Never a decision. */
	policySummary?: HandPolicySummary;
	running: number;
	lastSeen: number;
	meta?: Record<string, string>;
	/** "local" for the daemon's own hand. */
	kind: "local" | "remote";
}

export interface HandCallResult extends HandResult {
	endpointId: string;
}

export type ClientToHub =
	| { type: "hello"; v: number; agent: string }
	| { type: "call"; id: string; call: HandCall }
	| { type: "cancel"; id: string }
	| { type: "hands"; id: string };

export type HubToClient =
	| { type: "ready"; v: number; hands: HandStatus[] }
	| { type: "stream"; id: string; stream: StreamName; data: string }
	| { type: "reply"; id: string; result: HandCallResult }
	| { type: "hands"; id: string; hands: HandStatus[] }
	| { type: "error"; id?: string; code: string; message: string };

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

export function encodeFrame(message: unknown): string {
	return JSON.stringify(message) + "\n";
}

/**
 * Incremental NDJSON decoder with a hard frame cap.
 * Returns `null` when a frame is too large (the connection should be dropped).
 */
export class FrameDecoder<T> {
	private buffer = "";

	constructor(
		private readonly onFrame: (message: T) => void,
		private readonly maxFrameBytes = MAX_FRAME_BYTES,
	) {}

	push(chunk: Buffer | string): { ok: boolean; error?: string } {
		this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
		if (this.buffer.length > this.maxFrameBytes && !this.buffer.includes("\n")) {
			return { ok: false, error: "frame too large" };
		}
		let nl: number;
		while ((nl = this.buffer.indexOf("\n")) >= 0) {
			const line = this.buffer.slice(0, nl);
			this.buffer = this.buffer.slice(nl + 1);
			if (!line.trim()) continue;
			if (line.length > this.maxFrameBytes) return { ok: false, error: "frame too large" };
			let parsed: T;
			try {
				parsed = JSON.parse(line) as T;
			} catch {
				// A corrupt frame is dropped, not fatal: one bad line must not kill
				// a long-lived hand connection.
				continue;
			}
			this.onFrame(parsed);
		}
		return { ok: true };
	}

	reset(): void {
		this.buffer = "";
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Constant-time string compare for tokens. */
export function tokensEqual(a: string, b: string): boolean {
	const ab = Buffer.from(a);
	const bb = Buffer.from(b);
	if (ab.length !== bb.length) return false;
	return crypto.timingSafeEqual(ab, bb);
}

export function hashToken(token: string): string {
	return crypto.createHash("sha256").update(token).digest("hex");
}

/** Does this hand satisfy the capability a call needs? */
export function capabilityFor(op: HandOp): { need: keyof HandCapabilities; value?: unknown } | null {
	switch (op) {
		case "exec":
			return { need: "exec" };
		case "git":
			return { need: "git" };
		case "readFile":
		case "listDir":
		case "stat":
			return { need: "fs" };
		case "writeFile":
			return { need: "fs" };
		default:
			return null;
	}
}

export function handSupports(
	caps: HandCapabilities,
	op: HandOp,
): { ok: boolean; reason?: string } {
	if (op === "exec" && !caps.exec) return { ok: false, reason: "exec not granted" };
	if (op === "git" && !caps.git) return { ok: false, reason: "git not granted" };
	if (op === "writeFile" && caps.fs !== "rw") return { ok: false, reason: `filesystem is ${caps.fs}, not rw` };
	if ((op === "readFile" || op === "listDir" || op === "stat") && caps.fs === "none") {
		return { ok: false, reason: "filesystem not granted" };
	}
	return { ok: true };
}

export function isHandOp(value: unknown): value is HandOp {
	return (
		value === "exec" ||
		value === "readFile" ||
		value === "writeFile" ||
		value === "listDir" ||
		value === "stat" ||
		value === "git"
	);
}
