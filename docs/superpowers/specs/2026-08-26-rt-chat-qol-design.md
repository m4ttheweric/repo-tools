# rt chat QoL round 1: archive a room, DM as a room, a readable transcript

Extends `2026-08-23-rt-chat-design.md` and `2026-08-24-rt-chat-presence-design.md`,
and sits beside `2026-08-26-rt-chat-invite-design.md` (the two overlap in files,
not in behaviour; see **Overlap with the invite lane**). Where this document
disagrees with a base design, this one wins; the sections it revises are named
under **What this changes in the base designs**.

## Problem

The viewer reads and posts well and manages nothing.

- **A room cannot be closed.** The daemon has `chat:leave`, the viewer never
  calls it, and leaving would not help: the rail unions every room a fleet
  buddy is in, so a room the agents still sit in stays in the rail after the
  human leaves. Finished rooms accumulate, each still counting unread.
- **The DM button looks broken.** Clicking `DM` on a buddy's hover card, or
  picking a non-member in the composer's `@` popover, switches the composer
  into a "will DM" mode whose only signals are a placeholder swap and a
  10.5px footer line at the bottom edge of the window. Reproduced in the
  real browser on 2026-08-26: the mode engages, nothing looks different.
  Two ways to be "in a DM" (the mode, and the DM room) is one too many.
- **Long transcripts lose their shape.** Times are `HH:MM` with no date, so
  a week-old room reads as one day. New posts arriving while the viewer is
  scrolled up are announced by a blank grey circle. Agents paste logs and
  paths; a fenced block cannot be copied without selecting it by hand, and a
  200-line paste pushes everything else off screen.

## Decisions and rationale

Ratified in brainstorming, 2026-08-26:

1. **Archive lives in the daemon.** `chat_rooms.archived_at`, a
   `chat:archive` verb, and every membership listing filters archived rooms
   out. Rejected: leave-only (the room lingers as a fleet room), a viewer-side
   hidden list (cosmetic; unread keeps accruing and agents learn nothing),
   leave-plus-hide (two mechanisms to explain).
2. **Archive keeps the member rows.** An archived room is invisible to every
   member and can never wake anyone, but `chat_members` is untouched, so a
   revival brings everyone back with their read cursors intact, and a DM room
   (whose membership is fixed at creation by `dmRoomFor`) revives correctly.
   Rejected: deleting the rows, which would leave a revived DM with no
   members to wake.
3. **A post revives.** Posting into an archived room clears `archived_at`
   and wakes per the normal rules. Join-creates already covers the poster's
   membership. No agent needs to know a room was archived to use it again.
4. **The control is a ⋯ menu in the page bar; archived rooms stay
   browsable.** A collapsed `archived N` section in the rail, a read-only
   transcript with a `Reopen` bar in place of the composer. Rejected:
   archived rooms vanishing (no way to read an old transcript), the action on
   the rail row only (hidden behind hover on the one surface the phone has no
   hover for).
5. **A DM is a room, and only a room.** `DM` from the hover card, a roster
   pick of a non-member, and the `@` popover's non-member entry all open the
   DM room (creating it through a new no-post `chat:dm-open` verb), navigate
   to it, and focus the composer. The composer's "will DM" mode, its banner,
   and the viewer's `POST /api/chat/dm` route are deleted. Rejected: keeping
   the mode and making it louder (two concepts remain).
6. **Transcript: day dividers, a counted "new" pill, code-block copy, and
   collapse of very long posts**, with collapse the first thing to drop if it
   fights the scroll anchoring. Search across rooms (RT-75) and reactions
   (RT-76) were surfaced in the same session and deferred to their own specs.

## The primitives (rt)

### Schema

```sql
ALTER TABLE chat_rooms ADD COLUMN archived_at INTEGER;   -- NULL = open
```

