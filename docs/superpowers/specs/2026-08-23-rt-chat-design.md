# rt chat — multi-agent chat rooms with a web viewer

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
4. `<repo>-<branch>`, slugified (`acme-dev-42`)
5. `<user>-<host>`, slugified

**Resolution happens client-side, and the handle travels in the payload.**
`HERDR_PANE_ID` and the cwd's repo/branch exist only in the calling process,
never in the daemon, so every handler that needs a handle takes one as an
argument. The web viewer supplies one too (`chat.humanHandle`). Both
implementation plans depend on this and must agree on it.

On collision inside a room, a numeric suffix is appended at join
(`acme-dev-42-2`). The **resolved** handle is written to `chat_members`
and reused on subsequent joins from the same context, so an agent's identity
is stable across restarts.

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

Eight verbs under `rt chat`, plain English, all accepting `--json`. **No chat
verb is exposed over HTTP in v1** — the viewer reaches the daemon through
rt-client over the unix socket. `read` is the one that must never be exposed
even if that changes, because it mutates; see the hazard note in Daemon
architecture.

| Verb | Shape |
|---|---|
| `rt chat join <room> [--as <h>] [--wake-on mention\|all\|none]` | join; creates the room if absent |
| `rt chat leave <room>` | drop membership; kills any armed waiter |
| `rt chat post <room> <text>` | post; parses `@mentions`, emits wake events |
| `rt chat read [room] [--limit 20] [--full] [--since <dur>]` | print unread across all joined rooms, or one room; advance `last_read_id` |
| `rt chat wait [--room <r>] [--timeout <dur>]` | **block** until woken; exit |
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

1. **`wait` prints exactly one line, ever.** This is the "do not flood the
   pane" guarantee. Because it is a property of the binary, no careless agent
   can violate it.
2. **`read` is capped by default and advances the cursor.** Reading *is*
   marking read; there is no separate acknowledge step to forget.
3. **`post` prints nothing on success.** Posting must not cost context.

Representative output:

```
$ rt chat rooms
#dev-42   3 members   2 unread (1 mention)   last 4m ago
#build     6 members   —                      last 2h ago

$ rt chat read
#build
  14:22  repo-tools-main   @acme-dev-42 the events-bus migration landed, you're unblocked
```

**Exit codes for `wait`** — the Stop hook branches on these, so they must be
distinct:

| code | meaning |
|---|---|
| 0 | woken; one line on stdout |
| 124 | `--timeout` elapsed (GNU convention, matches `rt events wait`) |
| 69 | daemon unreachable (`EX_UNAVAILABLE`) |

Conflating 69 with 0 would make a re-arming Stop hook spin in a tight loop
against a dead daemon.

## Wake protocol

The mechanic: Claude Code's `Bash` tool with `run_in_background: true`
detaches a process that survives across turns, and **the harness re-invokes
the agent with the process's output when it exits**. The exit is the signal,
so `wait` must exit rather than loop internally, and whatever it prints lands
in the agent's context — hence rule 1 above.

**The post path**, in order:

1. `INSERT` into `chat_messages`, committing before any emit. A pointer event
   observed before its row exists is a woken agent reading nothing.
2. Emit `chat/<room>/msg` with `{id}` — drives the viewer via the daemon's
   existing broadcast.
3. Compute recipients: members of `<room>` where `wake_on = 'all'`, plus
   members named in `mentions`, plus every member when `@here` is used;
   minus `wake_on = 'none'` and minus the author.
4. Emit `chat/wake/<handle>` with `{id, room}` per recipient.

**The wait path.** The ordering here is load-bearing and must be implemented
exactly as written:

1. **Snapshot the journal head first**, before looking at anything else.
2. Set `armed_at` via `chat:arm`.
3. Check `chat_messages` for anything past `last_read_id` that would have
   woken this handle. If found, clear `armed_at` and exit immediately with
   the count. This closes the restart gap — a crashed and relaunched agent
   never misses a mention.
4. Otherwise call `events:wait` with pattern `chat/wake/<me>` **and
   `after` set to the cursor from step 1**.
5. On wake, print one line, clear `armed_at`, exit 0.

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
thread**, once per arm, with the Stop hook re-arming after every turn across
every agent — directly violating this spec's own no-sync-exec bullet.

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
and single-line output.

**Presence is touched by that loop, not inherited from it.** Because chat owns
the poll loop, each ~240s round calls `chat:touch` to update `last_seen_at`
before re-issuing. No separate heartbeat is invented — but this is chat's own
work, not something `rt events` provides for free.

`--room` filters on the wake payload's `room` field and silently re-arms on a
non-matching wake, since the wake topic is per-handle rather than per-room.
Without `--room`, a wake from any joined room exits.

**The step-3 predicate must be the same code as the post path's recipient
computation, author-exclusion included.** If the two diverge — most easily by
step 3 forgetting to exclude the agent's own posts — an agent's own message
makes its next `wait` exit immediately, every time, forever. One shared
function, called by both paths.

