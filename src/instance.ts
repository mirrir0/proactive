/**
 * `<runtime>/instance.json`, 0600, carrying the token because the socket's permissions are
 * the token's. It never carries a provider key. A record whose pid is gone is removed.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { MirPaths } from "./paths.ts";

export interface MirInstance {
	/** The client API socket. */
	socket: string;
	/** What a client presents. */
	token: string;
	pid: number;
	startedAt: number;
	/** The version this daemon speaks. */
	protocol: number;
	/** When it listens. */
	hands?: { port: number };
	/** When it is served. */
	dashboard?: { port: number };
}

	/** The record's path for an install. */
export function instanceFile(paths: MirPaths): string {
	return join(paths.runtime, "instance.json");
}

/** Write the record for a daemon that is now listening. */
export function writeInstance(paths: MirPaths, instance: MirInstance): void {
	writeFileSync(instanceFile(paths), `${JSON.stringify(instance, null, "\t")}\n`, { mode: 0o600 });
}

	/** A crash leaves it; `readInstance` copes. */
export function removeInstance(paths: MirPaths): void {
	rmSync(instanceFile(paths), { force: true });
}

	/** A record whose process is gone is removed and treated as absent: a stale record reads as "mir is broken". */
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