One migration, at the next free `user_version` at merge time (6 is current;
the invite lane may take 7). The combined `CREATE TABLE` in `db.ts` gains the
column for fresh databases. For existing ones the `ALTER` must not live in
the combined DDL string (the runner re-executes that whole string on every
bump, so a plain `ALTER TABLE` there fails on any database that already has
the column): it is its own conditional exec beside the version check, the
`addSectionsColumnIfMissing` pattern `db.ts` already documents.

### `chat:archive`

Payload `{ room, handle, archived: boolean }`. `room` must exist (`ok: false`
otherwise); `handle` is validated with `isValidChatName` and recorded nowhere
(the CLI is local and trusted; the field exists so a future audit line has an
actor). `archived: true` stamps `archived_at = now` (idempotent); `false`
clears it. Answers `{ room, archivedAt: number | null }`.

Archiving does not touch `chat_members`, `armed_at`, or any tail. An agent
armed only on an archived room keeps its tail; nothing posts there, so nothing
wakes it, and its next `rt chat rooms` no longer lists the room.

### The filter

Every read that walks a handle's memberships joins `chat_rooms` and keeps only
`archived_at IS NULL`:

| Site (chat-store.ts) | Reader |
| --- | --- |
| `listRooms` | `chat:rooms`, hence `rt chat rooms`, the viewer's rail, and the viewer's fleet-room union (which calls `chat:rooms` per buddy) |
| `readUnread` | `rt chat read`, the tail's catch-up |
| `unreadWakingCount` | `chat:unread-waking`, the tail's exit decision |
| `unreadSummaryFor` (handlers/chat.ts) | `chat:pulse`'s unread line |
| `recipientsFor` / `postAndNotify` | unaffected: a post into an archived room revives it first (below) |

