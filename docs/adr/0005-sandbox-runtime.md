# 0005 — Enforce hand policy with the Anthropic Sandbox Runtime

## Status
Accepted. Supersedes the hand-rolled `sandbox-exec`/`bwrap` wrapping in ADR 0004.

## Context
ADR 0004 gave a hand two guarantees: an **executable allowlist** (which programs
may start) and **write confinement** (which paths they may touch). Building the
smoke test for it exposed the gap between them:

```
$ cat /etc/hosts        # allowed: `cat` is on the allowlist
$ node -e 'writeFileSync("~/.zshrc", ...)'   # allowed: `node` is on the allowlist
```

An allowlist answers "may this program run?", not "what may it touch or reach?".
Write confinement fixed half of that. The other half — **network** — was not
enforced at all, and a process that can read `~/.ssh` and reach the internet is
the exact exfiltration path §8.4 warns about. Read confinement was also missing,
so `read_file` on the hand could reach anything the operator could.

Implementing read + network confinement by hand means generating seatbelt
profiles, wiring bubblewrap network namespaces, and running HTTP/SOCKS proxies
with an allowlist — per platform, with its own failure modes. That is a
specialised security component, not a feature.

## Decision
Delegate enforcement to **`@anthropic-ai/sandbox-runtime`** (`srt`), the library
behind Claude Code's sandboxing. A hand's policy is mapped onto its config and
applied to the whole process tree of every `exec`.

**Mapping** (`buildSandboxConfig` in `src/hands/sandbox.ts`):

| hand policy | `srt` config |
| --- | --- |
| `roots` | `filesystem.allowWrite` (+ `srt`'s own temp/scratch paths) |
| `denyWritePaths` | `filesystem.denyWrite` |
| `denyReadPaths` | `filesystem.denyRead` |
| `network.allowedDomains` | `network.allowedDomains` (allow-only; empty = no network) |
| `network.deniedDomains` | `network.deniedDomains` (wins over allow) |
| `network.allowLocalBinding` | `network.allowLocalBinding` |
| `network.allowUnixSockets` | `network.allowUnixSockets` |

**Three invariants keep this honest:**

1. **No silent downgrade.** If the sandbox is requested and cannot be provided —
   unsupported platform, missing `bwrap`, a config `srt` refuses — construction
   throws and the hand refuses to start. `HandExecutor` also refuses to run a
   command when `policy.sandbox === "srt"` and no sandbox was injected.
2. **The wrapper is not an injection point.** `srt` takes a command *string* and
   runs it through a shell, so the argv we were given is shell-quoted element by
   element (`shellQuote`) before embedding. An argument can never become a
   second command.
3. **The hand's own tools obey the same lists.** `read_file`, `list_dir`,
   `stat` and `write_file` check `denyReadPaths`/`denyWritePaths` directly
   (`isPathDenied`), so the model cannot step around the sandbox by asking the
   hand instead of a shell.

**Denials are reported as policy.** `srt` annotates stderr and records
violations per invocation; a failed command that the sandbox blocked comes back
as `ok: false, blocked: true` with an error naming the policy, not as a bare
`EPERM` the model has to guess about. Attribution uses the per-call `commandId`,
so concurrent calls cannot cross-attribute.

**Network requires a client that honours the proxy.** `srt` mediates traffic
through host-side proxies. `curl`, `git`, `npm` and `pnpm` honour
`HTTPS_PROXY`; Node's `fetch` does not by default, so the executor injects
`NODE_USE_ENV_PROXY=1` into the child environment. This is documented because it
is the difference between "the hand has no network" and "this particular client
does not use the network it has".

## Alternatives considered
- **Keep the hand-rolled wrappers and add network namespaces/proxies.** That is
  re-implementing `srt`, including its per-platform matrix and proxy logic, with
  no security review. Rejected.
- **Container per task instead of OS sandboxing.** Stronger isolation, but it
  cannot reproduce a laptop's uncommitted changes, credentials or intranet
  access — the reason BYOM exists. The two compose: a hand may itself be a
  container.
- **Docker/Podman for the local hand only.** Same objection, plus a hard
  dependency the user may not have.
- **No network confinement, allowlist only.** Leaves the exfiltration path open;
  the whole point of a hand boundary is that a compromised brain cannot turn
  "read a file" into "send it somewhere".

## Consequences
- `@anthropic-ai/sandbox-runtime` (Apache-2.0) is now a runtime dependency of the
  hands subsystem, and therefore of the endpoint binary.
- **Secure by default changes behaviour**: a hand with no `--allow-net` has no
  network. `git push`, `npm install` and `curl` fail until the operator names the
  hosts. The endpoint prints the effective allowlist at startup, and the failure
  reads as a policy denial.
- `srt` holds **one session per process**. A process may host exactly one hand
  policy; a second, different policy throws rather than silently merging. The
  daemon's local hand and a remote endpoint each live in their own process, so
  this is not a practical limit.
- `srt` locates its shell by spawning `which` with a 1s timeout, which can
  misreport a healthy shell on a loaded machine. The wrapper retries briefly on
  that specific error; everything else surfaces immediately.
- Windows enforcement exists in `srt` (WFP + ACLs) but is untested here; the
  `env` merge in the executor is written for it and marked as such.
