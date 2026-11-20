#!/usr/bin/env node
/**
 * The one executable: the brain (`daemon`, `serve`, `start`), its administration, and the
 * hand (`endpoint`) — a role, not a second program. Resolved from this file, never from the
 * working directory, so it behaves the same from a shell, pm2 and launchd.
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
