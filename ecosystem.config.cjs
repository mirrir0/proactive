/**
 * pm2 ecosystem for mir.
 *
 * Only the daemon is declared here; Workers (`mir-worker-<taskId>`) are spawned
 * on demand by the daemon via the pm2 API (ADR 0001).
 *
 *   pm2 start ecosystem.config.cjs
 */
const fs = require("node:fs");
const path = require("node:path");

// Resolve from this file, not from the working directory: a global install runs
// `mir start` from anywhere, and pm2 inherits whatever cwd the caller had.
const root = __dirname;
const built = path.join(root, "dist", "index.js");
const compiled = fs.existsSync(built);

module.exports = {
	apps: [
		{
			name: "mir-daemon",
			script: compiled ? built : path.join(root, "src", "index.ts"),
			args: "daemon",
			cwd: root,
			interpreter: process.execPath,
			...(compiled ? {} : { interpreter_args: "--import tsx" }),
			autorestart: true,
			max_restarts: 20,
			restart_delay: 2000,
			watch: false,
		},
	],
};
