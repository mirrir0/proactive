/**
 * instance.ts — which mir is running, and how to reach it.
 *
 * One daemon, not one per client. A stack that spawns its own brain per member ends
 * up with two brains on one machine, two stores, and a dashboard showing the wrong
 * one — so the daemon says where it is, and a client attaches to *that*.
 *
 * The record lives in the runtime directory (0600, in the user's own directory):
 *
 *     <runtime>/instance.json
 *     { "socket": "…/brain.sock", "token": "…", "pid": 1234,
 *       "startedAt": 1795…, "protocol": 1,
 *       "hands": { "port": 4700 }, "dashboard": { "port": 4788 } }
 *
 * It carries the token because the socket's permission is the token's permission:
 * both are 0600 in the same directory, and a client that can read one can already
 * connect with the other. What it never carries is a *provider* key — that is the
 * daemon's own environment.
 *
 * A stale record is worse than none: it sends a client to a socket nobody is
 * listening on, and the failure reads as "mir is broken" rather than "mir is not
 * running". So `readInstance` checks the pid, and the daemon removes the file on a
 * clean shutdown.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { MirPaths } from "./paths.ts";

export interface MirInstance {
	/** The client API socket. */
	socket: string;
	/** The bearer token a client presents. */
	token: string;
	pid: number;
	startedAt: number;
	/** The API version this daemon speaks. */
	protocol: number;
	/** Where its hands hub listens, when it does. */
	hands?: { port: number };
	/** Where its dashboard is served, when it is. */
	dashboard?: { port: number };
}

/** Where the record lives for a given install. */
export function instanceFile(paths: MirPaths): string {
	return join(paths.runtime, "instance.json");
}

/** Write the record for a daemon that is now listening. */
export function writeInstance(paths: MirPaths, instance: MirInstance): void {
	writeFileSync(instanceFile(paths), `${JSON.stringify(instance, null, "\t")}\n`, { mode: 0o600 });
}

/** Remove it, on a clean shutdown. A crash leaves it; `readInstance` copes. */
export function removeInstance(paths: MirPaths): void {
	rmSync(instanceFile(paths), { force: true });
}

/**
 * The instance this install says is running, or undefined.
 *
 * A record whose process is gone is removed and treated as absent: the alternative
 * is every client trying a dead socket and reporting the wrong cause.
 */
export function readInstance(paths: MirPaths): MirInstance | undefined {
	const file = instanceFile(paths);
	if (!existsSync(file)) return undefined;
	let parsed: MirInstance;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8")) as MirInstance;
	} catch {
		rmSync(file, { force: true });
		return undefined;
	}
	if (typeof parsed.socket !== "string" || typeof parsed.token !== "string" || !Number.isInteger(parsed.pid)) {
		rmSync(file, { force: true });
		return undefined;
	}
	if (!alive(parsed.pid)) {
		rmSync(file, { force: true });
		return undefined;
	}
	return parsed;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