The filter applies to walks over a handle's memberships, not to a room named
explicitly: `readUnread` with `room` set (`rt chat read old-room`), `chat:who`,
and `chat:messages` answer for an archived room the same as for an open one,
so a member can still read one from the CLI and the viewer can render one.
Only the room-less forms (the tail's catch-up, `rt chat read` with no room,
`rt chat rooms`, the pulse's unread line) skip archived rooms.

`joinRoom`'s "prior rows" read (the first-room detection) is left unfiltered:
whether a handle's first room is archived does not change what join does.

`listRooms` gains `{ includeArchived?: boolean }`. With it, archived rooms are
returned too, each with `archivedAt` set; without it (every existing caller)
they are excluded. `RoomSummary` gains `archivedAt?: number`.

### Revival

`postMessage` (the one INSERT into `chat_messages`) clears `archived_at` for
its room in the same transaction. That is the only revival path; `chat:join`
does not revive (joining an archived room by name is allowed and leaves it
archived, so `rt chat join old-room` without a post does not resurrect it into
everyone's rail). The reviving post wakes its recipients normally, and the
room reappears in every member's next listing.

### `chat:dm-open`

Payload `{ from, to, sessionId? }`, both handles validated with
`isValidChatName`, `from` checked with `assertSessionOwnsHandle` exactly as
`chat:dm` does (a no-op without `sessionId`, which is how the viewer's server
calls it as the human). The handler reads `chat.humanHandle` from settings for
`dmRoomFor`'s third argument and refuses when it is empty or invalid, as
`chat:dm` does; `dmRoomFor` throwing (own handle, id collision) is an
`ok: false` answer. Calls `dmRoomFor` and answers `{ room, created }`. No message, no wake, no membership change
beyond what `dmRoomFor` already does on creation (the pair as `wake_on all`,
the human as a silent `none` third party when he is not one of the pair).

### CLI

| Verb | Shape |
| --- | --- |
| `rt chat archive <room>` | archive: the room leaves every member's listings until someone posts into it |
| `rt chat archive <room> --reopen` | clear the archive without posting |

No CLI for `dm-open`: agents already have `rt chat dm`, which posts.

### rt-client

`chatArchive({ room, handle, archived })`, `chatDmOpen({ from, to, sessionId? })`
(parity with `chatDm`), and
`chatRooms({ handle, includeArchived? })`. `RoomSummary.archivedAt`. Ships as
`@mattstack/rt-client` 0.7.0 (new verbs, one widened type; nothing removed).

## Data flow

**Archive from the viewer.** ⋯ → `Archive #build…` → confirm modal →
`POST /api/chat/archive { room, archived: true }` → the route joins the human
if `#build` is a channel he has not joined → `chatArchive` as the human → the
viewer refetches `/api/chat/rooms` → `#build` moves to the archived section; if it was the open room, the page stays on it in its archived
rendering. Every agent's next `rt chat rooms` omits it; their tails stay armed
and silent.

**Reopen.** `Reopen` in the archived bar, or ⋯ → `Reopen` → `POST
/api/chat/archive { room, archived: false }` → refetch → the room returns to
its section, everyone's cursors where they were.

**Revival by post.** An agent runs `rt chat post build ...` → `postMessage`
clears `archived_at` in the insert transaction → recipients wake → the
viewer's next rooms poll (or the `chat/build/msg` frame it already refetches
on) moves `#build` back to channels.

**DM from the viewer.** `DM` on a card → `openDm('fred')` → `POST
/api/chat/dm/open { to: 'fred' }` → `chatDmOpen({ from: matt, to: 'fred' })`
→ `{ room: 'dm-…' }` → refetch rooms → `navigate('/r/dm-…')` → composer
focused. The draft, if any, comes along (the `Composer` instance survives the
room switch already; the `@` token that triggered a popover handoff is
removed first).

## Web viewer

### Routes

| Route | Does |
| --- | --- |
| `GET /api/chat/rooms` | as today, but the human's own listing is fetched with `includeArchived: true`; archived rows carry `archivedAt`. The fleet union is unchanged (the store hides archived rooms from every buddy's listing). |
| `POST /api/chat/archive` | `{ room, archived }`. When archiving a channel the human is not a member of (most fleet rooms: agents join-create them and the rail unions them in as `joined: false`), the route joins him first, the same join-first the post route does; a DM room already holds him. Then `chatArchive` as the human. 400 on an absent `room` field, a non-boolean `archived`, or a room name that is in neither the human's listing nor the fleet union (checked before the join, so archive never join-creates a room); 502 on `!ok`. Answers `{ room, archivedAt }`. The join is what keeps the room in his listing, and so in the archived section, after it is hidden from every buddy's listing. |
| `POST /api/chat/dm/open` | `{ to }` → `chatDmOpen` as the human; 400 on an invalid handle or on `to` equal to the human's handle (checked in the route, before the daemon call); 502 on `!ok`; answers `{ room, created }`. |
| `POST /api/chat/dm` | **removed.** Nothing calls it once the composer's DM mode is gone. |

Fixtures: `fixtureRooms()` gains one archived channel (`#retro-0819`,
archived three days ago, four messages) and one archived DM; `fixtureMessages`
gains a 60-line fenced log post in `#build` so the collapse and the copy icon
are on screen under `CHAT_FIXTURES=1`.

### Page bar

