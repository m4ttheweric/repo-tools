# rt chat invite: rooms from the viewer, agents from herdr panes

Extends `2026-08-23-rt-chat-design.md` and `2026-08-24-rt-chat-presence-design.md`.
Where this document disagrees with either, this one wins; the sections it
revises are named under **What this changes in the base designs**.

Mockups: https://claude.ai/code/artifact/93d55ea7-54c1-4866-9685-bdc3b605661b
(three artboards: the New room form, the standalone PanePicker, entry points
and the returned payload). Their generator lands in the chat repo's
`design/build.py` with the viewer PR.

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
3. **The primitives live in rt** (`chat:panes`, `chat:invite`, `read --last`),
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

## The primitives (rt)

### The gate

`herdrAvailable()`: the socket at `HERDR_SOCKET_PATH`, else
`~/.config/herdr/herdr.sock`, exists and answers `session.snapshot`. The
daemon runs outside any pane, so the path is configured, never inherited.
Both new verbs answer `{ ok: false, error: "herdr unavailable" }` when the
gate fails; nothing else about their shape changes. The daemon speaks herdr's
newline-delimited JSON directly over the socket, one connection per call,
5s timeout per call. No shell-out.

### `chat:panes`

`rt chat panes [--json]`, rt-client `chatPanes()`. One row per herdr pane
whose `agent === "claude"`, joined to presence:

```ts
interface ChatPane {
  paneId: string;            // herdr pane_id, e.g. "w7A:pY"
  workspace: string;         // herdr WorkspaceInfo.label
  title?: string;            // terminal_title_stripped, the Claude session title
  cwd?: string;              // foreground_cwd ?? cwd
  repo?: string;             // repoLabel(deriveRepoIdentity(cwd)), as presence derives it
  branch?: string;           // git, as presence derives it
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

### `chat:pane-peek`

`rt chat panes --peek <pane> [--lines 8]`, rt-client `chatPanePeek()`.
Returns `{ paneId, lines: string[] }`, herdr `pane.read` of the visible
screen, trailing blank lines dropped. Read on demand only; never as part of
`chat:panes`.

### `chat:invite`

`rt chat invite <pane> --room <room> [--note <text>]`, rt-client
`chatInvite()`. Types the join command into one pane and reports what
happened; it never touches membership.

- Text injected: `/chat:join <room>`, then, when a note is given, a second
  line `note from <humanHandle>: <note>`. Nothing else; the brief is in the
  room.
- Delivery: herdr `agent.prompt` with `wait: { until: ["working"],
  timeout_ms: 5000 }`. On a stall, one `Enter` keypress (the Claude TUI can
  absorb the bundled Enter into the composer), then one more 5s wait.
- Result: `{ paneId, delivered: "accepted" | "queued" | "refused", reason?:
  string }`. `accepted`: the agent reached `working`. `queued`: the agent was
  already `working`, herdr queued the text and no confirmation is possible.
  `refused`: the pane is `blocked` (herdr will not inject into an approval
  dialog), is not a Claude pane, or herdr is unavailable; `reason` says
  which.
- The pane's own session is refused with `reason: "that is this pane"` when
  the caller runs inside herdr and `HERDR_PANE_ID` matches.

### `rt chat read <room> --last N`

Shows the newest N messages of a room regardless of the caller's cursor
(`chat:messages`, the verb the viewer already reads with), then advances the
cursor exactly as a plain `read` does. `--last` and `--since` are mutually
exclusive. Documented in `rt:chat` as the way to catch up on a room you just
joined or were pointed at.

## Data flow

**Create a room from the viewer.** `POST /api/chat/rooms { room, seed?,
wakeOn? }`: the server joins as the human (which creates the room, stamping
`wakeOn` as the room default when given), posts the seed if one was written,
and returns `{ room, seedId? }`. Then `POST /api/chat/invite { room, panes:
[{ paneId, note? }] }` runs `chatInvite` per pane, sequentially, and returns
every result. The client navigates to `/r/<room>` and shows the results on
the transcript's edge line. Members appear as each pane signs in: the roster
polls every 5s and refetches on wake frames, and the join skill's first post
is a wake frame.

**Add agents to an existing room.** The room page opens the picker directly
with `disable` marking members and blocked panes, then calls the invite
route with what comes back. Invitees are pointed at the room's newest
messages by `read --last`; the page's hint says to post a fresh brief first
if the room needs one.

**Recruit from a pane.** The agent runs `rt chat panes --json`, matches the
request against title, repo, branch, cwd and handle, confirms through a
form, signs itself in with `--room`, posts the seed as itself, and runs
`rt chat invite` per chosen pane. See Skills.

## Web viewer

### Routes

| Route | Does |
| --- | --- |
| `GET /api/herdr/panes` | `chatPanes()` as `{ available, panes }`. herdr unavailable is `available: false` with 200, not a 502, so the UI hides both entry points instead of erroring. |
| `GET /api/herdr/panes/:id/peek?lines=8` | `chatPanePeek()` as `{ lines }`. |
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
}
const pickPanes = usePanePicker();               // (opts) => Promise<ChatPane[] | null>
```

