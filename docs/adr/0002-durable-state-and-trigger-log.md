# 0002 — Durable daemon state and an idempotent trigger log

## Status
Accepted.

## Context
ADR 0001 moved Workers into their own processes, but the daemon kept its whole
world in memory: `tasks`, `workers`, `threads`, `subscriptions` and the Router's
inbox were plain `Map`s and arrays. Two consequences, both fatal for an
always-online agent:

- A daemon restart (crash, deploy, `pm2 restart`) erased every task and
  subscription. Follow-up events on a PR then cold-started at the Router, which
  had no idea a Worker already owned that thread; in-flight work vanished with
  no record and no notification to the user.
- Events that arrived while the daemon was going down were simply lost. There
  was no dedupe either, so any at-least-once delivery upstream would be
  processed twice.

§5.1 of the paper is explicit: compute may be stateless, **state may not**.

## Decision
Introduce `src/store.ts` (`MirStore`), a single SQLite database
(`$MIR_STATE_DIR/mir.sqlite`, WAL, `busy_timeout=5000`) owning:

| table | purpose |
| --- | --- |
| `events` | the trigger log; `id` is the primary key, so re-delivery is idempotent |
| `tasks` | dispatch → running → done/failed/cancelled, with result/error |
| `workers` | the live worker registry (task, threads, heartbeat, progress) |
| `threads` + `subscriptions` | threads and their many-to-many Worker subscriptions |
| `objects` | the spilled-object reference graph behind Chain of Recall |

Behaviour that follows from it:

- **Dedupe on ingest.** `SuperAgent.submitEvent` inserts the event first. If the
  row already exists in a terminal state, the event is dropped and counted; if
  it is still `pending`, it is a replay after a crash and is processed.
- **Replay on boot.** `pending` events are re-submitted at startup, so an event
  accepted before a crash is not lost.
- **Recovery is explicit.** Persisted workers cannot be connected at boot (their
  control socket is gone), so their tasks are marked failed with the reason
  `daemon restarted while this task was running`, their pm2 apps are deleted, and
  one `recovery` item per affected channel is queued so the Router *tells the
  user* instead of silently forgetting.
- **Subscriptions are durable.** A follow-up on a thread still reaches the
  Worker that owns it after a restart; a stale subscription (worker gone) is
  dropped and the event falls back to the Router.
- **Retention.** Terminal events are pruned after `MIR_EVENT_RETENTION_MS`;
  spilled objects are capped at `MIR_OBJECT_RETENTION`.

## Alternatives considered
- **Keep memory + a JSON snapshot.** Simple, but every write must rewrite the
  whole world, and a torn write loses everything. No query surface for recall.
- **A separate durable log (Redis Streams / Kafka).** Right answer at scale, but
  it adds an operational dependency before there is load to justify it. SQLite
  in WAL mode handles the current single-daemon topology and keeps the seam
  (`MirStore`) small enough to swap.

## Consequences
- The Router's scheduling state is now a projection of the store; the maps are
  caches, not the source of truth.
- `mir status` works with the daemon stopped — it reads the store directly.
- Every worker heartbeat is a small write. At 8 workers × 15 s that is trivial;
  if worker counts grow, heartbeats should be batched into one update.
- Schema changes need a migration step; `migrate()` currently only creates
  tables (`CREATE TABLE IF NOT EXISTS`) and must grow real migrations before the
  first breaking change.
