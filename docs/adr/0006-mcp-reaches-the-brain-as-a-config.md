# 6. MCP reaches the brain as a config, and the stack keeps the call path

- Status: accepted
- Date: 2026-11-12

## Context

A Worker's MCP servers came from one file (`MIR_MCP_CONFIG_PATH`, default
`mcp.config.json`) read by the brain process and shared by every Worker it
started. That is a developer's file: it names the stack machine's own servers,
and nothing about a member.

The product's connected services live in the stack: `hosted_plugins`, one row
per registration, team-scoped or personal (`owner_user_id`), with each member's
credential in the stack's vault. The stack already serves them to cap'n'web over
two loopback routes — "what does this session load" and "proxy this call" — and
already decides every call with `authorizeAgent` on `mcp.call:<server>/<tool>`,
attaching the member's own credential only at the proxy.

A brain pinned to a space could reach none of it: `capabilitiesFor` returned
`mcp: false` for any task whose endpoint was `space:<id>`, so a space Worker had
no MCP tools at all.

The obvious design — the brain forwards every call to the host over its socket —
is a large one: two new frames on each of two sockets, a catalog cache, an
`McpSource` seam in the Worker, and a per-call round trip through the daemon. It
buys nothing the stack's existing proxy does not already do.

## Decision

**The brain is handed a config, not a credential, and it connects to the
stack's existing proxy itself.**

1. The stack serves `GET /agent/brain-mcp` to a brain, over loopback,
   authenticated by the brain's own token: an `mcp.config.json`-shaped answer
   naming each server the member's RLS shows them — the team's and their own —
   with `url` pointing at `/agent/brain-plugin/<id>` and the brain's token in
   the `authorization` header.
2. The brain fetches it (`src/mcp-servers.ts`), keeps it by content hash, and
   hands it to each Worker in its spec. It re-asks every minute and on a
   `mcp_changed` broadcast, so a server registered, keyed or unlinked while a
   Worker runs reaches that Worker without a restart.
3. Calls go to `/agent/brain-plugin/<id>`, which resolves the brain's token to
   its member, decides the call with `authorizeAgent` on
   `mcp.call:<server>/<tool>`, attaches the member's credential, and forwards.
   A listing is not decided: the server describing itself is not an action, and
   a tool the assistant may not call is refused when it calls it.

`capabilitiesFor` gives a space task `mcp: true` and keeps `net: false`: the
Worker calls a tool and makes no request of its own. The stack dials.

## Consequences

- **The per-call gate survives.** Every call still passes `authorizeAgent` and
  the stack still substitutes the credential, because the call still goes
  through the stack. Handing the brain the servers' own credentials would have
  moved authorization to mint-time; this does not.
- **No credential in the brain.** It holds its own token — derived by the host,
  held in memory, naming one member — and nothing else. A Worker's tool surface
  carries no secret at all.
- **The brain needs an identity on the stack.** `authorizeAgent` reads a
  principal and a session row on every call, so each brain has one session of
  its own (`<home>/identity.json`, 0600): the member's main assistant, live for
  as long as the brain is, ended when it stops.
- **A brain without a stack keeps the file.** `MIR_STACK_URL` unset means the
  old path exactly, which is how a brain run by hand still works.
- **The stack must be up for MCP.** A Worker's call while the host restarts
  fails with a readable error; a fetch failure leaves the last good config and
  is logged once per outage, not once a minute.
- **MCP tools cost boot time.** Listing them is per server: 78 tools from one
  server took ~2.5 s of a Worker's boot. That is the price of the model being
  able to call them, and it is paid once per Worker.
- **`mcp.call` grants are per tool, as they already were.** A member whose
  assistant has no grant for a tool gets a refusal in the tool's own terms, and
  the model can read it.

## What this replaced

The design this ADR rejects — proxying calls over the brain socket — was
sketched in `docs/proposals/mir-as-the-default-assistant.md` and dropped before
implementation: it was ~450 lines across four frames and two sockets for a
behaviour the stack's proxy already had.