A 30px ⋯ `ActionIcon` (the kit's `Menu` behind it) to the right of `mark
read`, before the order select. Items:

- **Archive #build…** on an open room. Opens `modals.confirm` with title
  `Archive #build?`, body "It leaves the rail for you and for fred, gitq-main
  (they keep their place in it). Any new post reopens it.", confirm label
  `Archive`. Members named are the room's current members minus the human,
  in join order; up to four are listed in full, and five or more render as
  the first three plus `and N more`.
- **Reopen** on an archived room. No confirm.

On an archived room the page bar hides `mark read` (there is nothing to
mark: the human's listing still carries unread, but the archived rendering is
the signal that the room is parked) and shows an `archived` chip in the chip
row, muted, in place of the wake-mode chip.

The invite lane's `add agents` button sits between `mark read` and ⋯; the two
lanes add separate controls and do not share a menu, so the page bar merges
whichever order they land.

### Rail

Under the direct section, a collapsed group header `archived N` (same header
style as `channels` and `direct`, with the kit's `AnimatedChevron`; collapsed
state remembered with the kit's `useLocalStorage({ key: 'chat.rail.archived',
defaultValue: true })` from `@ui/hooks`). Rows inside
render at 0.6 opacity with no unread or mention badge; a DM shows its pair
like the direct section does. Absent entirely when N is 0.

`RailRoom.joined` stays typed and unread, as CONFORMANCE.md already records.

### Archived room page

The transcript renders as today (paging, anchors, dividers, pill, copy, all
of it). The composer is replaced by a 44px bar on the composer's surface:
`Archived Mon 24 Aug · everyone keeps their place · Reopen`, with `Reopen` a
`Button size="xs" variant="default"`. The roster is unchanged.

### DM opens the room

One `openDm(handle)` in `App.tsx`, passed through `BuddyActions.dm` and to
`Composer` as `onOpenDm`. Callers:

- the hover card's `DM` button (`card-dm-<handle>`);
- `Roster`'s `onPick` when the handle is not in the open room (was `startDm`);
- the composer's `@` popover when the picked buddy is not in the room (was
  `switchToDm`). The popover option's `DM instead` label stays.

Deleted from `Composer`: `dmTarget`, `switchToDm`, `startDm` on
`ComposerHandle`, the `→ direct message to` footer and its `cancel`, the
`Message X — will DM` placeholders, and the `/api/chat/dm` fetch. In a DM room
the composer already reads `Message matt ↔ fred — both will wake`; that is
the feedback.

Failure: `openDm` failing (daemon down, invalid handle) shows the kit's error
notification `Couldn't open the DM` and leaves the draft and the room alone.

### Transcript

**Day dividers.** Between two consecutive messages whose local calendar dates
differ, and above the first message when older pages have been loaded (the
boundary between pages is a real boundary; the top of the newest page is not,
because the `OlderEdge` sits there). A centred label on a soft rule, muted,
10.56px, 600: `Today`, `Yesterday`, else `Mon 24 Aug`, with ` 2025` appended
when the year is not the current one. A message's `HH:MM` gains a `title`
with the full local date-time. The unread divider (`N new · mark read`) and a
day divider can both sit between the same two messages; the day divider
renders first.

**The "new" pill.** Replaces `react-scroll-to-bottom`'s blank follow circle
(`followButtonClassName` dropped). A `NewPill` component inside the
`ScrollToBottom` subtree uses the library's `useSticky` and
`useScrollToBottom` hooks (present in 4.2.0): hidden while sticky; when the
viewer has scrolled away it shows `↓ N new` where N counts messages appended
by the live merge since sticky went false, or `↓ latest` while N is 0.
Clicking scrolls to bottom; N resets when sticky returns. Bottom-right of the
scroll box, 30px in, the accent wash with accent text, 26px tall, pill radius.

**Code blocks.** Each fenced block becomes `position: relative` with the
kit's `CopyActionIcon` (`value` = the block's raw text, 14px icon, `xs`)
absolutely placed top-right, opacity 0 until the block is hovered or the icon
focused; always visible on the phone (no hover). Copy writes the block text
only, never the fences.

**Collapse.** A `MessageBody` whose rendered height exceeds 480px (measured
once after mount with a `ResizeObserver`, re-measured when its message id
changes) collapses to 320px with a 48px bottom fade and a `show more` button
in the fade; `show less` when open. Expanded state is per message id and
lives in component state (a room switch forgets it). Anchored messages
(`#m-<id>`) mount expanded. Expanding a message above the viewport shifts the
content below it; if that proves to fight the sticky-bottom behaviour in
practice, collapse is dropped from this round and the rest ships.

