# 0003 — A security seam: channel auth, secret redaction, capability gating

## Status
Accepted.

## Context
§8.4 of the paper states the problem plainly: the architecture assumes the cloud
side and the endpoints trust each other, and that credentials on an endpoint can
enter the model's context. In this codebase that assumption was load-bearing:

- The HTTP channel accepted any POST from anywhere, so the **event stream that
  drives the agent** was unauthenticated. Anyone who could reach the port could
  give the agent instructions.
- The full task spec (title + description, which routinely contains private
  context) travelled as `MIR_WORKER_SPEC` in the pm2 environment, visible to
  every local user via `pm2 env` / `ps eww`.
- The `codemode` tool advertised `fetch` / `readFile` / `writeFile` and would
  have granted them unconditionally; the tool description was the only policy.
- Nothing scrubbed secrets from logs, prompts, tool output or replies. A token
  read from a file went straight into the Router's transcript.

A single incident in any of those is enough to lose a machine, so they are one
decision, not four.

## Decision

**1. Authenticate the input.** `verifyChannelRequest` (token and/or
HMAC-SHA256 over `<timestamp>.<body>`, constant-time comparison, 5-minute replay
window) runs **before the body is parsed**. The HTTP channel answers 401 and the
event never enters the system. The queue channel admits only files owned by the
daemon's uid. The control socket is `chmod 0600`. Unauthenticated channels are
logged as a warning at startup; a non-loopback bind without auth is an error.

**2. Never move secrets through ambient state.** The Worker spec is written to
`$MIR_STATE_DIR/specs/<workerId>.json` with mode `0600` and the environment
carries only the path. MCP configs may use `${env:NAME}`; `resolveSecretRefs`
substitutes at connect time, and every resolved value is registered with the
secret registry.

**3. Redact everywhere.** `secrets` (a process-wide `SecretRegistry`) is primed
from the environment and from MCP credentials. Logs, fallback replies, HTTP/queue
outbound text, codemode output and worker deltas all pass through
`redactSecrets`. Longest value wins, values under 8 characters are ignored so
ordinary prose is not mangled.

**4. Make the tool surface a policy.** A Worker's `WorkerCapabilities`
(`net`, `fs: none|ro|rw`, `mcp`, `codemode`) decide which host helpers are even
injected into the codemode sandbox: no `fetch` without `net`, no
`readFile`/`writeFile` without `fs`, and `writeFile` only at `fs: "rw"`. File
helpers are rooted at the Worker's cwd and reject traversal rather than clamping
it. `MIR_WORKER_TOOL_ALLOW` / `MIR_WORKER_TOOL_DENY` layer a name/glob policy on
top.

## Alternatives considered
- **Network isolation only** (bind to localhost, trust the LAN). Cheap, but it
  does nothing about prompt injection through a legitimate channel, nor about
  credentials in the model's context.
- **A separate secrets manager / vault.** Correct at scale; the seam here
  (`SecretRegistry`, `resolveSecretRefs`) is deliberately small so it can be
  backed by one later without touching call sites.
- **Sandbox the whole Worker in a container.** The right long-term answer for
  `fs`/`net`, and the reason capabilities are modelled explicitly now: the policy
  already exists, only the enforcement mechanism would change.

## Consequences
- Existing deployments must set `MIR_HTTP_TOKEN` (or an HMAC secret) before
  exposing the HTTP channel beyond localhost.
- `codemode` no longer silently claims capabilities it does not have; the tool
  description lists exactly what was granted.
- Secrets are still *visible to the model* if a tool returns them; redaction
  removes them from logs and outbound text, but a credential read into context
  is still a credential in context. Solving that requires a credential broker
  that performs authenticated calls on the agent's behalf — the next step, and
  the reason `resolveSecretRefs` lives in the security module.
