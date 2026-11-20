/**
 * The sandbox a hand's work runs inside: `srt` (seatbelt, bubblewrap, WFP) with host-side
 * proxies for network allowlisting, or `confined` for a fence that also restricts reads.
 *
 * Two invariants: a sandbox that cannot be provided throws rather than downgrading
 * silently, and argv is shell-quoted element by element because `srt` takes a string.
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

	/** Every element single-quoted; a literal quote becomes `'\''`. This is what stops a second command. */
export function shellQuote(argv: string[]): string {
	return argv
		.map((arg) => `'${String(arg).replace(/'/g, `'\\''`)}'`)
		.join(" ");
}

	/** Reads are open and narrowed by `denyReadPaths`; writes and network are allow-only. */
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

	/** `srt` is process-global, so a second hand with another policy is a configuration error. */
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
 * `srt` has `allowWrite` and no `allowRead`, so a hand's root says where a Worker may put
 * things and nothing about what it may look at. This is the OS primitive applied whole —
 * `sandbox-exec` with a deny-by-default seatbelt profile, or `bwrap` with read-only system
 * binds and `--unshare-net`. It fails closed.
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
	// Configuration a tool needs to run at all. Not secrets — `~/.ssh`, `~/.aws` and the
	// brain's own state stay denied — but `git` refuses to start without its config, and
	// a Worker that cannot run `git status` reports the sandbox as a broken machine.
	"/etc/gitconfig",
] as const;

/** Single files a tool needs, read as literals: `subpath` does not match a file. */
const SYSTEM_READ_FILES = ["~/.gitconfig", "~/.gitignore_global", "~/.config/git/config"] as const;

/** A `~` path as an absolute one. */
function homeOf(entry: string): string {
	return entry.startsWith("~/") ? path.join(process.env["HOME"] ?? "", entry.slice(2)) : entry;
}

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
 * Two details that cost an afternoon each: ancestors need a read rule of their own (a
 * `subpath` on the leaf does not cover the walk, and the denial is a silent abort), and
 * paths must be resolved (`/tmp` is `/private/tmp`).
 */
export function buildSeatbeltProfile(policy: HandPolicy, capabilities: HandCapabilities): string {
	const read = new Set<string>(SYSTEM_READ);
	const write = new Set<string>(["/private/tmp", "/private/var/folders", "/dev"]);
	for (const root of policy.roots) {
		const real = realOrSelf(root);
		read.add(real);
		if (capabilities.fs === "rw") write.add(real);
	}
	const readFiles = new Set<string>(SYSTEM_READ_FILES.map(homeOf));
	const denied = policy.denyReadPaths.map(realOrSelf);
	for (const file of readFiles) {
		// An operator who denies it wins: the deny rules are rendered after the allows.
		if (denied.some((entry) => file === entry || file.startsWith(`${entry}/`))) readFiles.delete(file);
	}
	for (const entry of denied) read.delete(entry);

	const readLeaves = [...read].filter((entry) => !denied.some((d) => entry === d || entry.startsWith(`${d}/`)));
	const ancestors = new Set<string>(["/"]);
	for (const entry of [...readLeaves, ...readFiles, ...write]) {
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
		section("allow file-read*", [...readFiles], literal),
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

	/** Throws when the primitive is missing: a hand that cannot start, not one that runs unconfined. */
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
