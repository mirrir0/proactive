/**
 * A task as a value, rendered as the message that starts a Worker.
 *
 * The only thing that turns a `TaskSpec` into text, so a wrong brief is a bug in one
 * function rather than something to spot in a transcript.
 */

import type { WorkerCapabilities } from "./security.ts";

/** The part of a `WorkerSpec` that decides what the Worker reads. */
export interface TaskSpec {
	taskId: string;
	/** The row. */
	title: string;
	/** What the person asked for, in their words. */
	description: string;
	/** The brief: paths, constraints, what a good answer looks like. */
	instructions?: string;
	capabilities: WorkerCapabilities;
	endpointId?: string;
	/** Where the hand's files start, when it says. */
	handRoot?: string;
	handName?: string;
	hasHands: boolean;
}

/** Short on purpose: role, skills and invariants live in the system prompt. */
export function taskMessage(spec: TaskSpec): string {
	const lines = [
		`Task: ${spec.title}`,
		"",
		...(spec.instructions === undefined
			? [`Description: ${spec.description}`]
			: [`What this is for: ${spec.description}`, "", spec.instructions]),
		"",
		`In this process: ${describeOwnCapabilities(spec.capabilities)}.`,
	];
	if (spec.hasHands) {
		lines.push(
			"Your files are not here: they are on the hand, and its tools are how you reach them. That is normal, not a limitation.",
		);
		// A name, never an id: a Worker repeats to a person whatever it was handed.
		const label =
			spec.handName !== undefined
				? `“${spec.handName}”`
				: spec.endpointId !== undefined
					? "the hand this task was assigned"
					: "whichever hand the hub picks (call `list_hands` to see it)";
		lines.push(`Execution happens on a hand (see the \`hands\` skill). You are on: ${label}.`);
		if (spec.handRoot !== undefined) {
			lines.push(`Its files start at: ${spec.handRoot}. Relative paths begin there.`);
		}
	} else {
		lines.push(
			"No hand is configured, so nothing here can read a file: say what you cannot do rather than guessing at a directory.",
		);
	}
	lines.push(
		"If a follow-up message arrives that is not part of this task, call release_event instead of answering it.",
	);
	return lines.join("\n");
}

/** In words, not JSON: `{"fs":"none"}` gets reported to a person as "no filesystem access". */
function describeOwnCapabilities(capabilities: WorkerCapabilities): string {
	const parts = [
		capabilities.mcp ? "connected services are available" : "no connected services",
		capabilities.codemode ? "you can run pure computation" : "no computation sandbox",
		capabilities.net ? "you can reach the network" : "no network",
	];
	return `${parts.join(", ")}. No files of your own — the hand has those.`;
}
