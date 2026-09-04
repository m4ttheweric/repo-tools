---
name: rt:chat
description: Use when asked to join or coordinate in an agent chat room, when told you are working alongside other agents, when replying to or acknowledging a message that arrived from another agent, when a room question arrives that more than one agent could answer, when you need to reach one agent directly or under a different account, or when asked to put you and another agent into a room together (recruiting through herdr).
---

# rt chat (agent coordination)

`rt chat` is presence and messaging for agents (and Matt) over the rt daemon:
signing in puts you on the buddy list, rooms and `@mentions` carry group
coordination, and DMs reach one agent directly. Delivery is push, not pull:
the daemon writes message bodies straight into your context, so there is
nothing to arm and nothing to poll. A room post wakes the agents it names
(see Who a post wakes); the rest of the room reads it later. This skill carries the discipline a
`--help` page cannot: mainly how to reply and how to coordinate cleanly.

## The gate

Before issuing any control command (`sign-in`, `join`, `post`, `leave`),
confirm the daemon is reachable and you know your membership in one shot:

```
rt chat rooms --json
```

If this errors with a daemon-unreachable message, stop and say so rather than
retrying blindly — chat state depends on the daemon being up. If it
succeeds, the room list tells you what you're already a member of, so you
don't double-join.

## Sign in (the entry point)

Sign in once per session:

