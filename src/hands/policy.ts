/**
 * Hand policy — what a hand is allowed to do, and how it is enforced.
 *
 * The hand is the security principal: the machine's owner decides what may run
 * there. This module is the enforcement point, and it is shared by the endpoint
 * daemon and by the daemon's built-in local hand so both behave identically.
 *
 * Three rules, each of which exists because the alternative is a known exploit:
 *
 *   1. **Paths are confined to declared roots.** Resolved and checked, never
 *      clamped — a path that escapes is an error, not a surprise write.
 *   2. **Exec is an allowlist of executables, argv only.** No shell by default,
 *      so a model-generated string cannot become `rm -rf /` via `;`.
 *   3. **Children get a filtered environment.** Secrets in the hand's own
 *      environment are never passed down, and are redacted from output.
 */

import fs from "node:fs";
import path from "node:path";
import type {
	ExecInput,
	HandCapabilities,
	HandOp,
	HandPolicy,
	HandPolicySummary,
	ShellInput,
} from "./protocol.ts";
import { DEFAULT_HAND_POLICY } from "./protocol.ts";

/** Env vars a child process needs to function; everything else is opt-in. */
const BASE_ENV_ALLOW = [
	"PATH",
	"HOME",
	"TMPDIR",
	"TMP",
	"TEMP",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TERM",
	"SHELL",
	"USER",
	"LOGNAME",
	"PWD",
	"TZ",
];

/** Anything matching this is never passed to a child, even if allowlisted. */
const SECRET_NAME_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|AUTH)/i;

export interface PolicyViolation {
	code:
		| "path-outside-roots"
		| "path-denied"
		| "exec-denied"
		| "shell-denied"
		| "too-many-args"
		| "bad-input";
	message: string;
}

export class HandPolicyError extends Error {
	constructor(
		readonly code: PolicyViolation["code"],
		message: string,
	) {
		super(message);
		this.name = "HandPolicyError";
	}
}

/** Merge a partial policy over the defaults, normalising roots to absolute paths. */
export function normalizePolicy(partial: Partial<HandPolicy> = {}, base: HandPolicy = DEFAULT_HAND_POLICY): HandPolicy {
	const merged: HandPolicy = { ...base, ...partial };
	return {
		...merged,
		roots: (merged.roots ?? []).map((root) => path.resolve(root)),
		allow: merged.allow ?? [],
		deny: merged.deny ?? [],
		envAllow: merged.envAllow ?? [],
		sandbox: merged.sandbox === "none" ? "none" : "srt",
		network: {
			allowedDomains: merged.network?.allowedDomains ?? [],
			deniedDomains: merged.network?.deniedDomains ?? [],
			allowLocalBinding: merged.network?.allowLocalBinding ?? false,
			allowUnixSockets: merged.network?.allowUnixSockets ?? [],
		},
		// An explicit list replaces the defaults rather than adding to them: an operator
		// who names what to deny means that, and a hand with nothing denied is a
		// decision, not an oversight.
		denyReadPaths: (merged.denyReadPaths ?? []).map((entry) =>
			entry.startsWith("~/") ? path.join(process.env["HOME"] ?? "", entry.slice(2)) : entry,
		),
		denyWritePaths: merged.denyWritePaths ?? [],
		maxOutputBytes: Math.max(1024, merged.maxOutputBytes),
		maxFileBytes: Math.max(1024, merged.maxFileBytes),
		maxConcurrent: Math.max(1, merged.maxConcurrent),
		defaultTimeoutMs: Math.max(1000, merged.defaultTimeoutMs),
		maxTimeoutMs: Math.max(merged.defaultTimeoutMs, merged.maxTimeoutMs),
	};
}

/**
 * Parse a policy from JSON, or from the flat strings a CLI provides.
 * Unknown keys are ignored so a config can carry forward-compatible fields.
 */
