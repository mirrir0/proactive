/**
 * Hand tools — what a brain sees of its hands.
 *
 * The paper's point is that a hand is `execute(name, input) → string`. These
 * tools are that surface, and nothing more: no transport, no credentials, no
 * knowledge of whether the hand is a laptop, a container or the machine next
 * door. A policy violation comes back as a tool error the model can read and
 * react to, which is what keeps a stuck or refusing hand from becoming a stuck
 * brain.
 *
 * Output is capped and redacted before it enters the context window, so a large
 * build log or a leaked token cannot blow up a turn.
 */

import { Type } from "typebox";
import { defineTool, type AgentToolResult, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HandsClient } from "./client.ts";
import type { HandCallResult, HandOp } from "./protocol.ts";
import { redactSecrets } from "../security.ts";
import { metrics } from "../telemetry.ts";

export interface HandToolsOptions {
	client: HandsClient;
	/** Pin every call to one hand (the task's assigned endpoint). */
	endpointId?: string;
	/** Cap on characters returned to the model. */
	maxResultChars?: number;
}

const DEFAULT_MAX_RESULT_CHARS = 24_000;

/** Render a result as the compact text a model can act on. */
export function formatHandResult(result: HandCallResult, maxChars = DEFAULT_MAX_RESULT_CHARS): string {
	const lines: string[] = [];
	const hand = result.endpointId ? `hand=${result.endpointId}` : "hand=?";
	lines.push(`${result.ok ? "ok" : "error"} (${hand}, ${result.durationMs}ms)`);
	if (result.exitCode !== undefined && result.exitCode !== null) lines.push(`exit=${result.exitCode}`);
	if (result.signal) lines.push(`signal=${result.signal}`);
	if (result.error) lines.push(`error: ${result.error}`);

	const stdout = (result.stdout ?? "").trimEnd();
	const stderr = (result.stderr ?? "").trimEnd();
	if (stdout) {
		lines.push("--- stdout ---", stdout);
	}
	if (stderr) {
		lines.push("--- stderr ---", stderr);
	}
	if (result.data !== undefined) {
		lines.push("--- data ---", JSON.stringify(result.data, null, 2));
	}
	if (result.truncated) lines.push("(output truncated at the hand's cap)");

	let text = redactSecrets(lines.join("\n"));
	if (text.length > maxChars) {
		text = text.slice(0, maxChars) + `\n…[truncated ${text.length - maxChars} chars]`;
	}
	return text;
}

function toToolResult(result: HandCallResult, maxChars?: number): AgentToolResult<any> {
	metrics.counter("mir_hand_tool_results_total", 1, { ok: String(result.ok) });
	return {
		content: [{ type: "text", text: formatHandResult(result, maxChars) }],
		details: {
			ok: result.ok,
			endpointId: result.endpointId,
			exitCode: result.exitCode ?? null,
			truncated: Boolean(result.truncated),
			durationMs: result.durationMs,
		},
		isError: !result.ok,
	};
}

export function createHandTools(options: HandToolsOptions): ToolDefinition[] {
	const { client } = options;
	const pinned = options.endpointId;
	const maxChars = options.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS;

	const call = async (
		op: HandOp,
		input: Record<string, unknown>,
		timeoutMs?: number,
	): Promise<HandCallResult> =>
		client.call({ op, input, endpointId: pinned, timeoutMs });

	return [
		defineTool({
			name: "exec",
			label: "Run a command on the hand",
			description:
				"Run a command in the execution environment (the hand) assigned to this task. " +
				"Pass `argv` as an array — it is never sent through a shell, so pipes and `;` do not work unless this hand grants shell access. " +
				"Working directory and allowed executables are enforced by the hand's policy; a refusal comes back as an error you can read.",
			parameters: Type.Object({
				argv: Type.Array(Type.String(), {
					description: 'Command and arguments, e.g. ["git", "status", "--short"].',
				}),
				cwd: Type.Optional(Type.String({ description: "Working directory, relative to the hand's roots." })),
				timeout_ms: Type.Optional(Type.Number({ description: "Timeout in milliseconds." })),
				shell: Type.Optional(
					Type.Boolean({ description: "Run through /bin/sh -c (only if the hand grants shell)." }),
				),
			}),
			async execute(_id, params): Promise<AgentToolResult<any>> {
				const result = await call(
					"exec",
					{ argv: params.argv, cwd: params.cwd, timeoutMs: params.timeout_ms, shell: params.shell },
					params.timeout_ms,
				);
				return toToolResult(result, maxChars);
			},
		}),
		defineTool({
			name: "read_file",
			label: "Read a file on the hand",
			description: "Read a UTF-8 text file from the execution environment, confined to the hand's roots.",
			parameters: Type.Object({
				path: Type.String({ description: "Path, relative to the hand's roots." }),
			}),
			async execute(_id, params): Promise<AgentToolResult<any>> {
				return toToolResult(await call("readFile", { path: params.path }), maxChars);
			},
		}),
		defineTool({
			name: "write_file",
			label: "Write a file on the hand",
			description: "Write a UTF-8 text file in the execution environment. Requires the hand's filesystem to be read-write.",
			parameters: Type.Object({
				path: Type.String({ description: "Path, relative to the hand's roots." }),
				content: Type.String({ description: "File contents." }),
			}),
			async execute(_id, params): Promise<AgentToolResult<any>> {
				return toToolResult(await call("writeFile", { path: params.path, content: params.content }));
			},
		}),
		defineTool({
			name: "list_dir",
			label: "List a directory on the hand",
			description: "List the entries of a directory in the execution environment.",
			parameters: Type.Object({
				path: Type.String({ description: "Path, relative to the hand's roots." }),
			}),
			async execute(_id, params): Promise<AgentToolResult<any>> {
				return toToolResult(await call("listDir", { path: params.path }), maxChars);
			},
		}),
		defineTool({
			name: "git",
			label: "Run git on the hand",
			description:
				"Run a git command in the execution environment. Credentials stay on the hand: `git push`/`pull` use the local remote, and you never see a token.",
			parameters: Type.Object({
				args: Type.Array(Type.String(), { description: 'git arguments, e.g. ["status", "--short"].' }),
				cwd: Type.Optional(Type.String({ description: "Repository directory, relative to the hand's roots." })),
				timeout_ms: Type.Optional(Type.Number({})),
			}),
			async execute(_id, params): Promise<AgentToolResult<any>> {
				return toToolResult(
					await call("git", { args: params.args, cwd: params.cwd, timeoutMs: params.timeout_ms }, params.timeout_ms),
					maxChars,
				);
			},
		}),
		defineTool({
			name: "list_hands",
			label: "List available hands",
			description:
				"List the execution environments (hands) reachable from here, with their capabilities and roots. Use it when you need to know what this task can reach.",
			parameters: Type.Object({}),
			async execute(): Promise<AgentToolResult<any>> {
				const hands = await client.refreshHands();
				const text = hands.length
					? hands
							.map(
								(h) =>
									`${h.endpointId} (${h.kind}${h.connected ? "" : ", offline"}) — exec=${h.capabilities.exec} shell=${h.capabilities.shell} fs=${h.capabilities.fs} git=${h.capabilities.git} running=${h.running}/${h.policy.maxConcurrent}\n  roots: ${h.policy.roots.join(", ") || "(none)"}\n  allow: ${h.policy.allow.join(", ") || "(none)"}`,
							)
							.join("\n")
					: "no hands are connected";
				return { content: [{ type: "text", text }], details: { hands } };
			},
		}),
	];
}
