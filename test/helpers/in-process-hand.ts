/**
 * A hand in the same process, for tests.
 *
 * The daemon itself never offers its own directory as a hand: a brain's home is not
 * a place anyone asked about, and a Worker that named no hand read the brain's
 * journal and reported it as the space's files. Tests still want a hand that needs no
 * socket, so this one lives here rather than in `src/`.
 */

import type {
	EndpointToHub,
	HandCapabilities,
	HandPolicy,
	HandPolicySummary,
	HubToEndpoint,
	WorkItem,
} from "../../src/hands/protocol.ts";
import { policySummary } from "../../src/hands/policy.ts";
import type { EndpointConnection } from "../../src/hands/hub.ts";
import type { HandExecutor } from "../../src/hands/executor.ts";

export class InProcessHand implements EndpointConnection {
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
