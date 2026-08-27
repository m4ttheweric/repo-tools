# rt chat invite: rooms from the viewer, agents from herdr panes

Extends `2026-08-23-rt-chat-design.md` and `2026-08-24-rt-chat-presence-design.md`.
Where this document disagrees with either, this one wins; the sections it
revises are named under **What this changes in the base designs**.

Mockups: https://claude.ai/code/artifact/93d55ea7-54c1-4866-9685-bdc3b605661b
(four artboards: the New room form, the standalone PanePicker, the New pane
form inside it, entry points and the returned payload). Their generator lands
in the chat repo's `design/build.py` with the viewer PR.

## Problem

Today a room is assembled by hand: Matt opens every herdr pane he wants in
it, types the sign-in slash command, and pastes a brief into each one. The
viewer can read rooms and post into them but cannot create one, cannot seed
it before anyone arrives, and knows nothing about the panes on the desk. And
an agent told "add you and the agent working on foo into a room so you can
coordinate" has no way to find foo's pane or to get it into the room; it can
only sign itself in and hope.

Two facts of the shipped design shape the fix:

- **Only the agent can make itself listening.** Sign-in plus arming `rt chat
  tail` under `Monitor` happens inside the pane. Nothing outside a pane can
  arm a tail, so "adding an agent" has to end with that pane running the
  join itself.
- **Joining hides history.** `chat:join` seeds the member's cursor at the
  room's `MAX(id)` so a joiner is never woken by the past. A seed message
  posted before an agent joins is therefore invisible to `rt chat read`,
  `--since`, and the tail's catch-up. "All joiners will see it" needs a verb
  that reaches behind the cursor.

herdr is the thing that makes the rest trivial: it knows every pane, which
ones run Claude, each pane's Claude Code session id (the same key the
presence row is stored under), whether the agent is idle, working or blocked
at a prompt, and it can type into a pane. The whole feature is gated on
herdr; without it the new surfaces hide.

## Decisions and rationale

Ratified in brainstorming, 2026-08-26:

1. **Adding a pane to a room types a slash command into it.** The invite
   injects `/chat:join <room>` (plus an optional note) and the agent signs
   in, joins, arms its tail and reads the seed itself. Rejected: a silent
   server-side join on the agent's behalf. The daemon would allow it
   (`chat:join` takes any handle) but the agent would be a member with no
   tail, `idle` at best, and nothing would tell it why it is there.
2. **The seed message is the brief.** One message, posted as the human when
   the room is created, visible in the transcript to anyone who opens the
   room later. A per-pane note is optional and rides the injected command.
3. **The primitives live in rt** (`pane:list`, `chat:invite`, `read --last`),
   called by the viewer through rt-client and by agents through the CLI.
   Rejected: the viewer's server talking to herdr on its own (agents would
   then depend on the viewer being up, and the pane/presence join would be
   done twice), and each caller driving herdr directly (two copies of the
   injection quirks).
4. **The seed reaches a joiner through `rt chat read <room> --last N`**, a
   cursor-independent read over the existing non-mutating `chat:messages`
   verb. Rejected: a `readFrom` parameter on join (daemon change that only
   helps invited joins) and pasting the seed body into every pane (long
   seeds duplicated N times).
5. **The pane picker is a standalone component** that resolves with the
   picked pane rows. The New room form and the room page are its first two
   callers; it carries no invite semantics of its own, so focusing a pane
   from the roster or launching something into a pane can reuse it.
6. **The picker lists only panes running Claude Code.** Shell panes are
   hidden; a Claude pane whose agent never signed in is listed as
   `not signed in` and is invitable, because those are exactly the panes
   the by-hand workflow was for.
7. **A pane can be peeked.** When a session title is not enough to tell two
   panes apart, a row expands to the last lines of that pane's screen
   (herdr `pane.read`), fetched only for that row.
8. **The picker is reachable from the New room form and from an existing
   room's page bar.** Pulling a pane into `#build` later must not mean
   recreating `#build`.
