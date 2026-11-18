---
name: subagents
description: Split a task into independent checks that run at once. Use when the work divides into parts that do not need each other's answers — several files to read, several suspects to verify.
---

`dispatch_task` from inside a task runs a subagent and waits for its conclusion. It is a
return value, not a conversation: the subagent answers you, and nothing it says reaches a
person except through your own answer.

- **Dispatch when the parts do not depend on each other.** Three files to read, three
  suspects to verify, three places to look. Then they run at once and you read three
  answers.
- **Do not dispatch a single question.** That is your own job, and a subagent costs a
  process and a model turn to tell you what one tool call would have.
- **Never split what you have not looked at.** Read enough to know the parts are real
  before dividing them, or you will get three confident answers about the wrong thing.
- **Write the brief for the subagent, not for a person**: which files, what to decide,
  what to report. It cannot see your context, so anything it needs is in the brief.
- **Its answer is evidence, not a conclusion.** You are the one who has to be right: if two
  answers disagree, say so and check, rather than picking the one you liked.
