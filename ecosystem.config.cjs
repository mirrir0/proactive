/**
 * pm2 ecosystem for mir.
 *
 * Only the daemon is declared here; Workers (`mir-worker-<taskId>`) are spawned
 * on demand by the daemon via the pm2 API (ADR 0001).
 *
 *   pm2 start ecosystem.config.cjs
 */
module.exports = {
	apps: [
		{
			name: "mir-daemon",
			script: "src/index.ts",
			args: "daemon",
			cwd: __dirname,
			interpreter: process.execPath,
			interpreter_args: "--import tsx",
			autorestart: true,
			max_restarts: 20,
			restart_delay: 2000,
			watch: false,
		},
	],
};