export function parsePolicy(raw: string | undefined | null, base: HandPolicy = DEFAULT_HAND_POLICY): HandPolicy {
	if (!raw || !raw.trim()) return normalizePolicy({}, base);
	const trimmed = raw.trim();
	if (!trimmed.startsWith("{")) {
		throw new HandPolicyError("bad-input", "policy must be a JSON object");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch (err) {
		throw new HandPolicyError("bad-input", `policy is not valid JSON: ${(err as Error).message}`);
	}
	if (!parsed || typeof parsed !== "object") {
		throw new HandPolicyError("bad-input", "policy must be an object");
	}
	return normalizePolicy(parsed as Partial<HandPolicy>, base);
}

/** Resolve `p` inside one of the policy roots, or throw. */
/** The real path of a root, so a root that is itself a symlink still matches. */
function realRoots(roots: string[]): string[] {
	return roots.map((root) => {
		try {
			return fs.realpathSync(root);
		} catch {
			return path.resolve(root);
		}
	});
}

/**
 * The real path of `candidate`, walking to the nearest ancestor that exists.
 *
 * A write target usually does not exist yet, and `realpath` throws on it. Resolving
 * the parent is enough: a symlink anywhere above it is what an escape needs.
 */
function realCandidate(candidate: string): string {
	let current = candidate;
	for (let hops = 0; hops < 64; hops += 1) {
		try {
			return path.join(fs.realpathSync(current), path.relative(current, candidate));
		} catch {
			const parent = path.dirname(current);
			if (parent === current) return candidate;
			current = parent;
		}
	}
	return candidate;
}

export function resolveInRoots(roots: string[], p: string, label = "path"): string {
	if (typeof p !== "string" || p.length === 0) {
		throw new HandPolicyError("bad-input", `${label} must be a non-empty string`);
	}
	if (roots.length === 0) {
		throw new HandPolicyError("path-outside-roots", `${label}: this hand has no filesystem roots configured`);
	}
	// Real paths, both sides. `path.resolve` alone lets a symlink inside a root point
	// anywhere — `files/link -> /Users/orchid` passes the check and reads the disk — and
	// the hand's own file tools run in this process, where no OS sandbox is watching.
	// Resolving the candidate also accepts the root's own aliases: on macOS a temp dir
	// arrives as `/var/...` and is really `/private/var/...`.
	const real = realRoots(roots);
	for (let index = 0; index < roots.length; index += 1) {
		const root = roots[index]!;
		const realRoot = real[index]!;
		const candidate = path.resolve(root, p);
		const rel = path.relative(realRoot, realCandidate(candidate));
		// Returned as the caller wrote it: a root that is itself a symlink should not
		// change the paths a Worker sees, only which ones are refused.
		if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return candidate;
	}
	throw new HandPolicyError("path-outside-roots", `${label} escapes the allowed roots: ${p}`);
}

/**
 * True when `target` is inside one of `deniedPaths`.
 *
 * The sandbox already enforces `denyRead`/`denyWrite` for spawned processes; the
 * hand's own `read_file`/`write_file`/`list_dir` tools must apply the same rule,
 * or the model could step around the sandbox by asking the hand directly.
 */
export function isPathDenied(deniedPaths: string[], target: string): boolean {
	const absolute = realCandidate(path.resolve(target));
	for (const entry of deniedPaths) {
		const denied = realCandidate(path.resolve(entry));
		if (absolute === denied) return true;
		const rel = path.relative(denied, absolute);
		if (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)) return true;
	}
	return false;
}

/** Glob-ish match for executable names (`*` = any run of characters). */
export function matchName(pattern: string, name: string): boolean {
	if (pattern === name) return true;
	if (!pattern.includes("*")) return false;
	const re = new RegExp(
		"^" + pattern.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$",
	);
	return re.test(name);
}

/** The executable name an argv refers to (`/usr/bin/git` → `git`). */
export function executableName(argv: string[]): string {
	const first = argv[0] ?? "";
	return path.basename(first);
}

/**
 * Validate an exec request against the policy.
 * Returns the argv to run (never a shell string) or throws.
 */
export function validateExec(
	input: ExecInput,
	policy: HandPolicy,
	capabilities: HandCapabilities,
): { argv: string[]; shell: boolean; cwd?: string } {
	if (!Array.isArray(input.argv) || input.argv.length === 0) {
		throw new HandPolicyError("bad-input", "exec requires a non-empty argv array");
	}
	if (input.argv.length > 64) {
		throw new HandPolicyError("too-many-args", "exec argv is limited to 64 entries");
	}
	for (const arg of input.argv) {
		if (typeof arg !== "string") throw new HandPolicyError("bad-input", "argv entries must be strings");
	}
	if (!capabilities.exec) throw new HandPolicyError("exec-denied", "exec is not granted on this hand");

	const name = executableName(input.argv);
	const denied = policy.deny.some((pattern) => matchName(pattern, name));
	if (denied) throw new HandPolicyError("exec-denied", `executable "${name}" is denied`);
	const allowed = policy.allow.some((pattern) => matchName(pattern, name));
	if (!allowed) {
		throw new HandPolicyError(
			"exec-denied",
			`executable "${name}" is not in this hand's allowlist (${policy.allow.join(", ") || "empty"})`,
		);
	}

	const wantsShell = input.shell === true;
	if (wantsShell && !capabilities.shell) {
		throw new HandPolicyError("shell-denied", "shell execution is not granted on this hand");
	}
	if (wantsShell && !policy.allow.some((pattern) => matchName(pattern, "sh"))) {
		// Shell mode turns an argv into a string; without an explicit `sh` grant the
		// executable allowlist would stop meaning anything.
		throw new HandPolicyError(
			"shell-denied",
			'shell execution requires "sh" in the allowlist — grant it explicitly if this hand is meant to run scripts',
		);
	}

	const cwd = input.cwd ? resolveInRoots(policy.roots, input.cwd, "cwd") : policy.roots[0];
	return { argv: input.argv, shell: wantsShell, cwd };
}

