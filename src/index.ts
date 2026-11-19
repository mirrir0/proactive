/**
 * mir CLI.
 *
 *   mir serve             run the daemon and its client API (what a display connects to)
 *   mir daemon            run the daemon in the foreground (dev; terminal channel)
 *   mir start|stop        manage mir-daemon under pm2
 *   mir status            tasks + workers, read from the durable store (works offline)
 *   mir recall <query>    search spilled context (tasks, triggers, conclusions)
 *   mir send <text>       POST an event to the HTTP channel
 *   mir metrics           print the metrics snapshot from the metrics endpoint
 */

import { loadEnv } from "./env.ts";
import { buildConfig, runDaemon } from "./daemon.ts";
import { ProcessManager } from "./process-manager.ts";
import { MirStore } from "./store.ts";
import crypto from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hashToken } from "./hands/protocol.ts";
import { runEndpoint } from "./endpoint/main.ts";
import { ensurePaths, mirPaths, requiredDirs, socketFits, socketLimit } from "./paths.ts";

function usage(): void {
	console.log(
		[
			"mir <command>",
			"",
			"  init              create this machine's mir directories and config",
			"  paths             print where this install keeps its files",
			"  serve             run the daemon with its client API on (see MIR_API_*)",
			"  daemon            run the daemon in the foreground (dev)",
			"  start             start mir-daemon under pm2",
			"  stop              stop/delete mir-daemon",
			"  restart           restart mir-daemon",
			"  status            tasks + workers from the durable store",
			"  recall <query>    search spilled context objects",
			"  send <text>       POST an event to the HTTP channel",
			"  metrics           print the metrics endpoint snapshot",
			"",
			"  hands list        registered hands and their last known state",
			"  hands add         register a hand; prints its token once",
			"  hands revoke <id> stop accepting a hand",
			"  hands rm <id>     forget a hand",
			"  hands work        recent work dispatched to hands",
			"",
			"  endpoint          run the hand on this machine: the endpoint that does the work",
			"",
		].join("\n"),
	);
}

async function pm2ctl(cmd: string): Promise<void> {
	const pm2mod: any = await import("pm2");
	const pm2 = pm2mod.default ?? pm2mod;
	await new Promise<void>((res, rej) => pm2.connect((e: Error | null) => (e ? rej(e) : res())));
	try {
		await new Promise<void>((res, rej) => {
			const done = (e: Error | null) => (e ? rej(e) : res());
			if (cmd === "start") {
				pm2.start(
					{
						name: "mir-daemon",
						script: "src/index.ts",
						args: "daemon",
						cwd: process.cwd(),
						interpreter: process.execPath,
						interpreter_args: "--import tsx",
						autorestart: true,
					},
					done,
				);
			} else if (cmd === "stop") pm2.delete("mir-daemon", done);
			else if (cmd === "restart") pm2.restart("mir-daemon", done);
			else done(null);
		});
	} finally {
		await new Promise<void>((res) => pm2.disconnect(() => res()));
	}
	console.log(`[mir] ${cmd} done`);
}

function printStatus(store: MirStore): void {
	const tasks = store.listTasks();
	const workers = store.listWorkers();
	const counts = store.counts();
	console.log(`state: ${JSON.stringify(counts)}`);
	if (tasks.length === 0) {
		console.log("no tasks");
	} else {
		console.log("\ntasks:");
		for (const t of tasks.slice(-30)) {
			const when = new Date(t.updatedAt).toISOString();
			console.log(
				`  ${t.id}  ${t.status.padEnd(9)} ${t.fast ? "fast " : "     "} ${when}  ${t.title}${
					t.error ? `  (${t.error})` : ""
				}`,
			);
		}
	}
	if (workers.length > 0) {
		console.log("\nworkers (last known):");
		for (const w of workers) {
			console.log(
				`  ${w.id}  task=${w.taskId}  ${w.status}  heartbeat ${Math.round(
					(Date.now() - w.lastHeartbeat) / 1000,
				)}s ago  ${w.progress ?? ""}`,
			);
		}
	}
}

