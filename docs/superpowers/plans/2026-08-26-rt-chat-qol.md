# rt chat QoL round 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Archive a room from the daemon and the viewer, make a DM only ever a room, and make long transcripts readable (day dividers, a counted "new" pill, code-block copy, collapse of tall posts).

**Architecture:** Phase 1 lives in repo-tools: `chat_rooms.archived_at` behind a `chat:archive` verb, every membership walk filtered, a post revives, a no-post `chat:dm-open` verb, both exposed through rt-client 0.7.0 and the CLI. Phase 2 lives in the chat viewer: two routes over the new verbs, the composer's DM mode deleted in favour of navigating to the DM room, a ⋯ menu and an archived rail section, and four transcript additions, each audited against the artboards.

**Tech Stack:** Bun, `bun:sqlite`, `bun:test` (rt); Hono on Bun, React 19, Mantine 9 through mantine-kit's `@ui/*` barrels, vitest + jsdom + Testing Library, `react-scroll-to-bottom` 4.2 (viewer).

**Spec:** `docs/superpowers/specs/2026-08-26-rt-chat-qol-design.md` (this repo). Read it first; every task below argues from it.

## Global Constraints

- Work only in worktrees: rt in `~/Documents/GitHub/repo-tools-chat-qol` (branch `feat/chat-archive-dm-open`, created off `spec/rt-chat-qol` in Task 1), the viewer in `~/Documents/GitHub/chat/.claude/worktrees/chat-qol` (branch `worktree-chat-qol`). Never touch either repo's main checkout.
- Room and handle names match `^[a-z0-9._-]+$` (`isValidChatName`); every new verb validates with it and refuses with a reason.
- rt-client ships as `0.7.0`; the viewer's `package.json` moves to `"@mattstack/rt-client": "^0.7"`.
- Schema bump to `user_version` 7 (6 is current, 5 is reserved). Re-check at rebase time against the invite lane.
- The `ALTER TABLE` for `archived_at` is a conditional exec beside the version check (the `addSectionsColumnIfMissing` pattern), never inside a `V*_SCHEMA` string.
- No em dashes or en dashes in any new code, string, comment, commit message or doc; use `...`, parentheses, or a middle dot `·` where the existing UI already uses one. Existing strings are left as they are.
- Comments only for a constraint the code cannot show. No narration, no history, no reviewer notes.
- Viewer UI: import Mantine components from `@ui/core` in `src/app/**`; files under `src/ui/**` may import `@mantine/core` except `Table`, `TextInput`, `CopyButton`. Icons come from the `@ui/icons` registry by name (`moreHorizontal`, `copy`, `check`, `arrowDown`, `chevronDown`, `hash` all exist).
- Viewer conformance: no UI task is done until its elements are in `design/audit.mjs`'s `TARGETS` and the audit passes against `CHAT_FIXTURES=1` (Task 16).
- Commit after every task, with the repo's imperative one-line style, and end every commit message with the two trailer lines the session uses:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_014DK8caKoMFXhKQHh8Uufsg`.

## File Structure

**Phase 1, repo-tools**

| File | Change |
| --- | --- |
| `lib/state/db.ts` | `archived_at` in `V3_SCHEMA`'s `chat_rooms`; `SCHEMA_VERSION = 7`; `addArchivedAtColumnIfMissing` |
| `lib/state/chat-store.ts` | `RoomSummary.archivedAt`; `archiveRoom`, `roomArchivedAt`; open-membership filter in `listRooms`, `membershipsFor` (room-less), `unreadWakingCount`; revive in `postMessage` |
| `lib/state/index.ts` | export `archiveRoom`, `roomArchivedAt` |
| `lib/daemon/handlers/chat.ts` | `chat:archive`, `chat:dm-open`; `chat:rooms` `includeArchived` |
| `packages/rt-client/src/commands.ts` | the two command types, `chat:rooms` payload, `RoomSummary.archivedAt`, `COMMAND_NAMES` |
| `packages/rt-client/src/client.ts`, `index.ts`, `README.md`, `package.json` | `chatArchive`, `chatDmOpen`, `chatRooms` option; 0.7.0 |
| `commands/chat.ts` | `rt chat archive <room> [--reopen]` |
| `lib/command-tree-def.ts`, `website/docs/reference/chat.mdx` | verb list, `--reopen` flag, regenerated reference |
| `skills/rt-chat/SKILL.md` | verb rows, Archiving paragraph |
| tests | `lib/state/__tests__/{db,chat-store,dm-store}.test.ts`, `lib/daemon/__tests__/chat-handlers.test.ts`, `packages/rt-client/test/client.test.ts`, `commands/__tests__/chat.test.ts` |

**Phase 2, chat**

| File | Change |
| --- | --- |
| `package.json` | rt-client `^0.7` |
| `src/server/chat.ts` | rooms with `includeArchived`; `POST /api/chat/archive`; `POST /api/chat/dm/open`; `/api/chat/dm` removed |
| `src/server/fixtures.ts` | an archived channel, an archived DM, a 60-line code post |
| `src/app/App.tsx` | `openDm`, `archiveRoom`, archived-room rendering, phone ⋯ and archived drawer section |
| `src/ui/buddies-context.tsx` | unchanged shape; `dm` now navigates |
| `src/ui/Composer.tsx` | DM mode deleted; `onOpenDm` prop |
| `src/ui/PageBar.tsx` | ⋯ menu, archived chip, `onArchive` |
| `src/ui/RoomRail.tsx` | archived section |
| `src/ui/ArchivedBar.tsx` (new) | the composer's replacement on an archived room |
| `src/ui/Transcript.tsx` | day dividers, time `title`, `NewPill`, code copy, collapse |
| `src/ui/NewPill.tsx` (new) | the counted follow pill |
| `src/ui/transcript-scroll.module.css` | `.follow` rules removed |
| `design/build.py`, `design/ANATOMY.md`, `design/audit.mjs`, `design/spec.json` | artboard elements, anatomy, `TARGETS` |
| `ARCHITECTURE.md` | API table, message-body section |
| tests | `src/server/chat.test.ts`, `src/ui/{Composer,PageBar,RoomRail,Transcript,ArchivedBar}.test.tsx`, `src/app/App.test.tsx` |

---

# Phase 1: repo-tools

