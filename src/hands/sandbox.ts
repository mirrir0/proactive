/**
 * The sandbox a hand runs its work inside.
 *
 * Enforcement is delegated to the Anthropic Sandbox Runtime (`srt`), which wraps
 * the whole process tree with the OS's own primitives — seatbelt on macOS,
 * bubblewrap on Linux, a WFP egress fence on Windows — plus host-side HTTP and
 * SOCKS proxies for network allowlisting. That is a better boundary than this
 * project could build for itself, and it covers the two axes a command
 * allowlist cannot:
 *
 *   - **paths** — the process may only write inside the hand's roots, and may
 *     not read credential material such as `~/.ssh` or `~/.aws`;
 *   - **network** — outbound traffic is denied unless the destination matches
 *     `network.allowedDomains`, so an injected instruction cannot exfiltrate
 *     what it just read.
 *
 * Two invariants this module exists to keep:
 *
 *   1. **No silent downgrade.** If the sandbox is requested and cannot be
 *      provided (unsupported platform, missing `bwrap`, a config `srt` refuses),
 *      construction throws. A boundary the operator believes in is worse than
 *      one they know is missing.
 *   2. **The sandbox is not a policy bypass.** `srt` wraps a *command string*,
 *      so the argv we were given is shell-quoted element by element before it
 *      is embedded. No argument can become a second command.
 */

import fs from "node:fs";
import path from "node:path";
import {
	SandboxManager,
	getDefaultWritePaths,
	type SandboxRuntimeConfig,
	type SandboxViolationEvent,
} from "@anthropic-ai/sandbox-runtime";
import type { HandCapabilities, HandPolicy } from "./protocol.ts";
import type { Logger } from "../telemetry.ts";

export interface SandboxWrapResult {
	argv: string[];
	env: NodeJS.ProcessEnv;
}

export interface SandboxWrapper {
	readonly kind: "srt" | "confined";
	readonly network: { allowedDomains: string[]; deniedDomains: string[] };
	/** Wrap an argv for spawning. `commandId` attributes violations to this call. */
	wrap(argv: string[], options: { cwd?: string; commandId: string }): Promise<SandboxWrapResult>;
	/** Rewrite stderr so sandbox denials read as policy, not as a mystery bug. */
	annotate(commandId: string, stderr: string): string;
	/** Violations observed while `commandId` ran. */
	violations(commandId: string): SandboxViolationEvent[];
	/** Release per-command state. Call after the child exits. */
	cleanup(): void;
	dispose(): Promise<void>;
}

/**
 * Quote one argv element for POSIX `sh`.
 *
 * `srt` takes a command *string* and runs it through a shell, so this is the
 * only thing standing between a model-supplied argument and the host shell.
 * Every element is single-quoted; a literal quote becomes `'\''`.
 */
