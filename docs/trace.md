# Tracing one chat

The brain is a serialized actor with a log. That log is the only place the flow
of a chat exists: what the person said and when, what the Router did about it,
what each dispatched worker did in its own thread, and what came back. Reading it
by hand is `sqlite3` and squinting; `scripts/trace.ts` is the same thing, in the
order it happened, with the waiting visible.

```sh
npm run trace                                   # the chats this brain has, newest first
npm run trace -- --latest                       # the most recent chat, in full
npm run trace -- --chat <chatId>                # one chat
npm run trace -- --thread <threadId>            # one thread: a chat's, or a worker's
npm run trace -- --task <taskId>                # one dispatch, with its brief, then its worker
npm run trace -- --chat <id> --turns 3 --full   # the last three turns, whole arguments
npm run trace -- --chat <id> --json             # the trace as data, for a program
```

`--state <path>` points it at a database, a member's home, or the brains root
when the default is not what you want; the default is the newest state under
`$MIR_BRAIN_DIR` (the stack) or `~/.local/share/mir/state` (a developer's
`mir serve`). It only ever `SELECT`s, and it opens the file read-only when
SQLite allows it, so it is safe against a live brain.

## What it prints

```
Find vision document in space
  chat   01M7GQ9F6Y2DF7GTEMDCVZTK2A
  thread 01M7GQ9F7RZP9ZHWDPFB54WHY5 · idle · 33 entries
  brain  pid 48213 running · dev-team/076DRV/224QRM
  span   2026-11-15 16:05:10 → 16:17:19 (12m 9s)
  flow   9 turns (7 yours, 2 from work) · 2 dispatched · 5 did no work · median 5s before anything happens

turn 2 · you · 16:05:38 · 8s
  idle between turns 18s
  you  its in the space, not in linear
      +8s says Already searching — the document hunt is focused on the space, not Linear. I'll report back…
      +0s · turn closed turn finished
```

- **A turn is what the person saw as one**: their words, everything the brain
  did about them, and the entry that closed it (`turn finished`, `the worker
  finished`, or a stop). A worker's conclusion opens a turn of its own, marked
  `work`, because that is a turn with nobody's words in it.
- **The person's message is written at admission**, so the offset from it to the
  next entry is real waiting — a queued turn or a slow model, not a rounding.
- **A dispatch is drawn from its task**, not from the raw tool call, and the
  worker's thread is drawn under it: its calls, its refusals, its conclusion.
  Arguments and results are one line each; `--full` shows them whole.
- **A rename is drawn** even though the chat's transcript hides it: when the
  brain named the chat is part of the flow.
- **The brain line says whether the process that wrote this is alive.** `pid …
  gone — this is a copy of its state` changes how a gap reads: a queue is not
  the same as a brain that stopped mid-turn. The identity is the session it runs
  as on the stack, which is what its grants hang off.
- **`--json`** carries the same structure (`turns`, `dispatches` with their
  workers and children, `findings`, `counters`), which is what a script or an
  agent should read rather than the text.

## Findings

The findings at the end are facts with a code, counted — never a verdict. What
to do about them is the reader's job, and that is the point: they are the
sentences a change to the Router or a Worker's brief is argued from.

| code | what it counted |
| --- | --- |
| `talk-only-turn` | a turn of the person's with a reply, no dispatch, and no tool call. The reply's promise ("Already searching…", "I'll report back") is quoted when there is one. |
| `slow-start` | a minute or more between the person's words and anything happening. When the brain was writing to other threads in that window, they are named — that is the difference between a slow model and a queue. |
| `long-turn` | a turn open past two minutes: the person could not type until it closed. |
| `duplicate-dispatch` | the same work dispatched twice, by the words of the two titles — and whether the person asked again or the brain re-dispatched itself, which are opposite problems. |
| `failed-task` | a dispatch that ended failed, with the last thing its worker said. |
| `stopped-task` | a dispatch the person stopped. |
| `undelivered-conclusion` | a task that finished whose own words are not in the chat. The check is verbatim, because the contract is that the conclusion *is* the answer: a model restating it is the failure this catches, not a delivery. |
| `conclusion-elsewhere` | a task whose conclusion went into a different conversation than the one being read. Not a lost answer — a task replayed into a second thread looks like this. |
| `refused-tool` | a worker that tried a tool it was not granted, with the tool's name. This is a grant problem, not a model problem. |
| `repeated-call` | the same tool with the same arguments twice in one worker. |

`note`-severity findings (a stop) are shown but not counted in the list's
`flags` column, which is for the things worth opening a chat about.

## What it does not do

- **It does not read the host's Postgres.** The chat's row and the UI's copy of
  the messages live there; what the brain saw and did is in the brain, and that
  is the trace. A chat's title comes from the thread's `name`, which is the
  row's copy.
- **It does not show the prompt.** What the Router was sent is not recorded;
  a turn's inputs are its entries and the briefs on its dispatches. Recording
  prompts is a change to the brain, not to this tool.
- **It does not judge.** `talk-only-turn` does not know whether the reply was
  right to say nothing — only that it did nothing and said something.
