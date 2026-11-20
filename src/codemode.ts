/**
 * JavaScript in a QuickJS VM. What it can reach is policy, not accident: `fetch` only
 * with `net`, file helpers only with `fs` and rooted at the Worker's cwd, `mcp__*` only
 * with `mcp`.
 */

import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	InlineCodemodeSandbox,
	loadQuickJSWasm,
	type CodemodeTool,
	type CodemodeResult,
} from "@earendil-works/pi-codemode";
import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { type WorkerCapabilities, DEFAULT_WORKER_CAPABILITIES, redactSecrets } from "./security.ts";
import { log } from "./telemetry.ts";

export interface CodemodeToolOptions {
	/** Working directory for codemode scripts, and the root of the fs capability. */
	cwd?: string;
	/** Persistent store for store()/load() across codemode calls. */
	store?: Map<string, unknown>;
	/** MCP tools exposed as globals to codemode scripts (snapshot at creation). */
	mcpTools?: CodemodeTool[];
	/** When set, a changed tool set rebuilds the sandbox; it wins over `mcpTools`. */
	getMcpTools?: () => CodemodeTool[];
	/** What the script may reach. Defaults to the permissive development set. */
	capabilities?: WorkerCapabilities;
	/** Per-execution deadline (ms). */
	timeoutMs?: number;
}

/** The QuickJS wasm is expensive to load; cache it forever. */
let wasmPromise: Promise<Awaited<ReturnType<typeof loadQuickJSWasm>>> | null = null;
function getWasm() {
	if (!wasmPromise) wasmPromise = loadQuickJSWasm();
	return wasmPromise;
}

const MAX_READ_CHARS = 512 * 1024;

/** Resolve `p` under `root`, rejecting escapes. Returns null when outside. */
export function resolveInsideRoot(root: string, p: string): string | null {
	const absolute = path.resolve(root, p);
	const rel = path.relative(root, absolute);
	if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return absolute;
	return null;
}

