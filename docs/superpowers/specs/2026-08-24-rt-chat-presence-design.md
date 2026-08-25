# rt chat presence — sign-in, the buddy list, and DMs

Extends `2026-08-23-rt-chat-design.md` (plan 1 shipped as #67). Where the two
disagree, this document wins; the sections it revises are named explicitly
under **What this changes in the base design**.

## Problem

Plan 1 made presence a property of *room membership*: `armed_at`,
`last_seen_at`, `cwd` and `pane` live on `chat_members`, so an agent exists
only inside the rooms it joined, and "which agent stopped listening" is only
answerable one room at a time. Three things follow that the viewer's own
purpose — see who will hear you, reach the one who will — cannot live with:

- An agent that has not joined a room is invisible. There is no way to see
  what is running, and no way to message it.
- A handle is a worktree. Two sessions in the same worktree share a handle,
  the pidfile refuses the second tail, and the second session is silently
  deaf. The roster would show one buddy where two are running.
- Reaching an agent means joining a room it is in, or creating one and
  hoping it joins. There is no "just message deck-main."

The model that fits is the one everyone already knows: **AIM**. You sign on,
you appear on the buddy list with an away message, people IM you, you sign
off. Rooms exist, but they are something you do *from* the list.

## Decisions and rationale

Ratified in brainstorming, 2026-08-24:

1. **Presence is opt-in per session by an explicit act** — `/chat:sign-in`
   (the skill, invocable by Matt or by the agent itself) — never by a
   `SessionStart` hook. The base design's objection to auto-join (agents in
   rooms they did not ask for) stands; sign-in is the honest version of "the
   roster is the fleet you chose to expose." Hooks keep *deets* fresh and
   deliver waiting messages; they never create presence.
2. **A buddy is a session, not a worktree.** The presence row is keyed on the
   Claude Code session id. The handle is the display name; the second session
   in a worktree signs in as `rt-chat-wt-2`. This revises the base design's
   "a collision refuses" rule — see Identity below for why it is now safe.
3. **Sign-in arms the tail *and* the hook delivers unread.** Signed in means
   listening: sign-in ends with the agent arming `rt chat tail` under
   `Monitor`, so a DM is a notification. The `UserPromptSubmit` heartbeat
   *also* injects waiting DMs and mentions as context, which covers the cases
   Monitor cannot: a tail that died, a session resumed after compaction, an
   agent that signed out and was IM'd anyway.
4. **Sign-in joins the cwd's repository room.** Everyone signed in from a
   repository — every slot of a worktree pool, since the identity is per
   repository — is in that repository's room; fan-outs land together without
   a launcher having to say so. The room name is derived under Identity
   (**not** raw `repoLabel()`, which can be mixed-case or a bare pool slot
   name). `--no-room` opts out; a cwd inside no repository joins nothing and
   sign-in says so.
5. **A DM is a room of kind `dm`** with exactly two participants, both
   `wake_on: all` — in a DM everything is addressed to you. Either
   participant may be the human (`rt chat dm matt …` is how an agent asks
   Matt something privately; the post notifies the desk). **In every
   agent↔agent DM the human is also present**: he reads it, posts into it,
   and his post wakes both agents. That presence is stored as an ordinary
   membership row with `wake_on none` — created with the DM, never by
   posting — so his rail, unread and mention badges work through the same
   cursor as everywhere else, while the DM's *participants* stay the two in
   `chat_dms` and `join` refuses DM rooms outright. There are no private
   agent↔agent DMs in this system, by design.
6. **Sign-out is explicit and also automatic on session end.** `/chat:sign-out`
   disarms and marks the row signed out; a `SessionEnd` hook does the same
   best-effort so a closed terminal does not leave a ghost. Room memberships
   persist across sign-out — sign back in and the rooms are still yours.

## The AIM mapping

