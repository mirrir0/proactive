/**
 * Worker process entrypoint (`mir-worker-<taskId>` under pm2).
 *
 * Boots one WorkerRuntime for the Task named in MIR_WORKER_SPEC, connects to the
 * daemon's control channel, runs the Task, reports the conclusion, then serves
 * follow-up Thread events until idle — then exits.
 */

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { loadEnv } from "./env.ts";
import type { OpenRouterRouting } from "./types.ts";
import type { WorkerSpec } from "./process-manager.ts";
import { WorkerRuntime } from "./worker.ts";
import { ControlClient } from "./ipc.ts";

function readSpec(): WorkerSpec {
	const raw = process.env.MIR_WORKER_SPEC;
	if (!raw) throw new Error("MIR_WORKER_SPEC is not set");
	return JSON.parse(raw) as WorkerSpec;
}

async function main(): Promise<void> {
	loadEnv();
	const spec = readSpec();
	const apiKey = process.env.OPENROUTER_API_KEY;
	if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");

	const modelRuntime = await ModelRuntime.create();
	await modelRuntime.setRuntimeApiKey("openrouter", apiKey);
	await modelRuntime.getAvailable("openrouter");

	const originalStream = (modelRuntime as any).streamSimple.bind(modelRuntime);
	(modelRuntime as any).streamSimple = (model: any, ctx: any, opts: any) =>
		originalStream(model, ctx, { ...opts, maxTokens: spec.maxTokens });

	const model = modelRuntime.getModel("openrouter", spec.modelId);
	if (!model) throw new Error(`model not found: ${spec.modelId}`);
	if (spec.providerRouting) {
		(model as any).compat = {
			...(model as any).compat,
			openRouterRouting: spec.providerRouting as OpenRouterRouting,
		};
	}

	const client = new ControlClient(spec.socketPath, spec.workerId, spec.taskId);
	await client.connect();

	const worker = await WorkerRuntime.create({
		taskId: spec.taskId,
		modelRuntime,
		model,
		thinkingLevel: (spec.thinkingLevel as any) ?? "high",
		reporter: {
			status: (status, progress) => client.status(status, progress),
			delta: (text) => client.delta(text),
		},
	});

	const taskPrompt = [
		`Task: ${spec.title}`,
		"",
		`Description: ${spec.description}`,
		"",
		"Complete this task. Then report a concise conclusion (what you did, what you found, the outcome).",
	].join("\n");

	let idleTimer: NodeJS.Timeout | null = null;
	let stopping = false;

	const finish = async (): Promise<void> => {
		if (stopping) return;
		stopping = true;
		if (idleTimer) clearTimeout(idleTimer);
		client.status("done");
		await worker.dispose();
		client.close();
		process.exit(0);
	};

	const armIdle = () => {
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = setTimeout(() => void finish(), spec.idleExitMs);
		idleTimer.unref();
	};

	// Follow-up events on subscribed Threads arrive over the control channel.
	client.onEvent((event) => {
		armIdle();
		void (async () => {
			try {
				await worker.run(`Follow-up on your task's thread:\n\n${event.text}`);
			} catch (err) {
				client.status("failed", (err as Error).message);
			}
		})();
	});
	client.onAbort(() => void finish());

	try {
		client.status("busy", "running task");
		const result = await worker.run(taskPrompt);
		client.conclusion(result || "(worker produced no conclusion text)");
	} catch (err) {
		client.status("failed", (err as Error).message);
		client.conclusion(`FAILED: ${(err as Error).message}`);
	}

	armIdle();
}

main().catch((err) => {
	console.error("[worker] fatal:", err?.message ?? err);
	process.exit(1);
});
