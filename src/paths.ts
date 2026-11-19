/**
 * paths.ts — where a mir install keeps its files, on the platform it is on.
 *
 * One rule, three answers, and the answers are conventions rather than opinions:
 *
 *   - **Linux** follows the XDG Base Directory specification: `~/.config/mir`,
 *     `~/.local/share/mir`, `~/.local/state/mir`, `~/.cache/mir`, and sockets in
 *     `$XDG_RUNTIME_DIR/mir` when the session provides one. Each is overridable by
 *     its own XDG variable, which is what makes mir work under systemd, in a
 *     container with a mounted volume, or in a Flatpak-style sandbox.
 *   - **macOS** follows Apple's file-system guidance: `~/Library/Application
 *     Support/mir` for data and configuration, `~/Library/Logs/mir` for logs,
 *     `~/Library/Caches/mir` for caches. There is no runtime directory on macOS,
 *     so sockets live in `<support>/run`.
 *   - **Anything else** falls back to the XDG shape under the home directory, so a
 *     platform nobody has ported yet still has a place to put things.
 *
 * `MIR_HOME` overrides all of it with one directory — what a container wants, and
 * what a test wants — and the per-path variables (`MIR_STATE_DIR`, `MIR_SOCKET_PATH`,
 * …) still win over everything, because they are what an existing deployment sets.
 *
 * **A unix socket path has a hard limit** — 104 bytes on macOS, 108 on Linux — and
 * going over it fails with `ENAMETOOLONG` at bind time, long after the operator
 * stopped looking. `socketFits()` checks it where the path is made, so the error
 * names the limit and the variable that moves the socket.
 */

import { homedir, platform as hostPlatform } from "node:os";
import { join, resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

export interface MirPaths {
	/** The root the others were derived from (`MIR_HOME`, or the platform's). */
	readonly home: string;
	/** `config.json` lives here. */
	readonly config: string;
	/** Durable data: the SQLite store, the queue, per-task sessions. */
	readonly data: string;
	/** Things that describe a running install: pid, sockets, worker state. */
	readonly state: string;
	/** Caches that can be thrown away: MCP tool lists, model metadata. */
	readonly cache: string;
	/** Log files. */
	readonly logs: string;
	/** Where sockets go. Short on purpose: see `socketFits`. */
	readonly runtime: string;
	/** The daemon's control socket. */
	readonly daemonSocket: string;
	/** The hands hub's client socket. */
	readonly handsSocket: string;
	/** Where an HTTP-less channel drops events. */
	readonly queueDir: string;
	/** Per-task pi sessions. */
	readonly sessions: string;
	/** OAuth tokens for HTTP MCP servers. */
	readonly mcpOauth: string;
	/** The config file an `init` writes. */
	readonly configFile: string;
}

export interface MirPathsInput {
	readonly env?: NodeJS.ProcessEnv;
	readonly platform?: NodeJS.Platform;
	readonly home?: string;
}

/** The longest a unix socket path may be, by platform. */
export function socketLimit(platform: NodeJS.Platform = hostPlatform()): number {
	// `sockaddr_un.sun_path` is 104 on the BSDs (macOS included) and 108 on Linux;
	// the terminating NUL is not available to us on the former.
	return platform === "darwin" ? 103 : 107;
}

export function socketFits(path: string, platform: NodeJS.Platform = hostPlatform()): boolean {
	return Buffer.byteLength(path, "utf8") <= socketLimit(platform);
}

function firstSet(...values: Array<string | undefined>): string | undefined {
	for (const value of values) if (value !== undefined && value !== "") return value;
	return undefined;
}

export function mirPaths(input: MirPathsInput = {}): MirPaths {
	const env = input.env ?? process.env;
	const platform = input.platform ?? hostPlatform();
	const home = input.home ?? homedir();

	// `MIR_HOME` is the whole answer when it is set: one directory, every part of
	// the layout inside it.
	const override = firstSet(env.MIR_HOME);
	if (override !== undefined) {
		const root = resolve(override);
		return layout(
			root,
			join(root, "config"),
			join(root, "data"),
			join(root, "state"),
			join(root, "cache"),
			join(root, "logs"),
			join(root, "run"),
			env,
		);
	}

	if (platform === "darwin") {
		const support = join(home, "Library", "Application Support", "mir");
		return layout(
			support,
			join(support, "config"),
			join(support, "data"),
			join(support, "state"),
			join(home, "Library", "Caches", "mir"),
			join(home, "Library", "Logs", "mir"),
			// No runtime directory on macOS; sockets beside the data, kept short.
			join(support, "run"),
			env,
		);
	}

	// Linux and everything else: XDG, with the specification's own defaults.
	const configHome = firstSet(env.XDG_CONFIG_HOME) ?? join(home, ".config");
	const dataHome = firstSet(env.XDG_DATA_HOME) ?? join(home, ".local", "share");
	const stateHome = firstSet(env.XDG_STATE_HOME) ?? join(home, ".local", "state");
	const cacheHome = firstSet(env.XDG_CACHE_HOME) ?? join(home, ".cache");
	const runtimeBase = firstSet(env.XDG_RUNTIME_DIR);
	return layout(
		join(dataHome, "mir"),
		join(configHome, "mir"),
		join(dataHome, "mir"),
		join(stateHome, "mir"),
		join(cacheHome, "mir"),
		join(stateHome, "mir", "logs"),
		runtimeBase === undefined ? join(stateHome, "mir", "run") : join(runtimeBase, "mir"),
		env,
	);
}

function layout(
	home: string,
	config: string,
	data: string,
	state: string,
	cache: string,
	logs: string,
	runtime: string,
	env: NodeJS.ProcessEnv,
): MirPaths {
	const daemonSocket = firstSet(env.MIR_SOCKET_PATH) ?? join(runtime, "daemon.sock");
	const handsSocket = firstSet(env.MIR_HANDS_SOCKET) ?? join(runtime, "hands.sock");
	return {
		home,
		config,
		data: firstSet(env.MIR_DATA_DIR) ?? data,
		state: firstSet(env.MIR_STATE_DIR) ?? state,
		cache,
		logs,
		runtime,
		daemonSocket,
		handsSocket,
		queueDir: firstSet(env.MIR_QUEUE_DIR) ?? join(data, "queue"),
		sessions: firstSet(env.MIR_ROUTER_SESSION) ?? join(data, "router.session"),
		mcpOauth: firstSet(env.MIR_MCP_OAUTH_DIR) ?? join(data, "mcp-oauth"),
		configFile: join(config, "config.json"),
	};
}

/** The directories an install needs, in the order a person reads them. */
export function requiredDirs(paths: MirPaths): Array<{ name: string; path: string }> {
	return [
		{ name: "config", path: paths.config },
		{ name: "data", path: paths.data },
		{ name: "state", path: paths.state },
		{ name: "cache", path: paths.cache },
		{ name: "logs", path: paths.logs },
		{ name: "run", path: paths.runtime },
		{ name: "queue", path: paths.queueDir },
		{ name: "sessions", path: paths.sessions },
		{ name: "mcp-oauth", path: paths.mcpOauth },
	];
}

/** Create every directory an install needs; returns the ones that were new. */
export function ensurePaths(paths: MirPaths): string[] {
	const created: string[] = [];
	for (const dir of requiredDirs(paths)) {
		if (existsSync(dir.path)) continue;
		mkdirSync(dir.path, { recursive: true, mode: 0o700 });
		created.push(dir.path);
	}
	return created;
}
