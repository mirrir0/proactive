/**
 * Daemon entrypoint (`mir-daemon` under pm2).
 *
 * Runs the Router, Watchdog, the control server and every Channel listener.
 * Workers are separate pm2 processes (ADR 0001), spawned on demand.
 */

import { homedir } from "node:os";
import { loadEnv } from "./env.ts";
import { join } from "node:path";
import { SuperAgent } from "./superagent.ts";
import type { Channel, ChannelEvent } from "./channels/types.ts";
import { TerminalChannel } from "./channels/terminal.ts";
import { HttpChannel } from "./channels/http.ts";
import { QueueChannel } from "./channels/queue.ts";

function csvEnv(name: string): string[] | undefined {
	const v = process.env[name];
	if (!v) return undefined;
	const parts = v.split(",").map((s) => s.trim()).filter(Boolean);
	return parts.length ? parts : undefined;
}

function buildConfig() {
	const only = csvEnv("OPENROUTER_PROVIDER_ONLY");
	const quantizations = csvEnv("OPENROUTER_QUANTIZATIONS");
	return {
		modelId: process.env.OPENROUTER_MODEL ?? "nvidia/nemotron-3.5-super-vl:free",
		thinkingLevel: (process.env.MIR_THINKING ?? "medium") as any,
		batchWindowMs: 500,
		maxConcurrentWorkers: 8,
		providerRouting: only || quantizations
			? { only, quantizations, allow_fallbacks: false }
			: undefined,
		httpHost: process.env.MIR_HTTP_HOST ?? "127.0.0.1",
		httpPort: Number(process.env.MIR_HTTP_PORT ?? 4599),
		queueDir: process.env.MIR_QUEUE_DIR ?? join(homedir(), ".local", "share", "mir", "queue"),
		socketPath:
			process.env.MIR_SOCKET_PATH ?? join(homedir(), ".local", "share", "mir", "daemon.sock"),
		workerIdleExitMs: Number(process.env.MIR_WORKER_IDLE_MS ?? 120_000),
		maxTokens: Number(process.env.MIR_MAX_TOKENS ?? 8192),
	};
}

export async function runDaemon(): Promise<void> {
	loadEnv();
	const config = buildConfig();

	const channels: Channel[] = [
		new TerminalChannel(),
		new HttpChannel({ host: config.httpHost, port: config.httpPort }),
		new QueueChannel({ dir: config.queueDir }),
	];

	const agent = new SuperAgent(config, { channels });
	await agent.init();
	await agent.start();

	for (const ch of channels) {
		await ch.start((event: ChannelEvent) => {
			void agent.submitEvent(event);
		});
	}

	const shutdown = async (signal: string) => {
		console.log(`[daemon] ${signal} received, shutting down`);
		for (const ch of channels) await ch.stop().catch(() => {});
		await agent.stop().catch(() => {});
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));

	console.log(
		`[daemon] channels live: ${channels.map((c) => c.id).join(", ")}`,
	);
	console.log(`[daemon] HTTP events → POST http://${config.httpHost}:${config.httpPort}/channels/http/events`);
}

const invokedDirectly = process.argv[1] && /daemon\.(ts|js)$/.test(process.argv[1]);
if (invokedDirectly) {
	runDaemon().catch((err) => {
		console.error("[daemon] fatal:", err?.message ?? err);
		process.exit(1);
	});
}