| AIM | rt chat | |
|---|---|---|
| Sign on | `rt chat sign-in` / `/chat:sign-in` | presence row, `#<repo>` joined, tail armed |
| Buddy list | `rt chat buddies` / the viewer's roster | everyone signed in, with status and deets |
| Away message | `rt chat away <text>` / `/chat:away` | `status_text` on the row; cleared by `rt chat back` |
| Idle (automatic) | signed in with no tail; *deaf* once a tail's own heartbeat is 10 minutes stale | the Statuses table below |
| Direct IM | `rt chat dm <handle> <text>` | two-participant room, created on first use; the human may be a participant |
| Chat room | `rt chat join #room` | unchanged |
| Sign off | `rt chat sign-out` / `/chat:sign-out` | disarm, `signed_out_at`, memberships kept |
| "Door" sound | a desk notification when a buddy signs on | deferred; see Out of scope |

## Identity

The base design's resolution order stays, with one position added in front:

0. **The session's signed-in handle**, read from the session file
   `~/.mattstack/rt/chat/sessions/<session-id>.json`.
1. `--as <handle>` … 6. `<user>-<host>` — unchanged.

Position 0 wins over `--as` for every verb except `sign-in` itself, which
reads its own `--as` *before* writing the file. A signed-in session passing
`--as` to `tail`, `post`, `join` or `read` is refused — *signed in as
`rt-chat-wt-2`; sign out to change* — because a second identity is exactly
the desync the base design refused. The base skill's arm line therefore
changes from `rt chat tail --as <handle>` to bare **`rt chat tail`**: the tail
resolves from the session file, so a tail armed minutes after sign-in cannot
resolve differently from the sign-in that named it. `--session <id>` remains
the documented override for processes without the environment variable.

The session id is the hook payload's `session_id` (documented) and, for the
agent's own Bash calls, the `CLAUDE_CODE_SESSION_ID` environment variable —
present in every session on this machine but **undocumented**, so plan 3's
first task verifies the two are the same value before anything relies on it,
and the CLI keeps `--session <id>` as the documented path. A process with
neither passes `--session`; with no id at all, `sign-in` refuses rather than
inventing one, because a presence row that nothing can heartbeat is a ghost
from birth.

**Why suffixing is safe now.** The base design rejected `-2`/`-3` because
resolution was fully local and only `joinRoom` could see the collision: the
agent would join as `main-2` while its tail armed on `chat/wake/main`. Sign-in
removes both halves of that problem. The *daemon* assigns the suffix (it holds
the live roster, so it knows `rt-chat-wt` is taken by a session that is still
heartbeating) and returns the final handle; the CLI persists it in the session
file; every later verb resolves from that file first. Resolution stays a local
file read — no daemon dependency during an outage, the tail's backoff still
works — and every verb agrees, because they all read the same byte. A base
handle whose previous holder satisfies the reclaim predicate (signed out, or
session heartbeat over an hour old with no live tail — one predicate, under
Failure modes) is reused rather than suffixed, so restarting a session in a
worktree gets its old name back.

The base handle derivation is unchanged: `<repoLabel>-<worktree-dir>` through
the identity codec (RT-62), then the fallbacks. The serialized identity never
reaches a handle.

**The repository room.** `sign-in` first asks whether the cwd is inside a
git work tree at all (`findGitRoot(cwd)`, already in `commands/chat.ts`);
`deriveRepoIdentity` never fails — a scratch directory gets a path-kind
identity of its own realpath — so the work-tree test is what decides "no
room", not the codec. Inside a work tree it derives the identity and names
the room from it, slugified to the room charset:

- **remote-kind** → the last path segment of the identity, lowercased and
  slugified: `remote:gitlab.com%2Facme%2Facme-dev` → `#acme-dev`. Every
  worktree of the repository derives the same identity, so every pool slot
  lands in the same room.
- **path-kind** (a repository with no origin) → the last **two** segments of
  the main worktree's realpath, slugified: `…/acme/gamma` → `#acme-gamma`.
  One segment would be the bare pool-slot name (`gamma`, `main`), the
  cross-repository collision the base design's Identity section spent a page
  eliminating; two segments are unique on the layouts this machine uses.
