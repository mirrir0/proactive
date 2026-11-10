# 0001 — pm2 process topology: daemon + one pm2 app per Worker

## Status
Accepted.

## Context
The Super-agent architecture separates three things that a naive local agent
fuses into one process: the **compute** that runs the Agent Loop, the session
**state** that must persist, and the **execution environment**. See
`superagent.md` §5.

Previously `mir` ran everything — Router, Watchdog, and Workers — inside one
in-process REPL. Workers were merely isolated `AgentSession`s sharing the
daemon's event loop and lifetime. That does not give the system a real
background process manager, so:

- A runaway or crashing Worker can take the Router down with it.
- Nothing restarts the system if it dies; nothing keeps it online.
- Worker resource use is invisible to normal process tooling (pm2, `ps`, logs).

## Decision
Run **the daemon and every Worker as separate OS processes managed by pm2**:

- `mir-daemon` — Router + Watchdog + Channel listeners + the control server.
  Owns the durable Router session. Never runs a Task itself.
- `mir-worker-<taskId>` — one pm2 app per Task. Spawned by the daemon, connects
  back over the control channel, reports `status`/`conclusion`, and exits when
  finished. The daemon `pm2 delete`s it.

Workers communicate with the daemon over a local Unix-socket control channel
(NDJSON): `hello`, `status`, `conclusion` up; `event`, `abort` down.

## Alternatives considered
- **Single pm2 app for everything.** Simplest; keeps in-process Workers. Gives
  restart/log/monitoring, but not real per-Task isolation or scheduling.
- **Hybrid** (inline short tasks, pm2 only for long ones). Better resource use,
  but two code paths and two failure models for the same concept.

## Consequences
- True isolation: a Worker crash cannot kill the Router; pm2 restarts either.
- Real background process management: `pm2 ls`, logs, restart policy, autostart.
- Cost: ~1–2 s process spawn and per-Worker memory. Acceptable for tasks that
  are expected to be long-running; short chat turns stay in the Router.
- The control channel becomes a protocol with its own versioning surface, and
  the daemon must reap dead Worker apps (the Watchdog's job).