Owns fetching `/api/herdr/panes`, the filter (handle, workspace, title,
repo, path), the sort, the per-row peek (fetched when the eye opens), and
selection. Resolves with the picked `ChatPane` rows verbatim, `null` on
cancel. Carries no invite semantics: which rows are disabled and why is the
caller's `disable`.

Row anatomy (see the artboards): a 16px checkbox; the 8px status dot and
handle, or a hollow dot and `not signed in`; the workspace, plus the session
title when it differs from the handle; the caller's reason or the agent
state on the right (`working · queues until its turn ends`); a 22px eye; a
second line `repo · branch` with room tags; the path, head-truncated with an
LTR-isolated inner run so short paths keep their order; the peek block inside
the row when open. Rows use the `.opt` wash when selected and 0.55 opacity
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

The three artboards join `design/build.py` as generators; `ANATOMY.md`
gains a "Pane picker" and "New room" section; `audit.mjs` gets `TARGETS` for
the modal shell, the pane row, the checkbox, the peek block and both entry
points. The task is not done until the audit passes against the fixtures
server. CONFORMANCE.md's "focusing a herdr pane from a member row" stays not
built; the picker is the component that will do it.

## Skills

### `/chat:join <room>` (chat plugin, beside `sign-in`)

The text an invite types into a pane, so it must work cold in any pane,
signed in or not:

1. Gate: `rt chat rooms --json`; daemon down means say so and stop.
2. `rt chat sign-in --room <room>` (adds the room on an already-signed-in
   session; the handle is kept).
3. Arm the tail with `Monitor` if it is not running, by the session-start
   hook's own rule.
4. `rt chat read <room> --last 10`: the seed and anything since.
5. Post one line to the room saying what it understood and what it is
   taking, so the viewer shows arrival.
6. Act on the seed plus any `note from <human>:` line that arrived with the
   command. One narration line in the pane, per `rt:chat`.

### Recruiting (new section in `rt:chat`)

The skill's trigger line gains "put you and another agent in a room". For
"add you and the agent working on foo into a room so you can coordinate":

1. `rt chat panes --json`. Unavailable: say this needs herdr, stop.
2. Match foo against title, repo, branch, cwd and handle. Exclude this
   pane and panes already in the target room.
3. **Always a form.** One `AskUserQuestion` carrying the candidate panes as
   options (title · repo · status; multi-select), the proposed room name
   (a slug from the topic), and the seed draft (post as drafted, or
   rewrite). No pane is touched before the form returns.
4. `rt chat sign-in --room <room>`, post the seed as itself, then
   `rt chat invite <pane> --room <room> [--note ...]` per chosen pane,
   sequentially.
5. Report one line per pane (`accepted`, `queued, working`, `refused: at a
   prompt`) and the room link. A refused pane is reported, never retried
   blind.

## Failure modes