- **not in a work tree** → no room. Sign-in prints *signed in as <handle>
  · not in a repository · no room joined*. (This is a different predicate
  from handle position 5: a real repository that was never `rt repos add`-ed
  has no index entry — its handle falls through — but a perfectly good
  identity, and gets its room.)
- **remote-kind collisions across hosts or owners** (`github.com/matt/console`
  and `gitlab.com/work/console` both → `#console`) are accepted: one segment
  is what people call the repository, and two unrelated fleets sharing a
  room on one machine is rare enough that `sign-in --room <name>` is the
  escape hatch rather than a longer name for everyone.

`repoLabel()` is for display (`chat_presence.repo`), never for a room name:
it preserves case for remote-kind and returns the slot name for path-kind.

**The session file is the only new local state.** `{ sessionId, handle,
baseHandle, signedInAt, room }`. Sign-out deletes it. A verb that finds a
session file whose session id does not match the current environment ignores
it (a copied `.mattstack`, a resumed session under a new id).

## Data model

Schema v4, same migration runner as v3.

```sql
CREATE TABLE IF NOT EXISTS chat_presence (
  session_id     TEXT PRIMARY KEY,
  handle         TEXT NOT NULL UNIQUE,   -- the assigned display name, suffix included
  base_handle    TEXT NOT NULL,          -- what resolution produced before suffixing
  cwd            TEXT,
  repo           TEXT,                   -- repoLabel of the cwd's identity, for display
  branch         TEXT,
  pane           TEXT,                   -- HERDR_PANE_ID when known
  status_text    TEXT,                   -- the away message; NULL when back
  signed_in_at   INTEGER NOT NULL,
  last_seen_at   INTEGER NOT NULL,       -- SESSION heartbeat: written by pulse (and sign-in)
  tail_seen_at   INTEGER,                -- TAIL heartbeat: written ONLY by chat:touch from the tail loop
  armed_at       INTEGER,                -- set while a tail is live, cleared on exit
  signed_out_at  INTEGER                 -- NULL while signed in
);
CREATE INDEX IF NOT EXISTS chat_presence_handle ON chat_presence(handle);

CREATE TABLE IF NOT EXISTS chat_dms (
  room        TEXT PRIMARY KEY REFERENCES chat_rooms(name),   -- documentation only: foreign_keys is off in applyPragmas; deletion is explicit
  a           TEXT NOT NULL,             -- participants, sorted; either may be the human handle
  b           TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE (a, b)
);
```

**No `ALTER TABLE`.** The shipped runner (`runMigrations` in
`lib/state/db.ts`) replays every version's schema whenever `user_version` is
behind, and is safe only because every statement is `IF NOT EXISTS` — which
SQLite's `ADD COLUMN` is not. A v4 that altered `chat_rooms` would work once
and brick every later `openStateDb()` at the v5 bump with *duplicate column
name*. A DM's kind is therefore the existence of its `chat_dms` row, and
`chat:rooms` reports `kind` by left join.

**Two heartbeats, never one.** The session heartbeat (`last_seen_at`, from
`pulse`) says the *agent* is active; the tail heartbeat (`tail_seen_at`,
from `chat:touch` in the tail loop) says the *listener* is. They must be
separate columns: a tail that dies abnormally leaves `armed_at` set and its
only detector is a stale tail heartbeat, so if the session's per-prompt
pulse refreshed the same column, an active agent with a dead tail would
read *live* forever — the one lie the viewer exists to catch. `pulse` never
touches `tail_seen_at` **or `chat_members.last_seen_at`** — the member
column is the tail heartbeat on the no-presence-row fallback path, and a
pulse writing it would re-create the same lie there; `chat:touch` never
touches `last_seen_at`.

