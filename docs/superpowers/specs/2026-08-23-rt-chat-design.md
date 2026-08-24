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

- **The web viewer is a sibling repo, not part of rt.** Follows the `board`
  precedent — Bun server-rendered shell plus a small React island, no
  database of its own — and is registered with deck for HTTPS, supervision,
  and public access control.

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
4. `<repo>-<branch>`, slugified (`acme-acme-2299`)
5. `<user>-<host>`, slugified

On collision inside a room, a numeric suffix is appended at join
(`acme-acme-2299-2`). The **resolved** handle is written to `chat_members`
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

Seven verbs under `rt chat`, plain English, all accepting `--json`.

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
joined #buidl as acme-acme-2299 · 1 member · you are alone here
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
#acme-2299   3 members   2 unread (1 mention)   last 4m ago
#build     6 members   —                      last 2h ago

$ rt chat read
#build
  14:22  repo-tools-main   @acme-acme-2299 the events-bus migration landed, you're unblocked
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

**The wait path:**

1. Check `chat_messages` for anything past `last_read_id` that would have
   woken this handle. If found, exit immediately with the count. This closes
   the restart gap — a crashed and relaunched agent never misses a mention —
   and means no event cursor is persisted anywhere. `last_read_id` is the
   single source of truth for what has been seen.
2. Otherwise arm `rt events wait "chat/wake/<me>"`, setting `armed_at`.
3. On wake, print one line, clear `armed_at`, exit 0.

`--room` filters on the wake payload's `room` field and silently re-arms on a
non-matching wake, since the wake topic is per-handle rather than per-room.
Without `--room`, a wake from any joined room exits.

**Presence rides the long-poll for free.** The daemon caps a wait at 240s, so
the CLI re-issues roughly every four minutes regardless. Each re-issue touches
`last_seen_at`. No heartbeat mechanism is invented.

**Double-arm is refused.** A pidfile per `(room, handle)` under the rt dir; a
second `wait` refuses with a clear message. Two live waiters double-wake on
every message.

## Daemon architecture

- **`lib/chat/store.ts`** — tables, migration, and queries. Synchronous
  (`bun:sqlite`), per RT-48's transaction rule that `db.transaction()`
  callbacks cannot be async. Exposes `openChatStore(path)` as the explicit-path
  seam so tests never touch the real `state.db`.
- **`lib/daemon/handlers/chat.ts`** — thin typed handlers `chat:join`,
  `chat:leave`, `chat:post`, `chat:read`, `chat:rooms`, `chat:who`,
  `chat:mark`, delegating to the store. Cataloged in
  `packages/rt-client/src/commands.ts` so payload/response drift is a tsc
  error (MAT-31 pattern).
- **`commands/chat.ts`** — the CLI.
- **No sync-exec on the daemon thread** (MAT-222 lesson). The store's
  synchronous SQLite calls are short single-statement operations; nothing in
  the chat path blocks the loop.

**REST + WS.** The daemon's `api-server.ts` on `127.0.0.1:9401` is the
existing dashboard seam and is what the viewer consumes. New rows in
`API_ROUTES`:

| method | path | cmd |
|---|---|---|
| GET | `/api/chat/rooms` | `chat:rooms` |
| GET | `/api/chat/read` | `chat:read` |
| GET | `/api/chat/who` | `chat:who` |
| POST | `/api/chat/post` | `chat:post` |
| POST | `/api/chat/join` | `chat:join` |
| POST | `/api/chat/mark` | `chat:mark` |

**Every mutating chat route is added to `needsToken()`**, alongside
`/api/events/emit`. The server binds `127.0.0.1` but sets CORS `*`; the
`X-RT-Token` header requirement forces a preflight a hostile page cannot
satisfy. Omitting chat from that list would let any page a browser visits
post into rooms that steer agents.

`GET /api/chat/read` is deliberately **not** token-gated, consistent with the
server's "reads are free" policy for local metadata. This is a conscious
acceptance: a local page could read transcripts. The public surface is
protected by deck's gates, and the transcript is not credential material.

## The skill

**One skill, `rt:chat`**, shipped in `skills/` alongside the existing `herdr`
skill and following its shape: a single skill covering an entire CLI surface,
behind a gate.

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
- **A gate**, mirroring the herdr skill: verify the daemon is reachable and
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

Sibling repo, following `board`: Bun server-rendered shell, small React island
for live parts, no database of its own. Registered with deck
(`deck add chat --cmd ... --dir ...`), giving `chat.localhost` immediately and
`chat.m4tthew.dev` when published.

**Request path** — identical local and remote apart from the two gates:

```
browser ──https──► Cloudflare Access (Google sign-in list)
                        │
                   Deck gateway (password)
                        │
                   chat app server ──► daemon :9401 (holds X-RT-Token)
                        │                    │
                        └──── WS ────────────┘  (one subscription, fanned out)
```

**The app server proxies for two factual reasons, not as a policy
preference:**

1. The daemon binds `127.0.0.1`, so a phone cannot reach `:9401` at all.
2. `X-RT-Token` must stay server-side. Handing it to browser JS to let the
   composer post directly would expose it to anything that can read that JS,
   and the CORS-`*` mutation protection depends on the page *not* having it.

**One WS subscription, fanned out.** The daemon's `/ws` is a firehose of every
broadcast type. The app server holds one connection and re-serves chat frames
to N browsers rather than each open tab holding a daemon WS and filtering
client-side.

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

**Three statuses, not two:**

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
| Two waiters armed | Pidfile per `(room, handle)`; the second refuses. Otherwise every message double-wakes. |
| Agent dies holding a waiter | Inherited from `events-bus`: AbortSignal on connection close, with the 240s daemon cap as backstop. `armed_at` goes stale and the viewer shows `deaf`. |
| `last_read_id` > `max(id)` | Clamp down. Same class and cause as the events bus's ahead-cursor clamp (db recreated); without it, a permanent-looking hang. |
| Handle collision | Numeric suffix at join; resolved handle persisted, stable thereafter. |
| Room name typo | `join` prints the member count; `1 member · you are alone here` makes it obvious. Indistinguishable-from-success is the thing being avoided. |
| Agent blocks on `@matt` overnight | Skill convention: `--timeout 15m`, proceed on 124 under a stated assumption, announced in the room. |
| Invalid handle or room name | Rejected at `join` with the reason. Never silently normalized — a silently-renamed handle breaks mention wake in a way nobody can see. |

## Testing

Store tests use an explicit-path seam (`openChatStore(path)`), per RT-48, so
no test opens the real `state.db`. Beyond unit coverage of the store and
handlers, five integration tests carry the product:

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
5. **Token never reaches the browser.** Assert the `X-RT-Token` value appears
   in nothing the app server serves to a client. Cheap, and it is the one
   security property a later refactor could quietly break.

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

1. Store + migration in `state.db`, with the explicit-path seam.
2. Daemon handlers and `rt-client` command catalog entries.
3. `commands/chat.ts` — the seven verbs, with exit codes.
4. Integration tests 1–4 (these gate everything downstream).
5. `skills/chat` and the `Stop` hook.
6. `API_ROUTES` rows and `needsToken()` entries; integration test 5.
7. Web viewer repo; `deck add`.
8. Notifier producer for `@matt`; optional push provider.
9. `deck domain` gates and publish.

Steps 1–5 are usable on their own: agents can coordinate from the CLI before
any web viewer exists.

**This spec decomposes into two implementation plans**, split at that seam:
steps 1–6 in `repo-tools` (store, daemon, CLI, skill, hook, API routes) and
steps 7–9 in the viewer repo. The second plan depends on the first's API
routes being merged, and on nothing else.
