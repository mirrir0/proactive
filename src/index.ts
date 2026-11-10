/**
 * mir CLI.
 *
 *   mir daemon        run the daemon in the foreground (dev; terminal channel)
 *   mir start|stop    manage mir-daemon under pm2
 *   mir send <text>   POST an event to the HTTP channel
 *   mir status        list running Worker processes
 */

import { loadEnv } from "./env.ts";
import { runDaemon } from "./daemon.ts";
import { ProcessManager } from "./process-manager.ts";

function usage(): void {
	console.log(
		[
			"mir <command>",
			"",
			"  daemon            run the daemon in the foreground (dev)",
			"  start             start mir-daemon under pm2",
			"  stop              stop/delete mir-daemon",
			"  restart           restart mir-daemon",
			"  status            list Worker pm2 processes",
			"  send <text>       POST an event to the HTTP channel",
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

async function main(): Promise<void> {
	loadEnv();
	const [cmd, ...rest] = process.argv.slice(2);

	if (!cmd || cmd === "daemon") {
		await runDaemon();
		return;
	}

	if (cmd === "start" || cmd === "stop" || cmd === "restart") {
		await pm2ctl(cmd);
		return;
	}

	if (cmd === "status") {
		const pm = new ProcessManager();
		const workers = await pm.listWorkers();
		await pm.disconnect();
		console.log(workers.length ? JSON.stringify(workers, null, 2) : "no workers running");
		return;
	}

	if (cmd === "send") {
		const text = rest.join(" ").trim();
		if (!text) {
			console.error("usage: mir send <text>");
			process.exit(1);
		}
		const port = Number(process.env.MIR_HTTP_PORT ?? 4599);
		const res = await fetch(`http://127.0.0.1:${port}/channels/http/events`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text, from: "cli", reply_to: process.env.MIR_REPLY_TO }),
		});
		console.log(res.status, await res.text());
		return;
	}

	usage();
}

main().catch((err) => {
	console.error("[mir] fatal:", err?.message ?? err);
	process.exit(1);
});