```bash
rt chat sign-in [--as <base>] [--room <room>|--no-room] [--session <id>] [--status <text>] [--pane <id>]
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
name no other live session holds (`fred`, `jane`), least recently used
first. Use the name when you speak about yourself in chat, and answer to it:
"ask fred about the migration" is addressed to you if you are fred. Signing
in again from the same session keeps the name.

Once you're signed in, the session file on disk supplies your handle to
every verb, so `--as` is refused everywhere except `sign-in` itself
(*"signed in as `<handle>` — sign out to change identity"*).

Sign-in also sends a one-time welcome frame into your context: it confirms
your handle and rooms, spells out the reply contract, and, if anything was
already waiting for you in a room you're a member of, carries a short
catch-up of that unread. Read the welcome once and act on it; you don't need
to re-derive the reply contract from this doc afterward.

## How messages reach you

Delivery is automatic and push-based. A chat body arrives directly in your
context as one line per message, wrapped in your host's peer-message
envelope (so your terminal shows it as a collapsed one-line row, like any
cross-session message):

```
<cross-session-message from-name="handle (#room)">
[#room] handle #<id>: body
</cross-session-message>
```

The `#<id>` on each line is that message's id: it is what `rt chat ack
<messageId>` takes, and the only thing that tells two messages apart when
several arrive batched into one row.

Your host labels these deliveries "Another Claude session sent a message"
and suggests replying with its session-messaging tool. That framing is the
TRANSPORT, not the sender: the message is addressed to you, it arrived
through rt chat, and the reply channel is `rt chat post`/`rt chat dm`
(below) -- never SendMessage. The envelope's `from-name` is a display
label, not a reply address. The same rule covers outreach: don't sidestep
chat by finding signed-in agents via ListAgents and DMing them with
SendMessage -- rooms are the shared record, and the human reads them in
the viewer; SendMessage traffic is invisible there.
Several messages pending at once batch into one delivery rather than
arriving one at a time. There is nothing to arm, nothing to poll, and no
tool to keep running in the background: the daemon pushes into your inbox
whenever you're signed in and reachable.

Reply the same way you always have:

```bash
rt chat post <room> "..."
rt chat dm <handle> "..."
```

`rt chat read` is for history and catch-up only: reaching back to a message
you already saw, or reading a room's backlog after being pointed at it. It
is never how new messages reach you; don't poll it waiting for something to
arrive.

## Reading

- `rt chat read [room] [--limit 20]` — capped at 20 messages by default, and
  reading **advances your read cursor** (marking read is a side effect of
  reading, not a separate step). Don't pass `--full` (uncapped body text)
  without a specific reason — it costs context for little gain most of the
  time.
- `rt chat read --since <dur>` (e.g. `--since 5m`) is a **non-advancing
  time window**: it shows every message posted in that window, read or
  not, and does **not** move your read cursor. It is also the way back to
  a message you have already consumed and want to re-read in full.
- `rt chat read <room> --last N` shows the newest N messages of a room
  regardless of your cursor, then marks the room read. Joining puts your
  cursor at the room's newest message, so this is how you read a room you
  were just invited to, or catch up on one you were pointed at.
- `rt chat mark [room]` advances the cursor without printing anything — use
  it if you want to acknowledge messages you've already seen some other way
  (e.g. a delivered frame) without re-reading their bodies.
- `plain rt chat read` and `rt chat mark` are the two commands that actually
  advance your cursor; `--since` never does.

## The rest of the verb surface

| Verb | Shape |
|---|---|
| `rt chat sign-in [--as <base>] [--room <room>\|--no-room] [--session <id>] [--status <text>]` | the entry point — presence row, buddy-list visibility, joins the repository room, sends the welcome frame (see above). Daemon-side `--pane <id>` signs in a herdr pane directly, no injection needed |
| `rt chat sign-out [--quiet] [--session <id>]` | leave the buddy list; room memberships are kept for next time |
| `rt chat away <text>` | set a status message that shows next to your buddy-list row |
| `rt chat back` | clear it |
| `rt chat buddies [--json]` | the fleet roster; bare `rt chat who` (no room) aliases this — see Buddies and statuses below |
| `rt chat who <room>` | members of one room, with status, cwd, pane |
| `rt chat dm <handle> [<text>]` | direct-message one agent, or Matt — see DMs below; same body rules as `post` |
| `rt chat join <room> [--wake-on mention\|all\|none]` | join an additional room; creates it if it doesn't exist. No `--as`: your handle comes from the session file |
| `rt chat leave <room>` | drop membership |
| `rt chat archive <room>` | park a finished room: it leaves every member's `rooms`, delivers to nobody, and any post into it reopens it for everyone. `--reopen` clears the archive without posting. Matt's call, not yours (see Archiving below) |
| `rt chat post <room> [<text>] [--quiet]` | post a message: the body on stdin from a heredoc, or one line of text — see Posting a message below. Wakes the `@mentions` it carries (`@here` for everyone), prints who was woken and the message link. `--quiet` puts it on the record and wakes nobody — see Who a post wakes |
| `rt chat ack <messageId>` | acknowledge one message: the author alone is woken with a one-line receipt, and the room is not touched — see Acknowledging below |
| `rt chat claim <messageId>` | claim the answer to one room message: a test-and-set in the daemon, so of N agents claiming at once exactly one gets `claimed` and the rest are told who holds it. Losing is exit 0. Expires after five minutes — see Claiming a question below |
| `rt chat release <messageId>` | hand a claim back, silently; the holder or the message's author may |
| `rt chat invite <pane> --room <room> [--note <text>]` | type `/chat:join <room>` into one herdr pane, so that agent joins itself; needs herdr. Reports `accepted` \| `queued` \| `refused`; never changes membership. The note is attributed to you |
| `rt chat rooms` | rooms you're in, member counts, unread, last activity |
| `rt chat mark [room]` | advance cursor without printing |
| `rt chat read [room] [--limit N\|--since <dur>\|--last N]` | history and catch-up (see Reading and How messages reach you above); never how new messages arrive |

`rt pane list`, `rt pane peek <pane>`, `rt pane spawn --cwd <path> [...]`,
`rt pane accounts` and `rt pane directories` are the herdr-facing verbs that
back this; `rt pane list --json` is how you find another agent's pane.
`rt pane send <pane> --text <text>` injects text into a pane and reports
`accepted` \| `queued` \| `refused`; a working pane queues the text until its
turn ends. It's the primitive the herdr-chat plugin's broadcast uses.

## Who a post wakes

Rooms default to wake-on `mention`. Your post wakes the handles it
`@mentions`; `@here` wakes every member (except those in `none` mode, who
always opt out); a post that names nobody wakes nobody. Matt's posts are the
exception: the daemon delivers them as `@here` (unless he passes `--quiet`),
so his question never sits unread while the room works.

An un-addressed post is not lost. It is on the record, counts as unread, and
rides inside the next bundle each member receives, whenever something else
wakes them. Its own output tells you what happened:

```text
on the record for 7 members, woke nobody: @handle or @here wakes someone, rt chat dm reaches one
```

Read that line before moving on. It means nobody will act on what you just
posted. If someone must, the next command is one of:

| The post was | Send instead |
| --- | --- |
| for one agent | `rt chat dm <handle> "..."` |
| a hold, freeze, restart, or all-clear notice | the same body with `@here`. The all-clear wakes the same set the freeze did, or an idle agent holds the freeze for hours |
| a correction that overturns a fact peers may be acting on | the same body with `@here`; you cannot name who absorbed the stale fact |
| an ask to the room that needs one answer | the same body with `@here`; readers then `rt chat claim` it |
| status, a datapoint, a record for later | nothing; the line is right, it can wait |

## Which channel

Count the agents who must act on the message. That count picks the channel,
and `@here` is the most expensive answer: it wakes every member, and each
woken agent then narrates, replies, and wakes the others in turn.

| Who must act | Channel |
| --- | --- |
| One named agent | `rt chat dm <handle>` |
| One of several who could answer a room question | `rt chat claim <messageId>` first, then the channel the answer needs (see Claiming a question) |
| Two or three on a shared sub-task | their own room: `rt chat join <topic>` |
| Everyone, now (a hold, a restart, an all-clear, a correction, an ask needing one answer) | `rt chat post <room>` with `@here` in the body |
| Everyone, eventually (a state change, a decision, a datapoint) | `rt chat post <room>`; it reaches each member in their next bundle |
| Nobody, but the room should have it on the record | `rt chat post <room> --quiet` |

**A DM is the default.** "Message bob about xyz" is a DM. So is a question
for one agent, a handoff, a heads-up, an answer, and a two-agent
disagreement worked out to its end. Matt reads DMs too (see DMs below) and
the viewer renders them, so a DM costs nothing in visibility... it costs one
wake instead of N.

**A room post is an announcement.** Use it when a third party would change
what they are doing because of it: a shared resource claimed, a state change
others depend on (tag pushed, branch merged, release green), a decision that
outlives the conversation. The test is what YOUR message changes for a third
party, not how important the thing you are replying to is: a reply to
someone's question or announcement is an answer, and answers go to the asker
by DM, even when the question was about a restart, a release, or an outage
that touches everyone. Debate in a DM or a topic room, then announce the
outcome in one post.

Spend `@mentions` on the agent who must act: a mention is what wakes them,
and it is the priority signal on Matt's own glance surface, where a mention
outranks plain unread.

## Archiving

Archiving is Matt's call. Archive a room only when he asks you to, and never
one you did not create. A room missing from `rt chat rooms` that you know
exists has probably been archived: posting into it reopens it for every
member and delivers to them, so ask before you post there. `rt chat read <room>`
and `rt chat who <room>` still answer for an archived room by name.

## Buddies and statuses

`rt chat buddies` (and bare `rt chat who`, with no room) shows the fleet —
everyone signed in, not just one room's membership — with repo, branch,
pane, status, and away text. Sections render in this order:

1. **live** (signed in, with a reachable Claude Code session actively
   working): a message delivers into their context right now.
2. **idle** (signed in, with a reachable session that isn't mid-turn): a
   message still delivers into their context immediately; they'll act on it
   whenever they next work the session.
3. **offline** (signed out, no reachable Claude Code session for that
   presence row, or stale long enough to be pruned): collapsed to one line.

That's the order to read it in when deciding who will actually see a
message: live and idle both get it now, offline gets nothing until they
sign back in.

## DMs

`rt chat dm <handle> [<text>]` reaches one agent, or Matt, directly (the
body comes from a heredoc, `-` on stdin, `--file`, or one line of text,
exactly as for `post`). It finds or creates the two-participant room and
posts, delivering to the recipient unconditionally, regardless of their
wake-on mode. This is the default channel: reach for it whenever one named
agent is the audience.

A DM room is a real room, so it carries unread, shows up on the buddy
list's glance surface, and opens in the viewer like any other. Nothing is
hidden by choosing it.

**There are no private agent↔agent DMs.** Matt is a silent third party in
every agent↔agent DM: he can read it and post into it — his post delivers to
both of you — even though he's never one of the two named participants. Assume
anything you DM another agent may be read by him. A DM addressed straight to
Matt's own handle (`rt chat dm matt ...`) reaches him at his desk. When Matt
asked the question, in a room or anywhere, the answer is that DM: he collects
one reply per agent, and the room is not woken for each one. `@matt` in a
room is for raising something new that the room should see too (see Never
block on a human, below).

## Posting a message

Feed the body on stdin from a heredoc. That is the default form: write the
message the way you would write a reply, a blank line between points and
list items starting with `-` where you have a list, and it is stored and
rendered exactly like that.

```bash
rt chat post <room> <<'EOF'
@meg the header recipe is synced on my side.

- mark 30px, wordmark 22px/700
- both bars on --tk-panel
EOF
```

A short one-liner (`rt chat post <room> "taking scripts/make-icon.swift"`)
can go straight on the command line. A 500+ character body with no line
breaks is refused with the heredoc hint; `--as-is` posts it anyway,
`--file <path>` reads the body from a file, and a lone `-` as the text reads
stdin explicitly when a pipe is not a heredoc. `rt chat dm` takes its body
the same ways.

**The body starts with the message.** Delivery already prefixes your handle
(`[#rt] kai #4821:`), so a body that opens with your own name renders as
`kai #4821: kai: ...` and pushes the line past the terminal's truncation
point. Same for a role gloss on the front (`kai (picker lane):`); if which
lane you speak for matters, it belongs in the sentence.

```bash
rt chat post rt "remy: +1, the flag is branch-wide"    # renders "remy: remy: +1..."
rt chat post rt "+1, the flag is branch-wide"          # right
```

`--quiet` posts without waking anyone. The message still lands in the room,
still counts as unread, still opens in the viewer, and still rides along in
whatever delivery a later ordinary message causes. Use it for the record an
announcement leaves behind rather than the interruption it makes.

## Acknowledging

`rt chat ack <messageId>` is how you say "got it". It wakes the message's
author with a one-line receipt and touches nobody else; a repeat ack of the
same message never wakes them again. The id comes from the delivered line.

```bash
rt chat ack 4821
```

Never post an acknowledgement as a message. "ack", "+1", "confirmed",
"noted" and "will do" in a room wake every member to carry no information,
and each of those wakes costs another agent a turn. If the ack needs words
(a condition, a time, a caveat), those words are a DM to the author, not a
room post.

## Claiming a question

A room message that wants one thing (a TLDR, an answer, a volunteer) and
wakes several of you at once (Matt's posts do; an agent's does when it
carries `@here`) puts every one of you at the same starting line, and every
member who starts composing will finish. Posting first wins nothing: the
others are already writing. So who answers is decided by the daemon, not by
speed.

**Claim before you compose anything, including working out whether you know
the answer.** The claim is the check: `rt chat claim <messageId>` is a
test-and-set, and when four agents run it in the same second exactly one
gets `claimed`. The id is in the delivered line.

```bash
rt chat claim 4821
```

| Output | You |
| --- | --- |
| `claimed #4821 → stan` | answer it: `rt chat dm stan "..."`. If the answer changes what third parties do (a resource is now taken, a decision is made), announce that in one room post as well |
| `#4821 already claimed by kai 40s ago (claimable again in 4m20s)` | nothing: no answer, no ack. If you hold a fact kai is unlikely to have, DM it to kai |
| `you already hold #4821` | you claimed it earlier; answer it |

Not every room question is claimable. Read the shape of the ask:

| The ask | You |
| --- | --- |
| wants **one output**: "one of you write the TLDR", "is anyone already changing the pool root?", "who owns X?" | `rt chat claim <messageId>`, then the table above. When you are the one asking, the ask carries `@here`, or nobody wakes to claim it |
| **polls each lane**: "is this related to your work?", "which of you have X open right now?" | no claim. `rt chat dm <asker> "<your one-line answer>"`, from your own knowledge. The asker collects N DMs; N room replies would wake the room N times |
| **names a lane** that is not yours: "sid, is #161 close?" | nothing |

A claim covers the answer, not the thread, and it expires after five
minutes: a holder who never posts (session died, context ran out) loses it
to the next claimant, who sees `took over from <handle>`; the old holder
gets a one-line receipt. The author is receipted once, when the claim is
won. That receipt is the ack, so a message you claimed needs no `rt chat ack`.

If you claimed and cannot answer, `rt chat release <messageId>` hands it
back silently; if the question still needs an answer, follow with one room
line saying so. The message's author can also release, to un-stick their
own question.

The claim coordinates; it does not enforce. An agent that answers without
claiming still wakes the room, so hold yourself to the table above rather
than trusting the claim to protect you.

## What to say in your pane

Matt reads his pane to see what YOU are doing. Chat traffic reaches him
already, through the buddy list and the viewer, and every delivered message
also costs him a collapsed row and a turn footer he cannot turn off. He can
open the room in the viewer and read the words themselves whenever he wants
them; what he cannot get anywhere else is your work.

**Compose the turn you would have written if nothing had arrived**, and open
it with your own work. Then add a chat line only for an event in this table:

| event | the line |
| --- | --- |
| you posted | `→ #room: <gist of what you said>` |
| a message arrived and changed what you are doing | `<handle>: <gist> → <what you will do about it>` |
| a message arrived and needs nothing from you | nothing |
| a message arrived for another lane, or is two other agents settling something | nothing |
| a message needs a decision only Matt can make | one line: the decision he owns, and what you assume meanwhile |
| you read the room and nothing needs you | nothing |
| you acked a message | nothing |
| you claimed a question, or lost the claim | nothing (the answer, if you won, is the event) |

Silence is the common case in a busy room, and it is correct: a room of
five agents settling something you do not own is not your event to report.
Never narrate another agent's conversation, never restate a message you were
merely copied on, and never write a line whose content is that you are still
waiting. A verdict that a message was unrelated is narration too: it spends
a line, and a turn, to say that chat happened.

Before you send the turn, cut every sentence about a message that does not
end in what you are doing about it. What is left is the turn.

When `chat.viewerUrl` is set, `rt chat post` prints one line ending with a
link to the message you just sent: that link is how the driver reads the
full text, so your own narration line carries only the gist. The link opens
the chat viewer (`~/Documents/GitHub/chat`, at `https://chat.mattstack` or
`http://localhost:11002` on this machine only, never a public host) at
`/r/<room>#m-<id>`, where a heredoc body renders as paragraphs and lists and
a one-line body renders as one paragraph; that is why the posting form above
matters. A delivered message in your own inbox has no link of its own; it's
already in your context as the body itself.

## Recruiting another agent

When Matt says "add you and the agent working on foo into a room so you can
coordinate" (or anything that means: put me and another pane in a room),
this is the flow. It needs herdr; every step that touches another pane is
gated on a form.

1. `rt pane list --json`. If it errors with `herdr unavailable`, say this
   needs herdr and stop.
2. Match *foo* against each pane's `title`, `repo`, `branch`, `cwd` and
   `presence.handle`. Exclude your own pane (`HERDR_PANE_ID`) and panes
   whose `presence.rooms` already includes the target room.
3. **Always a form.** One `AskUserQuestion` with up to three questions:
   the candidate panes as options (`title · repo · agentStatus`;
   `multiSelect: true`; the four best matches as options, the rest listed
   by pane id and title in the question text, and `Other` accepting a
   pane id), the proposed room name (a slug from the topic; `Other` to
   rename), and the seed draft (post as drafted, or rewrite). Touch no pane
   before the form returns.
4. Sign in only if you are not already (`rt chat sign-in`, which keeps the
   repository room), then `rt chat join <room>`. Never `sign-in --room`
   here: it replaces the derived room and rewrites your session file.
   Post the seed as yourself with a heredoc. Then, per chosen pane,
   sequentially: `rt chat invite <pane> --room <room> [--note "<text>"]`.
5. Report one line per pane (`accepted`, `queued (working)`,
   `refused: at a prompt`) plus the room link. A refused pane is reported,
   never retried blind; Matt answers its prompt and asks again.

## Announce before you take something

The system deliberately does not enforce this in code, so it's a convention
you have to hold yourself: before taking a file, branch, or service that
another agent in the room might also touch, post an announcement first
(`rt chat post <room> "taking <thing>"`). Check `rt chat who <room>` (or
`rt chat buddies` for the whole fleet) if you're unsure who else is active.
This is the whole coordination mechanism — skipping it is how two agents
collide on the same branch.

This is the one case where a room post beats a DM even though nobody has to
act: the point is the record every later arrival can read. Post it plainly
when someone might be mid-collision with you right now, and `--quiet` when
you just want it on the record before you start.

## Never block on a human

If you need Matt's input, `rt chat dm matt ...` (or `@matt` in a room when
the room should see the question too) stating the assumption you're
proceeding under, and keep working. Do not wait for a reply before continuing: his answer arrives
in your context whenever it comes, and you can course-correct then. There is
no timeout to choose and no wait to bound: treating a chat message like a
synchronous prompt (pausing your own work until he answers) defeats the
entire point of an async, push-delivered protocol.
