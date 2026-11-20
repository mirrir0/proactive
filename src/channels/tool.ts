/**
 * The per-channel response tool: a reply is a tool call, never raw text, and its description
 * carries that channel's norms. Deliveries are reported to the turn's own `ReplyRecorder`.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Channel, ReplyContext, ReplyRecorder } from "./types.ts";
import { NOOP_RECORDER } from "./types.ts";

/** Per-channel reply length caps (a norm the system can actually enforce). */
export interface ReplyLimit {
	maxChars: number;
	/** Hard-truncate rather than reject, so a reply is never lost. */
	truncate: boolean;
}

export function makeResponseTool(
	channel: Channel,
	recorder: ReplyRecorder = NOOP_RECORDER,
	/** The turn knows the thread it is answering; without this a reply falls back to the last chat heard. */
	context?: () => ReplyContext,
) {
	return defineTool({
		name: `respond_${channel.id}`,
		label: `Respond on ${channel.id}`,
		promptSnippet: `Respond on the "${channel.id}" channel (${channel.kind}).`,
		promptGuidelines: [
			`To say anything to a human on the "${channel.id}" channel you MUST call respond_${channel.id}. Plain assistant text is not delivered anywhere.`,
			`Reply norms for ${channel.id}: ${channel.norms()}`,
		],
		description: [
			`Send a reply into the "${channel.id}" channel — ${channel.describe()}.`,
			`Reply norms: ${channel.norms()}`,
			`Optional addressing: pass \`reply_to\` (an event id) or \`thread\` to answer a specific event/thread; omit to answer the most recent inbound event on this channel.`,
		].join("\n"),
		parameters: Type.Object({
			text: Type.String({ description: "The reply text to deliver into this channel." }),
			reply_to: Type.Optional(
				Type.String({ description: "Event id to reply to. Omit to use the latest inbound event." }),
			),
			thread: Type.Optional(
				Type.String({ description: "Thread id to reply on. Omit to use the latest inbound thread." }),
			),
		}),
		async execute(_toolCallId, params) {
			const ctx: ReplyContext = {
				...(context?.() ?? {}),
				...(params.reply_to === undefined ? {} : { eventId: params.reply_to }),
				...(params.thread === undefined ? {} : { threadId: params.thread }),
			};
			// Counted before it is delivered: a refused reply must not reach a person
			// and then be apologised for.
			const verdict = recorder.record(channel.id, params.text, ctx);
			if (!verdict.ok) {
				return {
					content: [{ type: "text", text: verdict.reason }],
					details: { channel: channel.id, chars: 0 },
					isError: true,
				};
			}
			await channel.respond(params.text, ctx);
			return {
				content: [{ type: "text", text: `sent on ${channel.id}` }],
				details: { channel: channel.id, chars: params.text.length },
			};
		},
	});
}
