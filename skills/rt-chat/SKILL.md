---
name: rt:chat
description: Use when asked to join or coordinate in an agent chat room, when told you are working alongside other agents, or when you need to reach an agent under a different account.
---

# rt chat (agent coordination)

`rt chat` is group chat for agents (and Matt) over the rt daemon: rooms,
`@mentions`, and a wake protocol that turns a chat message into a Claude Code
notification. This skill carries the discipline a `--help` page cannot —
mainly how to stay listening without flooding your own context.

## The gate

Before issuing any control command (`join`, `post`, `leave`), confirm the
daemon is reachable and you know your membership in one shot:

```
rt chat rooms --json
```

If this errors with a daemon-unreachable message, stop and say so rather than
retrying blindly — chat state (arming, wake events) depends on the daemon
being up. If it succeeds, the room list tells you what you're already a
member of, so you don't double-join.

## Join, then arm the tail — the most important step

Join the room:

```
rt chat join <room> [--as <handle>] [--wake-on mention|all|none]
```

Then arm exactly once, using the **`Monitor`** tool with **`persistent:
true`**:

```
Monitor({ command: "rt chat tail --as <handle>", persistent: true,
          description: "chat mentions for <handle>" })
```

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
- If the stream ended for any other reason, re-arm with the same `Monitor`
  call above. If the exit code was **69**, the daemon was unreachable when
  the tail's retry budget ran out — check the daemon is back (the gate above)
  before re-arming, or you'll just get the same 69 again.

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
| `rt chat join <room> [--as <h>] [--wake-on mention\|all\|none]` | join; creates the room if it doesn't exist |
| `rt chat leave <room>` | drop membership; kills your tail only if this was your last room |
| `rt chat post <room> <text>` | post a message; parses `@mentions` and emits wake events. **Prints nothing on success** — posting must not cost context |
| `rt chat read [room] [--limit 20] [--full] [--since <dur>]` | see Reading above |
| `rt chat rooms` | rooms you're in, member counts, unread, last activity |
| `rt chat who [room]` | members with status (listening/idle/away), cwd, pane |
| `rt chat mark [room]` | advance cursor without printing |
| `rt chat tail [--room <r>] [--as <h>]` | the streaming wake feed; always run under `Monitor` as above, never bare |

`@mentions` are how you wake a specific agent: mentioning `@handle` in a
`post` wakes that handle's armed tail (if they're in `mention` mode, the
default) even if they're in the default `mention` mode rather than `all`. `@here`
wakes every member in the room except those in `none` mode (and never the
author) — `none` always opts out, even of `@here`.

## Announce before you take something

The system deliberately does not enforce this in code, so it's a convention
you have to hold yourself: before taking a file, branch, or service that
another agent in the room might also touch, post an announcement first
(`rt chat post <room> "taking <thing>"`). Check `rt chat who <room>` if
you're unsure who else is active. This is the whole coordination mechanism —
skipping it is how two agents collide on the same branch.

## Never block on a human

If you need Matt's input, `@matt` him in a message stating the assumption
you're proceeding under, and keep working. Do not wait for a reply before
continuing — his answer arrives as a notification through your armed tail
whenever it comes, and you can course-correct then. There is no timeout to
choose and no wait to bound, because a tail does not block: treating a chat
message like a synchronous prompt (pausing your own work until he answers)
defeats the entire point of an async wake protocol.
