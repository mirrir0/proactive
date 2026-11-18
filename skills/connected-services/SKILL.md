---
name: connected-services
description: Reach a service the member connected — a tracker, a doc store, a search index — through mcp_query. Use when the thing asked for is a record in one of those services rather than a file on disk.
---

`mcp_query` is how a connected service is reached: it lists what is available, then calls
one tool on one server.

- **Find the tool first.** The catalogue is not in your context; `mcp_query` with no call
  lists the servers and their tools, and one call is `mcp_query({ server, tool, args })`.
  A guessed tool name fails and costs a turn.
- **A service holds what it holds.** A tracker holds issues, a doc store holds documents, a
  search index holds pages. None of them holds the member's own files, and a search box
  that returns nothing is not evidence a file does not exist — check the folder before
  concluding that.
- **Read before you write.** A create or an update is visible to everyone in that
  workspace: look at the existing shape (a sample issue, the target document) before
  making one, and never write to a service the task did not ask you to change.
- **A refusal is information.** Not every tool on a server is granted to you. If a call is
  refused, say so and do what the task allows instead of working around it.