export function shellQuote(argv: string[]): string {
	return argv
		.map((arg) => `'${String(arg).replace(/'/g, `'\\''`)}'`)
		.join(" ");
}

/**
 * Map a hand policy onto an `srt` configuration.
 *
 * Reads are open by default (a dev machine is useless otherwise) and narrowed by
 * `denyReadPaths`. Writes are allow-only: the hand's roots plus `srt`'s own
 * defaults for temp/scratch. Network is allow-only and empty by default.
 */
export function buildSandboxConfig(policy: HandPolicy): SandboxRuntimeConfig {
	const allowWrite = [...new Set([...policy.roots, ...getDefaultWritePaths()])];
	return {
		network: {
			allowedDomains: policy.network.allowedDomains,
			deniedDomains: policy.network.deniedDomains,
			allowLocalBinding: policy.network.allowLocalBinding,
			...(policy.network.allowUnixSockets.length
				? { allowUnixSockets: policy.network.allowUnixSockets }
				: {}),
		},
		filesystem: {
			allowWrite,
			denyWrite: policy.denyWritePaths,
			denyRead: policy.denyReadPaths,
		},
	};
}

/** Process-global initialization guard: `srt` holds one session per process. */
let initialized: { key: string; promise: Promise<void> } | null = null;

function configKey(config: SandboxRuntimeConfig): string {
	return JSON.stringify({
		network: config.network,
		filesystem: config.filesystem,
	});
}

export interface SrtSandboxOptions {
	/** Abort an in-flight initialize. */
	signal?: AbortSignal;
}

/**
 * Build a sandbox for one hand. Throws when the sandbox cannot be enforced.
 *
 * `srt` is a process-global session, so a second hand in the same process with a
 * different policy is a configuration error rather than a silent merge.
 */
export async function createSrtSandbox(
	policy: HandPolicy,
	log: Logger,
	options: SrtSandboxOptions = {},
): Promise<SandboxWrapper> {
	if (!SandboxManager.isSupportedPlatform()) {
		throw new Error(`the sandbox runtime does not support ${process.platform}`);
	}

	const dependencies = await SandboxManager.checkDependenciesAsync();
	if (dependencies.errors.length > 0) {
		throw new Error(
			`sandbox dependencies are missing: ${dependencies.errors.join("; ")}` +
				(process.platform === "linux" ? " (install bubblewrap, or run with sandbox disabled)" : ""),
		);
	}
	for (const warning of dependencies.warnings) log.warn("sandbox dependency warning", { warning });

	const config = buildSandboxConfig(policy);
	const key = configKey(config);

	if (initialized && initialized.key !== key) {
		throw new Error(
			"a sandbox with a different policy is already initialized in this process; " +
				"one hand per process can own the sandbox runtime",
		);
	}
	if (!initialized) {
		initialized = { key, promise: SandboxManager.initialize(config, undefined, true) };
	}
	await initialized.promise;

	// Resolve the shell once, absolutely. `srt` otherwise looks `bash` up in PATH
	// at wrap time, which is both a startup race and a dependency on the very
	// environment the sandbox is about to replace.
	const binShell = process.platform === "win32" ? undefined : resolvePosixShell();

	log.info("sandbox initialized", {
		platform: process.platform,
		allowWrite: policy.roots,
		denyRead: policy.denyReadPaths,
		denyWrite: policy.denyWritePaths,
		allowedDomains: policy.network.allowedDomains,
		deniedDomains: policy.network.deniedDomains,
		allowLocalBinding: policy.network.allowLocalBinding,
	});

	return {
		kind: "srt",
		network: {
			allowedDomains: policy.network.allowedDomains,
			deniedDomains: policy.network.deniedDomains,
		},
		async wrap(argv, wrapOptions) {
			const command = shellQuote(argv);
			// `srt` locates its shell by spawning `which` with a 1s timeout, so a
			// loaded machine can make a healthy shell look missing. Retry briefly
			// instead of failing a task for a scheduling artefact; anything that is
			// not that artefact is surfaced immediately.
			let lastError: Error | null = null;
			for (let attempt = 0; attempt < 4; attempt++) {
				try {
					const wrapped = await SandboxManager.wrapWithSandboxArgv(
						command,
						binShell,
						undefined,
						options.signal,
						wrapOptions.cwd,
						{ commandId: wrapOptions.commandId },
					);
					return { argv: wrapped.argv, env: wrapped.env };
				} catch (err) {
					lastError = err as Error;
					if (!/not found in PATH|ETIMEDOUT|timed out/i.test(lastError.message)) throw lastError;
					log.warn("sandbox wrap retry", { attempt: attempt + 1, error: lastError.message });
					await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
				}
			}
			throw lastError ?? new Error("sandbox wrap failed");
		},
		annotate(commandId, stderr) {
			return SandboxManager.annotateStderrWithSandboxFailures(commandId, stderr);
		},
		violations(commandId) {
			try {
				return SandboxManager.getSandboxViolationStore().getViolationsForCommand(commandId);
			} catch {
				return [];
			}
		},
		cleanup() {
			SandboxManager.cleanupAfterCommand();
		},
		async dispose() {
			if (!initialized) return;
			initialized = null;
			await SandboxManager.reset();
		},
	};
}

// ---------------------------------------------------------------------------
// Confined: reads *and* writes inside the roots
// ---------------------------------------------------------------------------

/**
 * A sandbox that confines reads, which `srt` does not.
 *
 * `srt` is a write fence: `allowWrite` exists, `allowRead` does not, so a hand's
 * root says where a Worker may *put* things and nothing about what it may look at.
 * That is the right shape for a hand the member configured themselves — it can read
 * its own toolchain — and the wrong shape for a space, where the promise is "this
 * folder and nothing else".
 *
 * So this backend is the OS's own primitive, applied whole:
 *
 *   - **macOS** — `sandbox-exec` with a seatbelt profile that denies by default and
 *     allows reads of the roots plus the system toolchain (binaries, libraries,
 *     locale), writes of the roots plus temp, and no network at all.
 *   - **Linux** — `bwrap` with a read-only bind of the system directories, a
 *     read-write (or read-only, by `fs`) bind of the roots, a tmpfs for `/tmp`, and
 *     `--unshare-net`.
 *
 * It fails closed: no `sandbox-exec`, no `bwrap`, no sandbox. A boundary an operator
 * believes in is worse than one they know is missing.
 */

/** Directories a process needs to start at all. Read-only; never a member's data. */
const SYSTEM_READ = [
	"/usr/bin",
	"/usr/sbin",
	"/usr/lib",
	"/usr/libexec",
	"/usr/share",
	"/usr/local",
	"/opt/homebrew",
	"/bin",
	"/sbin",
	"/lib",
	"/lib64",
	"/etc",
	"/private/etc",
	"/System/Library",
	"/Library/Apple",
	"/private/var/db/dyld",
	"/dev",
] as const;

function seatbeltString(value: string): string {
	// Seatbelt profiles are s-expressions; a quote or backslash in a path would end
	// the literal early and change the policy.
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Every directory from `target` up to `/`, the target first. */
function ancestorsOf(target: string): string[] {
	const out: string[] = [];
	let current = target;
	for (let hops = 0; hops < 64; hops += 1) {
		out.push(current);
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return out;
}

/** The real path, or the path as given when it does not exist yet. */
function realOrSelf(target: string): string {
	try {
		return fs.realpathSync(target);
	} catch {
		return path.resolve(target);
	}
}

/**
 * The seatbelt profile for a policy: deny by default, allow the roots and the OS.
 *
 * Two details that cost an afternoon each if you get them wrong:
 *
 *   - **Ancestors need a read rule of their own.** A process walks `/`, `/Users`,
 *     `/Users/orchid` before it opens `/Users/orchid/space/file`. `subpath` on the
 *     leaf does not cover the walk, and the denial surfaces as `sandbox-exec`
 *     aborting with no message at all.
 *   - **Paths are resolved.** `/tmp/x` is really `/private/tmp/x`, and a profile
 *     written in the first form allows nothing.
 */
export function buildSeatbeltProfile(policy: HandPolicy, capabilities: HandCapabilities): string {
	const read = new Set<string>(SYSTEM_READ);
	const write = new Set<string>(["/private/tmp", "/private/var/folders", "/dev"]);
	for (const root of policy.roots) {
		const real = realOrSelf(root);
		read.add(real);
		if (capabilities.fs === "rw") write.add(real);
	}
	const denied = policy.denyReadPaths.map(realOrSelf);
	for (const entry of denied) read.delete(entry);

	const readLeaves = [...read].filter((entry) => !denied.some((d) => entry === d || entry.startsWith(`${d}/`)));
	const ancestors = new Set<string>(["/"]);
	for (const entry of [...readLeaves, ...write]) {
		for (const parent of ancestorsOf(entry).slice(1)) ancestors.add(parent);
	}

	const literal = (entry: string) => `  (literal ${seatbeltString(entry)})`;
	const subpath = (entry: string) => `  (subpath ${seatbeltString(entry)})`;
	const section = (kind: string, entries: string[], render: (entry: string) => string) =>
		entries.length === 0 ? "" : `(${kind}\n${entries.map(render).join("\n")}\n)`;

	return [
		"(version 1)",
		"(deny default)",
		"(allow process*)",
		"(allow signal)",
		"(allow sysctl-read)",
		"(allow mach-lookup)",
		"(allow file-read-metadata)",
		section("allow file-read*", [...ancestors], literal),
		section("allow file-read*", readLeaves, subpath),
		section("allow file-write*", [...ancestors], literal),
		section("allow file-write*", [...write], subpath),
		section("deny file-read*", denied, subpath),
		policy.network.allowedDomains.length === 0 && policy.network.deniedDomains.length === 0
			? "(deny network*)"
			: "(allow network*)",
	]
		.filter((line) => line !== "")
		.join("\n");
}

/** The `bwrap` argv that puts a command inside the roots and nothing else. */
export function buildBwrapArgv(policy: HandPolicy, capabilities: HandCapabilities, argv: string[], cwd?: string): string[] {
	const args = ["--die-with-parent", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp"];
	if (policy.network.allowedDomains.length === 0) args.push("--unshare-net");
	const seen = new Set<string>();
	for (const dir of SYSTEM_READ) {
		if (!fs.existsSync(dir) || seen.has(dir)) continue;
		seen.add(dir);
		args.push("--ro-bind", dir, dir);
	}
	for (const root of policy.roots) {
		if (!fs.existsSync(root)) continue;
		// `fs` is the hand's own grant: read-write hands bind writable, read-only hands
		// bind read-only, and the guest cannot talk its way past a bind mount.
		args.push(capabilities.fs === "rw" ? "--bind" : "--ro-bind", root, root);
	}
	if (cwd !== undefined && fs.existsSync(cwd)) args.push("--chdir", cwd);
	args.push("--", ...argv);
	return args;
}

export interface ConfinedSandboxOptions {
	readonly platform?: NodeJS.Platform;
	/** Resolved once so a wrap is cheap. */
	readonly sandboxExec?: string;
	readonly bwrap?: string;
}

/**
 * Build a read-confining sandbox for one hand.
 *
 * Throws when the platform's primitive is missing — the caller reports that as a
 * hand that cannot start, not as a hand that runs unconfined.
 */
export function createConfinedSandbox(
	policy: HandPolicy,
	capabilities: HandCapabilities,
	log: Logger,
	options: ConfinedSandboxOptions = {},
): SandboxWrapper {
	const platform = options.platform ?? process.platform;
	if (platform === "darwin") {
		const sandboxExec = options.sandboxExec ?? "/usr/bin/sandbox-exec";
		if (!fs.existsSync(sandboxExec)) throw new Error(`${sandboxExec} is missing: a confined hand needs it`);
		const profile = buildSeatbeltProfile(policy, capabilities);
		log.info("confined sandbox initialized", {
			kind: "seatbelt",
			read: policy.roots,
			write: policy.roots,
			denied: policy.denyReadPaths,
		});
		return {
			kind: "confined",
			network: { allowedDomains: policy.network.allowedDomains, deniedDomains: policy.network.deniedDomains },
			async wrap(argv) {
				return { argv: [sandboxExec, "-p", profile, ...argv], env: {} };
			},
			annotate(_commandId, stderr) {
				return stderr.replace(/sandbox-exec: /g, "sandbox: ");
			},
			violations() {
				return [];
			},
			cleanup() {},
			async dispose() {},
		};
	}
	if (platform === "linux") {
		const bwrap = options.bwrap ?? "bwrap";
		const found = [bwrap, "/usr/bin/bwrap", "/bin/bwrap"].find((candidate) =>
			candidate.startsWith("/") ? fs.existsSync(candidate) : true,
		);
		if (found === undefined) throw new Error("bwrap is missing: a confined hand needs bubblewrap");
		log.info("confined sandbox initialized", {
			kind: "bwrap",
			read: policy.roots,
			write: policy.roots,
			denied: policy.denyReadPaths,
		});
		return {
			kind: "confined",
			network: { allowedDomains: policy.network.allowedDomains, deniedDomains: policy.network.deniedDomains },
			async wrap(argv, wrapOptions) {
				return { argv: [found, ...buildBwrapArgv(policy, capabilities, argv, wrapOptions.cwd)], env: {} };
			},
			annotate(_commandId, stderr) {
				return stderr;
			},
			violations() {
				return [];
			},
			cleanup() {},
			async dispose() {},
		};
	}
	throw new Error(`no read-confining sandbox for ${platform}`);
}

/** Build the sandbox a policy asks for. `none` is the caller's business, not ours. */
export async function createSandbox(
	policy: HandPolicy,
	capabilities: HandCapabilities,
	log: Logger,
	options: SrtSandboxOptions & ConfinedSandboxOptions = {},
): Promise<SandboxWrapper> {
	if (policy.sandbox === "confined") return createConfinedSandbox(policy, capabilities, log, options);
	return createSrtSandbox(policy, log, options);
}

/** Absolute path to a POSIX shell for `srt` to run wrapped commands with. */
function resolvePosixShell(): string {
	for (const candidate of ["/bin/bash", "/usr/bin/bash", "/bin/sh", "/usr/bin/sh"]) {
		if (fs.existsSync(candidate)) return candidate;
	}
	return "/bin/sh";
}

/** True when the sandbox runtime can enforce policy on this machine. */
export function sandboxSupported(): boolean {
	return SandboxManager.isSupportedPlatform();
}
