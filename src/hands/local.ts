/**
 * The daemon's own machine, as a hand.
 *
 * Registering local execution behind the same `EndpointConnection` interface as
 * a remote laptop means there is exactly one dispatch path and one failure model:
 * `exec` either comes back with a result or with a tool error, whether the work
 * ran three feet away or across the internet. It also means a deployment with no
 * endpoints configured still works — it just has one hand.
 */

import type {
	EndpointToHub,
	HandCapabilities,
	HandPolicy,
	HandPolicySummary,
	HubToEndpoint,
	WorkItem,
} from "./protocol.ts";
import { policySummary } from "./policy.ts";
import type { EndpointConnection } from "./hub.ts";
import type { HandExecutor } from "./executor.ts";

export class LocalHand implements EndpointConnection {
	readonly endpointId: string;
	readonly kind = "local" as const;
	readonly name: string;
	capabilities: HandCapabilities;
	policy: HandPolicy;
	policySummary: HandPolicySummary;
	meta?: Record<string, string>;
	lastSeen = Date.now();
	running = 0;
	connected = true;

	private readonly aborts = new Map<string, AbortController>();

	constructor(
		private readonly executor: HandExecutor,
		private readonly deliver: (message: EndpointToHub) => void,
		options: { endpointId?: string; name?: string; meta?: Record<string, string> } = {},
	) {
		this.endpointId = options.endpointId ?? "local";
		this.name = options.name ?? "daemon-local";
		this.capabilities = executor.capabilities;
		this.policy = executor.policy;
		this.policySummary = policySummary(this.policy, this.capabilities);
		this.meta = options.meta;
	}

	send(message: HubToEndpoint): void {
		if (message.type === "work") {
			void this.runWork(message.work);
			return;
		}
		if (message.type === "cancel") {
			this.aborts.get(message.workId)?.abort();
		}
	}

	close(_reason?: string): void {
		this.connected = false;
		for (const controller of this.aborts.values()) controller.abort();
		this.aborts.clear();
		// A job started in the background is this hand's: the hand closing is the
		// end of it, so a stopped brain does not leave a server holding a port.
		this.executor.stopJobs();
	}

	private async runWork(work: WorkItem): Promise<void> {
		const controller = new AbortController();
		this.aborts.set(work.workId, controller);
		// `running` is owned by the hub (it counts in-flight calls on this
		// connection); incrementing here would double the perceived load.
		this.deliver({ type: "accepted", workId: work.workId });
		try {
			const result = await this.executor.run(work.op, work.input, {
				signal: controller.signal,
				maxOutputBytes: work.maxOutputBytes,
				onChunk: (stream, data) => this.deliver({ type: "chunk", workId: work.workId, stream, data }),
			});
			this.deliver({ type: "result", workId: work.workId, result });
		} catch (err) {
			this.deliver({
				type: "result",
				workId: work.workId,
				result: { ok: false, error: (err as Error).message, durationMs: 0 },
			});
		} finally {
			this.aborts.delete(work.workId);
			this.lastSeen = Date.now();
		}
	}
}
