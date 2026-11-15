/**
 * Session seam.
 *
 * Both layers run an LLM session, but the rest of the system must not care
 * whether that session is a real pi `AgentSession` or a scripted double. This
 * module defines the narrow surface the Router and Worker actually use, plus
 * the default implementation backed by `createAgentSession`.
 *
 * Why a seam: the interesting behaviour (batching, reply attribution, event
 * queueing, recovery) is scheduling logic, not model logic. With a factory
 * injected, tests drive that logic deterministically — no provider, no key,
 * no tokens — which is what makes the seven fixes below verifiable.
 */

import { createAgentSession, type ToolDefinition } from "@earendil-works/pi-coding-agent";

/** The subset of `AgentSession` this system relies on. */
export interface AgentSessionLike {
	/** Send a prompt. Resolves when the message is accepted or the turn ends (see waitForIdle). */
	prompt(text: string, options?: { streamingBehavior?: "steer" | "followUp" }): Promise<void>;
	/** Resolves once the agent has no queued work left. Optional for doubles. */
	waitForIdle?(): Promise<void>;
	subscribe(listener: (event: any) => void): () => void;
	dispose(): Promise<void>;
	readonly isIdle?: boolean;
	readonly isStreaming?: boolean;
	abort?(): Promise<void>;
	sendCustomMessage?(message: any, options?: any): Promise<void>;
}

export interface CreateSessionOptions {
	model: any;
	modelRuntime: any;
	/** Session manager (already created by the caller — file layout differs per layer). */
	sessionManager?: any;
	thinkingLevel?: string;
	noTools?: "all" | "builtin";
	/**
	 * The tools this session may use, by name. With `noTools: "all"` this is the
	 * whole surface: an extension the machine happens to have installed cannot add
	 * a tool to a Worker that was not given it.
	 */
	tools?: string[];
	/**
	 * Where pi reads its global config and extensions from.
	 *
	 * A Worker (and the Router) must not inherit the machine's pi extensions: those
	 * are someone's own tools — `subagent`, `todo`, `AskClaude` — and a Worker that
	 * has them is a Worker that can do things the assistant never could.
	 */
	agentDir?: string;
	customTools?: ToolDefinition[];
}

export type SessionFactory = (options: CreateSessionOptions) => Promise<AgentSessionLike>;

/** Production factory: a real pi agent session. */
export const createPiSession: SessionFactory = async (options) => {
	const result = await createAgentSession({
		model: options.model,
		modelRuntime: options.modelRuntime,
		sessionManager: options.sessionManager,
		thinkingLevel: options.thinkingLevel as any,
		noTools: options.noTools,
		...(options.tools === undefined ? {} : { tools: options.tools }),
		...(options.agentDir === undefined ? {} : { agentDir: options.agentDir }),
		customTools: options.customTools,
	});
	return result.session as unknown as AgentSessionLike;
};

/** Resolve a session to idle, tolerating doubles that do not implement it. */
export async function settleSession(session: AgentSessionLike): Promise<void> {
	if (typeof session.waitForIdle === "function") {
		await session.waitForIdle();
		return;
	}
	// Fallback: poll isIdle until it settles or a bounded time passes.
	const deadline = Date.now() + 30_000;
	while (session.isIdle === false && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
