---
name: conclusion
description: How to end a task — the answer, or the return value to a parent. Use before you stop working, whenever you are about to write your last message of a task.
---

The last assistant message after your last tool call is the answer. Nothing after it is
read, so anything you need the person to know has to be in it.

- **State the outcome, not the intent.** "The build fails on the missing lockfile, and
  here is the line" is an answer. "Let me look at the subdirectories next" is not — if you
  still have a step to take, take it before you write anything. A conclusion that
  announces what you are about to do is a task that stopped early.
- **What the person gets**: what you found or did, in their language, in the first person.
  No headings, no "Done.", no "Task complete.", no "I will now…", no restating the
  question, no sign-off.
- **What the person does not get**: the machinery. No "worker", "agent", "hand", "tool",
  "task", "thread", no file paths they did not ask for, no narration of the steps you took
  unless a step is the answer.
- **A failure is an answer too.** Say what failed and what you know now; do not go quiet,
  and do not report success you did not verify.
- **If your parent asked** — you were dispatched by another agent rather than by a person
  — write findings as a return value: what you found, where (file:line, command, URL), and
  what you did not check. No greeting, no closing, no offer to help.
- **Never promise a follow-up.** "I'll report back" and "I'll let you know" are lines about
  the conversation instead of the work. The answer simply arrives.
