# mir — domain model

Glossary of the terms this system uses. No implementation detail beyond what a
term *means*; but when code and this file disagree, one of them is wrong.

## Core

**Super-agent** — the whole system: one continuous entity the user talks to in
many places, working several tasks at once. Not a single session.

**Router** — the long-lived layer that is the global sequence point, memory and
coordination point. It talks to humans (through Channels) and **dispatches**
tasks. It never executes a task itself.

**Worker** — a context-isolated agent dedicated to one task. It has the execution
tools its **Capabilities** grant. It never talks to a human directly; it reports
conclusions to the Router, which decides what the user sees.

**Task** — a unit of work handed to a Worker: an identity, a title, a
description, an owning Thread (optional), and a status
(`queued → running → done | failed | cancelled`). `queued` means "accepted, no
Worker slot yet".

**Thread** — the ordered stream of Events about one object: a GitHub PR, an IM
topic, an email chain. Threads are many-to-many with Workers (subscription), and
both the thread and its subscriptions are durable.

**Subscription / pass-through** — a Worker subscribes to a Thread; later Events
on that Thread go straight to **every** subscribed Worker without a Router turn
(fast path). A Thread with no live subscriber falls to the Router (cold start).
A Worker can **hand back** an Event (`release`) or **unsubscribe** from a Thread
when it turns out not to be its business; both return control to the Router.

**Trigger** — an Event that has passed filtering and now warrants a decision.
Filtering is two-stage: **programmatic** (fast, deterministic) then **semantic**
(slow, model-judged).

**Semantic judge** — the small, cheap model call that decides whether an
unowned event deserves the Router's attention. Its policies are natural language
and can be enabled/disabled without code. It is skipped for Threads that already
have a subscriber: those are known-interesting.

## Router scheduling

**Inbox** — the Router's single serialized queue. Triggers, worker conclusions,
worker exits, recovery notices and system signals all enter it, and exactly one
turn runs at a time.

**Batch** — the slice of the inbox folded into one Router prompt. Batching is a
consequence of the turn being busy (§2.1), not a debounce: while idle a fixed
window coalesces the first arrivals (never reset, so a steady stream cannot
starve the Router); while a turn runs, everything that piles up goes into the
next turn.

**Turn** — one `prompt` + settle. A turn's **reply attribution** is evaluated
only after the session is idle, so a queued follow-up cannot cause the fallback
to post partial text.

**Fallback reply** — if a turn produced no response-tool call and no dispatch,
the model's plain text is delivered to the originating channel so the human still
gets an answer.

**Recovery notice** — an inbox item created at boot for each task that a restart
interrupted. It exists so the Router tells the affected channel what happened
instead of silently forgetting.

## Hands (the execution system)

**Hand** — an execution environment the agent can run work on: a laptop, a build
box, a container. A hand exposes a small, policy-bound operation set (`exec`,
`readFile`, `writeFile`, `listDir`, `stat`, `git`) and holds **no session state**.
Losing a hand is a failed tool call, not a lost task.

**Brain** — everything that holds the model loop and the session: the Router and
the Workers. A brain never touches files directly; it asks a hand.

**Endpoint** (`mir endpoint`) — the process that makes one machine a
hand. It dials **out** to the hub, so no inbound port or static address is
needed, and it enforces the machine owner's policy.

**Hub** — the daemon-side router for hands. It authenticates endpoints, tracks
their capabilities and load, dispatches work with a deadline, streams output, and
fails every call an endpoint owed when it disconnects.

**Hand policy** — what a hand will do, configured on the hand and only narrowable
by the hub: `roots` (paths must resolve inside them), `allow`/`deny` (executable
allowlist; argv only, no shell unless granted *and* `sh` is allowlisted),
timeouts, output caps, an env allowlist, and a **sandbox** that confines the
whole process tree: writes only inside the roots, reads blocked for
`denyReadPaths`, and network limited to `network.allowedDomains`. Enforcement is
the Anthropic Sandbox Runtime (seatbelt / bubblewrap / WFP), so a denial is
reported as policy rather than as a bare `EPERM`. Children get a filtered
environment; output is redacted.

**Hand capabilities** — what a hand can do: `exec`, `shell`, `fs`
(`none|ro|rw`), `git`. Advertised on connect and surfaced by `list_hands`.

**Sandbox** — the OS-level boundary around everything a hand executes. `srt`
mode is the default; `none` is an explicit, warned-about downgrade. A hand that
claims to be sandboxed but has none refuses to run.

**Local hand** — the daemon's own machine, registered behind the same interface.
A deployment with no endpoints still works, with one hand.

**Work item** — one dispatched operation: an id, an op, an input, a deadline and
an output cap. Its outcome is a **hand result**: `ok`, exit code, stdout/stderr,
structured data, duration, truncation.

## Channels (the event source system)

