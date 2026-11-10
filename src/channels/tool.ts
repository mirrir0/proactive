/**
 * Builds the per-Channel response tool from a Channel.
 *
 * The Router answers by calling `respond_<channel>`, which is exactly the
 * "responses are tool calls, not free-form text" contract. Each tool's
 * description carries that channel's reply norms so the model tailors length
 * and structure per place.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Channel } from "./types.ts";

/** Process-wide count of replies delivered into a channel (fallback safety net). */
export const channelActivity = { deliveries: 0 };

export function makeResponseTool(channel: Channel) {
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
			await channel.respond(params.text, {
				eventId: params.reply_to,
				threadId: params.thread,
			});
			channelActivity.deliveries++;
			return {
				content: [{ type: "text", text: `sent on ${channel.id}` }],
				details: { channel: channel.id, chars: params.text.length },
			};
		},
	});
}