Every command in this phase runs from `/Users/matt/Documents/GitHub/repo-tools-chat-qol`. Run `bun install` once after creating the branch (the `postinstall` builds rt-client's `dist/`, which `packages/rt-client/test/dist-freshness.test.ts` compares against).

### Task 1: Schema: `chat_rooms.archived_at`

**Files:**
- Modify: `lib/state/db.ts:24-25` (`SCHEMA_VERSION`), the `V3_SCHEMA` `chat_rooms` block (around line 173), `addSectionsColumnIfMissing` (line 262), `runMigrations` (line 403)
- Test: `lib/state/__tests__/db.test.ts`

**Interfaces:**
- Produces: column `chat_rooms.archived_at INTEGER` (NULL = open) on fresh and migrated databases; `SCHEMA_VERSION === 7`.

- [ ] **Step 1: Create the implementation branch in the worktree**

```bash
cd /Users/matt/Documents/GitHub/repo-tools-chat-qol
git switch -c feat/chat-archive-dm-open
bun install
```

- [ ] **Step 2: Write the failing tests**

In `lib/state/__tests__/db.test.ts`, every assertion that pins the schema version moves to 7. There are four: line 79 `expect(SCHEMA_VERSION).toBe(6);` (its test title becomes `"a fresh database reaches v7 directly, gaining every v1, v2, v3, v4, v6 and v7 change (v5 is reserved by another lane)"`), line 98 `toMatchObject({ user_version: 6 })`, line 164 `expect(userVersion(db)).toBe(6)` inside the `describe` at 158-159 (retitle that describe and its test from `migrates to v6` to `migrates to v7`), and line 421 `expect(before).toBe(6)`. Search the file for `toBe(6)` and `version: 6` once more before moving on. Then add, inside `describe("openStateDb — replay over an older user_version", ...)`:

```ts
  test("v7 adds chat_rooms.archived_at to a v6 database without touching its rows", () => {
    const dbPath = join(dir, "state.db");
    const db = openStateDb(dbPath, "cli");
    db.exec("INSERT INTO chat_rooms (name, created_at) VALUES ('build', 1);");
    // A real v6 file has no such column; SQLite >= 3.35 can drop one, which is
    // what makes this fixture honest rather than a fresh v7 relabelled.
    db.exec("ALTER TABLE chat_rooms DROP COLUMN archived_at;");
    db.exec("PRAGMA user_version = 6;");
    db.close();

    const migrated = openStateDb(dbPath, "cli");
    expect(userVersion(migrated)).toBe(7);
    const columns = (migrated.query("PRAGMA table_info(chat_rooms);").all() as { name: string }[]).map(c => c.name);
    expect(columns).toContain("archived_at");
    expect(migrated.query("SELECT name, archived_at FROM chat_rooms;").all()).toEqual([{ name: "build", archived_at: null }]);
    migrated.close();

    expect(() => openStateDb(dbPath, "cli").close()).not.toThrow();
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test lib/state/__tests__/db.test.ts`
Expected: FAIL: `expect(SCHEMA_VERSION).toBe(7)` receives 6; the new test fails on `DROP COLUMN archived_at` (no such column).

- [ ] **Step 4: Implement the schema change**

In `lib/state/db.ts`:

```ts
/** PRAGMA user_version target for the combined schema below (v1 + v2 + v3 + v4 + v6 + v7; v5 is reserved by another lane). */
export const SCHEMA_VERSION = 7;
```

In `V3_SCHEMA`, the `chat_rooms` table becomes:

```sql
CREATE TABLE IF NOT EXISTS chat_rooms (
  name        TEXT PRIMARY KEY,
  purpose     TEXT,
  created_at  INTEGER NOT NULL,
  archived_at INTEGER                 -- NULL while open; every membership walk skips a stamped room; a post clears it
);
```

Directly under `addSectionsColumnIfMissing`:

```ts
/** chat_rooms.archived_at (v7): the same conditional-exec rule as `sections`
    above, because the DDL string replays on every bump. */
function addArchivedAtColumnIfMissing(db: Database): void {
  const columns = db.query("PRAGMA table_info(chat_rooms);").all() as { name: string }[];
  if (columns.some((c) => c.name === "archived_at")) return;
  db.exec("ALTER TABLE chat_rooms ADD COLUMN archived_at INTEGER;");
}
```

In `runMigrations`, directly after `addSectionsColumnIfMissing(db);`:

```ts
      addArchivedAtColumnIfMissing(db);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test lib/state/__tests__/db.test.ts`
Expected: PASS, all tests in the file.

- [ ] **Step 6: Commit**

```bash
git add lib/state/db.ts lib/state/__tests__/db.test.ts
git commit -m "state: chat_rooms.archived_at, schema v7"
```

### Task 2: Store: archive, filter, revive

**Files:**
- Modify: `lib/state/chat-store.ts` (types at 36-42, SQL constants at 110-140, `listRooms` 234-249, `membershipsFor` 350-360, `postMessage` 409-424, `unreadWakingCount` 485-489)
- Modify: `lib/state/index.ts:97-120`
- Test: `lib/state/__tests__/chat-store.test.ts`, `lib/state/__tests__/dm-store.test.ts`

**Interfaces:**
- Produces:
  - `RoomSummary.archivedAt?: number` (set only on archived rows returned with `includeArchived`).
  - `archiveRoom(room: string, archived: boolean, db?: Database): { room: string; archivedAt: number | null }`; throws `chat: no such room "<room>"` when the row is absent.
  - `roomArchivedAt(room: string, db?: Database): number | null | undefined` (undefined: no such room).
  - `listRooms(handle: string, db?: Database, opts?: { includeArchived?: boolean }): RoomSummary[]`.
- Consumes: Task 1's column.

- [ ] **Step 1: Write the failing store tests**

Append to `lib/state/__tests__/chat-store.test.ts` (add `archiveRoom`, `roomArchivedAt` to the import list from `../chat-store.ts`):

```ts
test("archive hides a room from every membership walk and keeps the member rows", () => {
  const db = freshDb();
  joinRoom({ room: "build", handle: "a" }, db);
  joinRoom({ room: "build", handle: "b" }, db);
  joinRoom({ room: "other", handle: "b" }, db);
  postMessage({ room: "build", handle: "a", body: "@b look" }, db);

  const stamped = archiveRoom("build", true, db);
  expect(stamped.room).toBe("build");
  expect(typeof stamped.archivedAt).toBe("number");
  expect(roomArchivedAt("build", db)).toBe(stamped.archivedAt);

  expect(listRooms("b", db).map(r => r.room)).toEqual(["other"]);
  expect(listRooms("b", db, { includeArchived: true }).map(r => [r.room, r.archivedAt !== undefined])).toEqual([["build", true], ["other", false]]);
  expect(unreadWakingCount("b", db)).toEqual([]);
  expect(readUnread({ handle: "b", limit: 20 }, db)).toEqual([]);
  expect(listMembers("build", db).map(m => m.handle)).toEqual(["a", "b"]);
});

test("a room named explicitly still answers while archived", () => {
  const db = freshDb();
  joinRoom({ room: "build", handle: "a" }, db);
  joinRoom({ room: "build", handle: "b" }, db);
  postMessage({ room: "build", handle: "a", body: "hi" }, db);
  archiveRoom("build", true, db);
  const read = readUnread({ handle: "b", room: "build", limit: 20 }, db);
  expect(read).toHaveLength(1);
  expect(read[0]!.messages.map(m => m.body)).toEqual(["hi"]);
  expect(listMessages({ room: "build", limit: 20 }, db)).toHaveLength(1);
});

test("a post into an archived room revives it and wakes the members who were there", () => {
  const db = freshDb();
  joinRoom({ room: "build", handle: "a" }, db);
  joinRoom({ room: "build", handle: "b", wakeOn: "all" }, db);
  archiveRoom("build", true, db);
  expect(listRooms("a", db)).toEqual([]);

  const posted = postMessage({ room: "build", handle: "a", body: "back to it" }, db)!;
  expect(posted.recipients).toEqual(["b"]);
  expect(roomArchivedAt("build", db)).toBeNull();
  expect(listRooms("a", db).map(r => r.room)).toEqual(["build"]);
  expect(listRooms("b", db).map(r => [r.room, r.unread])).toEqual([["build", 1]]);
});

test("archive refuses a room that does not exist, reopen clears the stamp, and both are idempotent", () => {
  const db = freshDb();
  expect(() => archiveRoom("nope", true, db)).toThrow(/no such room/);
  expect(roomArchivedAt("nope", db)).toBeUndefined();
  joinRoom({ room: "build", handle: "a" }, db);
  const first = archiveRoom("build", true, db).archivedAt;
  expect(archiveRoom("build", true, db).archivedAt).toBe(first);
  expect(archiveRoom("build", false, db)).toEqual({ room: "build", archivedAt: null });
  expect(archiveRoom("build", false, db)).toEqual({ room: "build", archivedAt: null });
  expect(listRooms("a", db).map(r => r.room)).toEqual(["build"]);
});

test("join by name does not revive an archived room", () => {
  const db = freshDb();
  joinRoom({ room: "build", handle: "a" }, db);
  archiveRoom("build", true, db);
  joinRoom({ room: "build", handle: "c" }, db);
  expect(roomArchivedAt("build", db)).not.toBeNull();
  expect(listRooms("c", db)).toEqual([]);
});
```

Append to `lib/state/__tests__/dm-store.test.ts` (add `archiveRoom, listRooms` to the chat-store import):

```ts
test("an archived DM revives on the next dm post with both participants and the silent human intact", () => {
  const db = fresh();
  const { room } = dmRoomFor("a", "b", "matt", db);
  archiveRoom(room, true, db);
  expect(listRooms("a", db)).toEqual([]);
  expect(listRooms("matt", db)).toEqual([]);
  const posted = postMessage({ room, handle: "a", body: "still there?", mentions: ["b"] }, db)!;
  expect(posted.recipients).toEqual(["b"]);
  expect(listRooms("a", db).map(r => r.room)).toEqual([room]);
  expect(listMembers(room, db).map(m => m.handle).sort()).toEqual(["a", "b", "matt"]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test lib/state/__tests__/chat-store.test.ts lib/state/__tests__/dm-store.test.ts`
Expected: FAIL with `archiveRoom is not a function` (export missing).

- [ ] **Step 3: Implement the store changes**

In `lib/state/chat-store.ts`:

1. `RoomSummary` gains one field:

```ts
export interface RoomSummary {
  room: string;
  memberCount: number;
  unread: number;
  mentions: number;
  lastPostedAt?: number;
  /** Set only when the caller asked for archived rooms; absent on an open room. */
  archivedAt?: number;
}
```

2. Beside `MemberRow`, the joined row shape:

```ts
interface MembershipRow extends MemberRow {
  archived_at: number | null;
}
```

3. New SQL constants, next to `SELECT_HANDLE_MEMBERSHIPS_SQL`:

```ts
const SELECT_HANDLE_MEMBERSHIPS_WITH_ROOM_SQL = `SELECT ${MEMBER_COLUMNS}, archived_at FROM chat_members JOIN chat_rooms ON chat_rooms.name = chat_members.room WHERE handle = ? ORDER BY room;`;
const SELECT_ROOM_ARCHIVED_SQL = `SELECT archived_at FROM chat_rooms WHERE name = ?;`;
const UPDATE_ROOM_ARCHIVED_SQL = `UPDATE chat_rooms SET archived_at = ? WHERE name = ?;`;
const REVIVE_ROOM_SQL = `UPDATE chat_rooms SET archived_at = NULL WHERE name = ? AND archived_at IS NOT NULL;`;
```

4. A helper directly above `listRooms`:

```ts
/** A handle's memberships in rooms that are not archived: the rows every
    room-less walk (rooms, read, the tail's catch-up, the pulse line) is
    allowed to see. An explicit room bypasses this on purpose. */
function openMembershipsFor(handle: string, db: Database): MembershipRow[] {
  const rows = db.query(SELECT_HANDLE_MEMBERSHIPS_WITH_ROOM_SQL).all(handle) as MembershipRow[];
  return rows.filter((r) => r.archived_at === null);
}
```

5. `listRooms` becomes:

```ts
export function listRooms(
  handle: string,
  db: Database = getStateDb(),
  opts: { includeArchived?: boolean } = {},
): RoomSummary[] {
  const all = db.query(SELECT_HANDLE_MEMBERSHIPS_WITH_ROOM_SQL).all(handle) as MembershipRow[];
  const rows = opts.includeArchived ? all : all.filter((r) => r.archived_at === null);
  return rows.map((row) => {
    const memberCount = (db.query(SELECT_ROOM_MEMBER_COUNT_SQL).get(row.room) as { n: number }).n;
    const unread = (db.query(SELECT_ROOM_UNREAD_SQL).get(row.room, row.last_read_id) as { n: number }).n;
    const mentions = (
      db.query(SELECT_ROOM_UNREAD_MENTIONS_SQL).get(row.room, row.last_read_id, `%"${escapeLike(handle)}"%`) as { n: number }
    ).n;
    const lastPosted = (db.query(SELECT_ROOM_LAST_POSTED_SQL).get(row.room) as { lastPostedAt: number | null }).lastPostedAt;

    const summary: RoomSummary = { room: row.room, memberCount, unread, mentions };
    if (lastPosted !== null) summary.lastPostedAt = lastPosted;
    if (row.archived_at !== null) summary.archivedAt = row.archived_at;
    return summary;
  });
}

export function roomArchivedAt(room: string, db: Database = getStateDb()): number | null | undefined {
  const row = db.query(SELECT_ROOM_ARCHIVED_SQL).get(room) as { archived_at: number | null } | null;
  return row ? row.archived_at : undefined;
}

export function archiveRoom(
  room: string,
  archived: boolean,
  db: Database = getStateDb(),
): { room: string; archivedAt: number | null } {
  const run = db.transaction((): { room: string; archivedAt: number | null } => {
    const current = roomArchivedAt(room, db);
    if (current === undefined) throw new Error(`chat: no such room "${room}"`);
    if (!archived) {
      db.query(UPDATE_ROOM_ARCHIVED_SQL).run(null, room);
      return { room, archivedAt: null };
    }
    const archivedAt = current ?? Date.now();
    if (current === null) db.query(UPDATE_ROOM_ARCHIVED_SQL).run(archivedAt, room);
    return { room, archivedAt };
  });
  return run();
}
```

6. `membershipsFor`'s room-less branch uses the open rows:

```ts
function membershipsFor(handle: string, room: string | undefined, db: Database): MemberRow[] {
  if (room) {
    const row = db.query(SELECT_ROOM_MEMBER_SQL).get(room, handle) as MemberRow | null;
    return row ? [row] : [];
  }
  return openMembershipsFor(handle, db);
}
```

7. `postMessage`'s transaction revives first:

```ts
  const run = db.transaction((): { id: number; recipients: string[] } => {
    const now = Date.now();
    db.query(REVIVE_ROOM_SQL).run(room);
    const result = db.query(INSERT_MESSAGE_SQL).run(room, handle, body, JSON.stringify(mentions), null, now);
    const recipients = recipientsFor(room, handle, mentions, db);
    return { id: Number(result.lastInsertRowid), recipients };
  });
```

8. `unreadWakingCount`'s first line becomes:

```ts
  const members = openMembershipsFor(handle, db);
```

`joinRoom`'s `priorRows` read and `markRead` keep `SELECT_HANDLE_MEMBERSHIPS_SQL` / `membershipsFor` as they are (`markRead` with no room now walks open rooms through `membershipsFor`, which is fine: marking an archived room read is not a behaviour anyone can observe).

In `lib/state/index.ts`, add `archiveRoom,` and `roomArchivedAt,` to the `./chat-store.ts` export block (after `listRooms,`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test lib/state`
Expected: PASS, every store suite.

- [ ] **Step 5: Commit**

```bash
git add lib/state/chat-store.ts lib/state/index.ts lib/state/__tests__/chat-store.test.ts lib/state/__tests__/dm-store.test.ts
git commit -m "chat-store: archiveRoom, open-membership walks, a post revives"
```

### Task 3: Daemon handlers `chat:archive`, `chat:dm-open`, `chat:rooms includeArchived`

**Files:**
- Modify: `packages/rt-client/src/commands.ts:113-124` (`RoomSummary`), `:251-279` (`Commands`), `:297-316` (`COMMAND_NAMES`)
- Modify: `lib/daemon/handlers/chat.ts:7-37` (imports), `:46-65` (`CHAT_COMMANDS`), the `chat:rooms` handler (181-189), the end of the handler map
- Test: `lib/daemon/__tests__/chat-handlers.test.ts`

**Interfaces:**
- Produces: daemon verbs
  - `chat:archive` payload `{ room: string; handle: string; archived: boolean }` → `{ room: string; archivedAt: number | null }`
  - `chat:dm-open` payload `{ from: string; to: string; sessionId?: string }` → `{ room: string; created: boolean }`
  - `chat:rooms` payload `{ handle: string; includeArchived?: boolean }`; rows carry `archivedAt?: number`.
- Consumes: Task 2's `archiveRoom`, `listRooms(handle, db, { includeArchived })`, `dmRoomFor`.

- [ ] **Step 1: Write the failing handler tests**

Append to `lib/daemon/__tests__/chat-handlers.test.ts`:

```ts
test("chat:archive hides the room from chat:rooms until includeArchived asks, and reopen restores it", async () => {
  const h = freshHandlers();
  await h["chat:join"]({ room: "build", handle: "a" });
  const res = await h["chat:archive"]({ room: "build", handle: "a", archived: true });
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error("unreachable");
  expect(res.data.room).toBe("build");
  expect(typeof res.data.archivedAt).toBe("number");

  const hidden = await h["chat:rooms"]({ handle: "a" });
  if (!hidden.ok) throw new Error("unreachable");
  expect(hidden.data.rooms).toEqual([]);

  const shown = await h["chat:rooms"]({ handle: "a", includeArchived: true });
  if (!shown.ok) throw new Error("unreachable");
  expect(shown.data.rooms).toHaveLength(1);
  expect(shown.data.rooms[0]).toMatchObject({ room: "build", archivedAt: res.data.archivedAt });

  const reopened = await h["chat:archive"]({ room: "build", handle: "a", archived: false });
  if (!reopened.ok) throw new Error("unreachable");
  expect(reopened.data).toEqual({ room: "build", archivedAt: null });
  const back = await h["chat:rooms"]({ handle: "a" });
  if (!back.ok) throw new Error("unreachable");
  expect(back.data.rooms.map((r) => r.room)).toEqual(["build"]);
});

test("chat:archive refuses an unknown room and an invalid name with a reason", async () => {
  const h = freshHandlers();
  const missing = await h["chat:archive"]({ room: "nope", handle: "a", archived: true });
  expect(missing.ok).toBe(false);
  if (missing.ok) throw new Error("unreachable");
  expect(missing.error).toContain("no such room");
  const bad = await h["chat:archive"]({ room: "Has@Sigil", handle: "a", archived: true });
  expect(bad.ok).toBe(false);
  if (bad.ok) throw new Error("unreachable");
  expect(bad.error).toContain("room");
});

test("chat:dm-open creates the pair's room without posting, then reuses it", async () => {
  const emitted: string[] = [];
  const h = freshHandlers((topic) => { emitted.push(topic); return 0; });
  const first = await h["chat:dm-open"]({ from: "matt", to: "a" });
  expect(first.ok).toBe(true);
  if (!first.ok) throw new Error("unreachable");
  expect(first.data.created).toBe(true);
  expect(first.data.room).toMatch(/^dm-/);
  expect(emitted).toEqual([]);

  const again = await h["chat:dm-open"]({ from: "matt", to: "a" });
  if (!again.ok) throw new Error("unreachable");
  expect(again.data).toEqual({ room: first.data.room, created: false });

  const messages = await h["chat:messages"]({ room: first.data.room });
  if (!messages.ok) throw new Error("unreachable");
  expect(messages.data.messages).toEqual([]);
  const who = await h["chat:who"]({ room: first.data.room });
  if (!who.ok) throw new Error("unreachable");
  expect(who.data.members.map((m) => m.handle).sort()).toEqual(["a", "matt"]);
});

test("chat:dm-open refuses a self DM, an invalid handle, and an empty humanHandle setting", async () => {
  const h = freshHandlers();
  const self = await h["chat:dm-open"]({ from: "matt", to: "matt" });
  expect(self.ok).toBe(false);
  if (self.ok) throw new Error("unreachable");
  expect(self.error).toMatch(/your own/i);

  const bad = await h["chat:dm-open"]({ from: "matt", to: "a:b" });
  expect(bad.ok).toBe(false);

  setSetting("chat.humanHandle", "", "user");
  try {
    const empty = await h["chat:dm-open"]({ from: "matt", to: "a" });
    expect(empty.ok).toBe(false);
    if (empty.ok) throw new Error("unreachable");
    expect(empty.error).toContain("chat.humanHandle");
  } finally {
    setSetting("chat.humanHandle", "matt", "user");
  }
});

test("chat:dm-open refuses a reclaimed sender the same way chat:dm does", async () => {
  // Same setup as `chat:dm refuses a reclaimed sender` (line 325): the
  // first session goes stale, a second session claims the handle, and the
  // stale session's own id no longer owns it.
  const h = freshHandlers();
  await h["chat:sign-in"]({ sessionId: "s1", baseHandle: "a" });
  h.db.run("UPDATE chat_presence SET last_seen_at = last_seen_at - 7200000");
  await h["chat:sign-in"]({ sessionId: "s2", baseHandle: "a" });
  const res = await h["chat:dm-open"]({ from: "a", to: "b", sessionId: "s1" });
  expect(res.ok).toBe(false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test lib/daemon/__tests__/chat-handlers.test.ts`
Expected: FAIL, type errors on `h["chat:archive"]` / `h["chat:dm-open"]` (not a function).

- [ ] **Step 3: Add the command types**

In `packages/rt-client/src/commands.ts`:

`RoomSummary` gains, after `defaultWake`:

```ts
  /** Set only when chat:rooms was asked for archived rooms; absent on an open room. */
  archivedAt?: number;
```

In `Commands`, replace the `chat:rooms` line and add two entries after `chat:dm`:

```ts
  "chat:rooms": { payload: { handle: string; includeArchived?: boolean }; data: { rooms: RoomSummary[] } };
```

```ts
  "chat:archive": { payload: { room: string; handle: string; archived: boolean }; data: { room: string; archivedAt: number | null } };
  "chat:dm-open": { payload: { from: string; to: string; sessionId?: string }; data: { room: string; created: boolean } };
```

In `COMMAND_NAMES`, after `"chat:dm",`:

```ts
  "chat:archive",
  "chat:dm-open",
```

- [ ] **Step 4: Add the handlers**

In `lib/daemon/handlers/chat.ts`:

Import `archiveRoom` from `../../state/index.ts` (add it to the existing import list, after `listRooms,`).

`CHAT_COMMANDS` gains, after `"chat:dm",`:

```ts
  "chat:archive",
  "chat:dm-open",
```

The `chat:rooms` handler's first line becomes:

```ts
      const rooms = listRooms(payload.handle, db, { includeArchived: payload.includeArchived === true }).map((room) => {
```

After the `chat:dm` handler, before the closing `};`:

```ts
    "chat:archive": async (payload: Commands["chat:archive"]["payload"]): Promise<CommandResult<"chat:archive">> => {
      const { room, handle, archived } = payload;
      if (!isValidChatName(handle)) return { ok: false, error: `invalid handle "${handle}"` };
      if (!isValidChatName(room)) return { ok: false, error: `invalid room "${room}"` };
      if (typeof archived !== "boolean") return { ok: false, error: "archived must be true or false" };
      try {
        return { ok: true, data: archiveRoom(room, archived, db) };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    "chat:dm-open": async (payload: Commands["chat:dm-open"]["payload"]): Promise<CommandResult<"chat:dm-open">> => {
      const { from, to, sessionId } = payload;
      if (!isValidChatName(from)) return { ok: false, error: `invalid handle "${from}"` };
      if (!isValidChatName(to)) return { ok: false, error: `invalid handle "${to}"` };
      const err = assertionError(() => assertSessionOwnsHandle(from, sessionId, db));
      if (err) return { ok: false, error: err };
      const humanHandle = getSetting<string>("chat.humanHandle").value;
      if (!isValidChatName(humanHandle)) {
        return { ok: false, error: `chat: chat.humanHandle setting is empty or invalid ("${humanHandle}")` };
      }
      try {
        return { ok: true, data: dmRoomFor(from, to, humanHandle, db) };
      } catch (dmErr) {
        return { ok: false, error: dmErr instanceof Error ? dmErr.message : String(dmErr) };
      }
    },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test lib/daemon/__tests__/chat-handlers.test.ts`
Expected: PASS. Also run `bun test lib` to confirm nothing else in the daemon suites moved.

- [ ] **Step 6: Commit**

```bash
git add packages/rt-client/src/commands.ts lib/daemon/handlers/chat.ts lib/daemon/__tests__/chat-handlers.test.ts
git commit -m "daemon: chat:archive, chat:dm-open, chat:rooms includeArchived"
```

### Task 4: rt-client 0.7.0: `chatArchive`, `chatDmOpen`, `chatRooms` option

**Files:**
- Modify: `packages/rt-client/src/client.ts:186-191` (`chatRooms`), after `chatDm` (~line 323)
- Modify: `packages/rt-client/src/index.ts:13-31`
- Modify: `packages/rt-client/README.md:100-106`
- Modify: `packages/rt-client/package.json:3`
- Test: `packages/rt-client/test/client.test.ts`

**Interfaces:**
- Produces (exported from `@mattstack/rt-client`):
  - `chatArchive(a: { room: string; handle: string; archived: boolean }, o?: RtClientOptions): Promise<RtResponse<{ room: string; archivedAt: number | null }>>`
  - `chatDmOpen(a: { from: string; to: string; sessionId?: string }, o?: RtClientOptions): Promise<RtResponse<{ room: string; created: boolean }>>`
  - `chatRooms(a: { handle: string; includeArchived?: boolean }, o?)`: sends `includeArchived` only when `true`.

- [ ] **Step 1: Write the failing wrapper tests**

Append to `packages/rt-client/test/client.test.ts` (extend the first import line with `chatArchive, chatDmOpen, chatRooms`):

```ts
describe("chat archive and dm-open", () => {
  test("chatArchive sends room, handle and archived verbatim", async () => {
    const { sock, seen, stop } = fakeDaemon({
      "chat:archive": { ok: true, data: { room: "build", archivedAt: 5 } },
    });
    stops.push(stop);
    const res = await chatArchive({ room: "build", handle: "matt", archived: true }, { sockPath: sock });
    expect(res).toEqual({ ok: true, data: { room: "build", archivedAt: 5 } });
    expect(seen).toEqual([{ cmd: "chat:archive", payload: { room: "build", handle: "matt", archived: true } }]);
  });

  test("chatDmOpen omits sessionId when not given and passes it when given", async () => {
    const { sock, seen, stop } = fakeDaemon({
      "chat:dm-open": { ok: true, data: { room: "dm-abc", created: true } },
    });
    stops.push(stop);
    await chatDmOpen({ from: "matt", to: "a" }, { sockPath: sock });
    await chatDmOpen({ from: "a", to: "b", sessionId: "s1" }, { sockPath: sock });
    expect(seen[0]!.payload).toEqual({ from: "matt", to: "a" });
    expect(seen[1]!.payload).toEqual({ from: "a", to: "b", sessionId: "s1" });
  });

  test("chatRooms sends includeArchived only when true", async () => {
    const { sock, seen, stop } = fakeDaemon({ "chat:rooms": { ok: true, data: { rooms: [] } } });
    stops.push(stop);
    await chatRooms({ handle: "matt" }, { sockPath: sock });
    await chatRooms({ handle: "matt", includeArchived: false }, { sockPath: sock });
    await chatRooms({ handle: "matt", includeArchived: true }, { sockPath: sock });
    expect(seen.map((s) => s.payload)).toEqual([
      { handle: "matt" },
      { handle: "matt" },
      { handle: "matt", includeArchived: true },
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/rt-client/test/client.test.ts`
Expected: FAIL, `chatArchive` is not exported.

- [ ] **Step 3: Implement the wrappers**

In `packages/rt-client/src/client.ts`, replace `chatRooms`:

```ts
export function chatRooms(
  a: { handle: string; includeArchived?: boolean },
  o: RtClientOptions = {},
): Promise<RtResponse<{ rooms: RoomSummary[] }>> {
  const payload: Record<string, unknown> = { handle: a.handle };
  if (a.includeArchived === true) payload.includeArchived = true;
  return rtCommand<{ rooms: RoomSummary[] }>("chat:rooms", payload, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 });
}
```

After `chatDm`:

```ts
export function chatArchive(
  a: { room: string; handle: string; archived: boolean },
  o: RtClientOptions = {},
): Promise<RtResponse<{ room: string; archivedAt: number | null }>> {
  return rtCommand<{ room: string; archivedAt: number | null }>(
    "chat:archive",
    { room: a.room, handle: a.handle, archived: a.archived },
    { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 },
  );
}

export function chatDmOpen(
  a: { from: string; to: string; sessionId?: string },
  o: RtClientOptions = {},
): Promise<RtResponse<{ room: string; created: boolean }>> {
  const payload: Record<string, unknown> = { from: a.from, to: a.to };
  if (a.sessionId !== undefined) payload.sessionId = a.sessionId;
  return rtCommand<{ room: string; created: boolean }>("chat:dm-open", payload, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 });
}
```

In `packages/rt-client/src/index.ts`, add `chatArchive,` and `chatDmOpen,` after `chatDm,` in the export list.

In `packages/rt-client/package.json`, `"version": "0.7.0"`.

In `packages/rt-client/README.md`'s function table, change the membership row and add one:

```
| `chatJoin` / `chatLeave` / `chatArchive` | membership (`wakeOn: mention \| all \| none`); archive parks a room for everyone until a post revives it |
| `chatPost` / `chatDm` / `chatDmOpen` / `chatRead` / `chatMessages` / `chatMark` | messages: post, DM, open a DM room without posting, read-and-advance, page, advance the cursor |
```

(Replace the existing `chatPost / chatDm / ...` row with the second line above.)

- [ ] **Step 4: Rebuild dist and run the package tests**

Run: `bun run --cwd packages/rt-client build && bun test packages`
Expected: PASS, including `dist-freshness.test.ts` (it compares a fresh build with the `dist/` you just rebuilt).

- [ ] **Step 5: Commit**

```bash
git add packages/rt-client/src/client.ts packages/rt-client/src/index.ts packages/rt-client/README.md packages/rt-client/package.json packages/rt-client/test/client.test.ts
git commit -m "rt-client 0.7.0: chatArchive, chatDmOpen, chatRooms includeArchived"
```

### Task 5: CLI `rt chat archive`, command tree, skill doc

**Files:**
- Modify: `commands/chat.ts:1-27` (header comment), `:48-74` (rt-client import list), the verb functions (add `runArchive` after `runLeave`, line 690), `:1424-1444` (`USAGE`, `VERBS`)
- Modify: `lib/command-tree-def.ts:654-679`
- Regenerate: `website/docs/reference/chat.mdx`
- Modify: `skills/rt-chat/SKILL.md:128-152` (verb table) and the room guidance
- Test: `commands/__tests__/chat.test.ts`

**Interfaces:**
- Produces: `rt chat archive <room> [--reopen] [--as <h>] [--json]`.
- Consumes: Task 4's `chatArchive`.

- [ ] **Step 1: Write the failing CLI test**

In `commands/__tests__/chat.test.ts`, after the `leave drops membership` test (line 367-372), add:

```ts
  test("archive hides the room from rooms until reopened; --json reports the stamp", async () => {
    await runChat(["join", "r", "--as", "a"]);
    const out = JSON.parse(await runChat(["archive", "r", "--json", "--as", "a"]));
    expect(out.ok).toBe(true);
    expect(out.room).toBe("r");
    expect(typeof out.archivedAt).toBe("number");
    expect(JSON.parse(await runChat(["rooms", "--json", "--as", "a"])).rooms).toEqual([]);

    const plain = await runChat(["archive", "r", "--reopen", "--as", "a"]);
    expect(plain).toContain("reopened #r");
    expect(JSON.parse(await runChat(["rooms", "--json", "--as", "a"])).rooms.map((x: { room: string }) => x.room)).toEqual(["r"]);
  });

  test("archive refuses a room that does not exist with exit 1", async () => {
    const { code, stderr } = await runChatRaw(["archive", "ghost", "--as", "a"]);
    expect(code).toBe(1);
    expect(stderr).toContain("no such room");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test commands/__tests__/chat.test.ts -t archive`
Expected: FAIL, `unknown verb "archive"`.

- [ ] **Step 3: Implement the verb**

In `commands/chat.ts`:

Header comment: after the `rt chat leave <room>` line add

```
 *   rt chat archive <room> [--reopen]              park a room for everyone; a post revives it
```

Import: add `chatArchive,` to the `../packages/rt-client/src/index.ts` import list (alphabetically, before `chatArm`).

After `runLeave`:

```ts
async function runArchive(args: string[]): Promise<void> {
  const room = positional(args);
  if (!room) fail("usage: rt chat archive <room> [--reopen]");
  requireValidName("room", room);

  const handle = resolveHandle(args);
  requireValidName("handle", handle);

  const archived = !args.includes("--reopen");
  const res = await chatArchive({ room, handle, archived });
  const data = unwrap(res, "archive");

  if (args.includes("--json")) {
    console.log(JSON.stringify({ ok: true, room: data.room, archivedAt: data.archivedAt }));
    return;
  }
  console.log(
    archived
      ? `archived #${room}: hidden from every member's rooms until someone posts into it`
      : `reopened #${room}`,
  );
}
```

`USAGE` becomes:

```ts
const USAGE =
  "usage: rt chat <join|leave|archive|post|read|rooms|who|mark|tail|sign-in|sign-out|away|back|buddies|dm|pulse> ...";
```

`VERBS` gains `archive: runArchive,` after `leave: runLeave,`.

Check `unwrap` (line 136): it must `fail()` with the daemon's error text so the second test sees `no such room` on stderr. If it prints `rt chat: archive: <error>`, the assertion above already matches by substring.

- [ ] **Step 4: Update the command tree and regenerate the reference**

In `lib/command-tree-def.ts`, the `chat` leaf:

- the comment `// rooms/who/mark/tail/sign-in/...` gains `archive` after `leave`;
- the Verb placeholder becomes `"join | leave | archive | post | read | rooms | who | mark | tail | sign-in | sign-out | away | back | buddies | dm | pulse"`;
- the Room hint's first clause becomes `"Room name for join/leave/archive/post/read/who/mark; ..."`;
- after the `Wake on` flag add:

```ts
      { name: "Reopen", flag: "--reopen", type: "boolean", default: false, hint: "For archive: clear the archive instead of setting it" },
```

- the JSON hint's parenthetical gains `archive` after `leave`.

Run: `bun run docs:gen && bun run docs:check`
Expected: `chat.mdx` regenerated with the new verb and flag; `docs:check` exits 0.

- [ ] **Step 5: Update the skill**

In `skills/rt-chat/SKILL.md`'s verb table, after the `rt chat leave <room>` row:

```
| `rt chat archive <room>` | park a finished room: it leaves every member's `rooms`, wakes nobody, and any post into it reopens it for everyone. `--reopen` clears the archive without posting. Matt's call, not yours (see Archiving below) |
```

After the paragraph that starts `@mentions are how you wake a specific agent` (end of "The rest of the verb surface"), add:

```
## Archiving

Archiving is Matt's call. Archive a room only when he asks you to, and never
one you did not create. A room missing from `rt chat rooms` that you know
exists has probably been archived: posting into it reopens it for every
member and wakes them, so ask before you post there. `rt chat read <room>`
and `rt chat who <room>` still answer for an archived room by name.
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test commands/__tests__/chat.test.ts && bun run docs:check`
Expected: PASS; docs check clean.

- [ ] **Step 7: Commit**

```bash
git add commands/chat.ts lib/command-tree-def.ts website/docs/reference/chat.mdx skills/rt-chat/SKILL.md commands/__tests__/chat.test.ts
git commit -m "rt chat archive: park a room for everyone, --reopen to clear"
```

### Task 6: Full rt verification, PR, publish rt-client

**Files:** none new.

- [ ] **Step 1: Run everything**

```bash
bun run --cwd packages/rt-client build
bun test lib commands packages scripts
bun run docs:check
bunx tsc --noEmit -p packages/rt-client/tsconfig.json
```

Expected: every suite green, docs clean, types clean. If the repo has a root type check script, run that too.

- [ ] **Step 2: Rebase onto origin/main and re-check the two shared values**

```bash
git fetch origin
git rebase origin/main
grep -n "SCHEMA_VERSION =" lib/state/db.ts
grep -n '"version"' packages/rt-client/package.json
```

If main already reached schema 7 or rt-client 0.7.0 (the invite lane), take the next number in each and re-run Task 1's tests and Task 4's `dist-freshness` test.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin feat/chat-archive-dm-open
gh pr create --title "rt chat: archive a room, open a DM without posting (rt-client 0.7.0)" --body "$(cat <<'EOF'
## rt chat: archive a room, open a DM without posting

Spec: docs/superpowers/specs/2026-08-26-rt-chat-qol-design.md (in this PR).

### What changed

**Store** (`lib/state/`)

- Adds `chat_rooms.archived_at` (schema v7) with a conditional `ALTER` beside the version check
- Adds `archiveRoom` and `roomArchivedAt`; every room-less membership walk skips archived rooms; a post revives the room in its insert transaction

**Daemon and client**

- Adds `chat:archive` and `chat:dm-open`; `chat:rooms` takes `includeArchived`
- rt-client 0.7.0: `chatArchive`, `chatDmOpen`, `chatRooms({ includeArchived })`

**CLI and docs**

- Adds `rt chat archive <room> [--reopen]`, the command-tree entry, and the regenerated reference
- Skill: archiving is Matt's call; posting into an archived room reopens it

---

**Checklist**

- [x] Appropriate tests have been created or updated
  - store, dm-store, handler, rt-client and CLI suites; `bun test lib commands packages scripts` green

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_014DK8caKoMFXhKQHh8Uufsg
EOF
)"
```

- [ ] **Step 4: Publish rt-client after the merge, with Matt's go-ahead**

Publishing is outward-facing. Ask Matt before running it, then:

```bash
cd /Users/matt/Documents/GitHub/repo-tools-chat-qol/packages/rt-client
npm publish
npm view @mattstack/rt-client version
```

Expected: `0.7.0` on npm (`prepack` runs the build). Phase 2 cannot start its Task 7 install until this is on npm.

---

# Phase 2: chat viewer

Every command in this phase runs from `/Users/matt/Documents/GitHub/chat/.claude/worktrees/chat-qol` on branch `worktree-chat-qol`. Tests are vitest (`bunx vitest run <file>`); the full gates are `bun run typecheck`, `bun run lint`, `bunx vitest run`, `bun run build`. Phase 2 starts only once `@mattstack/rt-client@0.7.0` is on npm (Task 6, step 4).

### Task 7: Server: rooms with archived rows, `/api/chat/archive`, `/api/chat/dm/open`; fixtures

**Files:**
- Modify: `package.json:28`
- Modify: `src/server/chat.ts` (imports 1-13, the rooms route 140-148, the end of the router 258-300)
- Modify: `src/server/fixtures.ts` (`fixtureRooms` 116-138, `fixtureMembers` 140-168, `fixtureMessages` 170-244)
- Modify: `ARCHITECTURE.md` (the API table)
- Test: `src/server/chat.test.ts`, `src/server/fixtures.test.ts`

**Interfaces:**
- Produces:
  - `GET /api/chat/rooms` → `{ rooms: (RoomSummary & { joined?: false })[] }`, the human's rows including archived ones (`archivedAt` set).
  - `POST /api/chat/archive` `{ room: string; archived: boolean }` → `{ room, archivedAt }`; 400 `room is required` / `archived must be true or false` / `unknown room "<room>"`; 502 on `!ok`.
  - `POST /api/chat/dm/open` `{ to: string }` → `{ room, created }`; 400 `to is required` / `invalid handle` / `can't DM yourself`; 502 on `!ok`.
  - `POST /api/chat/dm` gone (JSON 404 through `static-disk.ts`'s `/api/*` rule).
  - Fixtures: `fixtureRooms(now?)` with `#retro-0819` (archived 3 days) and an archived DM `dm-7b2e9c4d1a0f` (`board-fix-auth ↔ matt`, archived 5 days); `fixtureMessages('build')` gains message 48, a 60-line fenced log; `fixtureMessages('retro-0819')` returns four messages across two days.
- Consumes: rt-client 0.7.0's `chatArchive`, `chatDmOpen`, `chatRooms({ includeArchived })`.

- [ ] **Step 1: Bump rt-client**

In `package.json`, `"@mattstack/rt-client": "^0.7"`, then `bun install`. Run `bunx vitest run src/server` to confirm the baseline is still green before changing anything.

- [ ] **Step 2: Write the failing server tests**

In `src/server/chat.test.ts`, change the `vi.mock` factory: remove `chatDm: vi.fn(),`, add `chatArchive: vi.fn(),` and `chatDmOpen: vi.fn(),`. Delete the test `"dm opens or reuses the pair's room and posts as the human"` (line 239). Add:

```ts
test('rooms asks for the human’s archived rooms too and passes archivedAt through', async () => {
  vi.mocked(rt.chatRooms).mockResolvedValueOnce({
    ok: true,
    data: {
      rooms: [
        { room: 'build', memberCount: 3, unread: 0, mentions: 0 },
        { room: 'retro', memberCount: 2, unread: 0, mentions: 0, archivedAt: 1700000000000 },
      ],
    },
  });
  vi.mocked(rt.chatBuddies).mockResolvedValueOnce({ ok: true, data: { buddies: [] } });
  const res = await app.request('/api/chat/rooms?handle=matt');
  expect(res.status).toBe(200);
  expect(rt.chatRooms).toHaveBeenCalledWith(
    { handle: 'matt', includeArchived: true },
    expect.anything()
  );
  const { rooms } = await res.json();
  expect(rooms[1]).toMatchObject({ room: 'retro', archivedAt: 1700000000000 });
});

test('archiving a channel the human never joined joins him first, then archives', async () => {
  // The human's own listing (no #build), then the fleet union's per-buddy listings.
  vi.mocked(rt.chatRooms)
    .mockResolvedValueOnce({ ok: true, data: { rooms: [] } })
    .mockResolvedValueOnce({ ok: true, data: { rooms: [{ room: 'build', memberCount: 2, unread: 0, mentions: 0 }] } });
  vi.mocked(rt.chatBuddies).mockResolvedValueOnce({
    ok: true,
    data: { buddies: [{ handle: 'fred', sessionId: 's', baseHandle: 'fred', signedInAt: 1, lastSeenAt: 1, status: 'live' }] },
  });
  vi.mocked(rt.chatWho).mockResolvedValueOnce({ ok: true, data: { members: [] } });
  vi.mocked(rt.chatJoin).mockResolvedValueOnce({ ok: true, data: { handle: 'matt', memberCount: 3, unread: 0 } });
  vi.mocked(rt.chatArchive).mockResolvedValueOnce({ ok: true, data: { room: 'build', archivedAt: 5 } });

  const res = await app.request('/api/chat/archive?handle=matt', {
    method: 'POST',
    body: JSON.stringify({ room: 'build', archived: true }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ room: 'build', archivedAt: 5 });
  expect(rt.chatJoin).toHaveBeenCalledWith({ room: 'build', handle: 'matt' }, expect.anything());
  expect(rt.chatArchive).toHaveBeenCalledWith({ room: 'build', handle: 'matt', archived: true }, expect.anything());
});

test('archiving a room already in the human’s listing never joins; a DM never joins either', async () => {
  vi.mocked(rt.chatRooms).mockResolvedValueOnce({
    ok: true,
    data: {
      rooms: [
        { room: 'build', memberCount: 3, unread: 0, mentions: 0 },
        { room: 'dm-1', memberCount: 2, unread: 0, mentions: 0, kind: 'dm', participants: { a: 'fred', b: 'matt' } },
      ],
    },
  });
  vi.mocked(rt.chatArchive).mockResolvedValue({ ok: true, data: { room: 'build', archivedAt: 5 } });
  await app.request('/api/chat/archive?handle=matt', { method: 'POST', body: JSON.stringify({ room: 'build', archived: true }) });
  vi.mocked(rt.chatRooms).mockResolvedValueOnce({
    ok: true,
    data: { rooms: [{ room: 'dm-1', memberCount: 2, unread: 0, mentions: 0, kind: 'dm', participants: { a: 'fred', b: 'matt' } }] },
  });
  await app.request('/api/chat/archive?handle=matt', { method: 'POST', body: JSON.stringify({ room: 'dm-1', archived: true }) });
  expect(rt.chatJoin).not.toHaveBeenCalled();
});

test('archive 400s on a bad body and on a room nobody lists, and never join-creates', async () => {
  const bad = await app.request('/api/chat/archive?handle=matt', { method: 'POST', body: JSON.stringify({ room: 'build' }) });
  expect(bad.status).toBe(400);
  const noRoom = await app.request('/api/chat/archive?handle=matt', { method: 'POST', body: JSON.stringify({ archived: true }) });
  expect(noRoom.status).toBe(400);

  vi.mocked(rt.chatRooms).mockResolvedValue({ ok: true, data: { rooms: [] } });
  vi.mocked(rt.chatBuddies).mockResolvedValue({ ok: true, data: { buddies: [] } });
  const ghost = await app.request('/api/chat/archive?handle=matt', { method: 'POST', body: JSON.stringify({ room: 'ghost', archived: true }) });
  expect(ghost.status).toBe(400);
  expect((await ghost.json()).error).toContain('unknown room');
  expect(rt.chatJoin).not.toHaveBeenCalled();
  expect(rt.chatArchive).not.toHaveBeenCalled();
});

test('reopen posts archived:false for a room in the human’s listing', async () => {
  vi.mocked(rt.chatRooms).mockResolvedValueOnce({
    ok: true,
    data: { rooms: [{ room: 'retro', memberCount: 2, unread: 0, mentions: 0, archivedAt: 7 }] },
  });
  vi.mocked(rt.chatArchive).mockResolvedValueOnce({ ok: true, data: { room: 'retro', archivedAt: null } });
  const res = await app.request('/api/chat/archive?handle=matt', { method: 'POST', body: JSON.stringify({ room: 'retro', archived: false }) });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ room: 'retro', archivedAt: null });
  expect(rt.chatArchive).toHaveBeenCalledWith({ room: 'retro', handle: 'matt', archived: false }, expect.anything());
});

test('dm/open opens or reuses the pair’s room as the human without posting', async () => {
  vi.mocked(rt.chatDmOpen).mockResolvedValueOnce({ ok: true, data: { room: 'dm-1a2b3c4d5e6f', created: true } });
  const res = await app.request('/api/chat/dm/open?handle=matt', { method: 'POST', body: JSON.stringify({ to: 'fred' }) });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ room: 'dm-1a2b3c4d5e6f', created: true });
  expect(rt.chatDmOpen).toHaveBeenCalledWith({ from: 'matt', to: 'fred' }, expect.anything());
  expect(rt.chatPost).not.toHaveBeenCalled();
});

test('dm/open 400s on a missing, invalid, or own handle before touching the daemon', async () => {
  for (const body of [{}, { to: 'Has@Sigil' }, { to: 'matt' }]) {
    const res = await app.request('/api/chat/dm/open?handle=matt', { method: 'POST', body: JSON.stringify(body) });
    expect(res.status).toBe(400);
  }
  expect(rt.chatDmOpen).not.toHaveBeenCalled();
});

test('POST /api/chat/dm is gone: a JSON 404, never the SPA shell', async () => {
  const res = await app.request('/api/chat/dm', { method: 'POST', body: JSON.stringify({ to: 'fred', body: 'hi' }) });
  expect(res.status).toBe(404);
  expect(res.headers.get('content-type')).toContain('application/json');
});
```

In `src/server/fixtures.test.ts`, the existing assertion at lines 66-68 that `fixtureRooms().filter(r => r.kind === 'dm')` has length 2 must exclude archived rows: change its filter to `r => r.kind === 'dm' && r.archivedAt === undefined`. Then add:

```ts
test('fixtures carry an archived channel, an archived DM, and a long code post', () => {
  const rooms = fixtureRooms();
  const archived = rooms.filter(r => r.archivedAt !== undefined);
  expect(archived.map(r => r.room)).toEqual(['retro-0819', 'dm-7b2e9c4d1a0f']);
  expect(fixtureMessages('build').at(-1)?.body.split('\n').length).toBeGreaterThan(60);
  const retro = fixtureMessages('retro-0819');
  expect(retro).toHaveLength(4);
  expect(new Date(retro[0]!.postedAt).getDate()).not.toBe(new Date(retro[3]!.postedAt).getDate());
  expect(fixtureMembers('retro-0819').map(m => m.handle)).toEqual(['deck-main', 'gitq-main']);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bunx vitest run src/server`
Expected: FAIL: `chatArchive`/`chatDmOpen` are not called, `/api/chat/dm` still answers 200, fixtures lack the rooms.

- [ ] **Step 4: Implement the routes**

In `src/server/chat.ts`:

Imports: replace `chatDm,` with `chatArchive,` and add `chatDmOpen,` (keep alphabetical: `chatArchive, chatBuddies, chatDmOpen, chatJoin, ...`).

Add near `parseIntParam`:

```ts
const CHAT_NAME = /^[a-z0-9._-]+$/;
```

The rooms route becomes:

```ts
  .get('/api/chat/rooms', async c => {
    if (fixturesEnabled()) return c.json({ rooms: fixtureRooms() }, 200);
    const res = await chatRooms(
      { handle: humanHandle(c), includeArchived: true },
      rtOpts()
    );
    if (!res.ok) return c.json({ error: res.error }, 502);

    const joined = res.data?.rooms ?? [];
    const extra = await unjoinedFleetRooms(joined);
    return c.json({ rooms: [...joined, ...extra] }, 200);
  })
```

Replace the whole `.post('/api/chat/dm', ...)` route with these two:

```ts
  // Archive is the one write that needs the human IN the room first: an
  // archived room only stays listed for members, and most channels are
  // join-created by agents. Joining first (never for a DM, which already
  // holds him) is the same move the post route makes. A name that neither
  // his listing nor the fleet union knows is refused before that join, so
  // a typo can never create-and-archive a room.
  .post('/api/chat/archive', async c => {
    let raw: { room?: unknown; archived?: unknown };
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: 'Malformed JSON in request body' }, 400);
    }
    const room = typeof raw?.room === 'string' ? raw.room : undefined;
    const archived = typeof raw?.archived === 'boolean' ? raw.archived : undefined;
    if (!room) return c.json({ error: 'room is required' }, 400);
    if (archived === undefined) {
      return c.json({ error: 'archived must be true or false' }, 400);
    }
    const handle = humanHandle(c);

    const roomsRes = await chatRooms(
      { handle, includeArchived: true },
      rtOpts()
    );
    if (!roomsRes.ok || !roomsRes.data) {
      return c.json({ error: roomsRes.error ?? 'rooms: no data' }, 502);
    }
    const mine = roomsRes.data.rooms.find(r => r.room === room);
    if (!mine) {
      const fleet = (await unjoinedFleetRooms(roomsRes.data.rooms)).find(
        r => r.room === room
      );
      if (!fleet) return c.json({ error: `unknown room "${room}"` }, 400);
      if (fleet.kind !== 'dm') {
        const joinRes = await chatJoin({ room, handle }, rtOpts());
        if (!joinRes.ok) return c.json({ error: joinRes.error }, 502);
      }
    }

    const res = await chatArchive({ room, handle, archived }, rtOpts());
    if (!res.ok) return c.json({ error: res.error }, 502);
    return c.json(res.data, 200);
  })
  // Opens or reuses the pair's room with no first message: the client
  // navigates to it and the composer there is the DM. Parsed by hand for
  // the same reason as `/api/chat/post`.
  .post('/api/chat/dm/open', async c => {
    let raw: { to?: unknown };
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: 'Malformed JSON in request body' }, 400);
    }
    const to = typeof raw?.to === 'string' ? raw.to : undefined;
    if (!to) return c.json({ error: 'to is required' }, 400);
    if (!CHAT_NAME.test(to)) return c.json({ error: `invalid handle "${to}"` }, 400);
    const from = humanHandle(c);
    if (to === from) return c.json({ error: "can't DM yourself" }, 400);
    const res = await chatDmOpen({ from, to }, rtOpts());
    if (!res.ok) return c.json({ error: res.error }, 502);
    return c.json(res.data, 200);
  });
```

- [ ] **Step 5: Implement the fixtures**

In `src/server/fixtures.ts`:

`fixtureRooms` takes `now = Date.now()` and returns, after the two existing DM rows:

```ts
    {
      room: 'retro-0819',
      memberCount: 3,
      unread: 0,
      mentions: 0,
      archivedAt: now - 3 * 24 * H,
    },
    {
      room: 'dm-7b2e9c4d1a0f',
      memberCount: 2,
      unread: 0,
      mentions: 0,
      kind: 'dm' as const,
      participants: { a: 'board-fix-auth', b: 'matt' },
      archivedAt: now - 5 * 24 * H,
    },
```

`fixtureMembers`: before `const all = ...`, add a fixed membership for the archived channel, since no buddy carries an archived room as a tag:

```ts
  const ARCHIVED_MEMBERS: Record<string, string[]> = {
    'retro-0819': ['deck-main', 'gitq-main'],
  };
```

and compute `inRoom` as:

```ts
  const inRoom = pair
    ? [pair.a, pair.b].filter(h => h !== 'matt')
    : (ARCHIVED_MEMBERS[room] ??
      all.filter(b => b.rooms.includes(room)).map(b => b.handle));
```

`fixtureMessages`: replace the `if (room !== 'build')` block's head with:

```ts
  if (room === 'retro-0819') {
    const at = (daysAgo: number, minutes: number) =>
      now - daysAgo * 24 * H + minutes * M;
    return [
      { id: 301, room, handle: 'deck-main', body: 'retro for the 0819 incident: what went wrong, what we keep.', postedAt: at(3, 0), mentions: [] },
      { id: 302, room, handle: 'gitq-main', body: 'the stack rebase raced the deploy. we keep: never restack while deck is mid-restart.', postedAt: at(3, 14), mentions: [] },
      { id: 303, room, handle: 'deck-main', body: 'agreed. writing it into the deploy loop doc.', postedAt: at(2, 5), mentions: [] },
      { id: 304, room, handle: 'gitq-main', body: 'done on my side too. closing this out.', postedAt: at(2, 40), mentions: [] },
    ];
  }
  if (room !== 'build') {
```

and append to the `build` list, after message 47:

```ts
    msg(
      48,
      'board-fix-auth',
      0.5,
      'full jest output for the auth suite, for the record:\n```\n' +
        Array.from({ length: 60 }, (_, i) =>
          i % 7 === 6
            ? `  ✕ auth › refresh token rotates (${120 + i} ms)`
            : `  ✓ auth › case ${i + 1} (${3 + (i % 5)} ms)`
        ).join('\n') +
        '\n```'
    ),
```

`H` is already defined in the file (`const H = 60 * M`).

- [ ] **Step 6: Update ARCHITECTURE.md**

In the API table: change the `GET /api/chat/rooms` row's description to `{ rooms: RoomSummary[] }: the human's rooms including archived ones (archivedAt set), then every room a fleet buddy is in that the human is not (joined: false)`; replace the `POST /api/chat/dm` row with:

```
| `POST /api/chat/archive` `{ room, archived }`  | joins the human first when he is not in the channel, then archives or reopens; 400 on a room nobody lists                       |
| `POST /api/chat/dm/open` `{ to }`             | opens or reuses the DM room without posting; the client navigates to it                                                          |
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `bunx vitest run src/server && bun run typecheck`
Expected: PASS; types clean (a stale `chatDm` reference anywhere fails the typecheck, which is the point).

- [ ] **Step 8: Commit**

```bash
git add package.json bun.lock src/server/chat.ts src/server/fixtures.ts src/server/chat.test.ts src/server/fixtures.test.ts ARCHITECTURE.md
git commit -m "server: archive and dm/open routes, archived rooms listed, /api/chat/dm removed"
```

### Task 8: A DM is a room: `openDm` replaces the composer's DM mode

**Files:**
- Modify: `src/ui/Composer.tsx` (props 60-100, state 279-289, `switchToDm`/`selectBuddy` 345-362, `send` 364-410, `useImperativeHandle` 445-451, placeholder 456-470, footer 626-645)
- Modify: `src/ui/buddies-context.tsx:6-12` (doc only)
- Modify: `src/app/App.tsx` (`PhoneDrawer` props 556-570 and the roster pick 706-715, `PhoneChat` 756-846, `App` 871-960, desktop composer/roster 1028-1052)
- Test: `src/ui/Composer.test.tsx`, `src/app/App.test.tsx`

**Interfaces:**
- Produces:
  - `ComposerHandle = { insertMention(handle: string): void; focus(): void }` (`startDm` removed).
  - `ComposerProps.onOpenDm?: (handle: string) => void` (`onNavigate` removed).
  - `App`-level `openDm(handle: string): Promise<void>`: `POST /api/chat/dm/open`, refetch rooms, navigate to `/r/<room>`, focus the composer; error notification `Couldn't open the DM`.
  - `BuddyActions.dm` now navigates (same signature).
- Consumes: Task 7's `/api/chat/dm/open`.

- [ ] **Step 1: Write the failing tests**

In `src/ui/Composer.test.tsx`, replace the test `"choosing DM instead posts through /api/chat/dm and navigates to the pair's room"` with:

```ts
test('choosing DM instead hands the handle to onOpenDm, drops the @ token and keeps the draft', async () => {
  const onOpenDm = vi.fn();
  renderWithProviders(
    <Composer
      room="build"
      roomMembers={[]}
      onOpenDm={onOpenDm}
      buddies={[{ handle: 'board-fix-auth', status: 'idle' }]}
    />
  );
  await userEvent.type(
    screen.getByRole('textbox'),
    'can you take the flaky one? @'
  );
  await userEvent.click(await screen.findByText('board-fix-auth'));
  expect(onOpenDm).toHaveBeenCalledWith('board-fix-auth');
  expect(screen.getByRole('textbox')).toHaveValue('can you take the flaky one? ');
  expect(fetchMock).not.toHaveBeenCalled();
  expect(screen.queryByText(/direct message to/)).toBeNull();
});
```

In `src/app/App.test.tsx`, add (imports: `userEvent` from `@testing-library/user-event`, `fetchMock`/`installFetchMock` are already imported):

```ts
function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

test('DM on a sender’s card opens the pair’s room and focuses the composer there', async () => {
  installFetchMock();
  const now = Date.now();
  const dmRoom = {
    room: 'dm-1a2b3c4d5e6f',
    memberCount: 2,
    unread: 0,
    mentions: 0,
    kind: 'dm' as const,
    participants: { a: 'fred', b: 'matt' },
  };
  const build = { room: 'build', memberCount: 2, unread: 0, mentions: 0 };
  fetchMock.mockImplementation((url: string) => {
    if (url === '/api/chat/dm/open') return Promise.resolve(jsonResponse({ room: dmRoom.room, created: true }));
    if (url === '/api/chat/rooms') return Promise.resolve(jsonResponse({ rooms: [build, dmRoom] }));
    return Promise.resolve(jsonResponse({}));
  });
  window.history.replaceState(null, '', '/r/build');
  renderWithProviders(
    <App
      initialState={{
        daemonReachable: true,
        buddies: [
          { sessionId: 's', handle: 'fred', baseHandle: 'fred', signedInAt: now, lastSeenAt: now, armedAt: now, tailSeenAt: now, status: 'live', rooms: ['build'] },
        ],
        rooms: [build],
        members: [{ room: 'build', handle: 'fred', joinedAt: now, lastReadId: 0, wakeOn: 'mention', status: 'live' }],
        messages: [{ id: 7, room: 'build', handle: 'fred', body: 'hello', mentions: [], postedAt: now }],
      }}
    />
  );
  const transcript = await screen.findByTestId('transcript');
  await userEvent.hover(within(transcript).getByText('fred'));
  await userEvent.click(await screen.findByTestId('card-dm-fred'));

  expect(fetchMock).toHaveBeenCalledWith(
    '/api/chat/dm/open',
    expect.objectContaining({ method: 'POST', body: JSON.stringify({ to: 'fred' }) })
  );
  await screen.findByTestId(`room-row-${dmRoom.room}`);
  expect(window.location.pathname).toBe(`/r/${dmRoom.room}`);
  // `focus()` defers through requestAnimationFrame.
  await waitFor(() =>
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveFocus()
  );
  expect(screen.queryByText(/direct message to/)).toBeNull();
});
```

(`waitFor` and `within` come from `@testing-library/react`.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx vitest run src/ui/Composer.test.tsx src/app/App.test.tsx`
Expected: FAIL: the composer still posts to `/api/chat/dm`; the App test finds no `room-row-dm-…` and the pathname stays `/r/build`.

- [ ] **Step 3: Rewrite the composer's DM path**

In `src/ui/Composer.tsx`:

Props: replace the `onNavigate` prop (doc and field) with:

```ts
  /** A buddy outside the room was picked in the `@` popover: the caller
      opens the DM room and moves there; the draft stays in this instance. */
  onOpenDm?: (handle: string) => void;
```

`ComposerHandle`:

```ts
export interface ComposerHandle {
  insertMention(handle: string): void;
  focus(): void;
}
```

and its doc comment becomes: `The imperative surface the roster and the app drive: insert a mention at the caret, or take focus after a room change.`

In the component: remove `onNavigate` from the destructured props and add `onOpenDm`; delete `const [dmTarget, setDmTarget] = useState<string | undefined>(undefined);`, the `useEffect(() => { setDmTarget(undefined); }, [room]);` block and its comment.

Replace `switchToDm`:

```ts
    function switchToDm(handle: string) {
      replaceToken('');
      closePopover();
      onOpenDm?.(handle);
    }
```

In `send()`, delete the whole `if (dmTarget) { ... return; }` block (the `/api/chat/dm` fetch), leaving the post path.

`useImperativeHandle`:

```ts
    useImperativeHandle(ref, () => ({
      insertMention: insertMentionAtCaret,
      focus: () => focusAt(value.length),
    }));
```

Placeholder: delete the `: dmTarget ? ... : ...` branch so it reads:

```ts
    const placeholder = !daemonReachable
      ? phone
        ? 'rt daemon unreachable'
        : "Can't post — rt daemon unreachable. Your draft is kept."
      : isDm
        ? phone
          ? `Message ${roomMembers.join(' ↔ ')}`
          : `Message ${roomMembers.join(' ↔ ')} — both will wake`
        : phone
          ? `Message #${room}`
          : `Message #${room} — @ to mention`;
```

Footer: delete the `: dmTarget ? (<>...cancel...</>)` branch so the ternary is `!daemonReachable ? (...) : (<> posting as ... </>)`.

If `PURPLE` is now only used by `BuddyOption`, leave it; if `notifications` is still used by the post path's catch, leave it. Run `bun run lint` to catch anything unused.

- [ ] **Step 4: Wire `openDm` in the app**

In `src/app/App.tsx`:

Import `notifications` from `@ui/notifications`.

`PhoneDrawer`: replace the `composerRef` prop with `onMention: (handle: string) => void` and `onOpenDm: (handle: string) => void`; the roster pick becomes:

```tsx
            onPick={(handle, { inRoom }) => {
              if (inRoom) onMention(handle);
              else onOpenDm(handle);
              onClose();
            }}
```

`PhoneChat`: replace `onNavigate: (room: string) => void` with `onOpenDm: (handle: string) => void`; the composer gets `onOpenDm={onOpenDm}` instead of `onNavigate={...}`; the drawer gets `onMention={handle => composerRef.current?.insertMention(handle)}` and `onOpenDm={handle => { onOpenDm(handle); setDrawerOpen(false); }}`.

In `App`, replace `handleComposerNavigate` and `buddyActions` with:

```ts
  const openDm = useCallback(
    async (handle: string) => {
      try {
        const res = await fetch('/api/chat/dm/open', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: handle }),
        });
        if (!res.ok) throw new Error('dm open failed');
        const data = (await res.json()) as { room: string };
        refetchRooms();
        setActiveRoom(data.room);
        const to = `/r/${encodeURIComponent(data.room)}`;
        if (window.location.pathname !== to) navigate(to);
        composerRef.current?.focus();
      } catch {
        notifications.error("Couldn't open the DM");
      }
    },
    [refetchRooms]
  );

  const buddyActions = useMemo(
    () => ({
      mention: (handle: string) => composerRef.current?.insertMention(handle),
      dm: (handle: string) => void openDm(handle),
    }),
    [openDm]
  );
```

Keep `selectRoom` as it is for the rail. Pass `onOpenDm={openDm}` to `PhoneChat` (removing `onNavigate`), `onOpenDm={openDm}` to the desktop `Composer` (removing `onNavigate`), and change both roster picks from `composerRef.current?.startDm(handle)` to `void openDm(handle)`.

Update the `BuddyActions.dm` doc in `src/ui/buddies-context.tsx` to `/** Open the DM room with \`handle\` and move to it. */`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bunx vitest run src/ui/Composer.test.tsx src/app/App.test.tsx src/ui/Roster.test.tsx && bun run typecheck && bun run lint`
Expected: PASS, clean.

- [ ] **Step 6: Commit**

```bash
git add src/ui/Composer.tsx src/ui/buddies-context.tsx src/app/App.tsx src/ui/Composer.test.tsx src/app/App.test.tsx
git commit -m "dm: a DM is a room, the composer's DM mode is gone"
```

### Task 9: Page bar ⋯ menu: archive with confirm, reopen, the archived chip

**Files:**
- Modify: `src/ui/PageBar.tsx` (imports 1-6, props 63-73, `controls` 165-215, chips 240-317)
- Modify: `src/app/App.tsx` (`App`: an `setArchived` handler; the desktop `PageBar` props 973-983)
- Test: `src/ui/PageBar.test.tsx`

**Interfaces:**
- Produces:
  - `PageBarProps.onArchive?: (room: string, archived: boolean) => void`.
  - exported `RoomMenu({ room, memberHandles, onArchive, size }: { room: RoomSummary; memberHandles: string[]; onArchive?: ...; size?: number })` from `PageBar.tsx`, the ⋯ trigger plus its menu, reused by the phone header in Task 11.
  - exported `memberList(handles: string[]): string`: `"fred"`, `"fred and gitq"`, `"a, b, c and d"`, `"a, b, c and 3 more"` (five or more).
  - `data-testid`s: `room-menu`, `room-menu-archive`, `room-menu-reopen`, `chip-archived`.
  - App-level `setArchived(room, archived)`: `POST /api/chat/archive`, refetch rooms; error notification `Couldn't archive the room` / `Couldn't reopen the room`.
- Consumes: `RoomSummary.archivedAt`; the kit's `modals.confirm` (`@ui/modals`).

- [ ] **Step 1: Write the failing tests**

Append to `src/ui/PageBar.test.tsx` (imports: `userEvent` from `@testing-library/user-event`, `vi`; `renderWithProviders` is what the file already uses so the `ModalsProvider` is present):

```ts
test('the ⋯ menu offers Archive with a confirm that names the members, and confirms through onArchive', async () => {
  const onArchive = vi.fn();
  renderWithProviders(
    <PageBar
      room={{ room: 'build', memberCount: 3, unread: 0, mentions: 0 }}
      buddies={[
        { handle: 'fred', status: 'live' },
        { handle: 'gitq-main', status: 'deaf' },
      ]}
      onArchive={onArchive}
    />
  );
  await userEvent.click(screen.getByTestId('room-menu'));
  await userEvent.click(await screen.findByTestId('room-menu-archive'));
  expect(await screen.findByText('Archive #build?')).toBeInTheDocument();
  expect(screen.getByText(/for you and for fred and gitq-main/)).toBeInTheDocument();
  expect(onArchive).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Archive' }));
  expect(onArchive).toHaveBeenCalledWith('build', true);
});

test('an archived room shows the archived chip, hides mark read, and its menu offers Reopen with no confirm', async () => {
  const onArchive = vi.fn();
  renderWithProviders(
    <PageBar
      room={{ room: 'retro', memberCount: 2, unread: 4, mentions: 1, archivedAt: Date.now() - 3 * 86_400_000 }}
      buddies={[{ handle: 'fred', status: 'live' }]}
      onArchive={onArchive}
    />
  );
  expect(screen.getByTestId('chip-archived')).toHaveTextContent('archived');
  expect(screen.queryByTestId('chip-wakes')).toBeNull();
  expect(screen.queryByTestId('mark-read-button')).toBeNull();
  await userEvent.click(screen.getByTestId('room-menu'));
  await userEvent.click(await screen.findByTestId('room-menu-reopen'));
  expect(onArchive).toHaveBeenCalledWith('retro', false);
  expect(screen.queryByText(/Archive #retro\?/)).toBeNull();
});

test('memberList reads like a sentence and caps at three names', () => {
  expect(memberList([])).toBe('');
  expect(memberList(['fred'])).toBe('fred');
  expect(memberList(['fred', 'gitq'])).toBe('fred and gitq');
  expect(memberList(['a', 'b', 'c', 'd'])).toBe('a, b, c and d');
  expect(memberList(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c and 2 more');
});
```

Add `memberList` to the `./PageBar` import.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx vitest run src/ui/PageBar.test.tsx`
Expected: FAIL: no `room-menu`, `memberList` not exported.

- [ ] **Step 3: Implement the menu and chip**

In `src/ui/PageBar.tsx`:

Imports: `import { ActionIcon, Box, Button, Group, Menu, Select, Text } from '@mantine/core';` and `import { modals } from '@ui/modals';`.

Props: add to `PageBarProps`:

```ts
  /** Archive (true) or reopen (false) the room; the bar confirms an archive
      itself, naming who loses the room from their rail. */
  onArchive?: (room: string, archived: boolean) => void;
```

Above `PageBar`:

```ts
export function memberList(handles: string[]): string {
  if (handles.length === 0) return '';
  if (handles.length === 1) return handles[0]!;
  if (handles.length <= 4) {
    return `${handles.slice(0, -1).join(', ')} and ${handles[handles.length - 1]}`;
  }
  return `${handles.slice(0, 3).join(', ')} and ${handles.length - 3} more`;
}

function archiveLabel(room: RoomSummary): string {
  return room.kind === 'dm' ? 'Archive this conversation…' : `Archive #${room.room}…`;
}

function archiveTitle(room: RoomSummary): string {
  return room.kind === 'dm' ? 'Archive this conversation?' : `Archive #${room.room}?`;
}

/** The ⋯ control and its menu. One component for the desk's page bar and
    the phone header, so both offer the same two actions. */
export function RoomMenu({
  room,
  memberHandles,
  humanHandle = 'matt',
  onArchive,
  size = 30,
}: {
  room: RoomSummary;
  /** The room's current members; the human is filtered out of the confirm
      text since it already says "for you". */
  memberHandles: string[];
  humanHandle?: string;
  onArchive?: (room: string, archived: boolean) => void;
  size?: number;
}) {
  const archived = room.archivedAt !== undefined;
  const others = memberList(memberHandles.filter(h => h !== humanHandle));
  const confirmArchive = () =>
    modals.confirm({
      title: archiveTitle(room),
      message: `It leaves the rail for you${others ? ` and for ${others}` : ''}. Everyone keeps their place in it, and any new post reopens it.`,
      labels: { confirm: 'Archive', cancel: 'Keep' },
      onConfirm: () => onArchive?.(room.room, true),
    });
  return (
    <Menu position="bottom-end" withinPortal radius="md" shadow="md">
      <Menu.Target>
        <ActionIcon
          variant="default"
          size={size}
          radius="md"
          aria-label="Room actions"
          data-testid="room-menu"
          styles={{ root: CONTROL_SURFACE }}
        >
          <Icon name="moreHorizontal" size={16} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown data-testid="room-menu-dropdown">
        {archived ? (
          <Menu.Item
            data-testid="room-menu-reopen"
            onClick={() => onArchive?.(room.room, false)}
          >
            Reopen
          </Menu.Item>
        ) : (
          <Menu.Item data-testid="room-menu-archive" onClick={confirmArchive}>
            {archiveLabel(room)}
          </Menu.Item>
        )}
      </Menu.Dropdown>
    </Menu>
  );
}
```

`PageBarProps` also gains `memberHandles?: string[]` (doc: `The room's full membership for the archive confirm; defaults to the buddies' handles, which omit offline members`). In `PageBar`, destructure `onArchive` and `memberHandles`, and in `controls`:

- the mark-read button's condition becomes `room.unread > 0 && room.archivedAt === undefined`;
- after the `Select` (still inside the fragment), add:

```tsx
      <Box ml={7.2} style={{ flex: 'none' }}>
        <RoomMenu
          room={room}
          memberHandles={memberHandles ?? buddies.map(b => b.handle)}
          onArchive={onArchive}
        />
      </Box>
```

In the reachable render, replace the `chip-wakes` chip with:

```tsx
        {room.archivedAt !== undefined ? (
          <Box component="span" style={CHIP_BASE} data-testid="chip-archived">
            archived
          </Box>
        ) : (
          <Box component="span" style={CHIP_BASE} data-testid="chip-wakes">
            wakes: {wakeMode}
          </Box>
        )}
```

- [ ] **Step 4: Wire the app**

In `src/app/App.tsx`'s `App`, after `openDm`:

```ts
  const setArchived = useCallback(
    async (room: string, archived: boolean) => {
      try {
        const res = await fetch('/api/chat/archive', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ room, archived }),
        });
        if (!res.ok) throw new Error('archive failed');
        refetchRooms();
      } catch {
        notifications.error(
          archived ? "Couldn't archive the room" : "Couldn't reopen the room"
        );
      }
    },
    [refetchRooms]
  );
```

and pass `onArchive={setArchived}` and `memberHandles={roomMembers}` to the desktop `PageBar` (every member of the open room, signed in or not).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bunx vitest run src/ui/PageBar.test.tsx src/app/App.test.tsx && bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ui/PageBar.tsx src/ui/PageBar.test.tsx src/app/App.tsx
git commit -m "page bar: room menu with archive (confirmed) and reopen, archived chip"
```

### Task 10: Rail: the collapsed archived section (desk and phone drawer)

**Files:**
- Modify: `src/ui/RoomRail.tsx` (imports 1-5, `RoomRow` 120-190, `RoomRail` 198-300)
- Modify: `src/app/App.tsx` (`PhoneDrawer` 556-735)
- Test: `src/ui/RoomRail.test.tsx`

**Interfaces:**
- Produces: rail rows for archived rooms (`data-testid="room-row-<room>"`, `data-archived="true"`, 0.6 opacity, no badges) inside a section toggled by `data-testid="archived-toggle"` (`aria-expanded`), collapsed by default and remembered under localStorage key `chat.rail.archived` (`true` = collapsed). The same section in the phone drawer with `phone-room-<room>` rows.
- Consumes: `RoomSummary.archivedAt`; the kit's `useLocalStorage` (`@ui/hooks`) and `AnimatedChevron` (`@ui/icons`).

- [ ] **Step 1: Write the failing tests**

Append to `src/ui/RoomRail.test.tsx`. The file renders with `renderWithProviders` from `@ui/storybook/test-utils`; add `import userEvent from '@testing-library/user-event';`, add `within` to the `@testing-library/react` import and `afterEach` to the vitest import:

```ts
afterEach(() => window.localStorage.removeItem('chat.rail.archived'));

test('archived rooms sit in a collapsed section, badge-less and dimmed, and the toggle remembers itself', async () => {
  const { unmount } = renderWithProviders(
    <RoomRail
      rooms={[
        { room: 'build', memberCount: 2, unread: 1, mentions: 0 },
        { room: 'retro', memberCount: 2, unread: 3, mentions: 1, archivedAt: 5 },
        { room: 'dm-1', memberCount: 2, unread: 0, mentions: 0, kind: 'dm', participants: { a: 'fred', b: 'matt' }, archivedAt: 6 },
      ]}
      activeRoom="build"
    />
  );
  expect(screen.getByText('ROOMS').nextSibling).toHaveTextContent('1');
  expect(screen.queryByTestId('room-row-retro')).toBeNull();
  const toggle = screen.getByTestId('archived-toggle');
  expect(toggle).toHaveTextContent('ARCHIVED');
  expect(toggle).toHaveTextContent('2');
  expect(toggle).toHaveAttribute('aria-expanded', 'false');

  await userEvent.click(toggle);
  const row = screen.getByTestId('room-row-retro');
  expect(row).toHaveAttribute('data-archived', 'true');
  expect(row.style.opacity).toBe('0.6');
  expect(within(row).queryByTestId('unread-badge')).toBeNull();
  expect(within(row).queryByTestId('mention-badge')).toBeNull();
  expect(screen.getByTestId('room-row-dm-1')).toHaveTextContent('fred');

  unmount();
  renderWithProviders(<RoomRail rooms={[{ room: 'retro', memberCount: 2, unread: 0, mentions: 0, archivedAt: 5 }]} />);
  expect(screen.getByTestId('archived-toggle')).toHaveAttribute('aria-expanded', 'true');
});

test('no archived rooms means no archived section', () => {
  renderWithProviders(<RoomRail rooms={[{ room: 'build', memberCount: 2, unread: 0, mentions: 0 }]} />);
  expect(screen.queryByTestId('archived-toggle')).toBeNull();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx vitest run src/ui/RoomRail.test.tsx`
Expected: FAIL: the archived room renders in the channel list; no toggle.

- [ ] **Step 3: Implement the section**

In `src/ui/RoomRail.tsx`:

Imports: add `import { useLocalStorage } from '@ui/hooks';` and `import { AnimatedChevron, Icon } from '@ui/icons';` (replacing the bare `Icon` import).

`RoomRow` gains `archived?: boolean`; the button gets `data-archived={archived ? 'true' : undefined}` and `opacity: archived ? 0.6 : undefined` in its style; the two badge lines become `{!archived && room.mentions > 0 && <MentionBadge .../>}` and `{!archived && room.unread > 0 && <UnreadBadge .../>}`.

In `RoomRail`:

```ts
  const openRooms = rooms.filter(r => r.archivedAt === undefined);
  const channelRooms = openRooms.filter(r => r.kind !== 'dm');
  const directRooms = openRooms.filter(r => r.kind === 'dm');
  const archivedRooms = rooms.filter(r => r.archivedAt !== undefined);
  const [archivedCollapsed, setArchivedCollapsed] = useLocalStorage<boolean>({
    key: 'chat.rail.archived',
    defaultValue: true,
  });
```

After the direct section (inside the outer `Stack`, after the closing `)}` of `directRooms.length > 0 && (...)`):

```tsx
      {archivedRooms.length > 0 && (
        <>
          <UnstyledButton
            data-testid="archived-toggle"
            aria-expanded={!archivedCollapsed}
            onClick={() => setArchivedCollapsed(!archivedCollapsed)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              width: '100%',
              padding: '10px var(--mantine-spacing-md) 4px',
              borderBottom: `1px solid var(--tk-border-soft)`,
            }}
          >
            <Text
              component="h3"
              fw={700}
              style={{
                margin: 0,
                fontSize: '9.5px',
                color: 'var(--tk-muted-text)',
                letterSpacing: '0.06em',
              }}
            >
              ARCHIVED
            </Text>
            <Text size="xs" style={{ color: 'var(--tk-muted-text)' }}>
              {archivedRooms.length}
            </Text>
            <Box style={{ flex: 1 }} />
            <AnimatedChevron
              opened={!archivedCollapsed}
              size={12}
              color="var(--tk-muted-text)"
            />
          </UnstyledButton>
          {!archivedCollapsed &&
            archivedRooms.map(room => (
              <RoomRow
                key={room.room}
                room={room}
                archived
                active={room.room === activeRoom}
                onSelect={() => onSelectRoom?.(room.room)}
              />
            ))}
        </>
      )}
```

(`AnimatedChevron` is `IconProps & { opened: boolean }` from `@ui/icons`; `color` and `size` are `IconProps`.)

In `src/app/App.tsx`'s `PhoneDrawer`: compute the same three lists plus the `useLocalStorage` pair (same key), pass `archived` into a `PhoneRoomRow` that gains the same `archived?: boolean` prop (dim, no badges), and add the section after the direct section using the drawer's `DIRECT` header styling with the label `ARCHIVED`, the count and the chevron, `data-testid="phone-archived-toggle"`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bunx vitest run src/ui/RoomRail.test.tsx src/app/App.test.tsx && bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/RoomRail.tsx src/ui/RoomRail.test.tsx src/app/App.tsx
git commit -m "rail: collapsed archived section, remembered per browser"
```

### Task 11: The archived room page: `ArchivedBar` in the composer's place; the phone ⋯

**Files:**
- Create: `src/ui/day-label.ts`, `src/ui/day-label.test.ts`
- Create: `src/ui/ArchivedBar.tsx`, `src/ui/ArchivedBar.test.tsx`
- Modify: `src/app/App.tsx` (`PhoneHeader` 356-440, `PhoneChat` composer 818-832, the desktop `Transcript` footer 1020-1040)
- Test: `src/app/App.test.tsx`

**Interfaces:**
- Produces:
  - `dayLabel(ts: number, now?: number): string` → `Today` / `Yesterday` / `Mon 24 Aug` / `Mon 24 Aug 2025`; `dayKey(ts): string` (local calendar day).
  - `ArchivedBar({ archivedAt, onReopen, phone? })`: `data-testid="archived-bar"`, text `Archived <dayLabel> · everyone keeps their place`, a `Reopen` button `data-testid="archived-reopen"`.
  - `PhoneHeader` gains `memberHandles` and `onArchive`, rendering `RoomMenu` at 44px after the counts.
- Consumes: Task 9's `RoomMenu` and `setArchived`.

- [ ] **Step 1: Write the failing tests**

`src/ui/day-label.test.ts`:

```ts
import { expect, test } from 'vitest';

import { dayKey, dayLabel } from './day-label';

const now = new Date(2026, 7, 26, 20, 0).getTime();
const days = (n: number) => now - n * 86_400_000;

test('dayLabel names today, yesterday, then the weekday and date, with the year only when it differs', () => {
  expect(dayLabel(now, now)).toBe('Today');
  expect(dayLabel(days(1), now)).toBe('Yesterday');
  expect(dayLabel(days(2), now)).toBe('Mon 24 Aug');
  expect(dayLabel(new Date(2025, 11, 31, 9, 0).getTime(), now)).toBe('Wed 31 Dec 2025');
});

test('dayKey follows the local calendar, not a 24h window', () => {
  const lateTonight = new Date(2026, 7, 26, 23, 59).getTime();
  const earlyTomorrow = new Date(2026, 7, 27, 0, 1).getTime();
  expect(dayKey(lateTonight)).not.toBe(dayKey(earlyTomorrow));
  expect(dayKey(lateTonight)).toBe(dayKey(now));
});
```

`src/ui/ArchivedBar.test.tsx`:

```tsx
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

import { renderWithProviders } from '@ui/storybook/test-utils';
import { ArchivedBar } from './ArchivedBar';

test('the archived bar says when, reassures, and reopens on its one button', async () => {
  const onReopen = vi.fn();
  renderWithProviders(
    <ArchivedBar archivedAt={Date.now() - 86_400_000} onReopen={onReopen} />
  );
  expect(screen.getByTestId('archived-bar')).toHaveTextContent(
    'Archived Yesterday · everyone keeps their place'
  );
  await userEvent.click(screen.getByTestId('archived-reopen'));
  expect(onReopen).toHaveBeenCalledTimes(1);
});
```

In `src/app/App.test.tsx`:

```ts
test('an archived room renders the archived bar instead of the composer, and Reopen posts archived:false', async () => {
  installFetchMock();
  window.history.replaceState(null, '', '/r/retro');
  renderWithProviders(
    <App
      initialState={{
        daemonReachable: true,
        buddies: [],
        rooms: [{ room: 'retro', memberCount: 1, unread: 0, mentions: 0, archivedAt: Date.now() - 3 * 86_400_000 }],
        members: [],
        messages: [{ id: 1, room: 'retro', handle: 'fred', body: 'closing out', mentions: [], postedAt: Date.now() }],
      }}
    />
  );
  expect(await screen.findByTestId('archived-bar')).toBeInTheDocument();
  expect(screen.queryByTestId('composer')).toBeNull();
  expect(screen.queryByTestId('mark-read-button')).toBeNull();
  await userEvent.click(screen.getByTestId('archived-reopen'));
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/chat/archive',
    expect.objectContaining({ method: 'POST', body: JSON.stringify({ room: 'retro', archived: false }) })
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx vitest run src/ui/day-label.test.ts src/ui/ArchivedBar.test.tsx src/app/App.test.tsx`
Expected: FAIL: modules missing; the App still renders the composer.

- [ ] **Step 3: Implement**

`src/ui/day-label.ts`:

```ts
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** The local calendar day a timestamp falls on, as a comparable key. */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function dayLabel(ts: number, now = Date.now()): string {
  const key = dayKey(ts);
  if (key === dayKey(now)) return 'Today';
  if (key === dayKey(now - 86_400_000)) return 'Yesterday';
  const d = new Date(ts);
  const base = `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === new Date(now).getFullYear()
    ? base
    : `${base} ${d.getFullYear()}`;
}
```

`src/ui/ArchivedBar.tsx`:

```tsx
import { Button, Group, Text } from '@mantine/core';

import { dayLabel } from './day-label';

export interface ArchivedBarProps {
  archivedAt: number;
  onReopen: () => void;
  /** Phone chrome: the panel surface and 44px controls. @default false */
  phone?: boolean;
}

/** What replaces the composer on an archived room: when, a reassurance
    that nobody lost their place, and the one way back. */
export function ArchivedBar({ archivedAt, onReopen, phone = false }: ArchivedBarProps) {
  return (
    <Group
      data-testid="archived-bar"
      justify="space-between"
      wrap="nowrap"
      style={{
        height: 44,
        flex: 'none',
        padding: phone ? '0 var(--mantine-spacing-lg)' : '0 var(--mantine-spacing-md)',
        marginTop: phone ? 0 : 'var(--mantine-spacing-xs)',
        background: phone ? 'var(--tk-panel)' : undefined,
        borderTop: `1px solid ${phone ? 'var(--tk-border)' : 'var(--tk-border-soft)'}`,
      }}
    >
      <Text size="xs" truncate style={{ color: 'var(--tk-muted-text)', minWidth: 0 }}>
        Archived {dayLabel(archivedAt)} · everyone keeps their place
      </Text>
      <Button
        size="xs"
        variant="default"
        radius="md"
        data-testid="archived-reopen"
        onClick={onReopen}
        style={{ flex: 'none', height: phone ? 36 : undefined }}
      >
        Reopen
      </Button>
    </Group>
  );
}
```

In `src/app/App.tsx`:

- import `ArchivedBar` from `@ui/ArchivedBar` and `RoomMenu` from `@ui/PageBar`;
- desktop: the `Transcript`'s `footer` becomes

```tsx
                        footer={
                          activeRoomSummary?.archivedAt !== undefined ? (
                            <ArchivedBar
                              archivedAt={activeRoomSummary.archivedAt}
                              onReopen={() => void setArchived(activeRoom, false)}
                            />
                          ) : (
                            <Composer
                              ref={composerRef}
                              room={activeRoom}
                              roomMembers={roomMembers}
                              buddies={buddies}
                              isDm={activeRoomSummary?.kind === 'dm'}
                              daemonReachable={daemon.reachable}
                              onOpenDm={openDm}
                            />
                          )
                        }
```

- `PhoneChat`: gains `onArchive: (room: string, archived: boolean) => void`; renders `<ArchivedBar phone archivedAt={...} onReopen={() => onArchive(activeRoom, false)} />` in place of the `Composer` when `activeRoomSummary?.archivedAt !== undefined`; passes `memberHandles={roomMembers}` and `onArchive` to `PhoneHeader`.
- `PhoneHeader`: gains `memberHandles: string[]` and `onArchive`; after the fleet-count button, when `room` is defined:

```tsx
      {room && (
        <RoomMenu
          room={room}
          memberHandles={memberHandles}
          onArchive={onArchive}
          size={PHONE_TAP}
        />
      )}
```

- `App` passes `onArchive={setArchived}` to `PhoneChat`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bunx vitest run src/ui src/app && bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/day-label.ts src/ui/day-label.test.ts src/ui/ArchivedBar.tsx src/ui/ArchivedBar.test.tsx src/app/App.tsx src/app/App.test.tsx
git commit -m "archived room: the bar replaces the composer, phone header gets the room menu"
```

### Task 12: Transcript day dividers and full timestamps

**Files:**
- Modify: `src/ui/Transcript.tsx` (`MessageRow` 340-372, the list render 645-680, `loadOlder` 548-583)
- Test: `src/ui/Transcript.test.tsx`

**Interfaces:**
- Produces: a `data-testid="day-divider"` row (`aria-label="<label>"`) between messages on different local days and above the first message once an older page has been loaded; each time element carries `title` with `new Date(postedAt).toLocaleString()`.
- Consumes: Task 11's `dayLabel`/`dayKey`.

- [ ] **Step 1: Write the failing tests**

Append to `src/ui/Transcript.test.tsx`:

```tsx
test('a day divider sits between messages on different days, never between same-day ones', () => {
  // Today at noon: `Transcript` labels against the real clock, so the
  // fixture must be anchored to the day the test runs, never a fixed date.
  const noon = new Date();
  noon.setHours(12, 0, 0, 0);
  const now = noon.getTime();
  const msg = (id: number, postedAt: number) => ({
    id, room: 'build', handle: 'fred', body: `m${id}`, mentions: [], postedAt,
  });
  renderWithProviders(
    <Transcript
      room="build"
      messages={[
        msg(1, now - 2 * 86_400_000),
        msg(2, now - 2 * 86_400_000 + 60_000),
        msg(3, now - 86_400_000),
        msg(4, now),
      ]}
    />
  );
  const dividers = screen.getAllByTestId('day-divider');
  expect(dividers.map(d => d.getAttribute('aria-label'))).toEqual(['Yesterday', 'Today']);
  expect(screen.getByTestId('message-4').querySelector('[title]')?.getAttribute('title')).toBe(
    new Date(now).toLocaleString()
  );
});

test('loading an older page puts a day divider above what was the first message', async () => {
  const now = Date.now();
  renderTranscriptWithFakeSocket({
    room: 'build',
    messages: [{ id: 5, room: 'build', handle: 'fred', body: 'new', mentions: [], postedAt: now }],
  });
  expect(screen.queryByTestId('day-divider')).toBeNull();
  // Queued AFTER the render: `renderTranscriptWithFakeSocket` installs the
  // fetch mock, and the `before=` request is the next call it answers.
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({
      messages: [{ id: 1, room: 'build', handle: 'fred', body: 'old', mentions: [], postedAt: now - 3 * 86_400_000 }],
    }),
  } as Response);
  fireEvent.click(screen.getByTestId('transcript-edge'));
  await screen.findByTestId('message-1');
  // Two: one above the loaded page (labelled with message 1's own day,
  // which depends on the clock) and one at the boundary into today.
  const labels = screen.getAllByTestId('day-divider').map(d => d.getAttribute('aria-label'));
  expect(labels).toHaveLength(2);
  expect(labels[1]).toBe('Today');
});
```

If `renderTranscriptWithFakeSocket` (src/ui/test-utils.tsx:105) does not install the fetch mock itself, call `installFetchMock()` before the render instead; the queued response stays where it is.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx vitest run src/ui/Transcript.test.tsx`
Expected: FAIL: no `day-divider`.

- [ ] **Step 3: Implement**

In `src/ui/Transcript.tsx`:

Import `{ dayKey, dayLabel } from './day-label'`.

Add a component above `MessageRow`:

```tsx
/** A muted counterpart of the read-cursor divider: rules either side, the
    day in the middle. */
function DayDivider({ label }: { label: string }) {
  const rule = {
    flex: 1,
    height: 1,
    background: 'var(--tk-border-soft)',
  } as const;
  return (
    <Group
      gap="sm"
      wrap="nowrap"
      align="center"
      data-testid="day-divider"
      aria-label={label}
      style={{
        color: 'var(--tk-muted-text)',
        fontSize: '10.56px',
        fontWeight: 600,
        padding: 'var(--mantine-spacing-xs) 0',
      }}
    >
      <Box style={rule} />
      <span>{label}</span>
      <Box style={rule} />
    </Group>
  );
}
```

In `MessageRow`, the time `Text` gains `title={new Date(message.postedAt).toLocaleString()}`.

In `Transcript`: add `const [olderLoaded, setOlderLoaded] = useState(false);`, reset it in the `[room]` effect beside `setOlderExhausted(false)`, and set `setOlderLoaded(true)` inside `loadOlder` where `older.length > 0`.

In the list render, before the unread-divider check inside the `Fragment`:

```tsx
                  {(i === 0
                    ? olderLoaded
                    : dayKey(messages[i - 1]!.postedAt) !== dayKey(message.postedAt)) && (
                    <DayDivider label={dayLabel(message.postedAt)} />
                  )}
```

(The day divider renders before the unread divider when both apply to the same slot, which is the order the JSX above produces.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bunx vitest run src/ui/Transcript.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/Transcript.tsx src/ui/Transcript.test.tsx
git commit -m "transcript: day dividers, full timestamps on hover"
```

### Task 13: The counted "new" pill

**Files:**
- Create: `src/ui/NewPill.tsx`
- Modify: `src/ui/Transcript.tsx` (state, the WS merge 511-533, the scroll box 618-628)
- Modify: `src/ui/transcript-scroll.module.css` (`.follow` rules)
- Test: `src/ui/Transcript.test.tsx`

**Interfaces:**
- Produces: `NewPill({ count, onClick })`: `data-testid="new-pill"`, text `↓ N new` or `↓ latest`. Rendered by `Transcript` in the scroll box only while the viewer is away from the bottom; `count` = messages merged live since the viewer left the bottom, reset on return.
- Consumes: nothing new.

- [ ] **Step 1: Write the failing test**

Append to `src/ui/Transcript.test.tsx`:

```tsx
function viewOf(transcript: HTMLElement): HTMLElement {
  return transcript.querySelector<HTMLElement>('[class*="view"]')!;
}

function scrollTo(view: HTMLElement, top: number, height = 1000, client = 300) {
  Object.defineProperty(view, 'scrollHeight', { configurable: true, value: height });
  Object.defineProperty(view, 'clientHeight', { configurable: true, value: client });
  Object.defineProperty(view, 'scrollTop', { configurable: true, writable: true, value: top });
  fireEvent.scroll(view);
}

test('the new pill counts live arrivals while scrolled up and goes away at the bottom', async () => {
  const { pushFrame } = renderTranscriptWithFakeSocket({
    room: 'build',
    messages: [{ id: 1, room: 'build', handle: 'fred', body: 'first', mentions: [], postedAt: Date.now() }],
  });
  const view = viewOf(screen.getByTestId('transcript-scroll'));
  expect(screen.queryByTestId('new-pill')).toBeNull();

  scrollTo(view, 100);
  expect(screen.getByTestId('new-pill')).toHaveTextContent('↓ latest');

  pushFrame({ topic: 'chat/build/msg', payload: { id: 7 } });
  await screen.findByTestId('message-7');
  expect(screen.getByTestId('new-pill')).toHaveTextContent('↓ 1 new');

  scrollTo(view, 700);
  expect(screen.queryByTestId('new-pill')).toBeNull();
});
```

Check `renderTranscriptWithFakeSocket` (src/ui/test-utils.tsx:105) to confirm a pushed frame's refetch resolves with a message whose id matches the frame; the existing "a chat frame appends" test relies on the same thing.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run src/ui/Transcript.test.tsx -t "new pill"`
Expected: FAIL: no `new-pill`.

- [ ] **Step 3: Implement**

`src/ui/NewPill.tsx`:

```tsx
import { UnstyledButton } from '@mantine/core';

const ACCENT_TEXT = 'var(--mantine-color-accent-text)';

export interface NewPillProps {
  /** Live arrivals since the viewer scrolled away; 0 reads `latest`. */
  count: number;
  onClick: () => void;
}

/** The follow control, with the one fact a reader who scrolled up wants:
    how much arrived meanwhile. Opaque, so it reads over any message. */
export function NewPill({ count, onClick }: NewPillProps) {
  return (
    <UnstyledButton
      data-testid="new-pill"
      aria-label={count > 0 ? `${count} new messages, jump to latest` : 'Jump to latest'}
      onClick={onClick}
      style={{
        position: 'absolute',
        right: 30,
        bottom: 30,
        zIndex: 1,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        height: 26,
        padding: '0 10px',
        borderRadius: 13,
        fontSize: '10.56px',
        fontWeight: 600,
        color: ACCENT_TEXT,
        background: `color-mix(in srgb, ${ACCENT_TEXT} var(--tk-wash), var(--tk-card))`,
        border: `1px solid color-mix(in srgb, ${ACCENT_TEXT} 45%, transparent)`,
        boxShadow: '0 2px 8px rgba(0,0,0,0.18)',
      }}
    >
      ↓ {count > 0 ? `${count} new` : 'latest'}
    </UnstyledButton>
  );
}
```

In `src/ui/transcript-scroll.module.css`, replace the three `.follow` rules with:

```css
/* The library's own follow circle is replaced by NewPill, which knows how
   many messages arrived; the class must still exist for the prop. */
.follow {
  display: none;
}
```

In `src/ui/Transcript.tsx`:

- import `{ NewPill } from './NewPill'`;
- state: `const [awayFromBottom, setAwayFromBottom] = useState(false);` and `const [newSinceAway, setNewSinceAway] = useState(0);`, plus `const awayRef = useRef(false);` and `const messagesRef = useRef(messages); messagesRef.current = messages;`;
- a scroll listener effect after the WS effect:

```ts
  useEffect(() => {
    const view = scrollView();
    if (!view) return;
    const onScroll = () => {
      const away = view.scrollHeight - view.scrollTop - view.clientHeight > 4;
      awayRef.current = away;
      setAwayFromBottom(away);
      if (!away) setNewSinceAway(0);
    };
    view.addEventListener('scroll', onScroll, { passive: true });
    return () => view.removeEventListener('scroll', onScroll);
    // `scrollView` reads a ref; the listener is per room like the socket.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room]);
```

- in the WS handler's `.then`, replace `setMessages(prev => mergeMessages(prev, data.messages ?? []));` with:

```ts
          const next = mergeMessages(messagesRef.current, data.messages ?? []);
          const added = next.length - messagesRef.current.length;
          if (added > 0 && awayRef.current) setNewSinceAway(n => n + added);
          setMessages(next);
```

- reset in the `[room]` effect: `setNewSinceAway(0); setAwayFromBottom(false); awayRef.current = false;`;
- inside the `scrollBoxRef` `Box`, after `</ScrollToBottom>`:

```tsx
        {awayFromBottom && (
          <NewPill
            count={newSinceAway}
            onClick={() => {
              const view = scrollView();
              if (!view) return;
              if (typeof view.scrollTo === 'function') {
                view.scrollTo({ top: view.scrollHeight, behavior: 'smooth' });
              } else {
                view.scrollTop = view.scrollHeight;
              }
            }}
          />
        )}
```

The `.box` is already `position: relative`, so the pill anchors to the panel, not the scrolling content.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bunx vitest run src/ui/Transcript.test.tsx && bun run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/NewPill.tsx src/ui/Transcript.tsx src/ui/transcript-scroll.module.css src/ui/Transcript.test.tsx
git commit -m "transcript: the new pill counts what arrived while scrolled up"
```

### Task 14: Copy a code block

**Files:**
- Create: `src/ui/transcript-body.module.css`
- Modify: `src/ui/Transcript.tsx` (`MessageBody` 287-336)
- Test: `src/ui/Transcript.test.tsx`

**Interfaces:**
- Produces: each fenced block wrapped in `data-testid="code-wrap"` holding the `pre` and a `data-testid="code-copy"` wrapper around the kit's `CopyActionIcon`; copying writes the block's raw text.
- Consumes: `CopyActionIcon` from `@ui/core`.

- [ ] **Step 1: Write the failing test**

Append to `src/ui/Transcript.test.tsx`:

```tsx
test('a code block carries a copy control that writes the block text only', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  renderWithProviders(
    <Transcript
      room="build"
      messages={[{ id: 1, room: 'build', handle: 'fred', body: 'see:\n```\nline one\nline two\n```', mentions: [], postedAt: Date.now() }]}
    />
  );
  const copy = screen.getByTestId('code-copy').querySelector('button')!;
  fireEvent.click(copy);
  expect(writeText).toHaveBeenCalledWith('line one\nline two');
});
```

Add `vi` to the vitest import.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run src/ui/Transcript.test.tsx -t "copy control"`
Expected: FAIL: no `code-copy`.

- [ ] **Step 3: Implement**

`src/ui/transcript-body.module.css`:

```css
/* The copy control rides the block's top-right corner and shows on hover or
   focus; a touch screen has no hover, so there it is always shown. */
.codeWrap {
  position: relative;
}

.copy {
  position: absolute;
  top: 6px;
  right: 6px;
  opacity: 0;
  transition: opacity 120ms ease;
}

.codeWrap:hover .copy,
.copy:focus-within {
  opacity: 1;
}

@media (hover: none) {
  .copy {
    opacity: 1;
  }
}
```

In `src/ui/Transcript.tsx`: import `{ CopyActionIcon } from '@ui/core'` and `bodyClasses from './transcript-body.module.css'`; in `MessageBody`, the code branch becomes:

```tsx
          <Box
            key={`part-${i}`}
            className={bodyClasses.codeWrap}
            data-testid="code-wrap"
          >
            <Box
              component="pre"
              data-testid="code-block"
              style={{
                display: 'block',
                background: 'var(--ui-bg-1)',
                border: '1px solid var(--mantine-color-default-border)',
                borderRadius: 'var(--mantine-radius-sm)',
                fontSize: '11.2px',
                lineHeight: 1.5,
                marginTop: 'var(--mantine-spacing-xs)',
                overflowX: 'auto',
                padding: 'var(--mantine-spacing-sm) var(--mantine-spacing-md)',
                whiteSpace: 'pre',
                fontFamily: 'inherit',
              }}
            >
              {part.content}
            </Box>
            <Box className={bodyClasses.copy} data-testid="code-copy">
              <CopyActionIcon
                value={part.content}
                label="Copy"
                size="sm"
                variant="default"
                iconSize={14}
                aria-label="Copy code"
              />
            </Box>
          </Box>
```

(`CopyActionIcon` uses `@mantine/hooks`' `useClipboard`, which calls `navigator.clipboard.writeText`; the test installs that.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bunx vitest run src/ui/Transcript.test.tsx`
Expected: PASS, including the older `wide content scrolls inside its own container` test (the `pre` keeps its inline `overflowX`).

- [ ] **Step 5: Commit**

```bash
git add src/ui/transcript-body.module.css src/ui/Transcript.tsx src/ui/Transcript.test.tsx
git commit -m "transcript: copy a code block"
```

### Task 15: Collapse tall posts (first to drop)

**Files:**
- Modify: `src/ui/Transcript.tsx` (`MessageBody`, `MessageRow`, the list render), `src/ui/transcript-body.module.css`
- Test: `src/ui/Transcript.test.tsx`

**Interfaces:**
- Produces: a body taller than `COLLAPSE_AT = 480` px renders inside `data-testid="message-fold"` (`data-folded="true"` while collapsed, max-height 320px, a fade) with a `show more` / `show less` button `data-testid="fold-toggle"`. The anchored message (`#m-<id>`) mounts expanded.
- Consumes: Task 12's row structure.

- [ ] **Step 1: Write the failing tests**

Append to `src/ui/Transcript.test.tsx`:

```tsx
function withTallBodies(run: () => void) {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get() {
      return (this as HTMLElement).dataset.testid === 'message-body' ? 900 : 0;
    },
  });
  try {
    run();
  } finally {
    if (original) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', original);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollHeight;
  }
}

const tall = { id: 1, room: 'build', handle: 'fred', body: Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n'), mentions: [], postedAt: Date.now() };

test('a tall body folds with a show more control, and unfolds on click', async () => {
  withTallBodies(() => {
    renderWithProviders(<Transcript room="build" messages={[tall]} />);
  });
  const fold = screen.getByTestId('message-fold');
  expect(fold).toHaveAttribute('data-folded', 'true');
  fireEvent.click(screen.getByTestId('fold-toggle'));
  expect(fold).toHaveAttribute('data-folded', 'false');
  expect(screen.getByTestId('fold-toggle')).toHaveTextContent('show less');
});

test('the anchored message mounts unfolded; a short body never folds', () => {
  withTallBodies(() => {
    renderWithProviders(<Transcript room="build" messages={[tall]} anchor="m-1" />);
  });
  expect(screen.getByTestId('message-fold')).toHaveAttribute('data-folded', 'false');
  renderWithProviders(
    <Transcript room="other" messages={[{ ...tall, id: 2, room: 'other', body: 'short' }]} />
  );
  expect(screen.getAllByTestId('message-fold')).toHaveLength(1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx vitest run src/ui/Transcript.test.tsx -t "fold"`
Expected: FAIL: no `message-fold`.

- [ ] **Step 3: Implement**

Add to `src/ui/transcript-body.module.css`:

```css
.fold {
  position: relative;
  max-height: 320px;
  overflow: hidden;
}

.fold::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 48px;
  background: linear-gradient(to bottom, transparent, var(--tk-card));
  pointer-events: none;
}
```

In `src/ui/Transcript.tsx`:

```ts
const COLLAPSE_AT = 480;
```

`MessageBody` gains `startExpanded: boolean` and measures itself:

```tsx
function MessageBody({
  message,
  humanHandle,
  startExpanded,
}: {
  message: ChatMessage;
  humanHandle: string | undefined;
  startExpanded: boolean;
}) {
  const parts = splitCodeFences(message.body);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [tall, setTall] = useState(false);
  const [expanded, setExpanded] = useState(startExpanded);

  useLayoutEffect(() => {
    setTall((bodyRef.current?.scrollHeight ?? 0) > COLLAPSE_AT);
  }, [message.id]);

  const folded = tall && !expanded;
  const body = (
    <Text
      ref={bodyRef}
      component="div"
      data-testid="message-body"
      style={{
        fontSize: '12.16px',
        lineHeight: 1.55,
        whiteSpace: 'pre-wrap',
        minWidth: 0,
        overflowWrap: 'anywhere',
      }}
    >
      {parts.map((part, i) =>
        part.type === 'code' ? (
          <Box key={`part-${i}`} className={bodyClasses.codeWrap} data-testid="code-wrap">
            <Box
              component="pre"
              data-testid="code-block"
              style={{
                display: 'block',
                background: 'var(--ui-bg-1)',
                border: '1px solid var(--mantine-color-default-border)',
                borderRadius: 'var(--mantine-radius-sm)',
                fontSize: '11.2px',
                lineHeight: 1.5,
                marginTop: 'var(--mantine-spacing-xs)',
                overflowX: 'auto',
                padding: 'var(--mantine-spacing-sm) var(--mantine-spacing-md)',
                whiteSpace: 'pre',
                fontFamily: 'inherit',
              }}
            >
              {part.content}
            </Box>
            <Box className={bodyClasses.copy} data-testid="code-copy">
              <CopyActionIcon value={part.content} label="Copy" size="sm" variant="default" iconSize={14} aria-label="Copy code" />
            </Box>
          </Box>
        ) : (
          <span key={`part-${i}`}>
            {renderBlocks(part.content, message.mentions, humanHandle, `p${i}`)}
          </span>
        )
      )}
    </Text>
  );
  if (!tall) return body;
  return (
    <Box data-testid="message-fold" data-folded={folded ? 'true' : 'false'}>
      <Box className={folded ? bodyClasses.fold : undefined}>{body}</Box>
      <UnstyledButton
        data-testid="fold-toggle"
        onClick={() => setExpanded(e => !e)}
        style={{
          marginTop: 4,
          fontSize: '10.56px',
          fontWeight: 600,
          color: ACCENT_TEXT,
        }}
      >
        {folded ? 'show more' : 'show less'}
      </UnstyledButton>
    </Box>
  );
}
```

`MessageRow` gains `anchored: boolean` and passes `startExpanded={anchored}`; the list passes `anchored={anchor === `m-${message.id}`}`. Add `useRef`/`useLayoutEffect` to the React import if not already there (they are).

Measuring with `scrollHeight` on the unconstrained body is what lets the test drive it; a `ResizeObserver` is not needed because a body's height only changes with its message id.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bunx vitest run src/ui/Transcript.test.tsx && bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 5: Check the sticky-bottom behaviour by hand (the drop criterion)**

Run `bun run build && CHAT_FIXTURES=1 PORT=11003 bun src/server/index.ts`, open `http://localhost:11003/r/build` (ask Matt first, per his browser rule), scroll to the top, expand message 48, and confirm the viewport does not jump to the bottom and the pill does not appear. If it does either, revert this task (`git revert` its commit) and note it in the PR.

- [ ] **Step 6: Commit**

```bash
git add src/ui/Transcript.tsx src/ui/transcript-body.module.css src/ui/Transcript.test.tsx
git commit -m "transcript: fold tall posts behind show more"
```

### Task 16: Conformance: artboards, anatomy, audit

**Files:**
- Modify: `design/build.py` (CSS block, `rooms_rail`, `MSGS`/`transcript`, `desktop`, the canvas list at 633-641), regenerate `design/artboards/*.dc.html`, `design/spec.json`
- Modify: `design/ANATOMY.md`, `design/audit.mjs` (`TARGETS`)
- Modify: `ARCHITECTURE.md` ("What renders in a message body")

**Interfaces:**
- Produces: spec selectors `.day`, `.pill`, `.copy`, `.fold`, `.more`, `.menu`, `.room.archived`, `.archived-bar` (the archived chip is a plain `.chip`); a new artboard `Archived.dc.html`; `TARGETS` entries for `day-divider`, `new-pill`, `code-copy`, `message-fold`, `fold-toggle`, `room-menu`, `archived-toggle`, `room-row-retro-0819`, `chip-archived`, `archived-bar`, `archived-reopen`.

- [ ] **Step 1: Extend the artboard CSS**

In `build.py`'s `CSS`, after the `.divider::before, .divider::after` line:

```css
    .day { display: flex; align-items: center; gap: 7.2px; color: var(--muted-text); font-size: 10.56px; font-weight: 600; padding: 4.8px 0; }
    .day::before, .day::after { content: ''; flex: 1; height: 1px; background: var(--border-soft); }
    .pill { position: absolute; right: 30px; bottom: 30px; display: inline-flex; align-items: center; gap: 4px; height: 26px; padding: 0 10px; border-radius: 13px; font-size: 10.56px; font-weight: 600; color: var(--accent); background: color-mix(in srgb, var(--accent) var(--wash), var(--bg3)); border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent); box-shadow: 0 2px 8px rgba(0,0,0,0.18); }
    .codewrap { position: relative; }
    .copy { position: absolute; top: 6px; right: 6px; width: 22px; height: 22px; border-radius: 6px; display: inline-flex; align-items: center; justify-content: center; background: var(--bg1); border: 1px solid var(--border); color: var(--muted-text); }
    .fold { position: relative; max-height: 320px; overflow: hidden; }
    .more { margin-top: 4px; font-size: 10.56px; font-weight: 600; color: var(--accent); background: transparent; border: 0; padding: 0; cursor: pointer; }
    .menu { width: 30px; height: 30px; border-radius: 6px; display: inline-flex; align-items: center; justify-content: center; background: var(--bg1); border: 1px solid var(--border); color: var(--muted-text); }
    .room.archived { opacity: 0.6; }
    .sect.toggle { cursor: pointer; }
    .archived-bar { display: flex; align-items: center; justify-content: space-between; height: 44px; padding: 0 9.6px; margin-top: 4.8px; border-top: 1px solid var(--border-soft); }
```

Also add a `'more'` icon (an ellipsis) and `'copy'` icon to `ICON`, using lucide's `ellipsis` and `copy` paths at the same stroke settings as the others.

- [ ] **Step 2: Draw the elements**

- `rooms_rail(stale=False, archived_open=False)`: after the footnote, append a `.sect.toggle` row `ARCHIVED 2` with the `chev` icon; when `archived_open`, two `.room.archived` rows (`retro-0819`, and the pair `board-fix-auth ↔ matt`).
- `MSGS`: insert `('__day__', None, 'Today', None)` before the first message and the 60-line log post from the fixtures (Task 7) as the last entry with a `code` body; `transcript()` renders `__day__` as `<div class="day" aria-label="Today">Today</div>`, wraps every `code` in `<span class="codewrap"><span class="code">…</span><button class="copy" aria-label="Copy code">{ic('copy', 14)}</button></span>`, and renders the long one inside `<div class="fold">…</div><button class="more">show more</button>`.
- `transcript()` gains a `pill=False` argument that appends `<button class="pill">↓ 3 new</button>` inside the scroller; `desktop()` calls it with `pill=True` so Main shows it.
- `desktop()`'s page bar: after the order select add `<div style="width: 7.2px;"></div><button class="menu" aria-label="Room actions">{ic('more', 16)}</button>`.
- New `desktop_archived()` reusing `desktop()`'s pieces with: title `retro-0819`, chips `2 in room`, `1 listening`, `1 deaf: gitq-main`, `<span class="chip">archived</span>`, no mark read, the rail with `archived_open=True` and the archived row `.on`, the retro transcript (four messages across a `Yesterday`-style day divider), and `<div class="archived-bar"><span class="xs muted">Archived Sun 23 Aug · everyone keeps their place</span><button class="row" style="height: 30px; padding: 0 9.6px; background: var(--bg1); border: 1px solid var(--border); border-radius: 6px; font-family: inherit; font-size: 12.16px;">Reopen</button></div>` in place of the composer. Written to `Archived.dc.html`, added to the canvas list at `x: 0, y: 3060, w: 1440, h: 900, title: "An archived room"`.

Run: `cd design/artboards && python3 ../build.py && cd .. && python3 extract-spec.py`
Expected: the artboards regenerate; `spec.json` reports the new selectors.

- [ ] **Step 3: Write the anatomy**

In `design/ANATOMY.md`:

- Rooms rail: after the footnote paragraph, add a paragraph: `Then, only when an archived room exists, a `.sect.toggle` row reading `ARCHIVED N` with a chevron, collapsed by default and remembered per browser. Archived rows are `.room.archived` (opacity 0.6) with no badges; a DM keeps its `.pair` name.`
- Page bar: after the `wakes: <mode>` chip bullet, add `- `archived`: plain chip, replaces `wakes` on an archived room; `mark read` is hidden there`, and after the controls description: `A 30px `.menu` (⋯) sits last: `Archive #room…` (confirm names the members who lose it) or `Reopen`.`
- Transcript: after the read-cursor divider paragraph: `A day boundary is a `.day` divider (muted, 10.56px / 600, soft rules either side): `Today`, `Yesterday`, else `Mon 24 Aug`, with the year when it differs. Each fenced block is a `.codewrap` with a `.copy` control (22px) at its top-right, shown on hover or focus, always on touch. A body taller than 480px renders in a `.fold` (320px, a 48px fade) with a `.more` button: `show more` / `show less`; the anchored message never folds. While the viewer is scrolled up, a `.pill` (26px, accent on an opaque wash, 30px from the bottom-right) reads `↓ N new` or `↓ latest` and returns to the bottom.`
- A new `## Archived room` section: `The composer is replaced by an `.archived-bar` (44px, soft top border): `Archived <day> · everyone keeps their place` in `.xs.muted` and a default `Reopen` button. The transcript, roster and page bar are otherwise unchanged.`

- [ ] **Step 4: Add the audit targets**

Append to `TARGETS` in `design/audit.mjs`, following the existing entry shape:

```js
  // QoL round 1 -- day dividers, the new pill, code copy, the fold.
  { spec: '.day', find: '[data-testid="day-divider"]', props: ['align-items', 'color', 'display', 'font-size', 'font-weight', 'gap'], why: { padding: 'shorthand not enumerated; longhands verified by eye' } },
  { spec: '.pill', find: '[data-testid="new-pill"]', props: ['position', 'right', 'bottom', 'height', 'border-radius', 'font-size', 'font-weight', 'color'], why: { background: 'color-mix over the card token, verified by eye', border: 'verified by eye', padding: 'shorthand not enumerated; longhands verified by eye', display: 'inline-flex blockifies in some parents; verified in source', gap: 'verified by eye' } },
  { spec: '.copy', find: '[data-testid="code-copy"] button', props: ['width', 'height', 'border-radius'], why: { position: 'on the wrapper, not the button; verified by eye', top: 'wrapper', right: 'wrapper', display: 'ActionIcon authors inline-flex', background: 'theme token', border: 'theme token', color: 'theme token', 'align-items': 'verified by eye', 'justify-content': 'verified by eye' } },
  { spec: '.fold', find: '[data-testid="message-fold"][data-folded="true"] > div', props: ['max-height', 'overflow', 'position'] },
  { spec: '.more', find: '[data-testid="fold-toggle"]', props: ['font-size', 'font-weight', 'color', 'margin-top'], why: { background: 'UnstyledButton, verified by eye', border: 'UnstyledButton', padding: 'UnstyledButton', cursor: 'verified by eye' } },
  // QoL round 1 -- archive: the menu, the rail section, the chip, the bar.
  { spec: '.menu', find: '[data-testid="room-menu"]', props: ['width', 'height', 'border-radius'], why: { display: 'ActionIcon authors inline-flex; blockifies as a flex item', background: 'CONTROL_SURFACE token, verified by eye', border: 'token', color: 'token', 'align-items': 'verified by eye', 'justify-content': 'verified by eye' } },
  { spec: '.room.archived', find: '[data-testid="room-row-retro-0819"]', props: ['opacity'] },
  { spec: '.chip', find: '[data-testid="chip-archived"]', props: ['display', 'align-items', 'gap', 'height', 'border-radius', 'font-size', 'font-weight', 'white-space', 'color'], why: { padding: 'shorthand not enumerated; longhands verified by eye', border: 'token' } },
  { spec: '.archived-bar', find: '[data-testid="archived-bar"]', props: ['display', 'align-items', 'justify-content', 'height', 'margin-top'], why: { padding: 'shorthand not enumerated; longhands verified by eye', 'border-top': 'token' } },
```

The pill, the fold and the archived entries need their state on screen: capture once on `/r/build` scrolled up with a live arrival (or with the fixtures' 60-line post folded and the archived section expanded), and once on `/r/retro-0819`. Follow CONFORMANCE.md's two-step capture (`node design/audit.mjs --probe`, then Fast Browser's `browser_evaluate`, then `node design/audit.mjs <computed.json>`), against `CHAT_FIXTURES=1 PORT=11003 bun src/server/index.ts` after `bun run build`. Tell Matt before the capture: it drives his Chrome.

Run: `node design/audit.mjs /Users/matt/.fast-browser/chat-shots/computed.json`
Expected: 0 mismatches for every new target; fix the component, never the spec, on a mismatch.

- [ ] **Step 5: Update ARCHITECTURE.md's body section**

Append two bullets to "What renders in a message body": `- a copy control on every fenced block` and `- a fold on a body taller than 480px, expanded by `show more` and always expanded for the linked message`. Add one line after the list: `Day dividers split the list at local-date boundaries; a `↓ N new` pill appears while the viewer is scrolled up.`

- [ ] **Step 6: Commit**

```bash
git add design ARCHITECTURE.md
git commit -m "design: artboards, anatomy and audit targets for archive, dividers, pill, copy, fold"
```

### Task 17: Full viewer verification, PR, deploy

- [ ] **Step 1: Run every gate**

```bash
bun run typecheck && bun run lint && bunx vitest run && bun run build && bun run format:check
```

Expected: all green. Run `bun run format` if `format:check` complains and amend.

- [ ] **Step 2: Rebase and push**

```bash
git fetch origin
git rebase origin/main
```

If the invite lane landed first, resolve `src/server/chat.ts`, `PageBar.tsx`, `RoomRail.tsx`, `App.tsx`, `build.py`, `ANATOMY.md`, `audit.mjs` keeping both lanes' additions side by side (the ⋯ menu stays a separate control from `add agents`), re-run step 1, then:

```bash
git push -u origin worktree-chat-qol
gh pr create --title "chat: archive rooms, DM as a room, readable transcripts" --body "$(cat <<'EOF'
## Archive rooms, DM as a room, readable transcripts

Spec: repo-tools `docs/superpowers/specs/2026-08-26-rt-chat-qol-design.md`. Needs `@mattstack/rt-client` 0.7.0.

### What changed

**Server** (`src/server/chat.ts`)

- Lists the human's archived rooms with `archivedAt`
- Adds `POST /api/chat/archive` (joins the human first for an unjoined channel) and `POST /api/chat/dm/open`
- Removes `POST /api/chat/dm`

**DM**

- `DM` on a card, a roster pick, and the `@` popover's non-member entry all open the DM room and move there
- Deletes the composer's DM mode and its footer banner

**Archive**

- Page-bar ⋯ menu: `Archive #room…` behind a confirm that names the members, `Reopen` on an archived room
- Collapsed `archived N` rail section; an archived room shows the `ArchivedBar` in place of the composer

**Transcript**

- Day dividers, full timestamps on hover, a `↓ N new` pill, a copy control on code blocks, a fold on tall posts

**Also**

- Fixtures gain an archived channel, an archived DM and a 60-line log post; the artboards, anatomy and audit targets cover every new element

---

**Checklist**

- [x] Appropriate tests have been created or updated
  - server, Composer, PageBar, RoomRail, ArchivedBar, Transcript and App suites; `bunx vitest run` green; `design/audit.mjs` passes against fixtures

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_014DK8caKoMFXhKQHh8Uufsg
EOF
)"
```

- [ ] **Step 3: Deploy after the merge**

```bash
cd ~/Documents/GitHub/chat && git pull && bun run build && deck restart chat
deck status | grep chat
```

Expected: `chat 11002 up`. Open https://chat.mattstack, archive a finished room, DM an agent from its card, and read a long transcript once.