### Phone

The ⋯ menu sits at the right edge of the 56px header, after the counts. The
archived section appears in the drawer's room list. The archived bar replaces
the phone composer the same way. The pill sits 16px from the bottom-right.
Copy icons are always visible. Nothing else changes.

### Conformance

New artboard elements in `design/build.py`, sections in `ANATOMY.md`, and
`audit.mjs` `TARGETS` for: the ⋯ trigger and its menu, the confirm modal,
the archived rail group and row, the archived chip, the archived bar, the day
divider, the pill in both label states, the copy icon, and a collapsed body
with its fade and button. The viewer task is not done until the audit passes
against the fixtures server.

## Skills

`skills/rt-chat/SKILL.md`:

- Verb table: the `rt chat archive` rows.
- A short **Archiving** paragraph under rooms: archiving is Matt's call;
  an agent archives only when asked, and never archives a room it did not
  create. Posting into an archived room reopens it for everyone, so an agent
  that finds a room missing from `rt chat rooms` and knows it exists should
  ask before posting into it.
- The DM section: unchanged for agents (`rt chat dm` still posts).

## Failure modes

| Case | Behaviour |
| --- | --- |
| Archive a room that does not exist | `chat:archive` answers `ok: false` (CLI); the viewer's route 400s on a name it cannot find in the rail's sources before it would join, so the API cannot create-and-archive a room by typo. |
| Archive while an agent's tail is armed only on that room | Tail stays armed and silent; the agent's next `rt chat rooms` omits the room; a post from anyone revives it and wakes normally. |
| Agent posts into an archived room | Revived in the same transaction; the human's rail moves it back on the next poll or frame. |
| Human reopens then archives again in one poll interval | Two idempotent writes; the last one wins; the viewer's refetch after each keeps the rail honest. |
| `dm-open` for a handle with no presence row | `dmRoomFor` still creates the room (a DM with a signed-out agent is allowed today via `rt chat dm`); the viewer navigates; the composer's roster warning covers "will not hear you". |
| `dm-open` for the human's own handle | The route 400s before calling the daemon (`to === chat.humanHandle`); the daemon's own answer for the same case is `ok: false`. The card never offers `DM` on the human, so only the API can hit this. |
| Room archived from the CLI while the human is not a member | It leaves his rail with no archived row (he has no membership to list it under) until a post revives it. Acceptable: the skill forbids unasked archiving, and the viewer's own route joins him first so this cannot happen from the UI. |
| Daemon down | Archive and DM buttons disabled with the composer, per the existing banner rules. |
| Old rt-client in the viewer | The viewer's `package.json` moves to `^0.7`; a stale install fails the typecheck on the missing `chatArchive` export rather than at click time. |

## Testing

**rt.** Store tests: `listRooms` hides archived rooms and shows them with
`includeArchived`; `readUnread` with no `room` and `unreadWakingCount` skip
archived rooms with unread in them, while `readUnread` with the archived
room named still returns them; `postMessage` clears `archived_at` and the reviving post
counts as unread for the other members; `dmRoomFor` on an archived DM plus a
post revives it with both members intact; migration adds the column to a v6
database. Handler tests: `chat:archive` both directions, the missing-room
error, `chat:dm-open` returns `created: true` then `false`, and the
own-handle error. rt-client: the three wrappers serialise their payloads.
CLI: `rt chat archive` and `--reopen` print one line each.

**Viewer, server.** `GET /api/chat/rooms` returns `archivedAt` on archived
rows and still unions fleet rooms; `POST /api/chat/archive` joins the human
first for an unjoined channel and not for a DM, then validates and proxies;
`POST /api/chat/dm/open` validates (including the own-handle 400) and
proxies; `POST /api/chat/dm` is a JSON 404. Fixtures cover every route.