9. **An agent recruiting another agent always confirms first**, through
   `AskUserQuestion` forms: which pane, what room name, what seed. A wrong
   invite derails someone else's turn, and the herdr doorbell hook already
   rings on a form, so the confirmation is cheap for Matt.
10. **The picker can start a pane.** A `new pane` form (directory, cswap
    account, model, effort, optional opening prompt) runs the launch
    sequence `remote-agent.sh` and shepherdr's `spawn-agent.sh` already do
    by hand, and the new pane joins the list as `starting` until Claude is
    idle. That is what lets a whole fleet be assembled from the chat instead
    of one terminal at a time. The verbs live under `rt pane` (list, peek,
    spawn), since they are herdr concerns rt already has helpers for;
    `invite` stays under `rt chat` because it is about a room.

## The primitives (rt)

### The gate

`herdrAvailable()`: the socket at `HERDR_SOCKET_PATH`, else
`~/.config/herdr/herdr.sock`, exists and answers `session.snapshot`. The
daemon runs outside any pane, so the path is configured, never inherited.
Every `pane:*` verb and `chat:invite` answer `{ ok: false, error: "herdr
unavailable" }` when the gate fails; nothing else about their shape changes.
The daemon speaks herdr's newline-delimited JSON directly over the socket,
one connection per call. Socket timeout: 5s for a plain call; for a waiting
call (`agent.wait`, `agent.prompt` with `wait`) the request's own
`timeout_ms` plus a 5s margin, since herdr answers those at, not before,
their budget. No shell-out to `herdr`. The
two process spawns in this feature (`cswap list` for the account roster,
`git` for an unsigned pane's branch) are async `Bun.spawn`s; the base
design's rule that nothing sync-execs on the daemon thread (MAT-222) holds.

Request timeouts: rt-client's default is 15s. `paneSpawn()` passes
`timeoutMs: 90_000` and `chatInvite()` `timeoutMs: 20_000`, and the viewer's
own `fetch` for those routes sets no shorter limit; the daemon's socket idle
timeout (255s) already covers both.

### `pane:list`

`rt pane list [--json]`, rt-client `paneList()`. One row per herdr pane
whose `agent === "claude"`, joined to presence:

```ts
interface ChatPane {
  paneId: string;            // herdr pane_id, e.g. "w7A:pY"
  workspace: string;         // herdr WorkspaceInfo.label
  title?: string;            // terminal_title_stripped, the Claude session title
  cwd?: string;              // foreground_cwd ?? cwd
  repo?: string;             // the presence row's; else the repo index for cwd, via the worktree table for a linked worktree (no git)
  branch?: string;           // the presence row's; else one async `git` spawn for cwd
  agentStatus: "idle" | "working" | "blocked" | "done" | "unknown";
  sessionId?: string;        // agent_session.value, the Claude Code session UUID
  presence?: { handle: string; status: BuddyStatus; rooms: string[] };
}
```

The join is by `sessionId` first (presence rows are keyed on it), then by
`presence.pane === paneId` for a row whose session id herdr does not know.
`presence` is absent for a pane whose agent never signed in. `rooms` is the
handle's membership list (`listRooms`), so a caller can mark "already in
#build" without a second call. Sort order for humans: listening, idle, deaf,
not signed in; within a group, herdr's pane order.

### `pane:peek`

`rt pane peek <pane> [--lines 8]`, rt-client `panePeek()`. Returns
`{ paneId, lines: string[] }`, herdr `pane.read` of the visible screen,
trailing blank lines dropped. Read on demand only; never as part of
`pane:list`.

### `pane:spawn`

`rt pane spawn --cwd <path> [--account <cswap>] [--model <m>] [--effort <e>]
[--prompt <text>] [--workspace <label>]`, rt-client `paneSpawn()`. Starts
Claude in a new herdr tab and returns it as a `ChatPane` once it is usable.

1. Workspace: `--workspace`, else the `chat.herdrWorkspace` setting
   (default `chat`), registered through the settings registry. Create-or-
   reuse by label, mr-board's pattern: `workspace.list`, match the label,
   else `workspace.create` with `--no-focus` semantics.
2. `tab.create` in that workspace with the directory's basename as the
   label, `--no-focus`; the tab's `root_pane` is the pane.
3. `pane.send_input` of `cd <cwd> && <launch>` plus Enter, where launch is
   `cswap run <account> --share-history -- claude [--model m] [--effort e]`
   when an account is given and plain `claude [...]` otherwise. `--account`
   accepts a cswap slot number, email or alias, validated against
   `cswap list` (400-class error when unknown).
4. Poll `agent.get` until herdr registers the agent (the 0.3s to 0.6s lag
   shepherdr documents), then `agent.wait` until `idle`, `done` or
   `blocked`, 60s. `blocked` with "trust" on the visible screen is the
   trust dialog: send Enter and wait again.
5. If `--prompt` was given, `agent.prompt` it and wait for `working`.
6. Return the pane as `pane:list` would list it (`presence` absent,
   `agentStatus` as observed) plus `ready: boolean`. A pane that never
   reached idle within the budget is still returned, `ready: false`, with
   the pane id, so nothing is orphaned silently.

The account roster for callers: `rt pane accounts [--json]` parses
`cswap list` (async spawn) into `{ slot, email, alias?, headroom? }` rows.
No cswap means an empty list and the account field hidden.

### `pane:directories`

`rt pane directories [--q <text>] [--json]`, rt-client `paneDirectories()`.
Suggestions for the New pane form's directory field: every repo the daemon
indexes and every worktree it tracks, as `{ path, repo, branch? }`, filtered
by `q` as a substring of the path. Read from the daemon's own state (the
repo index and the worktree table), no git, so it is cheap enough to call
per keystroke. It exists because rt-client has no `repos:list` or
`worktree:list` catalog entry today and the viewer should not grow one just
to autocomplete a path.

