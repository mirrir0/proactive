/**
 * Builds the per-Channel response tool from a Channel.
 *
 * The Router answers by calling `respond_<channel>`, which is exactly the
 * "responses are tool calls, not free-form text" contract. Each tool's
 * description carries that channel's reply norms so the model tailors length
 * and structure per place.
 *
 * Deliveries are reported to a `ReplyRecorder` owned by the caller (the
 * Router's current turn). That replaces the old process-wide counter, which
 * could not distinguish "this turn replied" from "some earlier turn replied".
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

export function makeResponseTool(channel: Channel, recorder: ReplyRecorder = NOOP_RECORDER) {
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
			const ctx: ReplyContext = { eventId: params.reply_to, threadId: params.thread };
			await channel.respond(params.text, ctx);
			recorder.record(channel.id, params.text, ctx);
			return {
				content: [{ type: "text", text: `sent on ${channel.id}` }],
				details: { channel: channel.id, chars: params.text.length },
			};
		},
	});
}