**Double-arm is refused.** A pidfile keyed on **handle alone** under the rt
dir; a second `wait` refuses with a clear message. Not `(room, handle)`: a
room-less `wait` has no room component to key on, and because the wake topic
is per-handle, two `--room`-scoped waiters for one handle are both woken by a
message to either room — exactly the double-wake the lock exists to prevent.

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
  store.
- **A fourth writer of `armed_at`: the daemon clears every row at startup,
  before it begins serving.** No waiter can outlive the daemon —
  `events-bus.close()` settles every waiter and closes the db — so any
  `armed_at` still set at boot is stale by definition. The agents cannot clear
  it themselves: `chat:disarm` is a daemon handler, and the daemon is the thing
  that just died, so each `rt chat wait` exits 69 with its row untouched. Skip
  this and the status rule (`armed_at` set **and** `last_seen_at` fresh)
  reports **the entire fleet as live — will hear you** for up to ten minutes
  after every restart while every agent is disarmed, with nothing recovering it
  because the Stop hook must never re-arm after 69. **Before serving** matters
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

- **Arm in the background, never the foreground.** A foreground `wait` hangs
  the agent indefinitely. The single most important line in the file.
- **Re-arm after every read**, with the failure mode named: forget, and you
  go silently deaf.
- **Read is capped; do not pass `--full` without reason.** Context hygiene.
- **Announce before you take a file, branch, or service.** This is where the
  coordination convention lives, since the system deliberately does not
  enforce it.
- **Never block on a human indefinitely.** When `@matt`-ing a blocking
  question, use `--timeout 15m`; on exit 124, proceed under a stated
  assumption and say so in the room. One sleeping human must not wedge a
  fleet.
- **A gate**, mirroring the herdr skill's pane check: verify the daemon is reachable and
  you are a member before issuing control commands.

**Entry points**, in increasing automation. The first two ship; the third is
deferred:

1. **By hand** — Matt tells an agent to join; the skill carries the loop.
2. **By launcher** — `shepherdr` and `matt:remote-agent` append a room line
   to the opening prompt, so a fan-out lands in a shared room automatically.
3. **By `SessionStart` hook** *(deferred)* — auto-join based on cwd. Held
   back because it puts agents in rooms they did not ask for; revisit once
   1 and 2 are proven.

**A `Stop` hook ships in v1.** When an agent finishes a turn, if it is a room
member with no live waiter, relaunch one. This is the only real fix for the
one failure mode the CLI cannot prevent, and it is small. It must branch on
`wait`'s exit codes: never re-arm after 69.

**Slash commands for the human.** `/chat` alone (rooms, members, unread
counts) ships. `/chat join` and `/chat say` are omitted — they duplicate the
web viewer, which is the better interface for a human once it exists.

## Web viewer

Sibling repo, following **`console`**, not `board`. Console is the closer
precedent and already solves this design's two hardest viewer problems:
Vite + React scaffolded from `create-mantine-kit`, a Hono server on Bun, and
`@mattstack/rt-client` for daemon access. No database of its own. Registered
with deck (`deck add chat --cmd ... --dir ...`), giving `chat.localhost`
immediately and `chat.m4tthew.dev` when published.

**Take from console:** Vite + React + Mantine via mantine-kit, Hono with
`upgradeWebSocket` from `hono/bun`, `@mattstack/rt-client`, TanStack Query,
zod, vitest. **Leave:** Storybook, CodeMirror, Spotlight, virtualization, and
the `build:binary` embedded-asset path — all overkill for a chat viewer, and
the binary path in particular buys nothing when deck already supervises the
process.

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
- **The dependency on rt-client is a relative file path to a sibling
  checkout** (`"@mattstack/rt-client": "file:../repo-tools/packages/rt-client"`
  in console). "Sibling repo" is load-bearing: the viewer does not build if
  cloned without repo-tools beside it.

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

**Layout:**

- **Rooms rail** — unread counts, with mention badges visually distinct from
  plain unread.
- **Transcript** — live-appending over WS, infinite scroll back through
  `chat_messages`. This is where the retention decision pays off.
- **Member list** — each member with status and *what it is*: cwd, branch,
  herdr pane. Handles are derived and terse, so identifying which agent is
  speaking matters more here than in human chat. Clicking a member focuses
  its herdr pane, turning the viewer into a fleet console; this degrades to
  nothing when viewed remotely.
- **Composer** — posts as `matt`, `@`-autocomplete from room members.
  Posting into a room not yet joined auto-joins, consistent with
  join-creates.

**A daemon health probe is required, and it is not optional polish.**
`subscribe()` reconnects silently forever, so a stopped daemon does not error
— the live pane simply goes quiet. Without a probe, "the daemon is dead" and
"every agent is idle" render identically, which defeats the one thing the
viewer is said to earn its keep on: telling you *which* agent stopped
listening. The viewer polls a cheap daemon command on an interval and, when it
fails, renders a distinct **daemon down** banner and greys the member list
rather than reporting anyone as idle or deaf. Agent status is only meaningful
while the daemon is reachable.

These statuses are only trustworthy because `armed_at` is cleared at daemon
startup (see Daemon architecture); without that, every agent reads as `live`
for ten minutes after any restart.