### `chat:invite`

`rt chat invite <pane> --room <room> [--note <text>]`, rt-client
`chatInvite()`. Types the join command into one pane and reports what
happened; it never touches membership.

- Text injected, **one line**: `/chat:join <room>` and, when a note is
  given, ` note from <from>: <note>` appended on the same line with any
  newlines in the note collapsed to spaces. Claude Code dispatches a slash
  command from the first line only, so a second line would turn the whole
  thing into a plain prompt. Nothing else; the brief is in the room.
- `from` is a payload field, never assumed: the CLI sends the session
  file's handle (an agent) or `chat.humanHandle` when the caller is not
  signed in; the viewer's route sends `chat.humanHandle` explicitly. An
  agent's note therefore arrives attributed to that agent, never to Matt.
- Delivery: `agent.get` first. `blocked`: refused, nothing sent. `working`:
  `agent.prompt` without a wait, herdr queues it, result `queued`.
  Otherwise `agent.prompt` with `wait: { until: ["working"], timeout_ms:
  5000 }`; on a stall, one `Enter` keypress (the Claude TUI can absorb the
  bundled Enter into the composer), then one more 5s wait.
- Result: `{ paneId, delivered: "accepted" | "queued" | "refused", reason?:
  string }`. `accepted`: the agent reached `working`. `queued`: it was
  already working, or never showed `working` after the nudge; either way
  no confirmation is possible. `refused`: the pane is `blocked` (herdr will
  not inject into an approval dialog), is not a Claude pane, is the
  caller's own pane, or herdr is unavailable; `reason` says which.