/**
 * The argv a `shell` op becomes, after the two grants it needs.
 *
 * The shell is run *as a program* — `/bin/sh -c <command>` — rather than by
 * asking `exec` to reinterpret its argv as a string. That keeps one meaning for
 * `exec` (argv, no shell) and makes this op's own grant unavoidable: the
 * allowlist must name `sh`, or the executable check that gives the allowlist its
 * meaning would stop applying to everything the command then runs.
 */
export function validateShell(
	input: ShellInput,
	policy: HandPolicy,
	capabilities: HandCapabilities,
): { argv: string[]; cwd: string } {
	if (typeof input.command !== "string" || input.command.trim() === "") {
		throw new HandPolicyError("bad-input", "shell requires a non-empty command");
	}
	if (!capabilities.shell) {
		throw new HandPolicyError("shell-denied", "shell execution is not granted on this hand");
	}
	if (!policy.allow.some((pattern) => matchName(pattern, "sh"))) {
		throw new HandPolicyError(
			"shell-denied",
			'shell execution requires "sh" in the allowlist — grant it explicitly if this hand is meant to run scripts',
		);
	}
	const cwd = input.cwd ? resolveInRoots(policy.roots, input.cwd, "cwd") : policy.roots[0];
	if (cwd === undefined) throw new HandPolicyError("bad-input", "this hand has no root to run in");
	return { argv: [SHELL_PATH, "-c", input.command], cwd };
}

/** The POSIX shell a `shell` op runs, when it exists. */
const SHELL_PATH = "/bin/sh";

/**
 * What a hand says it enforces, for a person to read — never for a decision.
 * Counts, not contents, for the allow and deny lists.
 */
export function policySummary(policy: HandPolicy, capabilities: HandCapabilities): HandPolicySummary {
	return {
		sandbox: policy.sandbox,
		roots: [...policy.roots],
		allowCount: policy.allow.length,
		shell: capabilities.shell,
		fs: capabilities.fs,
		git: capabilities.git,
		allowedDomains: [...policy.network.allowedDomains],
		denyReadCount: policy.denyReadPaths.length,
		denyWriteCount: policy.denyWritePaths.length,
	};
}

/**
 * Build the environment for a child process: the safe base set plus explicit
 * allowlists, minus anything secret-shaped. Never the hand's full environment.
 */
export function filteredEnv(
	policy: HandPolicy,
	extra: Record<string, string> | undefined,
	env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = {};
	const allow = new Set([...BASE_ENV_ALLOW, ...policy.envAllow]);
	for (const name of allow) {
		if (SECRET_NAME_RE.test(name)) continue;
		const value = env[name];
		if (value !== undefined) out[name] = value;
	}
	for (const [name, value] of Object.entries(extra ?? {})) {
		// A model-supplied env cannot smuggle a secret name through either.
		if (SECRET_NAME_RE.test(name)) continue;
		out[name] = value;
	}
	return out;
}

/** Human-readable policy summary for prompts and `mir hands list`. */
export function describePolicy(policy: HandPolicy): string {
	return [
		`roots=${policy.roots.join(",") || "(none)"}`,
		`exec=${policy.allow.join(",") || "(none)"}`,
		`concurrency=${policy.maxConcurrent}`,
		`timeout=${policy.defaultTimeoutMs}ms/${policy.maxTimeoutMs}ms`,
		`output=${policy.maxOutputBytes}B`,
	].join(" ");
}

/** Ops a hand can serve, given its capabilities (used by the hub's selector). */
export function supportedOps(capabilities: HandCapabilities): HandOp[] {
	const ops: HandOp[] = [];
	if (capabilities.exec) ops.push("exec");
	if (capabilities.git) ops.push("git");
	if (capabilities.fs !== "none") ops.push("readFile", "listDir", "stat");
	if (capabilities.fs === "rw") ops.push("writeFile");
	return ops;
}