| Situation | What happens |
| --- | --- |
| rt daemon down | The existing banner; the `+` and `add agents` disable like the composer. |
| herdr socket missing or not answering | `chat:panes` and `chat:invite` return `herdr unavailable`; the viewer hides both entry points; the recruiting flow says it needs herdr and stops. |
| Target pane blocked at a prompt | `refused: at a prompt`. The picker already disables it with that reason; a race between listing and inviting surfaces on the edge line. Matt answers the prompt and re-invites. |
| Target agent working | `queued`. The text lands when its turn ends; nothing polls. |
| Enter absorbed by the composer | One nudge, one more wait; still not `working` means `queued`, reported as such. |
| Pane already in the room | Disabled in the picker; the recruiting flow skips it and says so. |
| Seed post fails after the room was created | The room exists with no seed; the form reports the failure and keeps the draft, the same rule the composer follows. |
| Invite fails part-way through a list | Every result is returned; the edge line shows each. Nothing is rolled back; a join is idempotent so re-inviting is safe. |
| Short path in the picker | The LTR-isolated run keeps segment order; long paths still head-truncate. (Check `Roster.tsx`'s `.path` for the same bidi reorder on short paths while in there.) |

## Testing

- repo-tools: the herdr NDJSON client against a fake unix socket
  (`Bun.listen`): pane/presence join by session id, the pane-id fallback,
  `blocked` refused, stalled then nudged then accepted, timeout. `read
  --last` at the CLI, cursor advancing, exclusive with `--since`. rt-client
  exports and types. `lib/herdr-agent.ts` moves from the removed
  `herdr wait` to `herdr agent wait` (0.8.0), with its test updated.
- chat: route tests with rt-client mocked as `chat.test.ts` does, including
  `available: false` and partial invite results. `PanePicker`: filter, sort,
  caller `disable` reasons, peek fetched only on open, resolve versus cancel,
  `multiple: false`. `NewRoomModal`: submit order, name validation, draft
  kept on failure, result line. Fixtures for every route. `audit.mjs`
  targets for the new components, passing against `CHAT_FIXTURES=1`.
- skills: `/chat:join` and the recruiting flow each get a real run in a
  pane before they are called done.

## Delivery order

1. repo-tools: the herdr client and gate, `chat:panes`, `chat:pane-peek`,
   `chat:invite`, `read --last`, rt-client wrappers and types, the verb
   table and the recruiting section in `rt:chat`, the `herdr wait` fix.
   Publish rt-client.
2. chat: routes and fixtures, `PanePicker`, `NewRoomModal`, the two entry
   points, the edge line, artboards and audit. Starts against fixtures; the
   final wiring waits on rt-client.
3. mattstack-marketplace: the `chat:join` skill.

## Out of scope

- A membership-change event from `chat:join`. Polling plus the join skill's
  first post covers arrival; a `chat/<room>/member` frame is a one-line
  follow-up if it lags.
- Focusing a herdr pane from the roster, DMing whoever is in a pane, or
  launching an agent into a new pane: future picker callers.
- Remote or multi-session herdr (`HERDR_SESSION`); only the default socket.
- Per-pane account or model: herdr does not expose them.
- A standalone `rt chat create` verb; join-creates stands.

## What this changes in the base designs

- `2026-08-23-rt-chat-design.md`, entry points: "by launcher" gains the
  viewer and the recruiting flow as launchers, both through `chat:invite`.
- `2026-08-23-rt-chat-design.md`, reading: `read` gains `--last N`, a
  cursor-independent read that still advances the cursor.
- `2026-08-24-rt-chat-presence-design.md`, web viewer: the viewer gains the
  `/api/herdr/*` routes and two `POST` routes that create a room and invite
  panes; the "no route addresses a pane by id" note in the chat repo's
  CONFORMANCE.md is now false for the picker and stays true for the roster.
- `skills/rt-chat/SKILL.md`: two new verbs in the table (`panes`, `invite`),
  the `--last` flag on `read`, and the recruiting section.
