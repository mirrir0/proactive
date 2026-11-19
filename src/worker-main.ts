/**
 * Worker process entrypoint (`mir-worker-<taskId>` under pm2).
 *
 * Boots one WorkerRuntime for the Task named in the spec file, connects to the
 * daemon's control channel, runs the Task, reports the conclusion, then serves
 * follow-up Thread events (queued, never dropped) until idle — then exits.
 *
 * MCP: the daemon watches mcp.config.json and broadcasts a `system` signal
 * (kind `mcp_changed`) when servers are added/removed/changed. On receipt this
 * worker hot-reloads its MCP connections, swaps its `mcp__*` tool set, refreshes
 * the codemode sandbox globals, re-reports its catalog to the daemon, and
 * injects a system message into the session so the model knows what changed.
 *
 * Security: the task spec arrives as a 0600 file path (never inline env), the
 * secret registry is primed from the environment so nothing leaks into logs or
 * prompts, and the tool surface is filtered by the spec's capability policy.
 */

import fs from "node:fs";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { loadEnv } from "./env.ts";
import type { OpenRouterRouting } from "./types.ts";
import type { WorkerSpec } from "./process-manager.ts";
import { taskMessage } from "./task-message.ts";
import { WorkerRuntime, createAgentTools, createWorkerControlTools } from "./worker.ts";
import { ControlClient } from "./ipc.ts";
import { McpManager, type McpConfig } from "./mcp.ts";
import { createCodemodeTool } from "./codemode.ts";
import { HandsClient } from "./hands/client.ts";
import { createHandTools } from "./hands/tools.ts";
import { createMcpQueryTool } from "./mcp-query.ts";
import { formatMcpChangedText, isEmptyDiff, type McpDiff } from "./mcp-catalog.ts";
import { filterToolNames, secrets, DEFAULT_WORKER_CAPABILITIES } from "./security.ts";
import { log } from "./telemetry.ts";

function readSpec(): WorkerSpec {
	const path = process.env.MIR_WORKER_SPEC_PATH;
	if (path) {
		const raw = fs.readFileSync(path, "utf8");
		return JSON.parse(raw) as WorkerSpec;
	}
	// Legacy path: inline env (kept so an old daemon can still spawn a worker).
	const raw = process.env.MIR_WORKER_SPEC;
	if (!raw) throw new Error("MIR_WORKER_SPEC_PATH is not set");
	return JSON.parse(raw) as WorkerSpec;
}

