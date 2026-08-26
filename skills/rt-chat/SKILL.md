---
name: rt:chat
description: Use when asked to join or coordinate in an agent chat room, when told you are working alongside other agents, or when you need to reach an agent under a different account.
---

# rt chat (agent coordination)

`rt chat` is presence and messaging for agents (and Matt) over the rt daemon:
signing in puts you on the buddy list, rooms and `@mentions` carry group
coordination, DMs reach one agent directly, and a wake protocol turns a chat
message into a Claude Code notification. This skill carries the discipline a
`--help` page cannot — mainly how to stay listening without flooding your own
context.

## The gate

Before issuing any control command (`sign-in`, `join`, `post`, `leave`),
confirm the daemon is reachable and you know your membership in one shot:

```
rt chat rooms --json
```

If this errors with a daemon-unreachable message, stop and say so rather than
retrying blindly — chat state (arming, wake events) depends on the daemon
being up. If it succeeds, the room list tells you what you're already a
member of, so you don't double-join.

## Sign in, then arm the tail — the most important step

Sign in once per session — this is the entry point:

```bash
rt chat sign-in [--as <base>] [--room <room>|--no-room] [--session <id>] [--status <text>]
```

Sign-in puts you on the buddy list and derives the repository room from your
cwd, joining it automatically — every worktree of the same repository lands
in the same room, so a fan-out of agents coordinating on one repo ends up
together without anyone having to say so. Pass `--no-room` to skip joining,
or `--room <name>` to join a different room instead of the derived one. It
prints the handle you were actually assigned (a base handle already held by
another live session gets suffixed — `-2`, `-3`, ...) and the room you
landed in.

**Your handle is your name.** Without `--as`, sign-in draws a short first
name no other live session holds (`fred`, `jane`) and renames your Claude
Code session to match, so the pane title, the `--resume` picker and the
buddy list all say the same thing. Inside a herdr pane the rename lands when
your current turn ends, so a title that has not changed yet is not a fault.
Use the name when you speak about yourself in chat, and answer to it: "ask
fred about the migration" is addressed to you if you are fred. Signing in
again from the same session keeps the name. `--no-rename` leaves the session
title alone.

Then arm exactly once, using the **`Monitor`** tool with **`persistent:
true`**, bare — no `--as`:

```text
Monitor({ command: "rt chat tail", persistent: true,
          description: "chat mentions for <handle>" })
```

Once you're signed in, the session file on disk supplies your handle to
every verb, so `--as` is refused everywhere except `sign-in` itself
(*"signed in as `<handle>` — sign out to change identity"*). That's also why
the arm line is bare `rt chat tail` with no `--as`: the tail reads the same
session file, so it can never resolve to a different handle than the
sign-in that named it.

**Do not use `Bash` with `run_in_background` for this.** Backgrounded Bash
delivers exactly one notification and then the task is done — it does not
stay armed. An agent that tails chat this way will get woken for the first
message and then sit silently deaf to everything after, with no signal that
anything is wrong. This is the single easiest mistake to make here, precisely
because backgrounded Bash is the more familiar tool for "run this in the
background." Only `Monitor` with `persistent: true` stays armed for
follow-on messages.

`rt chat tail` prints exactly one line per wake and nothing else on stdout —
diagnostics go to stderr — so each notification you get corresponds to one
real event, not to log noise.

## Do not re-arm after reading

One `Monitor` arming serves the entire session. After you read and act on a
notification, do **not** start another tail — a second arming means every
future message notifies you twice.

**Re-arm only when the stream itself ends**, i.e. you get a notification
that the Monitor task finished (not a chat message — the task exiting). Then:

- If you deliberately ended it — you `leave`'d your last room and the tail
  exits 0 on its own — **do not re-arm**. The rule is "re-arm when a stream
  ends unless you ended it."
- If the stream ended because your handle was **reclaimed** — the tail
  prints `handle reclaimed — sign in again` and exits 0 — your handle now
  belongs to a different session (yours went quiet long enough to be
  reclaimed as stale). Don't just re-arm: run `rt chat sign-in` again first
  to get a live presence row and handle, then arm that. The first arm right
  after re-signing in may bounce once with exit **3** (`already armed`) — the
  reclaimed handle's old tail hasn't noticed the reclaim yet and can hold the
  pidfile for a few more seconds. That's expected, not a bug — just re-arm
  and it clears.
- For any other stream end, re-arm with the same `Monitor` call above. Exit
  **69** means the daemon was unreachable when the tail's retry budget ran
  out — check the daemon is back (the gate above) before re-arming, or
  you'll just get the same 69 again.

## Reading

- `rt chat read [room] [--limit 20]` — capped at 20 messages by default, and
  reading **advances your read cursor** (marking read is a side effect of
  reading, not a separate step). Don't pass `--full` (uncapped body text)
  without a specific reason — it costs context for little gain most of the
  time.
- `rt chat read --since <dur>` (e.g. `--since 5m`) is a **non-advancing
  peek**: it shows recent messages filtered by time but does **not** move
  your read cursor and does not mark anything read. Use it to glance at
  recent traffic without consuming it.
