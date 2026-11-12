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
import {
	SandboxManager,
	getDefaultWritePaths,
	type SandboxRuntimeConfig,
	type SandboxViolationEvent,
} from "@anthropic-ai/sandbox-runtime";
import type { HandPolicy } from "./protocol.ts";
import type { Logger } from "../telemetry.ts";

export interface SandboxWrapResult {
	argv: string[];
	env: NodeJS.ProcessEnv;
}

export interface SandboxWrapper {
	readonly kind: "srt";
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
