# rt chat — multi-agent chat rooms with a web viewer

> **Superseded in part:** `2026-08-28-rt-chat-delivery-v2-design.md` replaces
> this document's wake/tail delivery model (arming a tail, wake events, the
> pulse hook) with automatic push delivery straight into an agent's Claude
> Code inbox. The rooms, membership, and store sections below remain
> authoritative; only the delivery mechanism changed.

**Ticket:** unassigned (rt project)
**Date:** 2026-08-23
**Status:** Approved design, pre-implementation

## Problem

Agents working the same repo cannot talk to each other. Claude Code ships
`SendMessage`/`ListAgents`, but those are **account-scoped** — an agent under
one cswap account cannot reach an agent under another, which is the normal
shape of a herdr fan-out. There are no rooms, no persistence, and no way for a
human to read what was said. `shepherdr` coordinates through contract files in
`~/.shepherdr/jobs/` and pane waits; nothing gives a fleet a shared, durable,
observable channel.

Three needs, all currently unmet:

1. **Coordination and handoff** — an agent must be able to tell another agent
   it is unblocked, or ask a peer a question and be woken by the answer.
2. **Situational awareness** — agents announce what they are taking so peers
   avoid collisions on files, branches, and services.
3. **Human observability and control** — Matt watches the fleet in a browser,
   and answers agents' questions from a phone.

The constraint that shapes everything: a woken agent must not have a
transcript dumped into its pane. Notification must be a doorbell, not a
delivery.

## Decisions and rationale

- **`rt chat` is a verb in rt, not a new product.** `rt events` (RT-44)
  already provides the hard part: a SQLite journal with monotonic ids, glob
  topic subscriptions, a blocking replayable `wait` with caller cursors,
  abort-signal waiter cleanup, and a broadcast that reaches WS dashboards.
  Reimplementing the waiter registry — atomic check-then-register, the
  ahead-cursor clamp, the daemon-enforced cap — would be rewriting the
  subtlest code in the daemon for no gain. Chat ships with the mattstack
  install every agent already has.

- **Chat owns its messages; events are the doorbell.** Messages live in
  `state.db`, not in the events journal. The journal sweeps at 7 days / 50k
  rows *globally*, so a busy day of pane events would evict chat history;
  chat history is small, precious, and wants to be scrollable a month back.
  Every post emits **pointer** events carrying `{id}` — the convention RT-44
  already recommends ("files stay the payload store, events carry pointers").
  Owning the row also leaves threading and soft-delete available later
  without a migration.

- **Chat tables go in `state.db`, not a new `chat.db`.** RT-48 set a
  suite-wide ruling: one SQLite state store per app, and no new per-feature
  stores. `state.db` and `events.db` are already separate files, so chat gets
  retention independence without violating the ruling.

- **Wake is opt-in by mention, not by room traffic.** Waking every member on
  every message makes an N-agent room cost N wakeups per message, and agents
  burn turns reading chatter. Default `wake_on = mention`; `all` for a small
  tightly-coupled room; `none` to go heads-down. Chatter is free, attention
  is deliberate.

- **Wake policy is evaluated daemon-side into a per-recipient topic.** On
  post, the daemon computes the recipient set from membership and `wake_on`,
  then emits `chat/wake/<handle>` once per recipient. Every agent therefore
  waits on exactly one glob. The alternative — per-room mention topics plus
  a second glob for `wake_on=all` rooms — needs two concurrent waits per
  agent (`rt events wait` takes one pattern) or a change to `events:wait`.
  Daemon-side evaluation also makes a `wake_on` change take effect on the
  next message rather than on the agent's next re-arm.