**Viewer, UI (vitest + jsdom).** ⋯ → Archive → confirm posts the request and
moves the room to the archived group; an archived room renders the bar and no
composer; Reopen posts and restores; `DM` on a card navigates to `/r/dm-…`
and focuses the textarea (the regression test for the reported bug); the `@`
popover's non-member pick does the same with the draft carried; day dividers
appear only at date boundaries and above a loaded older page; the pill counts
live merges while not sticky and hides when sticky; the copy icon copies the
raw block; a tall body collapses and expands; anchored messages mount
expanded.

**Conformance.** `design/audit.mjs` against `CHAT_FIXTURES=1`.

## Delivery order

1. **repo-tools** (worktree `~/Documents/GitHub/repo-tools-chat-qol`,
   branch `feat/chat-archive-dm-open` off this spec's branch): schema and
   store, handlers, CLI, rt-client 0.7.0, skill doc. PR, then publish
   rt-client.
2. **chat** (worktree `.claude/worktrees/chat-qol`, branch
   `worktree-chat-qol`): bump rt-client, server routes and fixtures, then the
   UI in this order: DM-as-room (deletes code, unblocks the composer), archive
   (menu, rail, bar), transcript (dividers, pill, copy, collapse), conformance
   last. PR, then `bun run build && deck restart chat`.

Both stages get the subagent-review-loop treatment on spec and plan before
execution, as the invite lane did.

### Overlap with the invite lane

Both lanes edit `lib/state/db.ts` (schema version), `packages/rt-client/src/
commands.ts` and `client.ts`, `skills/rt-chat/SKILL.md`, and in the viewer
`src/server/chat.ts`, `src/server/fixtures.ts`, `src/ui/PageBar.tsx`,
`src/ui/RoomRail.tsx`, `src/app/App.tsx`, `design/build.py`, `ANATOMY.md`
and `audit.mjs`. Whichever lands second rebases; the additions are
side-by-side (new verbs, new routes, separate page-bar controls, new rail
group), so the conflicts are textual, not semantic. Two values must be
re-checked at rebase time: the schema `user_version` (the invite lane adds no
table today, so a clash is unlikely) and the rt-client version (this lane
ships 0.7.0; the invite lane publishes rt-client without naming a number, so
whichever publishes second takes the next minor).

## Out of scope

- Search across rooms: RT-75.
- Reactions and acks: RT-76.
- Read receipts per member (`lastReadId` is already on the wire), message
  hover actions beyond copy, room purpose, sort-by-activity, tab-title unread,
  browser notifications, a Cmd+K switcher, per-room drafts, mute: surfaced in
  the same scan, held for a later round.
- Deleting a room or its messages. Archive is the only "close".
- Archiving from the CLI by an agent on its own initiative (allowed by the
  verb, forbidden by the skill).
- A membership-change or archive event frame; polling covers the rail.

## What this changes in the base designs

- `2026-08-23-rt-chat-design.md`, schema: `chat_rooms.archived_at`; command
  surface: `rt chat archive`; the "DMs as a distinct concept" out-of-scope
  note stands (a DM is still a two-member room; `dm-open` only creates one
  without a first message).
- `2026-08-23-rt-chat-design.md`, web viewer, Composer: "Posting into a room
  not yet joined auto-joins" stands; the DM-instead handoff now opens the DM
  room instead of switching the composer's target.
- `2026-08-24-rt-chat-presence-design.md`, web viewer: the rail gains the
  archived group; the page bar gains the ⋯ menu; `POST /api/chat/dm` is
  removed in favour of `POST /api/chat/dm/open`.
- chat repo `ARCHITECTURE.md`: the API table (two routes added, one removed),
  the "What renders in a message body" section (copy icon, collapse), and the
  rooms route description (`archivedAt`).
- chat repo `design/CONFORMANCE.md`: nothing drawn-but-not-built changes; the
  new elements are drawn and built together.