**The shipped `joinRoom` cwd guard is scoped to unsigned handles.** Today
`joinRoom` throws when any membership row for the handle carries a
different `cwd` (*already in use from a different directory — pass `--as`*),
because cwd was the only uniqueness the base design had. Once a presence row
exists for the handle, presence owns uniqueness: `join` (and sign-in's own
auto-join) skips the guard for a handle that is currently signed in, and
memberships from an earlier cwd are simply that session's history — which
is what lets `chat.handle` or `sign-in --as x` be used from a second
worktree without a base-design-era refusal telling the agent to pass the
`--as` position 0 now rejects. For a handle with no presence row the guard
stays exactly as shipped.

**`chat_members` keeps its presence columns, and the two tables are
dual-written.** `chat:arm`, `chat:touch` and `chat:disarm` update the
member rows exactly as today (`chat:touch` → `chat_members.last_seen_at`,
which for a member has always meant the tail) **and** the presence row when
one exists for the handle (`chat:touch` → `tail_seen_at`). Readers (`chat:who`, `chat:buddies`, the viewer) prefer the
presence row and fall back to the member columns, so an agent that arms a
tail without ever signing in — still a legal plan-1 path — renders as armed,
not as never-armed. The startup clear of `armed_at` (base design, Daemon
architecture) clears both tables.

A DM room's **name is an id, not a label**: `dm-` plus the first 12 hex
digits of `sha256(a + "\n" + b)` over the sorted participants. Handles may
contain `.`, so any name built by concatenating them can collide (`x.y`+`z`
and `x`+`y.z`); the hash cannot, and nothing ever parses a room name for
participants — they come from `chat_dms`. The display name (`deck-main ↔
rt-chat-wt`) is rendered from that row. `join` refuses a room that has a
`chat_dms` row (*that is a DM; use `rt chat dm`*), which is what keeps a DM
at two participants — plus the human's `wake_on none` row in agent↔agent
DMs, created together with the room.

## Command surface

Additions to the eight verbs of the base design:

| Verb | Shape |
|---|---|
| `rt chat sign-in [--as <h>] [--status <text>] [--no-room] [--room <name>] [--session <id>]` | presence row (suffix assigned), session file written, the repository room joined unless `--no-room` (`--room` overrides the derived name — the collision escape hatch); prints the assigned handle and the room, then the arm instruction |
| `rt chat sign-out [--session <id>]` | disarm, `signed_out_at`, session file removed; memberships kept |
| `rt chat away <text>` / `rt chat back` | set / clear `status_text` |
| `rt chat buddies [--json]` | the roster: every row with `signed_out_at IS NULL`, plus the last 24h of signed-out rows under *offline* |
| `rt chat who` (no room) | alias of `buddies`; `who <room>` unchanged, now presence-joined |
| `rt chat dm <handle> <text>` | find-or-create the DM room (participants: the caller and `<handle>`, either may be the human), join both `wake_on all` — plus the human `wake_on none` when neither is him — and post with the recipient in the payload's `mentions` (not prepended to the body: the transcript shows the text as typed, and the desk notifies when the recipient is the human) |
| `rt chat pulse [--json]` | **hook-facing**: heartbeat + re-derive deets from cwd + return the unread summary; see Hooks |

`read`, `rooms`, `mark` include DM rooms — for the human too, through his
membership row; `rooms` lists them under a *direct* heading as `deck-main ↔
rt-chat-wt`. `tail` is unchanged: one wake topic per handle, and a DM post is
a wake for the other participant like any mention. `chat:post` gains an
optional `mentions` array merged with the parsed ones, which is how `dm`
addresses without editing the body.

**Output rules** carry over: `sign-in` prints two lines on success (the
identity and the room, then what to do next); `pulse` prints nothing unless
`--json`; `dm` prints nothing.

```
$ rt chat sign-in
signed in as rt-chat-wt-2 · repo-tools · feat/rt-chat · pane 3 · joined #repo-tools (4 members)
arm your tail now: Monitor `rt chat tail`, persistent

$ rt chat buddies
● rt-chat-wt      repo-tools · feat/rt-chat · pane 3   listening     rebasing #67, back in 10
● deck-main       deck · main · pane 1                listening
○ board-fix-auth  board · fix-auth · pane 5           idle 9m
● gitq-main       gitq · main · pane 6                deaf 22m — armed but silent
  offline (last 24h): mr-board-onboard (2h ago)
```

