/**
 * Thread & Subscription Manager (Section 3.2).
 *
 * Threads are event streams (consecutive Triggers on the same GitHub PR,
 * IM topic, or email chain). When the Router creates a Worker for the first
 * event in a Thread, that Worker subscribes to the Thread directly.
 *
 * Routing follows two paths:
 *   - Subscribed (Fast Path): follow-up events pass straight through to the
 *     subscribed Worker(s) — no extra Router turn.
 *   - Unsubscribed (Slow Path): new events with no subscriber go to the Router
 *     for evaluation and possible dispatch.
 *
 * Subscriptions are many-to-many: a Worker can subscribe to several Threads,
 * and a Thread can have several subscribed Workers.
 */

import type { Thread, Trigger } from "./types.ts";

export class ThreadManager {
	private threads = new Map<string, Thread>();
	private workerThreads = new Map<string, Set<string>>(); // workerId -> threadIds
	private threadSubscribers = new Map<string, Set<string>>(); // threadId -> workerIds

	/** Create or return an existing Thread for a Trigger. */
	getOrCreateThread(trigger: Trigger): Thread {
		if (trigger.threadId && this.threads.has(trigger.threadId)) {
			return this.threads.get(trigger.threadId)!;
		}

		const id = trigger.threadId ?? `thread-${crypto.randomUUID().slice(0, 8)}`;
		const thread: Thread = {
			id,
			name: `${trigger.channelId}-${id.slice(0, 8)}`,
			channelId: trigger.channelId,
			subscriberWorkerIds: [],
			lastEventAt: trigger.receivedAt,
		};
		this.threads.set(id, thread);
		return thread;
	}

	/** Subscribe a Worker to a Thread (fast-path registration). */
	subscribe(workerId: string, threadId: string): void {
		let workerThreads = this.workerThreads.get(workerId);
		if (!workerThreads) {
			workerThreads = new Set();
			this.workerThreads.set(workerId, workerThreads);
		}
		workerThreads.add(threadId);

		let subscribers = this.threadSubscribers.get(threadId);
		if (!subscribers) {
			subscribers = new Set();
			this.threadSubscribers.set(threadId, subscribers);
		}
		subscribers.add(workerId);

		const thread = this.threads.get(threadId);
		if (thread && !thread.subscriberWorkerIds.includes(workerId)) {
			thread.subscriberWorkerIds.push(workerId);
		}
	}

	/** Unsubscribe a Worker from a Thread. */
	unsubscribe(workerId: string, threadId: string): void {
		this.workerThreads.get(workerId)?.delete(threadId);
		this.threadSubscribers.get(threadId)?.delete(workerId);
		const thread = this.threads.get(threadId);
		if (thread) {
			thread.subscriberWorkerIds = thread.subscriberWorkerIds.filter(
				(id) => id !== workerId,
			);
		}
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
		if (thread) thread.lastEventAt = timestamp;
	}

	listThreads(): Thread[] {
		return Array.from(this.threads.values());
	}

	getThread(threadId: string): Thread | undefined {
		return this.threads.get(threadId);
	}
}