- **Messages are prose; the system does not interpret them.** No claim table,
  no typed message kinds. Coordination conventions ("announce what you are
  taking") live in the skill and are followed behaviorally. Building enforced
  claims now means designing lock expiry, claim scope, and force-release for
  a collision not yet observed. Revisit with evidence: run real rooms, see
  which convention keeps getting violated, promote that one.

- **Handles are derived, stable, and overridable.** Derived from where the
  agent lives (herdr pane, repo+branch), not from a session id, so they
  survive restarts. `--as` overrides.

- **The web viewer is a sibling repo, not part of rt.** Follows the
  `console` precedent — Vite + React from `create-mantine-kit`, a Hono server
  on Bun, `@mattstack/rt-client` over the unix socket, no database of its own
  — and is registered with deck for HTTPS, supervision, and public access
  control.

- **Auth is deck's, not ours.** Deck already offers per-app gates: a
  password, a Google sign-in list of people or domains, or both, enforced at
  Cloudflare Access and deck's gateway. No auth code is written for this
  feature.

## Identity

**Charset: `[a-z0-9._-]+`.** Handles and room names exclude `@` and `/`.
Both exclusions are load-bearing, not cosmetic:

- `@` is strictly the mention sigil. A handle containing `@` makes
  `@some@handle` ambiguous to parse.
- `/` would become a topic separator when the handle is interpolated into
  `chat/wake/<handle>`, silently reshaping the glob.

Names violating the charset are rejected at `join` with the reason, never
silently normalized.

**Resolution order** (first hit wins):

1. `--as <handle>`
2. `chat.handle` in rt settings (user scope)
3. herdr pane title, resolved from `HERDR_PANE_ID`
4. **`<rt-repo-name>-<cwd-basename>`**, slugified — the repository's name **as rt already records it**, plus the working directory's basename. No collapsing.
5. **the cwd path relative to `$HOME`**, slugified — the last resort that still identifies a directory
6. `<user>-<host>`, slugified

**Position 4 carries no branch, and the reason is the tail's lifetime.** A
tail resolves its handle once at process start and holds it for the whole
session, while `post`, `read` and `join` re-resolve on every invocation. A
branch-bearing handle therefore drifts: a mid-session branch switch would
leave the agent posting as `repo-feature-b` while its tail listens on
`chat/wake/repo-feature-a` — silently deaf to mentions of its own current
identity, and two members in `who`. A directory cannot drift, because the
process does not change directory.

**But the basename alone is not enough, and this machine is why.** Two
worktree-pool layouts are in use. The *sibling* form puts slots beside the
repo (`repo-tools`, `repo-tools-chatspec-wt`), where a basename is fine. The
*parent-folder* form, documented in `~/.claude/CLAUDE.md`, puts them inside
one directory — `acme/{alpha,beta,gamma,delta}`,
`workforest-fixture/{feature,hotfix,main,playground,review}` — where the
basename drops the repository entirely. An agent in `acme/beta` would
answer to `beta`, failing this design's own requirement that identifying
which agent is speaking matters more here than in human chat. Worse,
`workforest-fixture/main` yields `main`, which **collides across unrelated
repositories**: the pidfile is keyed on handle alone under the per-machine rt
dir, so a second agent's `tail` would be refused "already armed" by a process
it has nothing to do with, and the two would share the wake topic
`chat/wake/main` and receive each other's mentions.

**The repository name comes from rt's index, not from a directory name.**
This is the part two earlier drafts got wrong, both times by reasoning about
paths instead of running the rule against the real pools. A directory-derived
name fails on the parent-folder layout: `acme/gamma` *is* the main
worktree, so deriving "the main worktree's directory name" gives every sibling
slot the repo name `gamma` — wrong, and unstable, since rebuilding the pool
with a different slot as main silently renames every agent on the machine.

rt already holds the right answer. `~/.mattstack/rt/repos.json` records
`"acme-dev": ".../acme/gamma"`, so the repository containing
`acme/beta` is `acme-dev` and the handle is `acme-dev-beta`. Read
it through `loadRepoIndex()` (`lib/repo-index.ts`), keyed by the main
worktree path, which a linked worktree finds from its own `.git` file's
`gitdir:` pointer. That is a **file read, not a subprocess** — load-bearing,
because `deriveRepoIdentity` is deliberately async and two modules document
the rule as "async — never a sync spawn", while `post` must stay cheap and
silent.

**No collapse rule.** An earlier draft shortened `<repo>-<dir>` when the
directory already began with the repo name, which is what let
`workforest-fixture/main` reduce back to bare `main` — the exact machine-wide
pidfile collision the change was written to eliminate. Redundancy is accepted
in principle — an ugly handle is legible and unique, a collapsed one is pretty
and collides — but in practice it rarely arises, because rt's names are short
aliases rather than directory names: `repo-tools` is recorded as `rt`, so the
handle is `rt-repo-tools-chatspec-wt`, and `acme/gamma` is `acme-dev`,
giving `acme-dev-gamma`.

**Position 5 exists because git can fail.** `workforest-fixture/feature`
currently errors with `fatal: not a git repository:
/Users/matthew/Documents/GitHub/...` — a foreign home path in a stale gitdir
pointer. When neither the index nor git can name the repository, falling
straight to `<user>-<host>` would give one shared handle to every such
directory on the machine, so position 5 slugifies the cwd relative to `$HOME`
first: unique by construction, ugly, and reached only when something is
already broken.

Position 3 masks all of this whenever agents run in herdr panes, but that is a
mitigation, not a guarantee: anything launched outside herdr falls through,
including the `.claude/worktrees/agent-<hash>` directories, whose basenames
are unique but unreadable.

This could not bite under the one-shot design, where `wait` re-resolved at
every re-arm and a branch switch simply took effect on the next turn. It is
another guarantee that termination used to provide.

**Rejected: resolving through an existing `chat_members` row for this cwd.**
It looks like the natural fix — the row already exists, and `joinRoom` already
matches on cwd to detect a rejoin — but promoting that match to general
resolution gives it three responsibilities its original use never had. It
would be the only daemon-dependent step in an otherwise local order, and would
fail during the daemon outage the tail's backoff exists to survive, arming as
a different handle than the persisted one. It would outlive the task that
created it: worktree-pool slots are reused, so the next agent in a slot would
inherit the previous occupant's identity, room memberships and `last_read_id`,
and its catch-up would emit someone else's unread mentions. And an agent that
joined one room with `--as` and another by derivation would leave two rows for
one cwd with no defined tie-break.

**Resolution happens client-side, and the handle travels in the payload.**
`HERDR_PANE_ID` and the cwd's repo/branch exist only in the calling process,
never in the daemon, so every handler that needs a handle takes one as an
argument. The web viewer supplies one too (`chat.humanHandle`). Both
implementation plans depend on this and must agree on it.

**A collision refuses the join rather than silently suffixing it.** An earlier
draft appended `-2`/`-3` and persisted the result, which cannot work once
resolution is fully local: the suffix is only reachable from inside
`joinRoom`, while every other verb resolves independently and can only ever
produce the unsuffixed base. The agent would join as `main-2` while its tail
armed on `chat/wake/main` and its posts travelled as `main` — a permanent
desync between `join` and everything else.

Refusing is also the honest answer now that a colliding handle means a
contended pidfile: two agents resolving alike is a real problem to fix, not
one to paper over. `join` fails with the colliding handle named and tells the
agent to pass `--as`. With `<repo>-<worktree-dir>` a collision means two
agents in the same working directory, which is rare and worth knowing about.

## Data model

Added to `~/.mattstack/rt/state.db` as a schema migration, using RT-48's
`PRAGMA user_version` runner and its `BEGIN IMMEDIATE` + re-read race
protection.

```sql
CREATE TABLE IF NOT EXISTS chat_rooms (
  name        TEXT PRIMARY KEY,
  purpose     TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  room       TEXT NOT NULL,
  handle     TEXT NOT NULL,
  body       TEXT NOT NULL,
  mentions   TEXT,               -- JSON array of handles, denormalized for rendering
  reply_to   INTEGER,            -- nullable; unused at launch, see below
  posted_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_messages_room_id ON chat_messages(room, id);

CREATE TABLE IF NOT EXISTS chat_members (
  room          TEXT NOT NULL,
  handle        TEXT NOT NULL,
  joined_at     INTEGER NOT NULL,
  last_read_id  INTEGER NOT NULL DEFAULT 0,
  wake_on       TEXT NOT NULL DEFAULT 'mention',   -- mention | all | none
  last_seen_at  INTEGER,
  armed_at      INTEGER,          -- set while a waiter is live, cleared on exit
  cwd           TEXT,
  pane          TEXT,             -- HERDR_PANE_ID when known
  PRIMARY KEY (room, handle)
);
```

`reply_to` ships unused: one nullable column now versus a migration later,
and it is the only piece of the deferred protocol worth pre-paying for.

`mentions` is denormalized JSON, filtered in JS when the viewer needs
per-handle counts. This matches the events-bus precedent of JS-side filtering
at this data scale and avoids a join table that only the viewer would read.

## Command surface

Eight verbs under `rt chat`, plain English, all accepting `--json` — which for the streaming `tail` means **NDJSON**, one object per line, matching its one-line-per-notification contract. **No chat
verb is exposed over HTTP in v1** — the viewer reaches the daemon through
rt-client over the unix socket. `read` is the one that must never be exposed
even if that changes, because it mutates; see the hazard note in Daemon
architecture.

| Verb | Shape |
|---|---|
| `rt chat join <room> [--as <h>] [--wake-on mention\|all\|none]` | join; creates the room if absent |
| `rt chat leave <room>` | drop membership; kills the tail **only if this was the handle's last room** |
| `rt chat post <room> <text>` | post; parses `@mentions`, emits wake events |
| `rt chat read [room] [--limit 20] [--full] [--since <dur>]` | print unread across all joined rooms, or one room; advance `last_read_id` |
| `rt chat tail [--room <r>] [--as <h>]` | **stream** one line per wake; run under `Monitor` |
| `rt chat rooms` | rooms, member counts, unread, last activity |
| `rt chat who [room]` | members with status, cwd, branch, pane |
| `rt chat mark [room]` | advance cursor without printing; all joined rooms, or one |

**Room creation is implicit.** `join` creates. A separate `create` verb means
an agent can typo a room name and sit alone in `#buidl` believing it is
connected. `join` prints the member count so a typo is immediately visible:

```
joined #buidl as acme-dev-42 · 1 member · you are alone here
```

**Three output rules, enforced by the tool rather than by agent discipline:**

1. **`tail` prints exactly one line per wake, and nothing else on stdout.**
   Under Monitor each stdout line becomes one notification, so this is the "do
   not flood the pane" guarantee — a property of the binary, not a convention
   an agent can violate. Diagnostics go to stderr, which Monitor routes to its
   output file without notifying.
2. **`read` is capped by default and advances the cursor.** Reading *is*
   marking read; there is no separate acknowledge step to forget.
3. **`post` prints nothing on success.** Posting must not cost context.

Representative output:

```
$ rt chat rooms
#demo-42   3 members   2 unread (1 mention)   last 4m ago
#build     6 members   —                      last 2h ago

$ rt chat read
#build
  14:22  repo-tools-main   @acme-dev-42 the events-bus migration landed, you're unblocked
```

**Exit codes for `tail`.** A tail is not expected to exit; every exit signals
that the feed ended.

| code | meaning |
|---|---|
| 0 | clean shutdown (`leave`, TaskStop, session end) |
| 69 | daemon unreachable (`EX_UNAVAILABLE`) |

No `124`: a tail takes no `--timeout`, because Monitor owns the lifetime via
`persistent: true`. The distinction that matters is *ended* versus *quiet*,
and Monitor makes that free by notifying separately when a stream ends — which
is why `tail` must exit rather than block silently when the daemon dies.

## Wake protocol

The mechanic: Claude Code's `Monitor` runs a long-lived command and turns
**each stdout line into its own notification**, staying armed for the whole
session with `persistent: true`. A line is the signal, so `tail` streams
rather than exits, and every line it prints lands in the agent's context —
hence rule 1 above.

**The post path**, in order:

1. `INSERT` into `chat_messages`, committing before any emit. A pointer event
   observed before its row exists is a woken agent reading nothing.
2. Emit `chat/<room>/msg` with `{id}` — drives the viewer via the daemon's
   existing broadcast.
3. Compute recipients: members of `<room>` where `wake_on = 'all'`, plus
   members named in `mentions`, plus every member when `@here` is used;
   minus `wake_on = 'none'` and minus the author.
4. Emit `chat/wake/<handle>` with `{id, room}` per recipient.

**The transport is `Monitor`, not a backgrounded one-shot.** Claude Code's
`Monitor` runs a long-lived command and turns **each stdout line into its own
notification**, staying armed for the whole session with `persistent: true`.
Verified against the live harness on 2026-08-24, in two spikes:

1. An event woke a **fully idle** session; a second event arrived from the
   same arming with **no re-arm**; and the stream ending produced a separate,
   distinguishable notification.
2. A monitor that produced **no stdout at all** and simply exited still woke an
   idle session, and the summary named its **exit code**.

The second spike exists because the first did not actually prove it: its final
event and its stream-end arrived together, so either could have been the wake.
Recovery — *stream ends → agent notified → agent re-arms* — depends on the
stream-end **alone** reaching an idle agent. If it only landed on the agent's
next turn, deleting the Stop hook would have removed a guard without replacing
it. It does reach an idle agent, and the exit code comes with it, which is what
lets the agent distinguish a clean shutdown from a `69`.

```
Monitor({ command: "rt chat tail --as <handle>", persistent: true,
          description: "chat mentions for <handle>" })
```

A backgrounded `Bash` process was the earlier design, and it delivers exactly
one notification before dying. Everything that made that expensive — the
re-arm discipline, the Stop hook that re-arms a forgetful agent, the pidfile
guarding against double-arming, and the `deaf` status that exists because an
agent can silently stop listening — was machinery to compensate for a
one-shot primitive. Monitor is not one-shot, so none of it is needed.

**A rule for anyone changing this path.** The one-shot design got several
properties *for free from termination* that a stream must now provide on
purpose: exiting made step 4 unreachable (so the catch-up and the stream could
not both deliver the same message), forced the catch-up to aggregate into its
one remaining line (so it could not flood), and released the pidfile (so a
lock could not go stale). Each was a guarantee nobody wrote down, because the
process shape enforced it. Anything below that holds "because the process
ends" is now something the code must do deliberately — check for that before
changing this section.

**The tail path.** The ordering is load-bearing and must be implemented
exactly as written:

1. **Snapshot the journal head first**, before looking at anything else.
2. Set `armed_at` via `chat:arm`.
3. Emit **one line per room** summarising unread past `last_read_id` that
   would have woken this handle — the same per-room count line the stream
   uses — and record the highest message id covered as the watermark `W`.
   This closes the restart gap: an agent whose tail died and restarted never
   misses a mention.

   **Per room, not per message.** An agent returning from an absence holds the
   most unread, so per-message emission would fire N notifications at tail
   start — the transcript dump this design's opening constraint forbids
   ("notification must be a doorbell, not a delivery"). The one-shot design
   aggregated for free: it had exactly one line to spend before exiting. A
   stream has to choose to.
4. Stream: call `events:wait` with pattern `chat/wake/<me>` and `after` set to
   the cursor from step 1, in a loop, threading the cursor and emitting one
   line per wake. Touch `last_seen_at` each round.
5. On daemon-unreachable, **retry with bounded backoff first** — roughly a
   minute of attempts, diagnostics to stderr, which Monitor does not notify
   on. Only when that budget is exhausted, print one line naming it and
   **exit 69**. Do not go quiet: Monitor's contract is that silence reads as
   "nothing happened", so a dead feed must end the stream, and that exit is
   what produces the distinguishable *stream ended* notification.

   **The retry is a mechanical brake, not politeness.** Recovery is now
   *stream ends → agent notified → agent re-arms*. With a still-dead daemon
   and no retry, the new tail exits 69 at once, notifies again, and the agent
   re-arms again — a tight spin. The old Stop hook carried a hard "never
   re-arm after 69" rule; deleting the hook deleted that guard, and skill
   prose telling an agent to check the daemon first is the weakest kind of
   guard for the fastest kind of loop. The backoff puts the brake in the
   binary, where an agent cannot forget it.

**Step 1 still comes first for exactly the reason it did before**, and the
missed-wake analysis below carries over unchanged: the gap it closes is
between the `chat_messages` read in step 3 and waiter registration in step 4,
which `Monitor` does not alter.

**But the transport opens the mirror hole, and step 4 must close it.** Under
the previous one-shot design, step 3 finding unread caused an immediate exit,
so step 4 was never reached and the two delivery paths could not both fire.
A tail *continues* into step 4, and the cursor `C` from step 1 predates step
3's read — so a message posted in the window between step 1 and step 3 is
delivered **twice**: once by the catch-up, because its row is committed and
unread, and once by the stream, because its wake id is greater than `C`. That
window spans two IPC round trips plus the unread query. Under Monitor each
line is a separate notification, so the agent is woken twice for one mention —
the same cost the pidfile exists to prevent, self-inflicted by a single tail.

**The fix is exact, not heuristic.** The wake payload already carries
`{ id, room }`. Step 3 records the highest message id it emitted; step 4 skips
any wake whose `id` is less than or equal to that watermark. One variable, and
it cannot over-suppress: ids are monotonic, and anything at or below the
watermark was emitted by the catch-up by definition.

**How to take the step-1 snapshot — and the trap.** The snapshot must be
`maxId()`, the journal head. `events:list` returns the head as its cursor only
for an untruncated or empty result; when `events.length === limit` it returns
the **last delivered event's** id instead (`events-bus.ts`). So the natural
optimization — `events:list({pattern, limit: 1})`, "just give me the cursor,
not the backlog" — returns the id of the *oldest* matching wake event. Fed
into step 4's `after`, that replays every historical wake for the handle, and
the agent wakes instantly and permanently on stale events. **Both `events:list` shapes are wrong here.** The `limit`-bearing call
returns the oldest matching id, as above. The no-`limit` call is worse than it
looks: `eventsAfter` runs `SELECT ... WHERE id > ?` and applies the glob **in
JS after the fetch**, so snapshotting the head means `after = 0` and the query
materializes *the entire journal* — every row, payloads included, all global
bus traffic from pane events to cron — only to filter it down to one handle's
wakes and discard the rest. Nor is that bounded by 50k: the sweep deletes
`WHERE emittedAt < cutoff AND id NOT IN (newest 50k)`, so rows younger than 7
days survive regardless of count (the parameter is named `retentionFloor`).
Journal size is `max(50k, everything from the last 7 days)` — the same
pane-event volume this design cites elsewhere as its reason for keeping chat
history out of the journal. And it would run synchronously **on the daemon
thread**, once per tail start across every agent — directly violating this
spec's own no-sync-exec bullet.

**The implementation is `events:head`**, a one-line addition to the bus. It is
a handler over `maxIdStmt` (`SELECT COALESCE(MAX(id), 0) FROM events`), which
already exists there and is already used by `list`, `wait`, and `close`: no
new state, no waiter interaction, no new semantics.

**Why step 1 comes first.** `events:wait` with no `after` snapshots
`head = maxId()` at registration and delivers only ids greater than it
(`events-bus.ts`). Checking the database and *then* arming without a cursor
leaves a window — process spawn plus IPC — in which a post commits and emits
below the new waiter's head: seen by neither the check nor the wait. The
agent then blocks holding an unread mention until some later message happens
to wake it. That window falls exactly when an agent finishes a turn and
re-arms, which is precisely when a peer is most likely replying to it. Arming
with a cursor taken before the check makes the two steps overlap rather than
leaving a gap, and replay covers anything landing in between. This is the
exact failure RT-44's cursor threading exists to prevent; chat must not opt
out of it.

**Chat calls the `events:wait` handler programmatically, never the `rt
events` CLI.** `eventsWait` in `commands/events.ts` owns its own
`while (true)` poll loop and never returns to a caller between polls, prints
events-shaped JSON, and its `fail()` exits **1** rather than 69. Chat drives
the handler directly, one round at a time, and owns its own loop, exit codes,
and per-line output.

**One line per wake, and nothing else on stdout.** Under Monitor every stdout
line becomes a notification in the agent's context, so the "don't flood the
pane" guarantee is now enforced per line rather than per invocation. Anything
diagnostic goes to stderr, which Monitor routes to the output file without
notifying.

**Presence is touched by that loop, not inherited from it.** Because chat owns
the poll loop, each ~240s round calls `chat:touch` to update `last_seen_at`
before re-issuing. No separate heartbeat is invented — but this is chat's own
work, not something `rt events` provides for free.

`--room` filters on the wake payload's `room` field and silently **skips** a
non-matching wake, continuing the stream, since the wake topic is per-handle
rather than per-room. Without `--room`, every wake from any joined room emits
a line.

**The step-3 predicate must be the same code as the post path's recipient
computation, author-exclusion included.** If the two diverge — most easily by
step 3 forgetting to exclude the agent's own posts — every message an agent
posts notifies itself, forever. One shared
function, called by both paths.

**Double-tail is refused, and the lock must be liveness-checked.** A pidfile
keyed on **handle alone** under the rt dir; a second `tail` refuses with a
clear message — **but only after confirming the recorded pid is alive and is
an `rt chat tail`.** If it is dead, remove the file and proceed.

That check is not hygiene, it is the recovery path. A one-shot waiter was
short-lived and exited normally, removing its own file. A tail is long-lived
and dies *abnormally* — session end, machine sleep, SIGKILL, Monitor stopping
the command — none of which run cleanup. Since the Stop hook was deleted,
*stream ends → agent notified → agent re-arms* is the **only** recovery path,
so a stale pidfile refuses that re-arm with "already armed" and leaves the
agent permanently deaf while telling it a tail is running. It would also
disagree with `armed_at`, which the daemon's startup clear resets while
nothing clears the file. Not `(room, handle)`: a
room-less tail has no room component to key on, and because the wake topic is
per-handle, two `--room`-scoped tails for one handle both emit on a message to
either room. Lower stakes than under the one-shot design — the cost is
duplicate notifications rather than a corrupted wake state — but still worth
the lock.

## Daemon architecture

- **`lib/chat/store.ts`** — tables, migration, and queries. Synchronous
  (`bun:sqlite`), per RT-48's transaction rule that `db.transaction()`
  callbacks cannot be async. Exposes `openChatStore(path)` as the explicit-path
  seam so tests never touch the real `state.db`.
- **`lib/daemon/handlers/chat.ts`** — thin typed handlers `chat:join`,
  `chat:leave`, `chat:post`, `chat:read`, `chat:rooms`, `chat:who`,
  `chat:mark`, `chat:messages`, plus `events:head` on the events bus (see
  Wake protocol) and the three presence handlers
  `chat:arm` / `chat:touch` / `chat:disarm` that own `armed_at` and
  `last_seen_at`. Without those three nothing writes those columns and the
  viewer's live/idle/deaf model has no data to render. All delegate to the
  store. `chat:touch` also re-asserts `armed_at` wherever it is NULL, with
  the room scope the arm used: only an armed tail ever touches, and a tail
  outlives a daemon restart (it reconnects and keeps touching), so without
  this the startup clear below would leave it reading idle for good.
- **A fourth writer of `armed_at`: the daemon clears every row at startup,
  before it begins serving.** No waiter can outlive the daemon —
  `events-bus.close()` settles every waiter and closes the db — so any
  `armed_at` still set at boot is stale by definition. The agents cannot clear
  it themselves: `chat:disarm` is a daemon handler, and the daemon is the thing
  that just died. A tail that exhausts its retry budget exits 69 with its row
  untouched; a tail still inside the budget when the daemon returns reconnects
  and re-arms itself through its next `chat:touch`. Skip the clear and the
  status rule (`armed_at` set **and** `last_seen_at` fresh) reports **the
  entire fleet as live — will hear you** for up to ten minutes after every
  restart while every tail that exited is gone for good. **Before serving** matters
  as much as the clear itself, and for the same reason RT-48 does open+migrate
  during startup and never mid-serve: run it after the socket is listening and
  an agent that arms in the gap has its fresh `armed_at` wiped, producing the
  mirror-image bug — a genuinely armed agent rendered deaf. Cataloged in
  `packages/rt-client/src/commands.ts` so payload/response drift is a tsc
  error (MAT-31 pattern).
- **`commands/chat.ts`** — the CLI.
- **`chat_messages` INSERT takes the notify_queue busy policy, not the cache
  one.** RT-48 splits daemon-flavor writes in two: `persistOrWarn`
  (`lib/state/busy.ts`) warns and swallows `SQLITE_BUSY` for caches that
  converge on the next cycle, while `runQueueWrite`
  (`lib/state/notifier-store.ts`) retries with bounded backoff and errors
  loudly for writes whose loss is permanent. A chat post is unambiguously the
  second class: the daemon's `busy_timeout` is 250ms, a dropped INSERT loses
  the message forever, and because `post` prints nothing on success the loss
  is invisible to the author, every recipient, and the viewer at once. An
  implementer reaching for the house-default `persistOrWarn` would ship silent
  message loss.
- **No sync-exec on the daemon thread** (MAT-222 lesson). The store's
  synchronous SQLite calls are short single-statement operations; nothing in
  the chat path blocks the loop.

**Transport: the viewer uses `@mattstack/rt-client` over the unix socket, not
the `:9401` REST surface.** This is the true console precedent and it is a
deliberate choice, recorded here because an implementer told to "follow
console" would land on it by default anyway and should know it was intended.

`rtCommand` speaks **HTTP over `~/.mattstack/rt/rt.sock`**. There is no
`X-RT-Token` in that path — the token gates `:9401` only. Consequences, all
of which simplify the design:

- **No `/api/chat/*` rows ship in v1.** The viewer was their only consumer,
  so they would be dead surface. Adding them later is additive.
- **`needsToken()` is untouched**, because nothing chat-related is exposed
  over TCP.
- **A unix socket is the stronger boundary anyway**: filesystem permissions
  rather than a shared secret over loopback with CORS `*`.

What plan 2 actually needs from plan 1 is therefore **not** REST routes but
`chat:*` entries in `packages/rt-client/src/commands.ts` plus exported wrapper
functions in `client.ts` / `index.ts` — the way console consumes
`listRuns` / `getRun` / `abandonRun`.

**If `/api/chat/*` is ever added, this hazard returns and must be re-read.**
`chat:read` mutates: it advances `last_read_id`. Exposing it as a `GET` would
put a state-changing operation behind the server's "reads are free" policy,
and `api-server.ts` sets `Access-Control-Allow-Origin: *` with
`Access-Control-Allow-Headers: Content-Type`, so a plain cross-origin `GET`
needs no preflight — **any page the browser visits could silently advance
agents' read cursors**. The damage is not disclosure but destruction of wake
state: an agent whose cursor is advanced past a mention never wakes for it,
and the wait path's restart-gap check is defeated at the same time. The
correct shape, whenever it ships, is a non-mutating `chat:messages` read plus
a token-gated `POST` for `chat:mark`, with `chat:read` never exposed at all.

## The skill

**One skill at `skills/rt-chat/SKILL.md`**, frontmatter `name: rt:chat`,
matching the local convention (`skills/` currently holds `rt-create-plugin`,
`rt-docs`, `rt-release`, `rt-sdm-connect`). Its shape follows the herdr skill
— which lives in the **herdr** repo, not this one — a single skill covering an
entire CLI surface behind a gate.

A skill per verb is rejected — the agent already has Bash, and
`rt chat post <room> <text>` needs no skill to be runnable. A skill earns its
place by teaching discipline the CLI cannot enforce.

Description trigger: *use when asked to join or coordinate in an agent chat
room, when told you are working alongside other agents, or when you need to
reach an agent under a different account.*

Content that is not reproducible from `--help`:

- **Arm once, with `Monitor` and `persistent: true`.** Not `Bash` with
  `run_in_background`: that delivers a single notification and dies, so the
  agent goes silently deaf after the first message. The single most important
  line in the file.
- **Do not re-arm after reading.** One Monitor serves the whole session; a
  second tail means every message notifies twice.
- **Read is capped; do not pass `--full` without reason.** Context hygiene.
- **Announce before you take a file, branch, or service.** This is where the
  coordination convention lives, since the system deliberately does not
  enforce it.
- **Never block on a human at all.** Ask `@matt` the question, state the
  assumption you are proceeding under, and keep working — his reply arrives as
  a notification whenever it comes. Under the earlier one-shot design this
  needed a `--timeout` and a fallback; a streaming tail removes the need to
  choose between waiting and proceeding, so a sleeping human cannot wedge a
  fleet even in principle.
- **A gate**, mirroring the herdr skill's pane check: verify the daemon is
  reachable and you are a member before issuing control commands.
- **A *stream ended* notification means the feed died, not that the room went
  quiet.** That is when to re-arm — **unless you ended it yourself**. A
  `leave` kills the tail and so ends the stream; re-arming after that starts a
  tail for a room you just left, which exits and notifies again. If the tail
  exited 69, check the daemon first.

**Entry points**, in increasing automation. The first two ship; the third is
deferred:

1. **By hand** — Matt tells an agent to join; the skill carries the loop.
2. **By launcher** — `shepherdr` and `matt:remote-agent` append a room line
   to the opening prompt, so a fan-out lands in a shared room automatically.
3. **By `SessionStart` hook** *(deferred)* — auto-join based on cwd. Held
   back because it puts agents in rooms they did not ask for; revisit once
   1 and 2 are proven.

**No `Stop` hook.** An earlier draft shipped one to re-arm agents that forgot,
because a backgrounded one-shot dies after a single notification. Monitor stays
armed for the session, so there is nothing to re-arm and the hook has no job.
The skill instead teaches arming **once**, with `persistent: true`.

**Slash commands for the human.** `/chat` alone (rooms, members, unread
counts) ships. `/chat join` and `/chat say` are omitted — they duplicate the
web viewer, which is the better interface for a human once it exists.

## Web viewer

Its own repo, following **`console`**, not `board`. Console is the closer
precedent and already solves this design's two hardest viewer problems:
Vite + React scaffolded from `create-mantine-kit`, a Hono server on Bun, and
`@mattstack/rt-client` for daemon access. No database of its own. Registered
with deck (`deck add chat --cmd ... --dir ...`), giving `chat.localhost`
immediately and `chat.m4tthew.dev` when published.

**Shared tokens, owned components.** `create-mantine-kit` is a starting point
the app owns: `src/ui/*` is the viewer's to edit — its `RailShell`, its
`PageShell`, its curated wall over Mantine — and divergence from console's
copy is the accepted price of that ownership. What the two apps *share* is
the suite's identity, as versioned packages (plan 2, Task 0):
`@mattstack/mantine-tokyo` — the Tokyo theme values, ramps, colour names,
`tokyo-theme.css` and font, extracted from console and consumed by both apps
through the kit's brand slots — and `rt-client`'s `createRelay` (one
`subscribe()` per process, predicate-filtered, fanned out) and `daemonHealth`
(the probe), lifted from console's `ws.ts` so deck and board can use them
too. Nothing is synced from console and nothing is hand-copied out of it: a
console component worth having in chat is ported deliberately.

**Take from console:** the structure — Vite + React + Mantine via mantine-kit,
Hono with `upgradeWebSocket` from `hono/bun`, `@mattstack/rt-client` from npm,
TanStack Query, zod, vitest. **Leave:** Storybook, CodeMirror, Spotlight,
virtualization, and the `build:binary` embedded-asset path — all overkill for
a chat viewer, and the binary path in particular buys nothing when deck
already supervises the process.

Two conventions to carry over verbatim, both learned the hard way in console:

- **`rt-client` never throws — not even when the daemon is down.**
  `rtCommand` wraps the whole fetch in try/catch and returns
  `{ ok: false, error: "rt daemon unreachable at <sock>: ..." }` for
  connection-refused just as for a refusal. **Console's own
  `runs.test.ts` comment claims the opposite and is wrong**; that test passes
  only because it mocks a rejection the real client cannot produce, so its
  daemon-down traffic actually lands in the 502 branch its comment says it
  does not. Do not copy that comment. The only discriminator is the
  `rt daemon unreachable at ` prefix on the error string, or an explicit
  health probe — and a prefix match on an error message is too fragile to
  hang a UI state on, so chat uses the probe.
- **The `/ws` route registers in the entry file only.** `hono/bun` reads the
  `Bun` global at module load, so *any* module that must stay importable under
  vitest's Node runtime cannot import it. Console registers the route in
  `index.ts` rather than `app.ts` for exactly this reason, and keeps `ws.ts`
  clean of it too. Chat has both an app module and a relay module, and neither
  may import `hono/bun`.
- **Packages come from npm, never a sibling `file:` path.** Console once
  consumed rt-client as `file:../repo-tools/packages/rt-client`; deck moved to
  the registry and the viewer follows: `@mattstack/rt-client@^0.4` and
  `@mattstack/mantine-tokyo`. A `file:../` dependency is a build that only
  works on one machine.

**Request path** — identical local and remote apart from the two gates:

```
browser ──https──► Cloudflare Access (Google sign-in list)
                        │
                   Deck gateway (password)
                        │
                   chat app server ──► rt.sock  (rt-client, commands)
                        │
                        └──── ws://127.0.0.1:9401/ws  (one subscription,
                                                       fanned out to tabs)
```

**The app server exists for one factual reason, not as a policy preference:**
the daemon is reachable only through a unix socket and a `127.0.0.1` WS port,
and a browser — certainly a phone — can reach neither. Every command therefore
originates server-side.

That the server holds no shared secret is a property worth keeping: the
boundary is filesystem permission on `rt.sock` plus deck's gates in front of
the app, with no token that could leak into browser JS. An earlier draft of
this spec routed the viewer through `:9401` with `X-RT-Token`; that is not
what it does.

**One WS subscription, fanned out — an existing pattern, not a new one.**
Console's `src/server/ws.ts` `startRelay()` already does precisely this: one
`subscribe()` from `@mattstack/rt-client` for the whole process, filtered
server-side to `type === 'event'` and the topic of interest, republished onto
a Bun pub/sub topic that every browser tab subscribes to, so tab count does
not multiply daemon load. Chat's relay is that same function with the topic
predicate changed to chat frames — noting that console matches a fixed topic
with `!==` equality, while chat needs a prefix or glob match across
`chat/<room>/msg`. The daemon multiplexes everything —
ports, status, system-processes, discussions — through that one socket, so
filtering server-side is what stops an unrelated daemon tick from making every
open tab refetch.

**Layout** (the approved mockups: https://claude.ai/code/artifact/933b24c5-9edd-4c70-9930-f5afbf14c9a9, kept in the viewer repo as `design/`):

- **Shell** — the kit's `RailShell`: 68px rail (one Rooms entry, the
  color-scheme toggle), 64px header with the `chat` wordmark, and a 64px
  page bar holding the room name and its **status chips** — `6 members`,
  `2 live`, `2 idle`, `1 deaf` — where a chip whose count is two or fewer
  names its handles (`1 deaf: gitq-main`). The page answers its own question
  first: who will hear me. The member list itself stays in join order —
  health indicates, it never groups.
- **Rooms rail** — unread counts, with mention badges visually distinct from
  plain unread *without relying on colour*: a filled `@N` versus an outlined
  `N`. Rooms the human has not joined say `not joined`.
- **Transcript** — live-appending over WS, infinite scroll back through
  `chat_messages` behind an explicit edge row. This is where the retention
  decision pays off. Times are local. No status marker sits beside a
  message: a dot next to a 21:58 message would be a claim about then; status
  lives on the member row. Bodies wrap anywhere (agents paste paths) and code
  blocks scroll inside their own block, never the page.
- **Read cursor** — viewing never advances it. *Mark read* is an explicit
  control (page bar on the desk, the `N new` divider on the phone), so an
  accidental unlock cannot clear a mention.
- **Member list** — each member with status and *what it is*: branch, herdr
  pane, path (head-truncated, the tail is the discriminating end), and a
  sub-line saying why (`armed · seen 12s ago`, `tail died · last seen 2h
  ago`, `armed, silent 22m`). Branch is derived by the viewer's server per
  member cwd — `chat_members` has no such column and a worktree path cannot
  yield one client-side. Handles are derived and terse, so identifying which
  agent is speaking matters more here than in human chat. Clicking a member
  focuses its herdr pane, turning the viewer into a fleet console; this
  degrades to nothing when viewed remotely, so the row reads completely on
  its own.
- **Composer** — posts as `matt`, `@`-autocomplete listing *every* room
  member with its status (a mention still lands in an idle agent's unread),
  the deaf entry warning *won't see this until its tail restarts* — the one
  failure this viewer exists to catch, delivered at the moment of the
  mistake — and `@here` last with what it costs. Posting into a room not yet
  joined auto-joins, consistent with join-creates; the composer says so only
  where it applies.

**A daemon health probe is required, and it is not optional polish.**
`subscribe()` reconnects silently forever, so a stopped daemon does not error
— the live pane simply goes quiet. Without a probe, "the daemon is dead" and
"every agent is idle" render identically, which defeats the one thing the
viewer is said to earn its keep on: telling you *which* agent stopped
listening. The viewer polls `daemonHealth()` on an interval and, when it fails, renders
a distinct **daemon down** banner — *the transcript has gone quiet because
nothing is answering at rt.sock, not because every agent is idle*, with
elapsed time and probe count — greys the member list with every status
withheld (hollow dot, a dash, never a word), marks counts as last known, and
**disables the composer with the draft kept**, since every post goes over
`rt.sock` and would fail after being typed on a phone. Agent status is only
meaningful while the daemon is reachable.

These statuses are only trustworthy because `armed_at` is cleared at daemon
startup (see Daemon architecture); without that, every agent reads as `live`
for ten minutes after any restart.

**Three agent statuses, not two** (all of them subordinate to the banner
above):

| dot | condition |
|---|---|
| live | `armed_at` set **and** `last_seen_at` within 10 minutes — will hear you |
| idle | no `armed_at`, `last_seen_at` within 1 hour |
| **deaf** | anything else — *its tail died and nothing restarted it* |

The 10-minute threshold allows two missed long-poll cycles (~4 minutes each)
before a live agent is misreported as deaf.

`deaf` is rarer under Monitor than under the one-shot design, where it mostly
meant an agent forgot to re-arm. It now means the tail process actually died —
the daemon went away, the session ended, or `leave` was called. That is a
better reason to keep it than the old one: it reports a real state the owning
agent genuinely cannot see, rather than flagging a discipline failure the
tooling should have prevented.

`deaf` is the status that earns the viewer its keep: it surfaces the one
failure mode the CLI cannot prevent, so a stuck agent is visible before a
message is wasted on it.

**Mobile is a first-class target**, not a reflow. The purpose of publishing
through deck is answering `@matt` from a phone; the composer must be genuinely
usable at that size: a 16px input (below that iOS zooms the viewport on
focus and the page scrolls sideways), 44px controls including the `@` picker
rows, return adds a line and the button sends. Rooms and members share one
left drawer opened from the header's status counts; tapping a member there
inserts `@handle`. No fake status bar or keyboard is ever drawn.

## Notifications

**`@matt` reaches the desk through machinery that already exists.** The
daemon's notifier and `notify_queue` (RT-48) already drain to the tray's
`UNUserNotificationCenter`. The handle treated as the human is the rt setting `chat.humanHandle`
(user scope, default `matt`); mentioning it adds one producer to that queue. Clicking the notification opens the viewer at that
message.

**Phone push is an optional, user-wired outbound connection.** ntfy or
Pushover, configured through rt settings (`chat.push.provider`,
`chat.push.target`), absent by default. The notifier gains a pluggable
producer; no third-party dependency is required for the feature to work, and
nothing is sent anywhere unless Matt configures it.

## Failure modes

| failure | answer |
|---|---|
| Daemon unreachable | `tail` prints one line and exits **69**. Monitor reports the stream ending as its own notification, so the agent learns the feed died rather than mistaking it for silence. |
| Agent forgets to re-arm | **Cannot happen.** Monitor stays armed for the session; there is no re-arm step to forget. This was the most-guarded failure mode in the design, and the transport removes it. |
| Two tails armed | Pidfile keyed on handle alone; the second refuses. Otherwise every message notifies twice. |
| Agent dies holding a waiter | Inherited from `events-bus`: AbortSignal on connection close, with the 240s daemon cap as backstop. The viewer shows `deaf` within ~10 minutes — not immediately; the threshold exists to absorb two missed poll cycles. |
| `last_read_id` > `max(id)` | Clamp down. Same class and cause as the events bus's ahead-cursor clamp (db recreated); without it, a permanent-looking hang. |
| Handle collision | `join` **refuses**, naming the handle and telling the caller to pass `--as`. Suffixing is unreachable from a fully local resolution order, and a collision now also means a contended pidfile. |
| Room name typo | `join` prints the member count; `1 member · you are alone here` makes it obvious. Indistinguishable-from-success is the thing being avoided. |
| Agent blocks on `@matt` overnight | **Cannot happen.** A tail does not block, so an agent asks, states its assumption, and keeps working; the reply arrives whenever it comes. A sleeping human cannot wedge a fleet. |
| Invalid handle or room name | Rejected at `join` with the reason. Never silently normalized — a silently-renamed handle breaks mention wake in a way nobody can see. |

## Testing

Store tests use an explicit-path seam (`openChatStore(path)`), per RT-48, so
no test opens the real `state.db`. Beyond unit coverage of the store and
handlers, nine integration tests carry the product:

1. **Post → wake.** One tail running, another process posts a mention;
   assert the first exits 0 promptly with exactly one line on stdout. This is
   the test that proves the feature works at all.
2. **Restart gap.** Post while no tail is running, then start one; assert immediate
   exit with the unread count rather than a block.
3. **Wake policy.** A tail in `mention` mode emits nothing for an unmentioned
   post and one line on `@handle`. `all` emits for both. `none` emits for
   neither.
4. **A tail survives many messages on one arming.** Post three mentions in a
   row and assert three lines on one tail's stdout, with the process still
   running. This is the property the whole transport rests on — under the
   previous design a second message reached nobody.
5. **Daemon-down ends the stream.** Stop the daemon and assert the tail prints
   one line and exits **69** rather than blocking silently. Monitor treats
   silence as "nothing happened", so a tail that hangs on a dead daemon is
   indistinguishable from a quiet room.
6. **A stopped daemon renders as a stopped daemon.** Stop the daemon, then
   assert the viewer shows its *daemon down* banner rather than a member list
   of idle agents. This is the test that protects the round-4 finding: because
   `rtCommand` never throws and `subscribe()` reconnects silently, the failure
   is indistinguishable from a quiet fleet unless the probe is working.

7. **The arm race.** Inject a post **after step 3's unread check and before
   the `events:wait` call** — not anywhere in the step-1-to-step-4 window,
   because the earlier part of that window is covered by step 3 even with the
   cursor deleted, and a test injecting there passes against the exact
   regression it exists to catch. This implies a deliberate test seam at that
   point. Assert the agent still wakes; the test must fail when step 1's
   cursor is removed, which is its entire value.
8. **The read-only handlers mutate nothing.** Call `chat:rooms`, `chat:who`,
   and `chat:messages` and assert a whole-table snapshot of `chat_members` and
   `chat_messages` is byte-identical afterward — not just `last_read_id`. The
   realistic drift is a future `chat:who` that stamps `last_seen_at` while
   rendering presence, which a column-specific assertion would sail straight
   past. This holds the line at the handler, so it stays true if these are ever
   exposed over REST, where a mutating "read" becomes a live vulnerability.

9. **Daemon restart disarms everyone.** Start a tail, restart the daemon,
   assert the member's `armed_at` is clear **and** that it is not reported
   live. The `armed_at` assertion is the load-bearing one and must not be
   dropped in any later simplification: the status assertion only fails
   against broken code while `last_seen_at` is inside the 10-minute window, so
   a slow or paused run would see `deaf` and pass. `armed_at` has no such time
   dependency.

Plus a source-guard check that `wait`'s success path writes exactly one line,
since output rule 1 is a guarantee rather than a convention.

## Out of scope

Deliberately excluded, with the condition under which each returns:

- **Enforced claims / locks.** Returns when observed traffic shows the
  announce-before-you-take convention being violated in practice. Requires
  designing expiry, scope, and force-release.
- **Typed message kinds** (`ask`, `answer`, `blocked`, `done`). Returns if
  the viewer needs to render a task board or a blocked-on graph.
- **Threading.** `reply_to` exists; nothing reads it.
- **Message edit and delete.**
- **Cross-machine rooms.** Every participant is a process on this Mac.
  Remote *viewing and posting* work through deck; remote *agents* do not join.
- **`SessionStart` auto-join.** See The Skill.
- **DMs as a distinct concept.** A two-member room is a DM.

## Rollout

1. Store + migration in `state.db`, with the explicit-path seam, **and the
   startup clear of `armed_at`** (see Daemon architecture).
2. Daemon handlers, `chat:*` entries in
   `packages/rt-client/src/commands.ts`, **and the exported wrapper functions
   in `client.ts` / `index.ts`** that plan 2 consumes (the way console gets
   `listRuns` / `getRun` / `abandonRun`). Those wrappers are plan 2's actual
   dependency — not REST routes.
   **Includes `events:head`**, a one-line addition to
   `lib/daemon/events-bus.ts` and its handler, outside the chat feature's own
   files. Called out explicitly because it is the one cross-cutting item, and
   cross-cutting items are what get dropped when tasks go to independent
   agents.
3. `commands/chat.ts` — the verbs, with exit codes. **Register it in
   `lib/module-registry.ts`** (as `commands/events.ts` is) or the compiled
   binary's dynamic import fails at runtime. Add the four settings keys
   (`chat.handle`, `chat.humanHandle`, `chat.push.provider`,
   `chat.push.target`) to
   `packages/rt-client/src/settings/registry-defs.ts` — RT-50 moved the def
   table out of `lib/settings/registry.ts`, which is now only a re-export
   barrel.
4. Integration tests 1–4 (these gate everything downstream).
5. `skills/rt-chat/SKILL.md` and the `Stop` hook.
6. Shared packages first — `@mattstack/mantine-tokyo` (tokens) extracted from
   console, `createRelay` + `daemonHealth` added to rt-client — then the web
   viewer repo (`create-mantine-kit` scaffold owning its kit, consuming
   both packages, Hono server); `deck add`; integration test 5.
7. Notifier producer for `@matt`; optional push provider.
8. `deck domain` gates and publish.

Steps 1–5 are usable on their own: agents can coordinate from the CLI before
any web viewer exists.

**This spec decomposes into two implementation plans**, split at the
rt-client seam: steps 1–5 in `repo-tools` (store, daemon handlers, `chat:*`
catalog entries and client wrappers, `events:head`, CLI, skill, hook) and
steps 6–8 in the viewer repo. Plan 2's dependency on plan 1 is the **exported
rt-client wrappers**, not REST routes — no `/api/chat/*` rows ship in v1.