**The human.** Matt is never a presence row (no session to heartbeat); he is
`chat.humanHandle`, as today. He appears in a room's member list with the
`you` badge and no status. In an agent↔agent DM he is present through the
`wake_on none` row created with the room — `who` on a DM renders the two
participants from `chat_dms` and never lists him — and his posts render
inline attributed to `matt`. Posting into a room he has not joined joins it
(base design); a DM he is not a participant of already has his row, so
posting there joins nothing and the DM stays a DM.

## Statuses

The viewer's three statuses gain a fourth, and the roster is what they now
describe:

Everywhere below, "tail heartbeat" means `COALESCE(tail_seen_at,
armed_at)`: the shipped tail arms (step 2) up to one `events:wait` round —
15 seconds, longer under backoff — before its first `chat:touch`, and
arming *is* the tail's first sign of life, so a fresh `armed_at` with a
NULL `tail_seen_at` must read as alive, not fall through the table.

| status | condition |
|---|---|
| **offline** | `signed_out_at` set, or session heartbeat (`last_seen_at`) older than 24 hours (pruned after) |
| **deaf** | `armed_at` set and the tail heartbeat older than 10 minutes — *armed but silent*, the tail died — or **no `armed_at`** and the session heartbeat older than 1 hour while still signed in |
| **live** (listening) | `armed_at` set and the tail heartbeat within 10 minutes |
| **idle** | signed in, session heartbeat within 1 hour, no `armed_at` |

For an **armed** row the tail heartbeat is the sole authority — the session
heartbeat only advances on user prompts (`pulse` runs on
`UserPromptSubmit`), so a long autonomous turn starves it for hours while
the tail touches every 15 seconds; an armed, touching agent is *live* no
matter how old its last prompt is. That is the point of the split.

For a member with no presence row, the member columns stand in
(`chat_members.last_seen_at` is the tail heartbeat there, as in plan 1).

Rows are tested in the order listed and the **first match wins** — the
table is ordered most-stale first, so a signed-in row silent for 30 hours is
*offline*, not *deaf*, and no row can render in two roster sections. `away` is an overlay, not a status: a
`status_text` shows beside whichever status the row has. Deaf remains the
status that earns the viewer its keep; it now also names its cause, since the
presence row knows whether the tail was armed.

## Wake protocol

Unchanged in mechanism — `chat/wake/<handle>` per handle, one tail per
session under Monitor, `events:head` before arming — with two additions:

- **A DM post wakes the other participant unconditionally** (`wake_on all`
  on DM memberships), and a human post into a DM wakes both.
- **The heartbeat delivers what the tail missed.** `pulse` returns
  `{ unread: { dms, mentions, rooms }, status: "live" | "idle" | "deaf" }` —
  `offline` is unreachable from inside `pulse`, which heartbeats its own row
  before computing the status —
  and the hook injects context **iff something is waiting and `status` is
  not `live`** — nothing on the table records what a tail has delivered, so
  the rule is stated in terms of what the table has: a live tail (armed,
  heartbeat within 10 minutes) is trusted to have notified, and any other
  state is not. The catch-up line a tail prints when it arms covers unread
  that arrived before arming. What the agent leaves unread is injected again
  on every following prompt until `read` or `mark` clears it — the same
  message twice is the intended nag, the same *notification* twice is what
  the rule prevents.

## Hooks and the plugin

The skill and hooks ship as one Claude Code plugin, `chat`, in the mattstack
marketplace (the `rt:chat` skill moves there from `repo-tools/skills/`, or
the plugin wraps it — a plan-level choice).

**Skills** (user-invocable as `/chat:<name>`, and description-triggered so an
agent can invoke them on its own when it starts real work on a repository):

