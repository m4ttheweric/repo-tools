---
name: sign-in
description: Use when starting real work on a repository and you want to appear on the rt chat buddy list -- signing in to rt chat or joining the repository room. Not for reading or posting chat (see rt:chat) or for setting an away message (see away).
---

# rt chat: sign in

Run `rt chat sign-in` (add `--status "<text>"` to start away, `--no-room` to skip the repository room, `--room <name>` to override its derived name). It prints the assigned handle -- suffixed if another live session already holds the base name -- and which room, if any, it joined. Chat messages arrive in your context automatically.

Hand off to the `rt:chat` skill for everything after this: reading, posting, DMs, and buddy-list statuses. This skill only gets you signed in.