**Channel** — a place the agent can be communicated with (terminal, HTTP
webhook, file queue, IM, GitHub, email). A Channel is a first-class object with
**two directions** and its own **authentication**:
- **Inbound**: it emits **Events** (which may become Triggers), after
  transport-level verification.
- **Outbound**: it exposes its **own response tool** (`respond_<channel>`), and
  the Router replies by *calling that tool*, never by writing raw output.

**Event** — a single inbound message on a Channel: identity, channel, thread,
sender, text, and an opaque `reply_to` address. An Event becomes a Trigger only
after filtering. Events are recorded in the **trigger log** before processing.

**Response tool** — the per-Channel tool the Router calls to deliver a reply
(`respond_terminal`, `respond_http`, `respond_queue`). Each Channel carries its
own **reply norms** (IM short, GitHub/email structured). A reply is a tool call,
not free-form text, and it is what the **reply recorder** counts.

## Files and paths

One executable, `mir`. Everything is a subcommand of it: the brain (`daemon`,
`serve`, `start`), its administration (`status`, `hands`, `recall`, `metrics`,
`paths`, `init`), and the hand (`endpoint`). `bin/mir.js` resolves the compiled
`dist/index.js` when there is one and falls back to `src/index.ts` through tsx,
always from its own location — so `mir` behaves the same from a shell, from pm2,
and from a launchd unit. There is no second binary: a hand is a role, not another
program.

`src/paths.ts` decides where files go, per platform:

| | macOS | Linux |
|---|---|---|
| config | `~/Library/Application Support/mir/config` | `~/.config/mir` |
| data (SQLite, queue, sessions) | `…/mir/data` | `~/.local/share/mir` |
| state (pid, worker state) | `…/mir/state` | `~/.local/state/mir` |
| cache (MCP tool lists) | `~/Library/Caches/mir` | `~/.cache/mir` |
| logs | `~/Library/Logs/mir` | `~/.local/state/mir/logs` |
| sockets | `…/mir/run` | `$XDG_RUNTIME_DIR/mir`, else `~/.local/state/mir/run` |

Linux follows the XDG Base Directory specification, including each variable
(`XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME`,
`XDG_RUNTIME_DIR`). macOS follows Apple's layout. `MIR_HOME` puts everything under
one directory (what a container mounts), and the per-path variables
(`MIR_STATE_DIR`, `MIR_SOCKET_PATH`, `MIR_QUEUE_DIR`, …) still win over
everything, because they are what an existing deployment sets.

`mir init` creates the layout and writes `config.json` (which records where things
are, never a secret); `mir paths` prints it without touching disk. A unix socket
path is capped by the kernel — 103 bytes on macOS, 107 on Linux — so `init` checks
the two sockets it will bind and names the limit and the variable that moves them
rather than failing later at bind time.

## Processes

**Daemon** (`mir-daemon`) — the pm2-managed process that runs the Router, the
Watchdog, the Channel listeners and the control server. It does not run Workers.

**Worker process** (`mir-worker-<taskId>`) — one pm2-managed OS process per Task.
Spawned by the daemon, reports back over the control channel, exits when
finished. Its spec arrives as a `0600` file path, never inline in the
environment.

**Control channel** — the daemon↔worker link (a local socket, newline-delimited
JSON, versioned): `hello`, `status`, `heartbeat`, `conclusion`, `delta`,
`mcp_catalog`, `release`, `unsubscribe` (worker→daemon); `event`, `abort`,
`system` (daemon→worker).

**Heartbeat** — a liveness message independent of turn progress. A Worker sends
it on a timer even while a long tool call runs, so "busy" and "stuck" are
distinguishable.

**Watchdog** — an independent control loop with **its own agent session**. It
first applies deterministic recovery (a stale heartbeat means stop the task; a
Router turn past its budget means abort it), then — only if something needs
judgement — asks its model, with tools to stop/retry tasks, adjust trigger
policies, and record an incident.

## Durable State

**MirStore** — the daemon's durable state (`$MIR_STATE_DIR/mir.sqlite`, SQLite
in WAL mode). Tables: `events` (trigger log), `tasks`, `workers`, `threads`,
`subscriptions`, `objects`. It is the source of truth; the Router's maps are
caches.

**Trigger log** — the `events` table. `id` is the primary key, so re-delivery is
idempotent (at-least-once input). Events left `pending` by a crash are replayed
at boot; terminal events are pruned by retention.

**WorkerStateStore** — the shared per-worker SQLite (`workers.sqlite`, WAL) that
holds each Task's own record of its status/result, written by the Worker process
itself.

**Per-worker session files** — each Worker keeps its own pi-coding-agent session
file at `worker-state/sessions/worker-<taskId>.jsonl`. The session is
file-backed from the first run.

## Context

**Inline / Spill** — put soon-needed information directly in the window
(Inline); keep the rest outside with only a reference or summary (Spill). Long
payloads are spilled to `objects` and inlined as a truncated summary plus ids.

