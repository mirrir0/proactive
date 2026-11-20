/** NDJSON frames, one operation at a time, each with a deadline. See `docs/hands.md`. */

import crypto from "node:crypto";

/** A v1 endpoint is refused rather than half-understood. */
export const HANDS_PROTOCOL_VERSION = 2;

/** Hard cap on one NDJSON frame (both directions). */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;


export type HandFsMode = "none" | "ro" | "rw";

/** Advertised on connect; never trusted blindly. */
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

/** Empty = no network. */
export interface HandNetworkPolicy {
/** `example.com`, `*.example.com`, `host:port`. Never `*`. */
	allowedDomains: string[];
	deniedDomains: string[];
	/** Allow binding local ports (dev servers, test harnesses). */
	allowLocalBinding: boolean;
/** e.g. an ssh-agent. */
	allowUnixSockets: string[];
}

export const DEFAULT_HAND_NETWORK: HandNetworkPolicy = {
	allowedDomains: [],
	deniedDomains: [],
	allowLocalBinding: false,
	allowUnixSockets: [],
};

/** The hand is the security principal; the hub can only narrow this, never widen it. */
export interface HandPolicy {
/** Every path and cwd must resolve inside one of these. */
	roots: string[];
/** Empty = deny all. */
	allow: string[];
	deny: string[];
	maxOutputBytes: number;
	maxFileBytes: number;
	/** Omitted or 0 means no limit: the machine is the limit. */
	maxConcurrent?: number;
	defaultTimeoutMs: number;
	maxTimeoutMs: number;
/** Plus a safe base set. */
	envAllow: string[];
	/** `srt` fences writes and network; `confined` fences reads too; `none` leaves the allowlist. Requested-but-unavailable throws. */
	sandbox: "none" | "srt" | "confined";
	network: HandNetworkPolicy;
/** e.g. ~/.ssh, ~/.aws. */
	denyReadPaths: string[];
/** Even inside a root. */
	denyWritePaths: string[];
}

/** Reads are otherwise open: a hand that cannot read its own toolchain is useless. */
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
	maxConcurrent: 0,
	defaultTimeoutMs: 120_000,
	maxTimeoutMs: 15 * 60_000,
	envAllow: [],
	sandbox: "srt",
	network: { ...DEFAULT_HAND_NETWORK },
	denyReadPaths: [...DEFAULT_DENY_READ],
	denyWritePaths: [],
};


export type HandOp =
	| "exec"
	| "shell"
	| "readFile"
	| "writeFile"
	| "editFile"
	| "listDir"
	| "stat"
	| "git"
/** Started by `exec { background: true }`. */
	| "jobs"
	| "jobOutput"
	| "killJob";

export interface ExecInput {
/** argv is the default form; it never passes through a shell. */
	argv: string[];
	cwd?: string;
	timeoutMs?: number;
/** Only if the hand allows a shell. */
	shell?: boolean;
	env?: Record<string, string>;
	/** Returns at once with a job id: for servers and watchers, which do not exit. */
	background?: boolean;
}

/** As `jobs` lists it. */
export interface BackgroundJob {
	jobId: string;
	argv: string[];
	pid: number | undefined;
	startedAt: number;
/** The buffers are capped. */
	stdoutBytes: number;
	stderrBytes: number;
	exited: boolean;
	exitCode?: number | null;
	signal?: string | null;
}

	/** Separate from `exec` on purpose: this one involves a shell, and only when allowed. */
export interface ShellInput {
	command: string;
	cwd?: string;
	timeoutMs?: number;
	env?: Record<string, string>;
}

export interface ReadFileInput {
	path: string;
/** Defaults to the policy cap. */
	maxBytes?: number;
/** 1-based. Absent means from the first line. */
	offset?: number;
/** Absent means to the end, bounded by `maxBytes`. */
	limit?: number;
}

	/** Nothing is written unless every edit applies exactly once. */
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
/** `git <args…>`; push/pull use the local remote's credentials. */
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

	/** One call. */
export interface WorkItem {
	workId: string;
	op: HandOp;
	input: unknown;
/** Epoch ms; past it, the hand gives up. */
	deadlineMs: number;
	maxOutputBytes: number;
}

/** `ok=false` is a tool error, not a crash. */
export interface HandResult {
	ok: boolean;
	exitCode?: number | null;
	signal?: string | null;
	stdout?: string;
	stderr?: string;
/** File contents, dir entries, … */
	data?: unknown;
	error?: string;
	durationMs: number;
/** Output was cut. */
	truncated?: boolean;
/** The sandbox denied something. */
	blocked?: boolean;
	/** Cut off, not finished with a failure: a person needs the difference. */
	timedOut?: boolean;
}

export type StreamName = "stdout" | "stderr";


	/** Display only: the hub never decides anything from this. */
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
/** Compared against a hash, in constant time. */
	token: string;
	name: string;
	capabilities: HandCapabilities;
	meta?: Record<string, string>;
/** Never used for a decision. */
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
/** The endpoint matches it. */
			heartbeatMs: number;
	  }
	| { type: "work"; work: WorkItem }
	| { type: "cancel"; workId: string; reason?: string }
	| { type: "ping"; id: string }
	| { type: "reject"; code: string; message: string };


export interface HandCall {
	op: HandOp;
	input: unknown;
/** Omitted = the hub picks. */
	endpointId?: string;
	timeoutMs?: number;
}

export interface HandStatus {
	endpointId: string;
	name: string;
	connected: boolean;
	capabilities: HandCapabilities;
	/** The hub's narrowing, never the hand's real policy. */
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


export function encodeFrame(message: unknown): string {
	return JSON.stringify(message) + "\n";
}

	/** `null` when a frame is too large: the connection should be dropped. */
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


/** Constant-time. */
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