/** Host helpers granted by capabilities, as codemode globals. */
export function buildHostGlobals(
	capabilities: WorkerCapabilities,
	cwd: string,
): CodemodeTool[] {
	const globals: CodemodeTool[] = [];

	if (capabilities.net) {
		globals.push({
			name: "fetch",
			description: "HTTP request. Returns { status, headers, body } with the body as text.",
			inputSchema: {
				type: "object",
				properties: {
					url: { type: "string" },
					init: { type: "object", description: "fetch init: method, headers, body" },
				},
				required: ["url"],
			},
			async execute(args: any) {
				const url = String(args?.url ?? "");
				if (!/^https?:\/\//i.test(url)) throw new Error("fetch: only http(s) URLs are allowed");
				const res = await fetch(url, {
					...((args?.init as RequestInit) ?? {}),
					signal: AbortSignal.timeout(30_000),
				});
				const body = redactSecrets(await res.text());
				return JSON.stringify({
					status: res.status,
					headers: Object.fromEntries(res.headers.entries()),
					body: body.length > MAX_READ_CHARS ? body.slice(0, MAX_READ_CHARS) + "…[truncated]" : body,
				});
			},
		} as CodemodeTool);
	}

	if (capabilities.fs !== "none") {
		globals.push({
			name: "readFile",
			description: `Read a UTF-8 text file, relative to ${cwd}.`,
			inputSchema: {
				type: "object",
				properties: { path: { type: "string" } },
				required: ["path"],
			},
			async execute(args: any) {
				const target = resolveInsideRoot(cwd, String(args?.path ?? ""));
				if (!target) throw new Error(`readFile: path escapes ${cwd}`);
				const text = await readFile(target, "utf8");
				return text.length > MAX_READ_CHARS ? text.slice(0, MAX_READ_CHARS) + "…[truncated]" : text;
			},
		} as CodemodeTool);

		globals.push({
			name: "listDir",
			description: `List entries of a directory, relative to ${cwd}.`,
			inputSchema: {
				type: "object",
				properties: { path: { type: "string" } },
				required: ["path"],
			},
			async execute(args: any) {
				const target = resolveInsideRoot(cwd, String(args?.path ?? "."));
				if (!target) throw new Error(`listDir: path escapes ${cwd}`);
				const entries = await readdir(target, { withFileTypes: true });
				return entries
					.map((e) => {
						const suffix = e.isDirectory() ? "/" : "";
						return e.name + suffix;
					})
					.join("\n");
			},
		} as CodemodeTool);
	}

	if (capabilities.fs === "rw") {
		globals.push({
			name: "writeFile",
			description: `Write a UTF-8 text file, relative to ${cwd}.`,
			inputSchema: {
				type: "object",
				properties: { path: { type: "string" }, content: { type: "string" } },
				required: ["path", "content"],
			},
			async execute(args: any) {
				const target = resolveInsideRoot(cwd, String(args?.path ?? ""));
				if (!target) throw new Error(`writeFile: path escapes ${cwd}`);
				const parent = path.dirname(target);
				const parentStat = await stat(parent).catch(() => null);
				if (!parentStat?.isDirectory()) throw new Error(`writeFile: no such directory ${parent}`);
				await writeFile(target, String(args?.content ?? ""), "utf8");
				return `wrote ${target}`;
			},
		} as CodemodeTool);
	}

	return globals;
}

/** One-line capability description shown in the tool description. */
function capabilitiesLine(caps: WorkerCapabilities): string {
	const granted: string[] = ["console", "store/load", "text/image/exit"];
	if (caps.net) granted.push("fetch");
	if (caps.fs === "ro") granted.push("readFile", "listDir");
	if (caps.fs === "rw") granted.push("readFile", "listDir", "writeFile");
	if (caps.mcp) granted.push("mcp__<server>__<tool>");
	return granted.join(", ");
}

/** Create the codemode ToolDefinition using pi-codemode's real sandbox. */
export function createCodemodeTool(options: CodemodeToolOptions = {}): ToolDefinition {
	const cwd = options.cwd ?? process.cwd();
	const store = options.store ?? new Map<string, unknown>();
	const mcpTools = options.mcpTools ?? [];
	const capabilities = options.capabilities ?? DEFAULT_WORKER_CAPABILITIES;
	const hostGlobals = buildHostGlobals(capabilities, cwd);

	/** Keyed by the sorted global names, so a hot-reload rebuilds and nothing else does. */
	let currentSandbox: InlineCodemodeSandbox | null = null;
	let currentSignature = "";
	async function sandboxFor(globals: CodemodeTool[]): Promise<InlineCodemodeSandbox> {
		const signature = globals.map((g) => g.name).sort().join("\n");
		if (currentSandbox && signature === currentSignature) return currentSandbox;
		const wasm = await getWasm();
		currentSandbox = new InlineCodemodeSandbox({
			wasm,
			globals,
			timeoutMs: options.timeoutMs ?? 120_000,
		});
		currentSignature = signature;
		return currentSandbox;
	}

	return defineTool<any, any, any>({
		name: "codemode",
		label: "Codemode",
		description:
			"Run JavaScript for pure computation: data transformation, parsing, arithmetic. " +
			`Available: ${capabilitiesLine(capabilities)}. ` +
			// Said because it was tried: the sandbox is QuickJS, not Node. A model that
			// reaches for `require` or `process` gets a ReferenceError and concludes the
			// machine is broken, when the answer is that this is not where files live.
			"No `require`, no `import`, no `process`, no `fs`: this is not Node. Files are the hand's, and `exec`/`read_file`/`list_dir` are how you reach them. " +
			"Return a value to send it back as the tool result.",
		parameters: Type.Object({
			code: Type.String({ description: "JavaScript code to execute." }),
		}),
		exposure: "direct",
		defaultActive: true,
		async execute(_id, { code }: { code: string }, signal, _onUpdate, _ctx) {
			const mcpGlobals = capabilities.mcp ? (options.getMcpTools?.() ?? mcpTools) : [];
			const sandbox = await sandboxFor([...hostGlobals, ...mcpGlobals]);

			const result: CodemodeResult = await sandbox.execute(code, {
				signal,
				store: Object.fromEntries(store),
			});

			if (!result.ok) {
				return {
					content: [
						{
							type: "text",
							text: `codemode error: ${result.error.message}`,
						},
					],
					details: { error: result.error as any },
					isError: true,
				};
			}

			// Persist store writes from the script.
			for (const [key, value] of Object.entries(result.storeWrites.set ?? {})) {
				store.set(key, value);
			}
			for (const key of result.storeWrites.delete ?? []) {
				store.delete(key);
			}

			const outputText = redactSecrets(
				result.output
					.map((item) => {
						if (item.type === "text") return item.text;
						return `[${item.mimeType}] image`;
					})
					.join("\n") || String(result.value ?? "(no output)"),
			);

			if (result.output.length > 0 && outputText.includes("«redacted:")) {
				log.info("codemode output redacted", { count: result.output.length });
			}

			return {
				content: [{ type: "text", text: outputText }],
				details: { output: result.output, value: result.value },
			};
		},
	});
}

export interface CodemodeToolProvider {
	tool: ToolDefinition;
}

export function createCodemodeToolProvider(options: CodemodeToolOptions = {}): CodemodeToolProvider {
	return {
		tool: createCodemodeTool(options),
	};
}
