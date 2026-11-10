# mir — domain model

Glossary of the terms this system uses. No implementation detail; just what
words mean here. When code and this file disagree, one of them is wrong.

## Core

**Super-agent** — the whole system: one continuous entity the user talks to in
many places, working several tasks at once. Not a single session.

**Router** — the long-lived layer that is the global sequence point, memory and
coordination point. It talks to humans (through Channels) and **dispatches**
tasks. It never executes a task itself.

**Worker** — a context-isolated agent dedicated to one task. It has full
execution tools. It never talks to a human directly; it reports conclusions to
the Router, which decides what the user sees.

**Task** — a unit of work handed to a Worker: an identity, a title, a
description, an owning Thread (optional), and a status
(`queued → running → done|failed`).

**Thread** — the ordered stream of Events about one object: a GitHub PR, an IM
topic, an email chain. Threads are many-to-many with Workers (subscription).

**Subscription / pass-through** — a Worker subscribes to a Thread; later Events
on that Thread go straight to the Worker without a Router turn (fast path). A
Thread with no subscriber falls to the Router (cold start).

**Trigger** — an Event that has passed filtering and now warrants a decision.
Filtering is two-stage: programmatic (fast) then semantic (model).

## Channels (the event source system)

**Channel** — a place the agent can be communicated with (terminal, HTTP
webhook, file queue, IM, GitHub, email). A Channel is a first-class object with
**two directions**:
- **Inbound**: it emits **Events** (which may become Triggers).
- **Outbound**: it exposes its **own response tool** (`respond_<channel>`), and
  the Router replies by *calling that tool*, never by writing raw output.

**Event** — a single inbound message on a Channel: identity, channel, thread,
sender, text, and an opaque `reply_to` address. An Event becomes a Trigger only
after filtering.

**Response tool** — the per-Channel tool the Router calls to deliver a reply
into that Channel (`respond_terminal`, `respond_http`, `respond_queue`). Each
Channel carries its own **reply norms** (e.g. IM ≤ 100 words and short
conclusions; GitHub/email structured and information-dense). A reply is a tool
call, not free-form text.

## Processes

**Daemon** (`mir-daemon`) — the pm2-managed process that runs the Router, the
Watchdog and the Channel listeners. It does not run Workers.

**Worker process** (`mir-worker-<id>`) — one pm2-managed OS process per Task,
running that Task's Worker. Spawned by the daemon, reports back over the control
channel, exits when finished.

**Control channel** — the daemon↔worker link (a local socket, newline-delimited
JSON): `hello`, `status`, `conclusion` (worker→daemon), `event`, `abort`
(daemon→worker).

**Watchdog** — an independent control loop outside the Router that recovers from
liveness failures and model drift, rechecking transient failures.

## Context

**Inline / Spill** — put soon-needed information directly in the window
(Inline); keep the rest outside with only a reference or summary (Spill).

**Chain of Recall** — each recalled object inlines the IDs of next-hop objects,
so context expands hop by hop along a reference graph.