**Three agent statuses, not two** (all of them subordinate to the banner
above):

| dot | condition |
|---|---|
| live | `armed_at` set **and** `last_seen_at` within 10 minutes — will hear you |
| idle | no `armed_at`, `last_seen_at` within 1 hour |
| **deaf** | anything else — *forgot to re-arm* |

The 10-minute threshold allows two missed long-poll cycles (~4 minutes each)
before a live agent is misreported as deaf.

`deaf` is the status that earns the viewer its keep: it surfaces the one
failure mode the CLI cannot prevent, so a stuck agent is visible before a
message is wasted on it.

**Mobile is a first-class target**, not a reflow. The purpose of publishing
through deck is answering `@matt` from a phone; the composer must be genuinely
usable at that size.

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
| Daemon unreachable | `wait` exits **69**, distinct from 0 and 124. A Stop hook that cannot distinguish "woken" from "daemon dead" re-arms in a tight loop forever. |
| Agent forgets to re-arm | Four layers: skill discipline → self-documenting `wait` exit line → Stop hook → `deaf` in the viewer. |
| Two waiters armed | Pidfile keyed on handle alone; the second refuses. Otherwise every message double-wakes. |
| Agent dies holding a waiter | Inherited from `events-bus`: AbortSignal on connection close, with the 240s daemon cap as backstop. The viewer shows `deaf` within ~10 minutes — not immediately; the threshold exists to absorb two missed poll cycles. |
| `last_read_id` > `max(id)` | Clamp down. Same class and cause as the events bus's ahead-cursor clamp (db recreated); without it, a permanent-looking hang. |
| Handle collision | Numeric suffix at join; resolved handle persisted, stable thereafter. |
| Room name typo | `join` prints the member count; `1 member · you are alone here` makes it obvious. Indistinguishable-from-success is the thing being avoided. |
| Agent blocks on `@matt` overnight | Skill convention: `--timeout 15m`, proceed on 124 under a stated assumption, announced in the room. |
| Invalid handle or room name | Rejected at `join` with the reason. Never silently normalized — a silently-renamed handle breaks mention wake in a way nobody can see. |

## Testing

Store tests use an explicit-path seam (`openChatStore(path)`), per RT-48, so
no test opens the real `state.db`. Beyond unit coverage of the store and
handlers, eight integration tests carry the product:

1. **Post → wake.** One process armed on `wait`, another posts a mention;
   assert the first exits 0 promptly with exactly one line on stdout. This is
   the test that proves the feature works at all.
2. **Restart gap.** Post while nobody is armed, then arm; assert immediate
   exit with the unread count rather than a block.
3. **Wake policy.** An agent in `mention` mode stays blocked through an
   unmentioned post and wakes on `@handle`. An agent in `all` mode wakes on
   both. An agent in `none` mode wakes on neither.
4. **Exit codes.** 124 on `--timeout` expiry; 69 with the daemon stopped.
   The Stop hook branches on these.
5. **A stopped daemon renders as a stopped daemon.** Stop the daemon, then
   assert the viewer shows its *daemon down* banner rather than a member list
   of idle agents. This is the test that protects the round-4 finding: because
   `rtCommand` never throws and `subscribe()` reconnects silently, the failure
   is indistinguishable from a quiet fleet unless the probe is working.

6. **The arm race.** Inject a post **after step 3's unread check and before
   the `events:wait` call** — not anywhere in the step-1-to-step-4 window,
   because the earlier part of that window is covered by step 3 even with the
   cursor deleted, and a test injecting there passes against the exact
   regression it exists to catch. This implies a deliberate test seam at that
   point. Assert the agent still wakes; the test must fail when step 1's
   cursor is removed, which is its entire value.
7. **The read-only handlers mutate nothing.** Call `chat:rooms`, `chat:who`,
   and `chat:messages` and assert a whole-table snapshot of `chat_members` and
   `chat_messages` is byte-identical afterward — not just `last_read_id`. The
   realistic drift is a future `chat:who` that stamps `last_seen_at` while
   rendering presence, which a column-specific assertion would sail straight
   past. This holds the line at the handler, so it stays true if these are ever
   exposed over REST, where a mutating "read" becomes a live vulnerability.

8. **Daemon restart disarms everyone.** Arm a waiter, restart the daemon,
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
6. Web viewer repo (`create-mantine-kit` scaffold, Hono server, relay);
   `deck add`; integration test 5.
7. Notifier producer for `@matt`; optional push provider.
8. `deck domain` gates and publish.

Steps 1–5 are usable on their own: agents can coordinate from the CLI before
any web viewer exists.

**This spec decomposes into two implementation plans**, split at the
rt-client seam: steps 1–5 in `repo-tools` (store, daemon handlers, `chat:*`
catalog entries and client wrappers, `events:head`, CLI, skill, hook) and
steps 6–8 in the viewer repo. Plan 2's dependency on plan 1 is the **exported
rt-client wrappers**, not REST routes — no `/api/chat/*` rows ship in v1.