- The caller's own pane: the CLI sends `HERDR_PANE_ID` as `callerPane` in
  the payload (the daemon cannot see the caller's environment); a match is
  refused with `reason: "that is this pane"`.

### `rt chat read <room> --last N`

Shows the newest N messages of a room regardless of the caller's cursor
(`chat:messages`, the verb the viewer already reads with), then advances the
cursor with `chat:mark` (the newest N always include the room's max id, so
mark is exactly what a plain `read` would have done). `--last` and `--since`
are mutually exclusive. Documented in `rt:chat` as the way to catch up on a room you just
joined or were pointed at.

## Data flow

**Create a room from the viewer.** `POST /api/chat/rooms { room, seed?,
wakeOn? }`: the server joins as the human (which creates the room, stamping
`wakeOn` as the room default when given), posts the seed if one was written,
and returns `{ room, seedId? }`. Then `POST /api/chat/invite { room, panes:
[{ paneId, note? }] }` runs `chatInvite` per pane, sequentially, and returns
every result. The client navigates to `/r/<room>` and shows the results on
the transcript's edge line. Members appear as each pane signs in: the room
page refetches `who` for the open room on every `chat/<room>/msg` frame
(today it fetches only on room change), the fleet roster keeps its 5s poll,
and the join skill's first post is a `chat/<room>/msg` frame in every wake
mode, mentions or not.

**Add agents to an existing room.** The room page opens the picker directly
with `disable` marking members and blocked panes, then calls the invite
route with what comes back. Invitees are pointed at the room's newest
messages by `read --last`; the page's hint says to post a fresh brief first
if the room needs one.

**Recruit from a pane.** The agent runs `rt pane list --json`, matches the
request against title, repo, branch, cwd and handle, confirms through a
form, joins the room (signing in first only if it has not), posts the seed
as itself, and runs `rt chat invite` per chosen pane. See Skills.

**Spawn from the picker.** `POST /api/panes { cwd, account?, model?,
effort?, prompt?, workspace? }` runs `paneSpawn` and answers with the
returned `ChatPane` when it is ready (the request stays open for up to the
60s budget; the picker shows the row as `starting` meanwhile and swaps in
the answer). A `ready: false` answer stays listed with its state so Matt can
peek at what happened. Once idle the row is an ordinary pane: selectable,
invitable, `not signed in` until it joins.

## Web viewer

### Routes

| Route | Does |
| --- | --- |
| `GET /api/panes` | `paneList()` as `{ available, panes }`. herdr unavailable is `available: false` with 200, not a 502, so the UI hides both entry points instead of erroring. |
| `GET /api/panes/:id/peek?lines=8` | `panePeek()` as `{ lines }`. |
| `GET /api/panes/accounts` | `paneAccounts()` as `{ accounts }`; empty without cswap. |
| `POST /api/panes` | `{ cwd, account?, model?, effort?, prompt?, workspace? }`; `paneSpawn()`; answers `{ pane, ready }` when the pane is usable or the budget is spent; 400 on a missing cwd or unknown account. |
| `GET /api/panes/directories?q=` | `paneDirectories({ q })` as `{ directories }`: rt's repos and their worktrees, filtered by `q`. |
| `POST /api/chat/rooms` | `{ room, seed?, wakeOn? }`; validates the room name against rt's charset (400); joins as the human, posts the seed; returns `{ room, seedId? }`. |
| `POST /api/chat/invite` | `{ room, panes: [{ paneId, note? }] }`; one `chatInvite` per pane, sequential; returns `{ results: InviteResult[] }` with 200 even when some refused. |

All under `src/server/herdr.ts` and additions to `src/server/chat.ts`,
mounted like `chat`; fixtures for every route so `CHAT_FIXTURES=1` shows the
whole flow.

### PanePicker (standalone)

```ts
// src/ui/PanePicker/
interface PickPanesOptions {
  context?: string;                              // "to invite to #build", shown in the header
  multiple?: boolean;                            // default true
  disable?: (pane: ChatPane) => string | null;   // reason renders inline; null = selectable
  preselected?: string[];                        // paneIds
  allowCreate?: boolean;                         // shows the `new pane` action; default false
}
const pickPanes = usePanePicker();               // (opts) => Promise<ChatPane[] | null>
```

Owns fetching `/api/panes`, the filter (handle, workspace, title, repo,
path), the sort, the per-row peek (fetched when the eye opens), selection,
and, with `allowCreate`, the New pane form. Resolves with the picked
`ChatPane` rows verbatim, `null` on cancel. Carries no invite semantics:
which rows are disabled and why is the caller's `disable`.

**New pane form** (a second view inside the picker, back arrow to the
list): directory (a path input with suggestions from `/api/panes/
directories`, any path accepted), account (from `/api/panes/accounts`,
headroom beside each, hidden when the list is empty), model (defaults to
the newest Claude), effort (optional), workspace (from `chat.herdrWorkspace`,
editable), opening prompt (optional). `Start pane` posts to `/api/panes`,
returns to the list with the new row shown as `starting · selectable when
idle`, and preselects it when the answer comes back `ready`. A `ready:
false` answer keeps the row, unselectable, with its observed state so the
eye can show what the pane is doing.

Row anatomy (see the artboards): a 16px checkbox; the 8px status dot and
handle, or a hollow dot and `not signed in`; the workspace, plus the session
title when it differs from the handle; the caller's reason or the agent
state on the right (`working · queues until its turn ends`); a 22px eye; a
second line `repo · branch` with room tags; the path rendered the way
`Roster.tsx` already does it (real `…/leaf` text, `truncate` as the safety
net, no `direction: rtl`); the peek block inside the row when open. Rows use the `.opt` wash when selected and 0.55 opacity
when disabled.

### New room form

Opened by a 24px `+` beside the count in the rooms rail header. Fields:
room name (with the `#` prefix and the charset hint), seed (a textarea, the
markdown subset hint, "posted as matt · every invitee is told to read it
first"), wake mode (`mention` default, `all` explained as a war room), and
an Agents section listing picked panes, each with an optional note and a
remove control, with a `pick panes` button that launches the picker with
`context` and `disable` set for inviting. Footer: `Create without inviting`
and `Create #<room> · invite N`. Submit order is create, seed, invites, then
close and navigate.

### Room page

`add agents` beside `mark read` in the page bar launches the picker directly
and invites the result. After either flow, the transcript's edge line reads
`invited 2 · assured pane accepted · fred queued (working) · members appear
as they sign in` until the next room change.

### Phone

The form and the picker become full-height drawers with 44px controls, the
existing `Drawer` pattern. Not drawn in this pass.

### Conformance

The four artboards join `design/build.py` as generators; `ANATOMY.md`
gains a "Pane picker" and "New room" section; `audit.mjs` gets `TARGETS` for
the modal shell, the pane row, the checkbox, the peek block and both entry
points. The task is not done until the audit passes against the fixtures
server. CONFORMANCE.md's "focusing a herdr pane from a member row" stays not
built; the picker is the component that will do it.

## Skills

### `/chat:join <room>` (chat plugin, beside `sign-in`)

The text an invite types into a pane, so it must work cold in any pane,
signed in or not:

The command line is `/chat:join <room> [note from <handle>: <text>]`, all
on one line; the skill reads the room as the first word of `$ARGUMENTS` and
the rest as the note.

1. Gate: `rt chat rooms --json`; daemon down means say so and stop.
2. Not signed in: `rt chat sign-in` (which joins the derived repository
   room, so the invitee still lands where its worktree-mates are), then
   `rt chat join <room>`. Already signed in: `rt chat join <room>` alone;
   the handle is kept. Never `sign-in --room <room>` here: an explicit
   `--room` replaces the derived room instead of adding to it.
3. Arm the tail with `Monitor` if it is not running, by the session-start
   hook's own rule.
4. `rt chat read <room> --last 10`: the seed and anything since.
5. Post one line to the room saying what it understood and what it is
   taking, so the viewer shows arrival.
6. Act on the seed plus the note, if any, treating it as coming from the
   handle it names (an agent's note is that agent's request, not Matt's).
   One narration line in the pane, per `rt:chat`.

### Recruiting (new section in `rt:chat`)

The skill's trigger line gains "put you and another agent in a room". For
"add you and the agent working on foo into a room so you can coordinate":

1. `rt pane list --json`. Unavailable: say this needs herdr, stop.
2. Match foo against title, repo, branch, cwd and handle. Exclude this
   pane and panes already in the target room.
3. **Always a form.** One `AskUserQuestion` carrying the candidate panes as
   options (title · repo · status; multi-select), the proposed room name
   (a slug from the topic), and the seed draft (post as drafted, or
   rewrite). A question holds at most four options, so the four best
   matches are the options; when more match, the question text lists the
   rest by pane id and title and `Other` accepts a pane id. No pane is
   touched before the form returns.
4. Sign in only if not already signed in (plain `rt chat sign-in`, which
   keeps the derived repository room), then `rt chat join <room>`, the same
   rule as `/chat:join`; a re-sign-in would rewrite the session file's
   `room` and `sign-in --room` would replace the derived room. Post the
   seed as itself, then `rt chat invite <pane> --room <room> [--note ...]`
   per chosen pane, sequentially.
5. Report one line per pane (`accepted`, `queued, working`, `refused: at a
   prompt`) and the room link. A refused pane is reported, never retried
   blind.

## Failure modes

| Situation | What happens |
| --- | --- |
| rt daemon down | The existing banner; the `+` and `add agents` disable like the composer. |
| herdr socket missing or not answering | every `pane:*` verb and `chat:invite` return `herdr unavailable`; the viewer hides both entry points; the recruiting flow says it needs herdr and stops. |
| Target pane blocked at a prompt | `refused: at a prompt`. The picker already disables it with that reason; a race between listing and inviting surfaces on the edge line. Matt answers the prompt and re-invites. |
| Target agent working | `queued`. The text lands when its turn ends; nothing polls. |
| Enter absorbed by the composer | One nudge, one more wait; still not `working` means `queued`, reported as such. |
| Pane already in the room | Disabled in the picker; the recruiting flow skips it and says so. |
| Seed post fails after the room was created | The room exists with no seed; the form reports the failure and keeps the draft, the same rule the composer follows. |
| Invite fails part-way through a list | Every result is returned; the edge line shows each. Nothing is rolled back; a join is idempotent so re-inviting is safe. |
| Long or short path in the picker | Rendered as `…/leaf` text the way `Roster.tsx` does, so short paths keep their order and long ones still read from the leaf. |
| Spawn: workspace or tab creation fails | `pane:spawn` errors before anything runs; the form shows the herdr error and keeps its values. |
| Spawn: Claude never registers or never reaches idle within 60s | The pane is returned with `ready: false` and its observed state; it stays open in herdr and listed in the picker, unselectable, peekable. Nothing is closed on rt's behalf. |
| Spawn: trust dialog | `blocked` with "trust" on screen is answered with Enter once; any other `blocked` is returned as-is. |
| Spawn: unknown cswap account | Refused before launch (`400`); the account field lists what `cswap list` knows. |
| Spawn: an opening prompt on a pane that only reached `blocked` | Not sent; reported in `ready: false`. |

## Testing

- repo-tools: the herdr NDJSON client against a fake unix socket
  (`Bun.listen`): pane/presence join by session id, the pane-id fallback,
  `blocked` refused, stalled then nudged then accepted, timeout. The spawn
  sequence against the same fake with scripted status transitions:
  registration lag, trust dialog answered once, idle within budget, budget
  exhausted returning `ready: false`, unknown account refused before any
  socket call. The `cswap list` parser on captured output, including the
  no-cswap case. `read --last` at the CLI, cursor advancing, exclusive with
  `--since`. rt-client exports and types, including the `timeoutMs`
  overrides on `paneSpawn()` and `chatInvite()`. `lib/herdr-agent.ts` keeps
  shelling out to the `herdr` CLI (it is the CLI-side bounded-agent helper
  used by `lib/repo-index.ts` and `lib/rebase-escalation.ts`, not the
  daemon); the only change is its `herdr wait ...` calls becoming
  `herdr agent wait ...`, which herdr 0.7.5 renamed, with its test's fake
  `herdr` updated to match.
- chat: route tests with rt-client mocked as `chat.test.ts` does, including
  `available: false` and partial invite results. `PanePicker`: filter, sort,
  caller `disable` reasons, peek fetched only on open, resolve versus cancel,
  `multiple: false`, the `new pane` action hidden without `allowCreate`, the
  form's field visibility with and without accounts, the `starting` row
  swapping in the spawn answer and preselecting on `ready`, a `ready: false`
  row staying unselectable. `NewRoomModal`: submit order, name validation, draft
  kept on failure, result line. Fixtures for every route. `audit.mjs`
  targets for the new components, passing against `CHAT_FIXTURES=1`.
- skills: `/chat:join` and the recruiting flow each get a real run in a
  pane before they are called done; the join run includes a note on the
  command line, since that is the case the one-line dispatch claim exists
  for.

## Delivery order

1. repo-tools: the herdr socket client and gate, `pane:list`, `pane:peek`,
   `pane:spawn`, `pane:accounts`, `pane:directories`, `chat:invite`,
   `read --last`, the `chat.herdrWorkspace` setting, rt-client wrappers
   and types with their `timeoutMs` overrides, the verb table and the
   recruiting section in `rt:chat`, the `herdr agent wait` rename in
   `lib/herdr-agent.ts`. Publish rt-client.
2. chat: routes and fixtures, `PanePicker`, `NewRoomModal`, the two entry
   points, the `who` refetch on `chat/<room>/msg`, the edge line, artboards
   and audit. Starts against fixtures; the final wiring waits on rt-client.
3. mattstack-marketplace: the `chat:join` skill, plus its
   `./skills/join` entry in the plugin's `plugin.json` `skills` array.

## Out of scope

- A membership-change event from `chat:join`. The `who` refetch on
  `chat/<room>/msg` plus the join skill's first post covers arrival; a
  `chat/<room>/member` frame is a one-line follow-up if it lags.
- Moving `lib/herdr-agent.ts` (the CLI-side helper) onto the daemon's
  socket client so there is one spawn implementation. Its callers are not
  chat's; that is a follow-up with its own tests.
- Focusing a herdr pane from the roster and DMing whoever is in a pane:
  future picker callers.
- Provisioning a worktree from the New pane form; the directory must exist
  (`rt worktree provision` stays a CLI step).
- Closing or restarting a spawned pane from the viewer.
- Remote or multi-session herdr (`HERDR_SESSION`); only the default socket.
- Per-pane account or model: herdr does not expose them.
- A standalone `rt chat create` verb; join-creates stands.

## What this changes in the base designs

- `2026-08-23-rt-chat-design.md`, entry points: "by launcher" gains the
  viewer and the recruiting flow as launchers, both through `chat:invite`.
- `2026-08-23-rt-chat-design.md`, reading: `read` gains `--last N`, a
  cursor-independent read that still advances the cursor.
- `2026-08-24-rt-chat-presence-design.md`, web viewer: the viewer gains the
  `/api/panes*` routes and two `POST` routes that create a room and invite
  panes; the "no route addresses a pane by id" note in the chat repo's
  CONFORMANCE.md is now false for the picker and stays true for the roster.
- `skills/rt-chat/SKILL.md`: `rt chat invite` in the verb table, the
  `--last` flag on `read`, a pointer to the new `rt pane` group (`list`,
  `peek`, `spawn`, `accounts`), and the recruiting section.
- `lib/herdr-agent.ts`: only the `herdr wait` to `herdr agent wait` rename.
  `pane:spawn` is a new daemon-side implementation on the socket client;
  the CLI-side helper stays as is until the follow-up above migrates it.
