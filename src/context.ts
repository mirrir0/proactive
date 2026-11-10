/**
 * Context Manager — Inline & Spill + Chain of Recall.
 *
 * Treats the model's context window as a cache:
 *   - Inline: put information likely needed soon directly into the context
 *   - Spill:  keep full info outside the window, leave only a reference/summary
 *   - Chain of Recall: each recalled object inlines the IDs of next-hop objects,
 *     letting the model expand context hop-by-hop along a reference graph.
 *
 * Objects (Triggers, Threads, Worker Sessions, Tasks) get unique IDs. When one
 * object is injected, the IDs of closely related objects are inlined too, so the
 * model can follow references and recall more context on demand via tool calls.
 */

export interface SpilledObject {
	id: string;
	type: "trigger" | "thread" | "task" | "worker" | "message";
	summary: string;
	ref: string; // pointer/path to full data
	inlineIds: string[]; // IDs of next-hop objects to inline when recalled
}

export interface InlineBudget {
	maxInlineChars: number;   // cap for long inlined content
	maxInlineIds: number;     // max related IDs to inline per object
}

export const DEFAULT_INLINE_BUDGET: InlineBudget = {
	maxInlineChars: 200,
	maxInlineIds: 5,
};

/**
 * In-memory reference graph + spill store. In a production deployment this
 * would be backed by a persistent database (see Section 5: compute/state
 * separation).
 */
export class ContextManager {
	private spilled = new Map<string, SpilledObject>();
	private index = new Map<string, string[]>(); // object type -> ids
	private budget: InlineBudget;

	constructor(budget: InlineBudget = DEFAULT_INLINE_BUDGET) {
		this.budget = budget;
	}

	/** Spill a large object out of the window, keeping only a reference. */
	spill(obj: Omit<SpilledObject, "ref"> & { ref: string }) {
		this.spilled.set(obj.id, obj);
		let ids = this.index.get(obj.type);
		if (!ids) {
			ids = [];
			this.index.set(obj.type, ids);
		}
		if (!ids.includes(obj.id)) ids.push(obj.id);
	}

	/** Retrieve a spilled object by id (on-demand recall). */
	recall(id: string): SpilledObject | undefined {
		return this.spilled.get(id);
	}

	/**
	 * Inline an object into the model context: produce a compact string that
	 * includes the object's summary plus the IDs of related objects (the chain
	 * of recall entry points). Long content is truncated with a spill pointer.
	 */
	inline(obj: {
		id: string;
		type: SpilledObject["type"];
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
				const obj = this.spilled.get(id);
				if (obj) {
					chain.push(`${obj.type}:${obj.id} — ${obj.summary}`);
					next.push(...obj.inlineIds);
				}
			}
			current = next;
		}
		return chain;
	}

	listByType(type: SpilledObject["type"]): string[] {
		return this.index.get(type) ?? [];
	}
}
