/**
 * task-message.ts — what a Worker is told when it starts.
 *
 * A task is a value, not a sentence a model composes. The Router fills a
 * `TaskSpec` (`title` for the row, `description` for the person, `instructions`
 * for the Worker), and this module is the only thing that turns one into a
 * message. That is what makes the shape testable without a model: a brief that
 * puts the person's line where the Worker's brief belongs is a bug in one
 * function, not a thing to notice in a transcript.
 *
 * What is *not* here any more is the procedure. How to use a hand, when to reach
 * for a connected service, how to end a task — those are skills the Worker reads
 * (`skills/`), advertised in its system prompt with a description that says when
 * each applies. This message carries only what is specific to *this* task: what
 * it is, what it is for, the brief, and what it is allowed to touch.
 */

import type { WorkerCapabilities } from "./security.ts";

/** The part of a `WorkerSpec` that decides what the Worker reads. */
export interface TaskSpec {
	taskId: string;
	/** The row: what this is, in a few words. */
	title: string;
	/** The person's line: what this is for, as they would say it. */
	description: string;
	/** The brief: paths, constraints, what a good answer looks like. */
	instructions?: string;
	capabilities: WorkerCapabilities;
	/** The hand this task is pinned to, when it is pinned to one. */
	endpointId?: string;
	/** Where that hand keeps its files, when it keeps them anywhere. */
	handRoot?: string;
	/** What the hand is called, when it says. */
	handName?: string;
	/** Whether this Worker runs with a hand at all. */
	hasHands: boolean;
}

/**
 * The message that starts a task.
 *
 * Deliberately short: the Worker's system prompt already carries its role, its
 * skills and its invariants, so repeating them here would be a second copy that
 * drifts. What a Worker cannot get from anywhere else is which task it is on.
 */
export function taskMessage(spec: TaskSpec): string {
	const lines = [
		`Task: ${spec.title}`,
		"",
		// Two parts, because they answer different questions: what this is for (the
		// line the person sees) and what to do about it (the brief).
		...(spec.instructions === undefined
			? [`Description: ${spec.description}`]
			: [`What this is for: ${spec.description}`, "", spec.instructions]),
		"",
		`Capabilities granted to you: ${JSON.stringify(spec.capabilities)}.`,
	];
	if (spec.hasHands) {
		// Where the work happens, and which machine — the `hands` skill says how to
		// use it. A Worker told neither will run commands in its own process and
		// report files that were never touched.
		const label =
			spec.handName === undefined ? (spec.endpointId ?? "the hub's least-loaded capable hand") : `“${spec.handName}” (${spec.endpointId ?? "a hand"})`;
		lines.push(`Execution happens on a hand (see the \`hands\` skill). You are on: ${label}.`);
		// The folder the hand is rooted at is where "here" is. It is the hand's own
		// policy, so this is true of any hand — a space, a repo, a build box — and a
		// Worker that is not told will look for the file in a connected service.
		if (spec.handRoot !== undefined) {
			lines.push(`Its files start at: ${spec.handRoot}. Relative paths begin there.`);
		}
	} else {
		lines.push("No hand is configured: use your local tools.");
	}
	lines.push(
		// The one control fact that is not a skill: an event that is not this task's
		// is released, not answered. Answering it would put this Worker's words into
		// a conversation it is not part of.
		"If a follow-up message arrives that is not part of this task, call release_event instead of answering it.",
	);
	return lines.join("\n");
}