**Chain of Recall** — each recalled object inlines the IDs of next-hop objects,
so context expands hop by hop along a reference graph. The Router's `recall` tool
is the entry point (`id` or `query`, optionally `chain`).

## Security

**Capabilities** — what a Worker's tools may reach: `net`, `fs`
(`none|ro|rw`), `mcp`, `codemode`. Host helpers are only injected into the
codemode sandbox when granted; file helpers are rooted at the Worker's cwd and
reject traversal.

**Secret registry / redaction** — the process-wide set of known secret values,
scrubbed from logs, prompts, tool output and outbound replies.

**Credential ref** — `${env:NAME}` inside an MCP config. Resolved at connect
time, never stored in the config, and registered with the secret registry.

## Models

**Router model** — the default `modelId` (super-vl). Long-lived Router session
that handles all human interaction and dispatches tasks.

**Fast model** — configurable via `MIR_FAST_MODEL_ID` (defaults to lightning).
Used by Workers for tasks the Router marks as `fast`, by the semantic judge, and
by the Watchdog unless overridden.

## Observability

**Log record** — one NDJSON line on **stderr** (stdout belongs to the terminal
channel) with `ts`, `level`, `msg` and fields, secrets redacted.

**Metrics** — the numbers the architecture paper measures: Router turn latency,
batch size, queue depth, task duration p50/p95, replies, retries, watchdog
findings. Exposed as Prometheus text on `MIR_METRICS_PORT`.

**Trace** — one chat read end to end out of the durable state, read-only:
`npm run trace` (docs/trace.md). The log is the flow; a trace is the flow in the
order it happened, with the waiting and the pathologies counted. It is the
instrument a change to the Router, a Worker's brief, or the hand a task runs on
is argued from — so it reports facts with a code and never a verdict.

## MCP + Codemode (Worker tools)

**MCP config** — `mcp.config.json` at the project root (configurable via
`MIR_MCP_CONFIG_PATH`). Defines MCP servers Workers connect to, using the
standard `mcpServers` shape. Each Worker loads it on startup and connects to
every server (unless `mcp` capability is denied). Tools appear as
`mcp__<server>__<tool>`.

**Config watcher + hot-reload** — the daemon watches `mcp.config.json`
(parent-directory watch, ~300ms debounce, atomic-save friendly). When servers are
added/removed/changed it prunes the catalog cache for those servers and
broadcasts a `system` signal (`kind: "mcp_changed"`) to every connected Worker.
Each Worker re-reads the file, diffs against its own last-applied config,
disconnects removed/changed servers, connects added/changed ones
(`McpManager.sync()`), swaps its `mcp__*` tool definitions, refreshes the codemode
sandbox globals, re-reports its catalog, and injects a `[system]` note into its
session. A corrupt save is logged and skipped — the last good config stays
active.

**Skills** — the brain's instructions are pi skills, at `skills/<name>/SKILL.md`
in the package root (`src/skills.ts`). pi advertises each one's name, description
and path; `use_skill({ name })` reads the body, because the Router has no file
tools by design. A session's resource loader is built by `brainResourceLoader()`
and allow-listed to two roots — the package's `skills/` and the session's own
agent dir — because the SDK's default loader also scans `~/.pi/agent/skills`, so
a brain without one advertises every skill on the host it runs on (measured: 63,
none of them the brain's). The same filter keeps a `SKILL.md` in a Worker's
working directory out: a space folder is a member's files, not instructions.
Extensions and context files are off for the same reason. Invariants that must
hold on every turn stay in the system prompt; procedures live in skills.

**`mcp_query` tool** — every agent (each Worker *and* the Router) can search the
available MCP tools. Workers search their live `McpManager`; the Router searches
the daemon's cached catalog merged from worker reports.

**OAuth login** — HTTP MCP servers requiring OAuth trigger an interactive flow;
tokens are stored in `~/.local/share/mir/mcp-oauth/<host>.json` and refreshed on
401.

**Codemode tool** — `codemode({ code })` executes JavaScript in a sandboxed
QuickJS VM (`InlineCodemodeSandbox`). Available globals are exactly the granted
capabilities: `console`, `store()/load()`, `text()`, `image()`, `exit()`, plus
`fetch` (net), `readFile`/`listDir` (fs), `writeFile` (fs: rw), and
`mcp__<server>__<tool>()` (mcp). Store writes persist across codemode calls
within a Worker session.

Only Workers get MCP tools and codemode — the Router never executes tasks and
only has `respond_<channel>`, `dispatch_task`, `stop_task`, `list_workers`,
`list_tasks`, `list_hands`, `recall`, `use_skill` and the informational
`mcp_query`.

Workers get the hand tools (`exec`, `read_file`, `write_file`, `list_dir`, `git`,
`list_hands`) when a hub is configured. When a hand is present the Worker's local
codemode loses filesystem access: there is exactly one place a file can be, and
that place is the hand.
