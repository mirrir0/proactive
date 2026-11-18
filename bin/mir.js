#!/usr/bin/env node
/**
 * `mir` — the one executable.
 *
 * Everything mir does is reachable from this command: the brain (`daemon`,
 * `serve`, `start`), its administration (`status`, `hands`, `recall`, `metrics`,
 * `paths`, `init`), and the hand (`endpoint`). The hand used to be a second bin,
 * `mir-endpoint`, which meant an operator had two things to install to get one
 * system — and the endpoint is not a different program, it is a different role.
 *
 * Resolution: the compiled build when there is one (what `npm i -g` installs),
 * otherwise the TypeScript source through tsx (a checkout). Both are resolved
 * from this file, never from the working directory, so `mir` behaves the same
 * from a shell, from pm2, and from a launchd unit.
 */

import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const built = path.join(root, "dist", "index.js");
const source = path.join(root, "src", "index.ts");
const args = process.argv.slice(2);

if (existsSync(built)) {
	process.argv = [process.argv[0], built, ...args];
	await import(built);
} else if (existsSync(source)) {
	const child = spawn(process.execPath, ["--import", "tsx", source, ...args], { stdio: "inherit" });
	child.on("exit", (code, signal) => {
		if (signal) process.kill(process.pid, signal);
		else process.exit(code ?? 0);
	});
} else {
	console.error("mir: no build found. Run `npm run build`, or install the package instead of a checkout.");
	process.exit(1);
}
