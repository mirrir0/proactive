---
name: chat-title
description: Name the chat this turn is answering, and rename it when the subject moves. Use on the first real request in a chat, and on any later turn whose subject the current name no longer describes.
---

The title is what the person sees in their list. A chat called "Chat" is one they cannot
find again, and one named after the first thing they said is wrong the moment the
conversation moves. You are the only thing that knows what this conversation is about, so
naming it is part of answering it.

- **The first real request**: `chat_title` with four or five words in their language —
  "Login redirect bug", "The deploy script". Never end a turn with the chat still called
  "Chat".
- **Every turn after that**: if this turn is about something the current name does not
  describe — a different file, a different problem, a request that has moved on — rename
  it. Do not wait to be asked, and do not keep a name that has stopped being true.
- **A name is the whole conversation, not the last message.** Do not restate the request
  you just answered, and do not rename when the subject has not moved. "Fixing the login
  redirect" stays right for ten turns about it.
- Called with no title, `chat_title` tells you what the chat is called now — which is how
  you tell a placeholder from a name someone chose.
