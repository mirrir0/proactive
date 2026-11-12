/**
 * Thread & Subscription Manager (Section 3.2).
 *
 * Threads are event streams (consecutive Triggers on the same GitHub PR,
 * IM topic, or email chain). When the Router creates a Worker for the first
 * event in a Thread, that Worker subscribes to the Thread directly.
 *
 * Routing follows two paths:
 *   - Subscribed (Fast Path): follow-up events pass straight through to *all*
 *     subscribed Workers — no extra Router turn.
 *   - Unsubscribed (Slow Path): new events with no subscriber go to the Router
 *     for evaluation and possible dispatch.
 *
 * Subscriptions are many-to-many and durable: a restarted daemon reloads them,
 * so a follow-up on a PR still reaches the Worker that owns it.
 */

import type { Thread, Trigger } from "./types.ts";
import type { MirStore } from "./store.ts";

export class ThreadManager {
	private readonly threads = new Map<string, Thread>();
	private readonly workerThreads = new Map<string, Set<string>>(); // workerId -> threadIds
	private readonly threadSubscribers = new Map<string, Set<string>>(); // threadId -> workerIds
	private readonly store: MirStore | undefined;

	constructor(store?: MirStore) {
		this.store = store;
		this.hydrate();
	}

	/** Load durable threads + subscriptions into memory. */
	hydrate(): void {
		if (!this.store) return;
		for (const thread of this.store.listThreads()) {
			this.threads.set(thread.id, thread);
			for (const workerId of thread.subscriberWorkerIds) this.link(thread.id, workerId);
		}
	}

	private link(threadId: string, workerId: string): void {
		let threads = this.workerThreads.get(workerId);
		if (!threads) {
			threads = new Set();
			this.workerThreads.set(workerId, threads);
		}
		threads.add(threadId);
		let subs = this.threadSubscribers.get(threadId);
		if (!subs) {
			subs = new Set();
			this.threadSubscribers.set(threadId, subs);
		}
		subs.add(workerId);
		const thread = this.threads.get(threadId);
		if (thread && !thread.subscriberWorkerIds.includes(workerId)) {
			thread.subscriberWorkerIds.push(workerId);
		}
	}

	/** Create or return an existing Thread for a Trigger. */
	getOrCreateThread(trigger: Trigger): Thread {
		if (trigger.threadId && this.threads.has(trigger.threadId)) {
			return this.threads.get(trigger.threadId)!;
		}

		const id = trigger.threadId ?? `thread-${crypto.randomUUID().slice(0, 8)}`;
		const thread: Thread = {
			id,
			name: `${trigger.channelId}-${id.slice(0, 12)}`,
			channelId: trigger.channelId,
			subscriberWorkerIds: [],
			lastEventAt: trigger.receivedAt,
		};
		this.threads.set(id, thread);
		this.store?.upsertThread(thread);
		return thread;
	}

	/** Subscribe a Worker to a Thread (fast-path registration). Idempotent. */
	subscribe(workerId: string, threadId: string): void {
		this.link(threadId, workerId);
		this.store?.subscribe(threadId, workerId);
	}

	/** Unsubscribe a Worker from a Thread (worker hand-back / worker exit). */
	unsubscribe(workerId: string, threadId: string): void {
		this.workerThreads.get(workerId)?.delete(threadId);
		if (this.workerThreads.get(workerId)?.size === 0) this.workerThreads.delete(workerId);
		this.threadSubscribers.get(threadId)?.delete(workerId);
		if (this.threadSubscribers.get(threadId)?.size === 0) this.threadSubscribers.delete(threadId);
		const thread = this.threads.get(threadId);
		if (thread) {
			thread.subscriberWorkerIds = thread.subscriberWorkerIds.filter((id) => id !== workerId);
		}
		this.store?.unsubscribe(threadId, workerId);
	}

	/** Drop every subscription held by a Worker (it finished or died). */
	removeWorker(workerId: string): void {
		for (const threadId of [...(this.workerThreads.get(workerId) ?? [])]) {
			this.unsubscribe(workerId, threadId);
		}
		this.workerThreads.delete(workerId);
		this.store?.unsubscribeWorker(workerId);
	}

	/** Get all Workers subscribed to a Thread (fast-path fan-out targets). */
	getSubscribers(threadId: string): string[] {
		return Array.from(this.threadSubscribers.get(threadId) ?? []);
	}

	/** Get all Threads a Worker is subscribed to. */
	getWorkerThreads(workerId: string): string[] {
		return Array.from(this.workerThreads.get(workerId) ?? []);
	}

	/** Record an event on a Thread, updating its last-event timestamp. */
	touchThread(threadId: string, timestamp: number): void {
		const thread = this.threads.get(threadId);
		if (!thread) return;
		thread.lastEventAt = timestamp;
		this.store?.upsertThread(thread);
	}

	listThreads(): Thread[] {
		return Array.from(this.threads.values());
	}

	getThread(threadId: string): Thread | undefined {
		return this.threads.get(threadId);
	}

	get size(): number {
		return this.threads.size;
	}
}