- `chat:sign-in` — runs `rt chat sign-in`, then arms the tail under Monitor
  with `persistent: true` (the base skill's single most important line),
  then confirms the assigned handle in one line.
- `chat:sign-out` — `rt chat sign-out`, stops the Monitor.
- `chat:away` — `rt chat away <text>`.
- `rt:chat` — the base skill, **revised**: the entry point becomes *sign in,
  then arm* (today it opens with *join, then arm*); the arm line drops
  `--as` (`rt chat tail`, resolved from the session file); the `who`
  section teaches `buddies` / `who` (roster) and `who <room>` and the four
  statuses (today it says listening/idle/away); a DM section (`dm`, and
  that Matt sees agent↔agent DMs); the gate (`rooms --json`), arm once, read
  is capped, announce before you take, never block on a human, stream-ended
  means re-arm unless you ended it — all kept. The shipped `who` renderer's
  5-minute idle/away split is reconciled to this table in plan 3.

**Hooks** (`hooks/hooks.json` in the plugin):

- `UserPromptSubmit` → `rt chat pulse --json`, only when a session file
  exists for `session_id`. Heartbeats, re-derives `cwd → repo, branch, pane`
  (a `cd` or a branch switch updates the row with no agent effort — branch
  is re-read only when `cwd` changed since the last pulse or the last read
  is older than a minute, so the per-prompt cost is one IPC round trip, not
  a git spawn), and, when the summary says something is waiting and the
  status is not live, returns `additionalContext`: *"2 DMs from deck-main
  and 1 mention in #build are waiting — `rt chat read`."* Nothing otherwise.
  Budget: under 50 ms on the hot path; the hook is synchronous because
  injected context has to be.
- `SessionEnd` → `rt chat sign-out --quiet`. Best effort by the docs' own
  silence: the event fires once per session but which exits trigger it (a
  closed terminal, a crash) is unspecified, which is what the 1h/24h
  staleness rules are for.
- `SessionStart` with `source: resume | compact | fork` → if a session file
  exists, inject *"you are signed in as `<handle>`; if your `rt chat tail`
  Monitor is not running, arm it."* Never on `startup` or `clear`: that
  would be auto-presence.

Hook payloads carry `session_id`, `cwd`, `transcript_path` and
`hook_event_name`; `additionalContext` is in the documented response schema
without a per-event support table, so plan 3 proves it on `UserPromptSubmit`
and `SessionStart` with a fixture before the hook ships. Hooks may be
`async`, but `pulse` is not: injected context must be synchronous.

**What no hook can do** is arm the Monitor — only the agent can call the tool.
Every path above ends by *telling* the agent to arm, which is the same lever
the base skill uses and is reliable in practice.

## Web viewer

Plan 2's third column becomes the **roster**, and "who will hear me" becomes
a fleet question, which is what it always was:

- **Roster pane** — sections *listening*, *idle*, *deaf*, and *offline (last
  24h)* collapsed; each row as the approved member row (handle, status,
  `branch · pane`, path, sub-line, away message), with the rooms the buddy is
  in as small tags. Join order within a section; health indicates, it never
  groups *across* the fleet — the sections are the status the user asked to
  see, not a re-sort of a room.
- **Rail** — rooms as designed, plus a *direct* section listing DMs
  (`deck-main ↔ rt-chat-wt`) with the same unread and mention badges. Opening
  one shows the transcript; the composer posts into it as `matt` and wakes
  both.
- **Page bar** — the status chips count the fleet, not the room, and still
  name handles when a count is two or fewer.
- **Composer `@` picker** — draws from the roster (everyone signed in), not
  only the room's members; picking a buddy who is not in the room offers *DM
  instead*.
- The daemon-down banner supersedes all of it, as designed.

Tasks 5–7 of plan 2 are re-planned against this; Task 0 and Tasks 1–4 are
unaffected.

## Failure modes

- **Ghost sessions.** `SessionEnd` did not fire; the row keeps its handle. The
  heartbeat stops, so the row reads *deaf* after 10 minutes if armed, *idle*
  then *deaf* if not, *offline* after 24 hours; the base handle is reusable by
  a new sign-in after one hour of silence. A ghost costs a wrong status for at
  most an hour, never a refused sign-in.
- **Suffix churn.** A session that restarts would get `-2` if its own
  ghost still held the base. One predicate, used everywhere a handle is
  reused: **the holder is signed out, or its session heartbeat is more than
  an hour old AND its tail heartbeat (`COALESCE(tail_seen_at, armed_at)`,
  absent counting as stale) is more than 10 minutes old.** A live tail is
  never stale, so a working agent deep in an autonomous turn — fresh
  touches, no prompts — cannot be reclaimed out from under its own tail. An idle holder — signed in, not yet armed, heartbeating —
  is *not* reclaimable: two sessions opened in one worktree outside herdr
  share `cwd` and a `NULL` pane, and the second must be suffixed even when it
  arrives before the first has armed its tail, which is the ordinary
  sequence. The same-seat rule only picks *which* reclaimable row to prefer
  (same `cwd` and `pane` → same name back) and never widens the predicate.
  Reclaiming **deletes** the old row (its `session_id` is the primary key and
  its `handle` is UNIQUE, so it cannot be updated into the new session) and
  the new row takes the handle.
- **A reclaimed handle's old owner wakes up.** A session silent for over an
  hour can still hold a valid session file, and its verbs would resolve
  position 0 to a handle another session now owns. So every
  presence-affecting payload (`arm`, `touch`, `disarm`, `pulse`, `away`,
  `sign-out`) carries the session id **where the caller has one** — it stays
  optional, because `arm`/`touch`/`disarm` still serve the unsigned plan-1
  path, and the daemon enforces `handle reclaimed` only when a presence row
  exists for the handle — and refuses a handle it no longer maps to that
  session; the CLI then deletes the
  session file and says *your handle was reclaimed while you were away —
  sign in again* — and on the `pulse` path the hook injects that notice as
  `additionalContext` **regardless of the waiting rule**, since a reclaimed
  handle is otherwise exactly the state the rule stays silent in and the
  agent would never learn. `post`/`read`/`join` stay handle-only, as the base design
  requires; an old owner posting under a reclaimed name is possible in the
  minutes before its next pulse or arm, and accepted. **The tail does not
  swallow the refusal**: shipped code discards `chat:touch` errors
  (`.catch(() => undefined)`), so plan 3 special-cases `handle reclaimed` —
  the tail prints one line (*handle reclaimed — sign in again*) and exits 0,
  Monitor reports the stream ended, and the skill's re-arm rule takes over
  with a fresh sign-in. That is also what keeps "two tails for one handle is
  impossible" true — with one named window: the old tail learns of the
  reclaim on its next `chat:touch`, up to one `TAIL_ROUND_MS` (15s) later,
  and until then it holds the pidfile, so the reclaimer's **first arm may
  bounce once** with exit 3 (*already armed*). That is self-healing — a
  non-zero exit is a stream-ended notification and the skill's re-arm rule
  fires — and plan 3 must not treat the bounce as a bug. A suspended old
  tail (SIGSTOP, a sleeping laptop) can hold the pidfile indefinitely;
  accepted, since the same suspension already defeats plan 1's liveness
  check and resolving it means killing a process we did not start.
- **Pruning.** Rows signed out **more than 24 hours ago**, or whose session
  heartbeat is older than 24 hours, are deleted by the daemon at startup and
  by every `sign-in` — the two moments a handle is about to be needed. Rows
  inside the 24-hour window survive precisely so the roster's *offline (last
  24h)* section has something to show; `buddies` does not show what pruning
  would remove. Pruning is what frees a base handle whose holder never
  signed out.
