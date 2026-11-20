/** The narrow session surface the Router and Worker use, so tests can drive it without a provider. */

import { createAgentSession, type ToolDefinition } from "@earendil-works/pi-coding-agent";

/** The subset of `AgentSession` this system relies on. */
export interface AgentSessionLike {
	/** Resolves when the message is accepted or the turn ends (see `waitForIdle`). */
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
	/** With `noTools: "all"` this is the whole surface — no extension can add to it. */
	tools?: string[];
	/** Where pi reads global config and extensions. Not the machine's: those are someone else's tools. */
	agentDir?: string;
	/**
	 * Built by `skills.ts`, never left to the default: the default loader scans the
	 * machine's pi home, and `agentDir` is one more place scanned, not the only one.
	 */
	resourceLoader?: any;
	customTools?: ToolDefinition[];
	/** What pi tells the model its working directory is. A model told a directory answers about it. */
	cwd?: string;
}

export type SessionFactory = (options: CreateSessionOptions) => Promise<AgentSessionLike>;

/** Production factory: a real pi agent session. */
export const createPiSession: SessionFactory = async (options) => {
	const result = await createAgentSession({
		model: options.model,
		...(options.cwd === undefined ? {} : { cwd: options.cwd }),
		modelRuntime: options.modelRuntime,
		sessionManager: options.sessionManager,
		thinkingLevel: options.thinkingLevel as any,
		noTools: options.noTools,
		...(options.tools === undefined ? {} : { tools: options.tools }),
		...(options.agentDir === undefined ? {} : { agentDir: options.agentDir }),
		...(options.resourceLoader === undefined ? {} : { resourceLoader: options.resourceLoader }),
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
	// Fallback for doubles without `waitForIdle`.
	const deadline = Date.now() + 30_000;
	while (session.isIdle === false && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
