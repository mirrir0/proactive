#!/usr/bin/env node
/**
 * `mir-endpoint` launcher.
 *
 * Prefers the compiled build (what `npm i -g` installs) and falls back to the
 * TypeScript source through tsx, so the same binary works from a checkout.
 */
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const built = path.join(root, "dist", "endpoint", "main.js");
const source = path.join(root, "src", "endpoint", "main.ts");

if (existsSync(built)) {
	await import(built);
} else if (existsSync(source)) {
	const child = spawn(process.execPath, ["--import", "tsx", source, ...process.argv.slice(2)], {
		stdio: "inherit",
	});
	child.on("exit", (code, signal) => {
		if (signal) process.kill(process.pid, signal);
		else process.exit(code ?? 0);
	});
} else {
	console.error("mir-endpoint: build not found. Run `npm run build` first.");
	process.exit(1);
}