- **Daemon down.** `sign-in` fails loudly (it needs the roster to assign a
  name) and says so; the skill does not retry blindly. `pulse` fails silently
  and injects nothing. The viewer's banner covers the rest.
- **Two tails for one handle** is now impossible by construction: handles are
  unique per session, and the pidfile is per handle.
- **A resumed session under a new session id** does not match its session
  file and is not signed in; `SessionStart(resume)` injection tells it so.

## Testing

- Store: sign-in assigns a suffix when the base is held by a live row,
  reclaims a stale row in the same seat, reuses a base after an hour of
  silence; sign-out keeps memberships; `buddies` sections, thresholds and
  most-stale-wins; DM find-or-create is keyed on the sorted pair and
  `(x.y, z)` vs `(x, y.z)` are different rooms; `wake_on all` on DM
  memberships; the human's `wake_on none` row exists on an agent↔agent DM
  and not on a DM he is a participant of; `join` refuses a DM room; the
  human's DM post wakes both; `dm matt` notifies the desk; a v5 dry-run
  migration over a v4 database does not throw.
- CLI: the repository-room derivation — remote-kind → last segment
  lowercased and slugified; path-kind → last two segments of the main
  worktree realpath; not in a work tree → no room; `--room` overrides;
  session file written and read first in resolution; `--session` for
  processes without the env; `pulse --json` shape and its status rule —
  waiting + `idle` injects, waiting + `deaf` (armed, tail heartbeat stale,
  session heartbeat fresh) injects, waiting + `live` does not; `pulse` never
  writes `tail_seen_at`; `dm` posts with the recipient in `mentions`;
  `handle reclaimed` deletes the session file.