async function main(): Promise<void> {
	loadEnv();
	secrets.addFromEnv();
	const spec = readSpec();
	const capabilities = spec.capabilities ?? DEFAULT_WORKER_CAPABILITIES;
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

	// --- Hands: the execution environment this task runs against ---
	// The Worker process is a brain: it holds the model loop and the tool surface,
	// not the filesystem. If a hand is configured, filesystem access moves there.
	let handsClient: HandsClient | null = null;
	let handTools: any[] = [];
	/** Aborted when the daemon stops this task: the hand tools watch it. */
	const stopSignal = new AbortController();
	if (spec.handsSocketPath) {
		handsClient = new HandsClient({
			socketPath: spec.handsSocketPath,
			agent: `worker-${spec.workerId}`,
		});
		const connected = await handsClient
			.connect()
			.then(() => true)
			.catch((err) => {
				log.warn("hands hub unreachable; hand tools will report an error", {
					error: (err as Error).message,
					socket: spec.handsSocketPath,
				});
				return false;
			});
		handTools = createHandTools({
			client: handsClient,
			endpointId: spec.endpointId,
			signal: stopSignal.signal,
		});
		if (connected) {
			const hands = await handsClient.refreshHands().catch(() => []);
			log.info("hands available to this worker", {
				hands: hands.map((h) => h.endpointId),
				pinned: spec.endpointId ?? "auto",
			});
		}
	}

	// Local codemode keeps pure computation; the environment is the hand's job.
	//
	// Not "unless the hub is unreachable": the fallback used to hand codemode the
	// worker process's own `readFile`/`writeFile`, rooted at the brain's state
	// directory — a disk the Worker was never given, reachable exactly when the hands
	// were down. With no hand there is no filesystem, and the tool says so.
	const codemodeCapabilities = { ...capabilities, fs: "none" as const };

	// --- MCP + codemode setup (both gated by capabilities) ---
	const mcp = new McpManager();
	if (capabilities.mcp) {
		// The daemon holds the config when the stack is the source (this member's
		// connected services); the file is the fallback for a brain run by hand.
		await mcp.start(spec.mcpConfig ?? McpManager.loadConfig(spec.mcpConfigPath));
	}

	// Live reference so the codemode sandbox can rebuild its globals after a hot-reload.
	const mcpToolsRef = { tools: capabilities.mcp ? mcp.getCodemodeTools() : [] };

	const controlTools = (): any[] => {
		const defs: any[] = [];
		if (capabilities.mcp) {
			defs.push(...mcp.getToolDefinitions(), createMcpQueryTool(() => mcp.getToolCatalog()));
		}
		if (capabilities.codemode) {
			defs.push(
				createCodemodeTool({
					cwd: process.cwd(),
					getMcpTools: () => mcpToolsRef.tools,
					capabilities: codemodeCapabilities,
				}),
			);
		}
		return defs;
	};

	// Tool policy: an allow/deny list on top of the capability grants, applied to
	// everything the worker can call — the hand tools most of all. Filtering only the
	// MCP and codemode set meant `MIR_WORKER_TOOL_DENY=exec` removed nothing that
	// mattered: the tools that touch a disk are the hand's, and they went unfiltered.
	const client = new ControlClient(spec.socketPath, spec.workerId, spec.taskId);
	await client.connect();

	// How a Worker reaches other agents: through the daemon, which owns the tree.
	// Nothing here names a socket or a process — the daemon decides who `parent` is,
	// and refuses a task this Worker was not given.
	const clientChannel = {
		dispatchChild: (requestId: string, title: string, description: string, instructions?: string) =>
			client.dispatchChild(requestId, title, description, instructions),
		message: (to: string, text: string) => client.message(to, text),
		stopTask: (taskId: string) => client.stopTask(taskId),
	};

	// The tools for talking to other agents: `message` always, and dispatch/stop only
	// for a Worker that may fan out. Depth stops at one level here — as a tool list,
	// not an instruction a model could reason its way around — so a check gets
	// `message` and nothing to dispatch with.
	const agentTools = createAgentTools(clientChannel, {
		taskId: spec.taskId,
		canDispatch: (spec.depth ?? 0) === 0,
		...(spec.parentTaskId === undefined ? {} : { parentTaskId: spec.parentTaskId }),
	});
	const offered = [...agentTools, ...controlTools(), ...handTools];
	const permitted = filterToolNames(
		offered.map((tool) => String(tool.name)),
		spec.toolPolicy ?? {},
	);
	const customTools = offered.filter((tool) => permitted.includes(String(tool.name)));

	if (capabilities.mcp) {
		// Publish our catalog so the Router's mcp_query reflects reality.
		client.mcpCatalog(mcp.getServerReports(), mcp.getToolCatalog());
	}

	const worker = await WorkerRuntime.create({
		taskId: spec.taskId,
		// Where "here" is: the hand's root when there is one. A Worker with no hand has
		// no folder, and the state directory says that better than the brain's source tree.
		cwd: spec.handRoot ?? spec.sessionDir,
		sessionDir: spec.sessionDir,
		modelRuntime,
		model,
		thinkingLevel: (spec.thinkingLevel as any) ?? "high",
		mcpTools: mcpToolsRef.tools,
		customTools,
		capabilities,
		heartbeatMs: spec.heartbeatMs,
		reporter: {
			status: (status, progress) => client.status(status, progress),
			heartbeat: (status, progress) => client.heartbeat(status, progress),
			delta: (text) => client.delta(text),
			// What the Worker did, not only what it said: a tool call is the work, and
			// a thread that shows only the words is a thread that cannot be audited.
			toolCall: (call) => client.toolCall(call.id, call.name, call.args),
			toolResult: (result) => client.toolResult(result.id, result.isError, result.result),
			release: (eventId, reason) => client.release(eventId, reason),
			unsubscribe: (threadId, reason) => client.unsubscribe(threadId, reason),
		},
	});

	// Worker-side subscription control (release an event, leave a thread).
	// The runtime appends these to the live session's tool set and refreshes its
	// registry, so they are callable from the very next turn.
	const threadIds = spec.threadId ? [spec.threadId] : [];
	worker.addTools(createWorkerControlTools(worker, threadIds));

	// One renderer for every task: the person's line, the brief, what it may touch.
	const taskPrompt = taskMessage({ ...spec, hasHands: handsClient !== null });

	let idleTimer: NodeJS.Timeout | null = null;
	let stopping = false;

	const finish = async (): Promise<void> => {
		if (stopping) return;
		stopping = true;
		if (idleTimer) clearTimeout(idleTimer);
		client.status("done");
		await worker.dispose().catch(() => {});
		handsClient?.close();
		await mcp.stop().catch(() => {});
		// Flush before exiting: an immediate exit() can truncate the last message.
		await client.flush();
		client.close();
		process.exit(0);
	};

	const armIdle = () => {
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = setTimeout(() => void finish(), spec.idleExitMs);
		idleTimer.unref();
	};

	// --- MCP hot-reload on `system` signals from the daemon ---
	// Syncs are serialized: a second mcp_changed arriving mid-sync waits its turn.
	let syncQueue: Promise<void> = Promise.resolve();

	const handleMcpChanged = async (pushed?: McpConfig): Promise<void> => {
		let fresh: McpConfig;
		try {
			fresh = pushed ?? McpManager.loadConfig(spec.mcpConfigPath);
		} catch (err) {
			// The daemon's watcher already validated the file, but the file can
			// change again in between — keep the old config rather than tear down.
			log.error("MCP reload aborted, config unreadable", { error: (err as Error).message });
			return;
		}
		const diff: McpDiff = await mcp.sync(fresh);
		// Swap the mcp__* tool definitions in the session and refresh its registry.
		try {
			worker.replaceMcpTools(mcp.getToolDefinitions());
		} catch (err) {
			log.error("failed to refresh MCP tool set", { error: (err as Error).message });
		}
		// Refresh codemode sandbox globals (takes effect on the next codemode call).
		mcpToolsRef.tools = mcp.getCodemodeTools();
		// Re-report the catalog so the daemon/Router cache converges.
		client.mcpCatalog(mcp.getServerReports(), mcp.getToolCatalog());
		// System message: tell the model what was added/removed/changed.
		const text = formatMcpChangedText(diff);
		if (!isEmptyDiff(diff)) {
			await worker.injectSystemMessage(text, {
				added: diff.added,
				removed: diff.removed,
				changed: diff.changed,
				failed: diff.failed,
			});
		}
		log.info("MCP hot-reload done", {
			added: diff.added,
			removed: diff.removed,
			changed: diff.changed,
			failed: diff.failed,
		});
	};

	client.onSystem((msg) => {
		armIdle();
		if (msg.kind !== "mcp_changed" || !capabilities.mcp) return;
		syncQueue = syncQueue.then(() => handleMcpChanged(msg.config)).catch((err) => {
			log.error("MCP hot-reload failed", { error: (err as Error).message });
		});
	});

	// Follow-up events on subscribed Threads arrive over the control channel.
	// They are queued by the runtime, so an event that lands mid-turn is not lost.
	client.onEvent((event) => {
		armIdle();
		worker.enqueueFollowUp(
			[
				`Follow-up on your task's thread (event ${event.id}, from ${event.from ?? "unknown"}):`,
				"",
				event.text,
				"",
				"If this is outside your task, call release_event with a reason. Otherwise act on it and report a concise conclusion.",
			].join("\n"),
			event.id,
		);
	});
	// Another agent's words, at this Worker's next turn boundary. A message is a note,
	// not an instruction to drop what it is doing: the runtime queues it behind the
	// turn in flight.
	client.onMessage((from, text) => {
		armIdle();
		worker.enqueueFollowUp([`Message from ${from}:`, "", text, "", "Act on it if it changes your task; otherwise report your conclusion as you were going to."].join("\n"));
	});

	// A stop must land even when the turn is inside a tool: abort the session so
	// the tool sees it, then exit on a deadline rather than waiting for a turn
	// that may never finish.
	client.onAbort(() => {
		stopSignal.abort();
		void worker.abort("stopped by the daemon").catch(() => {});
		setTimeout(() => process.exit(0), 2000).unref();
		void finish();
	});

	try {
		client.status("busy", "running task");
		const result = await worker.run(taskPrompt);
		await worker.conclude(spec.taskId, result || "(worker produced no conclusion text)");
		client.conclusion(result || "(worker produced no conclusion text)");
	} catch (err) {
		const message = `FAILED: ${(err as Error).message}`;
		await worker.conclude(spec.taskId, message, (err as Error).message);
		client.conclusion(message);
	}

	armIdle();
}

main().catch((err) => {
	log.error("worker fatal", { error: (err as Error).message });
	process.exit(1);
});
