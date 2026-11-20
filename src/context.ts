/**
 * Inline & Spill with a chain of recall: a compact summary goes into the window, the full
 * object stays in the store with an id, and each recalled object names its next hops so
 * the model can walk the graph. Recall survives a restart, which is the point.
 */

import { Type } from "typebox";
import { defineTool, type AgentToolResult, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { MirStore } from "./store.ts";

export type SpillType = "trigger" | "thread" | "task" | "worker" | "message" | "conclusion" | "event";

export interface SpilledObject {
	id: string;
	type: SpillType;
	summary: string;
	ref: string; // pointer/path to full data
	inlineIds: string[]; // IDs of next-hop objects to inline when recalled
}

export interface InlineBudget {
	maxInlineChars: number; // cap for long inlined content
	maxInlineIds: number; // max related IDs to inline per object
}

export const DEFAULT_INLINE_BUDGET: InlineBudget = {
	maxInlineChars: 200,
	maxInlineIds: 5,
};

export interface ContextManagerOptions {
	/** Durable backing store. Omitted = in-memory (tests). */
	store?: MirStore;
	budget?: InlineBudget;
	/** Objects kept before pruning (only enforced when a store is present). */
	retention?: number;
}

export class ContextManager {
	private readonly cache = new Map<string, SpilledObject>();
	private readonly index = new Map<SpillType, string[]>();
	private readonly store: MirStore | undefined;
	private readonly budget: InlineBudget;
	private readonly retention: number;
	private writesSincePrune = 0;

	constructor(options: ContextManagerOptions = {}) {
		this.store = options.store;
		this.budget = options.budget ?? DEFAULT_INLINE_BUDGET;
		this.retention = options.retention ?? 5000;
	}

	/** Spill a large object out of the window, keeping only a reference. */
	spill(obj: SpilledObject): void {
		this.cache.set(obj.id, obj);
		let ids = this.index.get(obj.type);
		if (!ids) {
			ids = [];
			this.index.set(obj.type, ids);
		}
		if (!ids.includes(obj.id)) ids.push(obj.id);
		this.store?.putObject(obj);
		// Bound the in-memory cache; the store remains authoritative.
		if (this.cache.size > 2000) {
			const oldest = this.cache.keys().next().value;
			if (oldest !== undefined) this.cache.delete(oldest);
		}
		if (++this.writesSincePrune >= 500) {
			this.writesSincePrune = 0;
			this.store?.pruneObjects(this.retention);
		}
	}

	/** Retrieve a spilled object by id (on-demand recall). */
	recall(id: string): SpilledObject | undefined {
		const cached = this.cache.get(id);
		if (cached) return cached;
		const fromStore = this.store?.getObject(id);
		if (fromStore) this.cache.set(id, fromStore);
		return fromStore;
	}

	/** Search spilled objects by summary/id substring. */
	search(query: string, type?: SpillType, limit = 10): SpilledObject[] {
		if (this.store) return this.store.searchObjects(query, type, limit);
		const needle = query.toLowerCase();
		return [...this.cache.values()]
			.filter((o) => (!type || o.type === type) && (o.id.toLowerCase().includes(needle) || o.summary.toLowerCase().includes(needle)))
			.slice(-limit);
	}

	/** Summary plus the ids of related objects; long content is truncated with a spill pointer. */
	inline(obj: {
		id: string;
		type: SpillType;
		summary: string;
		relatedIds: string[];
	}): string {
		const idList = obj.relatedIds
			.slice(0, this.budget.maxInlineIds)
			.map((id) => `→ ${id}`)
			.join("\n  ");
		const summary =
			obj.summary.length > this.budget.maxInlineChars
				? obj.summary.slice(0, this.budget.maxInlineChars) + "… [spilled]"
				: obj.summary;

		const lines = [`[${obj.type}] ${obj.id}`, `  ${summary}`];
		if (idList) lines.push(`  related:`, idList);
		return lines.join("\n");
	}

	/** Build a Chain-of-Recall entry point from a starting object. */
	recallChain(startId: string, maxHops = 3): string[] {
		const visited = new Set<string>();
		const chain: string[] = [];
		let current: string[] = [startId];

		for (let hop = 0; hop < maxHops && current.length > 0; hop++) {
			const next: string[] = [];
			for (const id of current) {
				if (visited.has(id)) continue;
				visited.add(id);
				const obj = this.recall(id);
				if (obj) {
					chain.push(`${obj.type}:${obj.id} — ${obj.summary}`);
					next.push(...obj.inlineIds);
				}
			}
			current = next;
		}
		return chain;
	}

	listByType(type: SpillType): string[] {
		if (this.store) return this.store.listObjectsByType(type).map((o) => o.id);
		return this.index.get(type) ?? [];
	}
}

	/** An id fetches one object, a query searches; either way the next-hop ids come back. */
export function createRecallTool(context: ContextManager): ToolDefinition {
	return defineTool({
		name: "recall",
		label: "Recall context",
		description:
			"Recall context that is not in your window. Pass `id` for a specific object (trigger, thread, task, worker, conclusion) or `query` to search summaries. " +
			"Each result inlines the ids of related objects, so you can follow references hop by hop. Use this instead of guessing about past tasks.",
		parameters: Type.Object({
			id: Type.Optional(Type.String({ description: "Exact object id to recall." })),
			query: Type.Optional(Type.String({ description: "Substring to search in object summaries and ids." })),
			type: Type.Optional(
				Type.String({ description: "Restrict to one object type: trigger|thread|task|worker|conclusion|message." }),
			),
			limit: Type.Optional(Type.Number({ description: "Max search results (default 10, max 50)." })),
			chain: Type.Optional(
				Type.Boolean({ description: "Follow up to 3 hops of related ids from a recalled object." }),
			),
		}),
		exposure: "direct",
		async execute(_id, params): Promise<AgentToolResult<any>> {
			const limit = Math.max(1, Math.min(50, Math.floor(params.limit ?? 10)));
			const type = params.type as SpillType | undefined;
			let objects: SpilledObject[] = [];
			if (params.id) {
				const obj = context.recall(params.id);
				if (obj) objects = [obj];
			} else if (params.query) {
				objects = context.search(params.query, type, limit);
			} else {
				return {
					content: [{ type: "text", text: "Provide either `id` or `query`." }],
					details: { ok: false },
				};
			}
			if (objects.length === 0) {
				return {
					content: [
						{ type: "text", text: `No stored object matches ${params.id ?? `"${params.query}"`}.` },
					],
					details: { count: 0 },
				};
			}
			const lines: string[] = [];
			for (const obj of objects) {
				lines.push(`[${obj.type}] ${obj.id}`);
				lines.push(`  ${obj.summary}`);
				if (obj.inlineIds.length) {
					lines.push(`  related: ${obj.inlineIds.slice(0, 8).join(", ")}`);
				}
				lines.push(`  ref: ${obj.ref}`);
			}
			if (params.chain && objects[0]) {
				const chain = context.recallChain(objects[0].id, 3);
				if (chain.length > 1) {
					lines.push("", "chain of recall:");
					for (const hop of chain.slice(1)) lines.push(`  ${hop}`);
				}
			}
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { count: objects.length },
			};
		},
	});
}