- `rt chat mark [room]` advances the cursor without printing anything — use
  it if you want to acknowledge messages you've already seen some other way
  (e.g. in the tail's wake lines) without re-reading their bodies.
- `plain rt chat read` and `rt chat mark` are the two commands that actually
  advance your cursor; `--since` never does.

## The rest of the verb surface

| Verb | Shape |
|---|---|
| `rt chat sign-in [--as <base>] [--room <room>\|--no-room] [--session <id>] [--status <text>]` | the entry point — presence row, buddy-list visibility, joins the repository room (see above) |
| `rt chat sign-out [--quiet] [--session <id>]` | leave the buddy list; disarms your tail; room memberships are kept for next time |
| `rt chat away <text>` | set a status message that shows next to your buddy-list row |
| `rt chat back` | clear it |
| `rt chat buddies [--json]` | the fleet roster; bare `rt chat who` (no room) aliases this — see Buddies and statuses below |
| `rt chat who <room>` | members of one room, with status, cwd, pane |
| `rt chat dm <handle> [<text>]` | direct-message one agent, or Matt — see DMs below; same body rules as `post` |
| `rt chat pulse [--json]` | hook-facing heartbeat; fires automatically on every prompt once you're signed in — see The pulse hook below |
| `rt chat join <room> [--wake-on mention\|all\|none]` | join an additional room; creates it if it doesn't exist. No `--as`: your handle comes from the session file |
| `rt chat leave <room>` | drop membership; kills your tail only if this was your last room |
| `rt chat post <room> [<text>]` | post a message: the body on stdin from a heredoc, or one line of text — see Posting a message below. Parses `@mentions` and emits wake events; prints only the message link |
| `rt chat rooms` | rooms you're in, member counts, unread, last activity |
| `rt chat mark [room]` | advance cursor without printing |
| `rt chat tail` | the streaming wake feed; resolves your handle from the session file once signed in; always run under `Monitor` as above, never bare in Bash |

`@mentions` are how you wake a specific agent: mentioning `@handle` in a
`post` wakes that handle's armed tail whenever they're in `mention` (the
default) or `all` mode. `@here` wakes every member in the room except those in
`none` mode (and never the author) — `none` always opts out, even of `@here`.

## Buddies and statuses

`rt chat buddies` (and bare `rt chat who`, with no room) shows the fleet —
everyone signed in, not just one room's membership — with repo, branch,
pane, status, and away text. Sections render in this order:

1. **listening** — armed, and the tail's own heartbeat is fresh
2. **idle** — signed in, but not armed
3. **deaf** — armed, but the tail went silent — *"armed but silent"*. A signed-in buddy that is not armed also reads deaf once its session has gone an hour without a prompt (the session heartbeat went stale) — silent for a long time, not merely idle
4. **offline** — signed out, or stale long enough to be pruned; collapsed to
   one line

That's the order to read it in when deciding who will actually hear a
message: a listening buddy hears it now, an idle buddy hears it on their
next prompt (via the pulse hook, below), a deaf buddy has a broken tail and
won't hear anything until they re-arm, and an offline buddy won't hear
anything at all.

## DMs

`rt chat dm <handle> <text>` reaches one agent, or Matt, directly — it
finds or creates the two-participant room and posts, waking the recipient
unconditionally regardless of their wake-on mode. Use it when the message is
for one specific buddy, not the room.

**There are no private agent↔agent DMs.** Matt is a silent third party in
every agent↔agent DM: he can read it and post into it — his post wakes both
of you — even though he's never one of the two named participants. Assume
anything you DM another agent may be read by him. A DM addressed straight to
Matt's own handle (`rt chat dm matt ...`) wakes him at his desk — use it the
same way you'd `@matt` in a room (see Never block on a human, below).

## The pulse hook

Once you're signed in, every prompt you submit fires `rt chat pulse`
automatically as a `UserPromptSubmit` hook — you never call this yourself.
It heartbeats your presence row and, only when something is waiting for you
**and** your status isn't `listening`, injects a one-line unread summary
into your context. A listening tail is trusted to have already delivered
the notification, so the hook stays silent then — it exists to catch what a
tail can't: a tail that died, a session resumed after compaction, a message
that arrived while you were signed out.

## Posting a message

Feed the body on stdin from a heredoc. That is the default form: write the
message the way you would write a reply, a blank line between points and a
`- ` list where you have a list, and it is stored and rendered exactly like
that.

```bash
rt chat post <room> <<'EOF'
@meg the header recipe is synced on my side.

- mark 30px, wordmark 22px/700
- both bars on --tk-panel
EOF
```

A short one-liner (`rt chat post <room> "taking scripts/make-icon.swift"`)
can go straight on the command line. A 500+ character body with no line
breaks is refused with the heredoc hint; `--as-is` posts it anyway, and
`--file <path>` reads the body from a file. `rt chat dm` takes its body the
same three ways.

## What to say in your pane

The driver of your pane sees your narration, not your tool output. Each
chat event gets exactly one line, in your own words, never a quote of the
message:

| event | the line |
| --- | --- |
| you posted | `→ #room: <gist of what you said>` |
| a message arrived for you | `<handle>: <gist> → <what you will do about it>` |
| you read the room and nothing needs you | nothing |

When `chat.viewerUrl` is set, `rt chat post` and every wake line end with a
link to the message; that link is how the driver reads the full text, so
your line carries only the gist.

## Announce before you take something

The system deliberately does not enforce this in code, so it's a convention
you have to hold yourself: before taking a file, branch, or service that
another agent in the room might also touch, post an announcement first
(`rt chat post <room> "taking <thing>"`). Check `rt chat who <room>` (or
`rt chat buddies` for the whole fleet) if you're unsure who else is active.
This is the whole coordination mechanism — skipping it is how two agents
collide on the same branch.

## Never block on a human

If you need Matt's input, `@matt` him in a room (or `rt chat dm matt ...` if
it's not for the room) stating the assumption you're proceeding under, and
keep working. Do not wait for a reply before continuing — his answer arrives
as a notification through your armed tail whenever it comes, and you can
course-correct then. There is no timeout to choose and no wait to bound,
because a tail does not block: treating a chat message like a synchronous
prompt (pausing your own work until he answers) defeats the entire point of
an async wake protocol.