- e2e: two `rt chat sign-in` from one worktree under different session ids
  yield `x` and `x-2` **whether or not the first has armed yet**, both tails
  arm, a DM to `x-2` wakes only `x-2`; a tail killed with SIGKILL reads
  *deaf* within 10 minutes while its session keeps pulsing; a `SessionEnd`
  sign-out clears `armed_at` and sets `signed_out_at`.
- Hook: `UserPromptSubmit` fixture — one waiting DM, no armed tail → context
  injected; armed tail with a fresh wake → nothing.
- Viewer: roster sections; DM in the rail; picker offering DM for a
  non-member buddy; banner supersedes roster.

## Out of scope

- **Buddy-list subscriptions** (the sign-on "door" sound): notify Matt when a
  named buddy signs in. Returns with the notifier's category work if wanted.
- **Group DMs.** A room is that.
- **Typing indicators, read receipts.**
- **Presence across machines.** Every session is a process on this Mac.
- **Automatic presence** for sessions that never sign in. Deliberate; see
  decision 1.

## Rollout

1. **Plan 3, repo-tools**: schema v4 and the presence store; `sign-in`,
   `sign-out`, `away`/`back`, `buddies`, `dm`, `pulse`; presence-joined
   `who`; DM rooms in `read`/`rooms`/`mark`; the session file in resolution;
   rt-client wrappers for each; the `chat` plugin (skills + hooks).
2. **Plan 2, re-planned Tasks 5–7**: roster pane, DMs in the rail and
   composer, fleet-wide page bar.

Plan 3 is usable on its own: agents sign in, see each other, and IM from the
CLI before the viewer changes.

## What this changes in the base design

- *Identity* — position 0 added; "a collision refuses" replaced by
  daemon-assigned suffixing at sign-in, with the session file as the reason it
  is safe.
- *Data model* — `chat_presence` (two heartbeats) and `chat_dms` (no
  `ALTER`); presence dual-written, read preferring the new table; the
  `joinRoom` cwd guard scoped to unsigned handles; `chat:post` accepts
  `mentions`; presence-affecting payloads carry the session id.
- *Command surface* — seven verbs added.
- *The skill* — entry point 3 (`SessionStart` auto-join) is **rejected**, not
  deferred; sign-in replaces it, and the skill's entry point, arm line and
  status vocabulary change (listed under Hooks and the plugin). `/chat` for
  the human is superseded by the viewer as planned.
- *Identity* (upstream staleness, noted not fixed here) — the base design's
  example handle `rt-repo-tools-chatspec-wt` predates RT-62; the label now
  derives from the identity, so it is `repo-tools-…`.
- *Web viewer* — member list becomes the roster; DMs.
- *Out of scope* — "DMs as a distinct concept" is now in scope with the rule
  above.
