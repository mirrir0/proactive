/**
 * Minimal .env loader. Existing process env wins (same as `node --env-file`).
 * Called at the top of every entrypoint so pm2-spawned processes get the key.
 */
import fs from "node:fs";
import path from "node:path";

export function loadEnv(file = ".env"): void {
	let raw: string;
	try {
		raw = fs.readFileSync(path.resolve(process.cwd(), file), "utf8");
	} catch {
		return;
	}
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq < 0) continue;
		const key = trimmed.slice(0, eq).trim();
		let val = trimmed.slice(eq + 1).trim();
		if (
			(val.startsWith('"') && val.endsWith('"')) ||
			(val.startsWith("'") && val.endsWith("'"))
		) {
			val = val.slice(1, -1);
		}
		if (process.env[key] === undefined) process.env[key] = val;
	}
}