async function main(): Promise<void> {
	loadEnv();
	const [cmd, ...rest] = process.argv.slice(2);

	if (!cmd || cmd === "daemon") {
		await runDaemon();
		return;
	}

	/**
	 * `mir serve` — the brain as a service: the daemon, plus the door a display
	 * connects to. The socket and token come from the environment, and a serve
	 * with no token is refused: a brain that answers anyone who can open a socket
	 * is not one to leave running.
	 */
	if (cmd === "serve") {
		const socket = process.env.MIR_API_SOCKET ?? join(mirPaths().runtime, "brain.sock");
		const token = process.env.MIR_API_TOKEN ?? "";
		if (token === "") {
			console.error(
				"mir serve needs MIR_API_TOKEN (any long random string). The client sends it as its bearer.",
			);
			process.exit(1);
		}
		process.env.MIR_API_SOCKET = socket;
		// A brain can outlive the host that started it: its socket is a file and its
		// parent is gone. The host reaps a stale one through this file before it
		// starts a new one, so a restart never leaves two brains of one member
		// fighting over one socket — the old one keeps serving with the old env.
		const pidFile = process.env.MIR_BRAIN_PID_FILE ?? "";
		if (pidFile !== "") {
			mkdirSync(dirname(pidFile), { recursive: true });
			writeFileSync(pidFile, String(process.pid), { mode: 0o600 });
			const clear = (): void => {
				try {
					rmSync(pidFile, { force: true });
				} catch {
					// A pid file that cannot be removed is stale, not fatal.
				}
			};
			process.on("exit", clear);
			for (const signal of ["SIGINT", "SIGTERM"] as const) {
				process.on(signal, () => {
					clear();
					process.exit(0);
				});
			}
		}
		await runDaemon();
		return;
	}

	if (cmd === "start" || cmd === "stop" || cmd === "restart") {
		await pm2ctl(cmd);
		return;
	}

	const config = buildConfig();

	if (cmd === "status") {
		const store = MirStore.open(config.stateDir);
		printStatus(store);
		const pm = new ProcessManager();
		const live = await pm.listWorkers().catch(() => []);
		await pm.disconnect().catch(() => {});
		if (live.length > 0) {
			console.log("\npm2 worker processes:");
			for (const p of live) console.log(`  ${p.name}  ${p.status}  pid=${p.pid ?? "-"}`);
		}
		store.close();
		return;
	}

	if (cmd === "recall") {
		const query = rest.join(" ").trim();
		if (!query) {
			console.error("usage: mir recall <query>");
			process.exit(1);
		}
		const store = MirStore.open(config.stateDir);
		const hits = store.searchObjects(query, undefined, 20);
		if (hits.length === 0) console.log(`no objects match "${query}"`);
		for (const hit of hits) {
			console.log(`[${hit.type}] ${hit.id}\n  ${hit.summary}\n  ref: ${hit.ref}`);
		}
		store.close();
		return;
	}

	if (cmd === "send") {
		const text = rest.join(" ").trim();
		if (!text) {
			console.error("usage: mir send <text>");
			process.exit(1);
		}
		const headers: Record<string, string> = { "content-type": "application/json" };
		if (config.httpToken) headers["x-mir-token"] = config.httpToken;
		const res = await fetch(`http://${config.httpHost}:${config.httpPort}/channels/http/events`, {
			method: "POST",
			headers,
			body: JSON.stringify({ text, from: "cli", reply_to: process.env.MIR_REPLY_TO }),
		});
		console.log(res.status, await res.text());
		return;
	}

	if (cmd === "hands") {
		const [sub, ...args] = rest;
		const store = MirStore.open(config.stateDir);
		try {
			if (sub === "add") {
				const id = args[0];
				if (!id) {
					console.error('usage: mir hands add <id> [--name "Display Name"]');
					process.exit(1);
				}
				const nameIndex = args.indexOf("--name");
				const name = nameIndex >= 0 ? (args[nameIndex + 1] ?? id) : id;
				const token = crypto.randomBytes(24).toString("base64url");
				store.createEndpoint({ id, name, tokenHash: hashToken(token) });
				const hub = `${config.hands.host}:${config.hands.port}`;
				console.log(`registered hand "${id}" (${name})`);
				console.log("");
				console.log("Token (shown once — store it on the machine, not in git):");
				console.log(`  ${token}`);
				console.log("");
				console.log("Run this on that machine:");
				console.log(
					[
						`  mir-endpoint --hub ${hub} --id ${id} --token ${token}`,
						`               --root ~/work --allow git,ls,cat,rg,node,pnpm --fs rw`,
						config.hands.tlsCert ? "               --tls --ca /path/to/ca.pem" : "",
					]
						.filter(Boolean)
						.join("\n"),
				);
				return;
			}
			if (sub === "list" || sub === undefined) {
				const endpoints = store.listEndpoints();
				if (endpoints.length === 0) {
					console.log("no hands registered (the daemon's local hand is not registered here)");
					return;
				}
				for (const endpoint of endpoints) {
					const state = endpoint.revokedAt
						? `revoked ${new Date(endpoint.revokedAt).toISOString()}`
						: endpoint.lastSeen > 0
							? `last seen ${Math.round((Date.now() - endpoint.lastSeen) / 1000)}s ago`
							: "never connected";
					console.log(`${endpoint.id}  ${endpoint.kind}  ${endpoint.name}  — ${state}`);
					if (endpoint.capabilities && Object.keys(endpoint.capabilities).length) {
						console.log(`  capabilities: ${JSON.stringify(endpoint.capabilities)}`);
					}
				}
				return;
			}
			if (sub === "revoke") {
				const id = args[0];
				if (!id || !store.revokeEndpoint(id)) {
					console.error(`no such hand: ${id ?? "(missing id)"}`);
					process.exit(1);
				}
				console.log(`revoked ${id}`);
				return;
			}
			if (sub === "rm") {
				const id = args[0];
				if (!id || !store.deleteEndpoint(id)) {
					console.error(`no such hand: ${id ?? "(missing id)"}`);
					process.exit(1);
				}
				console.log(`removed ${id}`);
				return;
			}
			if (sub === "work") {
				const work = store.listWork(20);
				if (work.length === 0) {
					console.log("no work dispatched yet");
					return;
				}
				for (const item of work) {
					console.log(
						`${new Date(item.startedAt).toISOString()}  ${item.endpointId}  ${item.op}  ${
							item.ok ? "ok" : "failed"
						}  ${Math.round(item.durationMs)}ms${item.error ? `  (${item.error})` : ""}`,
					);
				}
				return;
			}
			console.error(`unknown hands command: ${sub ?? "(none)"}\n`);
			usage();
			process.exit(1);
		} finally {
			store.close();
		}
	}

	/**
	 * `mir init` — put the files where this platform says they go.
	 *
	 * Idempotent: it creates what is missing and keeps a config it finds.
	 */
	if (cmd === "init") {
		if (rest.includes("--help") || rest.includes("-h")) {
			usage();
			return;
		}
		const paths = mirPaths();
		const force = rest.includes("--force");
		const created = ensurePaths(paths);
		const config = configExists(paths.configFile) && !force ? "kept" : writeConfig(paths.configFile, paths);
		const sockets = [paths.daemonSocket, paths.handsSocket].filter((path) => !socketFits(path));

		console.log(`mir home   ${paths.home}`);
		for (const dir of requiredDirs(paths)) console.log(`  ${dir.name.padEnd(10)} ${dir.path}`);
		console.log(`  config file ${paths.configFile} (${config})`);

		if (sockets.length > 0) {
			console.error(
				[
					"",
					`This socket path is too long to bind (limit ${socketLimit()} bytes):`,
					...sockets.map((path) => `  ${path}`),
					"Set MIR_HOME (or MIR_SOCKET_PATH / MIR_HANDS_SOCKET) to a shorter directory.",
				].join("\n"),
			);
			process.exitCode = 1;
		}

		if (created.length === 0) console.log("\nnothing to create: this install was already initialized.");
		console.log(
			[
				"",
				"next:",
				"  mir daemon        run the brain in the foreground",
				"  mir start         run it under pm2",
				"  mir hands add <id>  register a machine that does the work",
				"  mir endpoint --hub host:port --id <id> --token <token>   run a hand",
			].join("\n"),
		);
		return;
	}

	/** `mir paths` — the same layout, without touching the disk. */
	if (cmd === "paths") {
		const paths = mirPaths();
		const width = Math.max(...requiredDirs(paths).map((dir) => dir.name.length));
		console.log(`home       ${paths.home}`);
		for (const dir of requiredDirs(paths)) console.log(`${dir.name.padEnd(width)}   ${dir.path}`);
		console.log(`config file ${paths.configFile}`);
		console.log(`daemon     ${paths.daemonSocket}`);
		console.log(`hands      ${paths.handsSocket}`);
		return;
	}

	if (cmd === "endpoint") {
		await runEndpoint(rest);
		return;
	}

	if (cmd === "metrics") {
		if (config.metricsPort <= 0) {
			console.error("metrics endpoint disabled (set MIR_METRICS_PORT)");
			process.exit(1);
		}
		const res = await fetch(`http://${config.metricsHost}:${config.metricsPort}/healthz`);
		console.log(JSON.stringify(await res.json(), null, 2));
		return;
	}

	usage();
}

function configExists(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/**
 * Write the config an install starts from.
 *
 * It records where things are rather than what they should be: a person looking
 * at this file is asking "where did my data go", and the answer should not be
 * "read the source".
 */
function writeConfig(path: string, paths: ReturnType<typeof mirPaths>): string {
	mkdirSync(dirname(path), { recursive: true });
	const body = {
		version: 1,
		home: paths.home,
		paths: {
			data: paths.data,
			state: paths.state,
			cache: paths.cache,
			logs: paths.logs,
			runtime: paths.runtime,
			daemonSocket: paths.daemonSocket,
			handsSocket: paths.handsSocket,
			queue: paths.queueDir,
			sessions: paths.sessions,
			mcpOauth: paths.mcpOauth,
		},
		// Channels and model are environment variables, not this file: a config
		// holding a key is a key in a backup.
		env: ["MIR_HTTP_PORT", "MIR_MODEL", "MIR_OPENROUTER_API_KEY", "MIR_API_TOKEN"],
	};
	writeFileSync(path, `${JSON.stringify(body, null, "\t")}\n`, { mode: 0o600 });
	return "written";
}

main().catch((err) => {
	console.error("[mir] fatal:", err?.message ?? err);
	process.exit(1);
});
