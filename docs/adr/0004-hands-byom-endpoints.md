# 0004 — Hands: a BYOM execution layer with its own installable daemon

## Status
Accepted.

## Context
After ADR 0001 the daemon manages **brains**: the Router and one pm2 process per
Worker, each holding a model loop. What it did not have is **hands** — a way to
execute on the machines where the work actually happens.

That gap is not a missing feature, it is a missing abstraction. Today a Worker's
`codemode` tool can read and write files, but it does so in the Worker's own
process, on the daemon's machine. So:

- a task can only run where the daemon runs, which rules out a laptop, a build
  box, or anything inside a customer's network;
- the "environment" is `process.cwd()` of the daemon, which is almost never the
  environment the task needs (uncommitted changes, local toolchain, intranet
  services, credentials);
- a crashed or hung Worker takes its sandbox with it, because the two are the
  same process.

`superagent.md` §5.2 and Anthropic's *Decoupling the brain from the hands* both
describe the same fix: leave state-heavy execution environments where they are,
and reach them on demand through a narrow interface. The interface is
`execute(name, input) → string`; the reach is a dial-out connection from the
environment to the cloud.

## Decision

Introduce a first-class **hand**: an execution environment that exposes a small,
policy-bound operation set, addressed by id, with no session state.

**1. One interface, three implementations.**
`EndpointConnection` (`src/hands/hub.ts`) is anything that can accept a
`HubToEndpoint` and hand back `EndpointToHub`. Behind it:

- `LocalHand` — the daemon's own machine, in-process. A deployment with no
  endpoints still works, with one hand.
- `EndpointDaemon` (`mir-endpoint`) — the installable process for macOS, Linux,
  and containers. Dials out over TCP/TLS; no inbound port, no static address.
- anything else later: a container scheduler, a phone, an emulator.

**2. The hand is the security principal.**
Policy (roots, executable allowlist, timeouts, output caps, env allowlist,
confinement) is configured **on the machine**, and the hub cannot widen it. Exec
is an **argv allowlist**, never a shell string, unless the hand explicitly grants
`sh` *and* allowlists it. Filesystem operations resolve inside declared roots and
refuse escapes rather than clamping them. Children get a filtered environment, so
a secret in the hand's own env never reaches a command — and output is redacted
before it leaves the hand.

Two guarantees, stated separately because conflating them is how sandboxes get
believed in wrongly:

- the **allowlist** decides which programs may start;
- **confinement** (`--confine`) decides what those programs may write, via
  `sandbox-exec` on macOS and `bwrap` on Linux, with writes limited to the
  declared roots.

Reads stay ambient under write confinement. A hand that requests confinement the
platform cannot provide refuses to run, rather than silently downgrading.

**3. Failure is a tool error, not a hung brain.**
Every call has a deadline at the hub and a deadline at the hand. A disconnect
fails every call that endpoint owed. A refused command comes back as `ok:false`
with a readable reason, which the model can act on. Nothing in the brain blocks
on a dead hand.

**4. The brain keeps only the loop.**
A Worker process holds the model, the tool surface and the session; the files,
the toolchain and the credentials live on the hand. When a hand is configured,
the Worker's *local* codemode loses filesystem access — otherwise there would be
two places a file could be, which is exactly the ambiguity this ADR removes.

**5. Brains ask; they do not choose blindly.**
`list_hands` is exposed to the Router and to Workers, and `dispatch_task` accepts
`endpoint`. Omitted, the hub picks the least-loaded connected hand that supports
the operation, preferring local on ties.

## Alternatives considered
- **Cloud sandbox per task** (clone the repo, rebuild). Cheap to reason about,
  but it cannot reproduce uncommitted changes, intranet services or a licensed
  toolchain, and it makes every task pay setup cost up front.
- **Run the harness on the endpoint too** (the coupled design). This is the
  container-as-pet problem: the session dies with the process, the machine needs
  an inbound port, and a prompt injection inside the harness is one step from the
  machine's credentials.
- **SSH from the daemon.** Works for a single machine, but it puts credentials in
  the cloud, needs inbound reachability, and gives no policy boundary the machine
  owner controls.

## Consequences
- A hand is cattle. Losing it costs one tool call, and the session log is
  untouched — the recovery path from ADR 0002 already covers the task.
- `mir-endpoint` becomes an installable artifact (`bin/mir-endpoint.js`, `npm i
  -g .`), with `launchd`/`systemd`/Docker recipes in `docs/hands.md`.
- The hub is a new trusted component: it authenticates hands (per-hand token,
  hashed at rest, constant-time compare) and must be reachable by them. It is
  deliberately *not* in the model's context: brains see `exec`, `read_file`,
  `write_file`, `list_dir`, `git`, `list_hands` and nothing else.
- Network egress from a brain (`fetch` in codemode) still happens in the cloud.
  Reaching an intranet URL from a hand is done with `exec` + `curl`, or by
  granting the hand a capability later. This is a known, documented limitation.
- A hand's policy is per-machine, so `list_hands` is the source of truth for what
  a task can do. The Router must read it rather than assume.

---

**Later:** the endpoint is not a second binary. `bin/mir-endpoint.js` was merged
into a single `mir` executable (`mir endpoint`), so installing one command gives
both the brain and the hand; the reasoning above is unchanged — the hand is still
a separate *process* with its own policy, and still dials out.
