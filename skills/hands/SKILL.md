---
name: hands
description: Work on the machine the member pointed you at — files, commands, git — instead of inside this process. Use whenever a task needs to read, write, run or search anything on disk.
---

Execution happens on a hand: an execution environment with a filesystem, a shell and git.
This process has none of them — when a hand is configured, even the local codemode loses
its file access — so the hand's tools are the only way anything on disk changes.

- `exec({ argv })` runs a command there. argv form, no shell unless the hand granted one.
- `read_file`, `write_file`, `list_dir` touch its filesystem, confined to its roots. A
  path outside them is refused, and that refusal is the answer — do not retry it another
  way.
- `git({ args })` runs git there, with the machine's own credentials.
- `list_hands()` shows the hand you run on, and nothing else. There is no second one to
  fall back to.

**A command that finishes is not a job.** `exec` returns when the command is done — a
search, a build, a test run, a `git` call. Run it normally and read the result.

**A server or a watcher is a job.** Start it with `background: true` when it does not
exit on its own, then read what it wrote with `job_output` — **polling, yourself**.
Nothing notifies you when a job finishes: there is no wake-up, no callback, and no new
turn with the result. A Worker that writes "I'll wait for it to come back" is waiting
for a message nobody sends, and will say the same sentence until its turn ends.

The job belongs to the task that started it — when the task is stopped, its jobs are
stopped with it. Do not leave a process listening on a port behind a task that has
ended.

Where a thing lives decides where you look for it: a file on this hand is found by its
name on disk; a record in a connected service is found through that service. They do not
overlap.
