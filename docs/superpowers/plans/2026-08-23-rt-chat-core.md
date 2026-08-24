# rt chat — core (plan 1 of 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `rt chat` — persistent, cross-account chat rooms that agents coordinate in, with a blocking wake that never dumps a transcript into an agent's pane.

**Architecture:** A semantic layer over the RT-44 event bus. Messages live in `state.db` (chat owns them); every post also emits *pointer* events carrying `{id}`, including one `chat/wake/<handle>` per recipient computed daemon-side from membership and `wake_on`. An agent parks a backgrounded `rt chat wait` that blocks on a single glob and exits when tapped, so the harness re-invokes it. Nothing in this plan builds a web UI.

**Tech Stack:** Bun, TypeScript, `bun:sqlite`, `bun test`.

**Spec:** `docs/superpowers/specs/2026-08-23-rt-chat-design.md` — read it before Task 1. On any conflict, the spec wins. Sections most load-bearing here: Wake protocol (the ordering is not negotiable), Daemon architecture, Command surface, Failure modes, Testing.

**Worktree for execution:** work in a dedicated worktree, never in `/Users/matt/Documents/GitHub/repo-tools` — that checkout is read-only reference and its branch changes without warning. Create one off `origin/main`:

```bash
git -C /Users/matt/Documents/GitHub/repo-tools worktree add \
  /Users/matt/Documents/GitHub/repo-tools-chat-wt -b feat/rt-chat origin/main
```

All paths below are relative to that worktree root.

## Global Constraints

Binding on every task.

- **Handles and room names match `^[a-z0-9._-]+$`.** No `@` (it is the mention sigil, and `@a@b` is ambiguous), no `/` (the handle is interpolated into the topic `chat/wake/<handle>` and a slash would reshape the glob). Invalid names are **rejected with the reason at `join`, never silently normalized** — a silently renamed handle breaks mention wake in a way nobody can see.
- **`rt chat wait` prints exactly one line on its success path, ever.** This is the "don't flood the agent's pane" guarantee and it is a property of the binary, not a convention agents follow. A source-guard test locks it (Task 8).
- **`rt chat post` prints nothing on success.** Posting must not cost context.
- **`wait` exit codes: `0` woken, `124` timeout, `69` daemon unreachable.** These must be distinct — the Stop hook branches on them, and a hook that cannot tell "woken" from "daemon dead" re-arms in a tight loop forever.
- **Everything outside `lib/state/` imports store APIs through the barrel `lib/state/index.ts`**, never from `./db.ts` or a store module directly (RT-48).
- **`db.transaction()` callbacks are synchronous** in `bun:sqlite` — it commits when the callback returns. Wrapping an async function is forbidden; all transactional store code is sync.
- **No module-load db access, ever.** `getStateDb()` must never be called at module scope. Initialize on first use.
- **No sync-exec on the daemon thread** (MAT-222). Handlers do short single-statement work only.
- **Clean-code comments only.** A comment states a constraint the code cannot show — a parity anchor, an ordering trap, a non-obvious invariant. No narration of the next line, no ticket numbers, no decision history in source. Decision records go in your task report, never in the code.
- **Commits:** prefix `chat:`, trailer `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- **Test gate:** `bun test lib commands packages scripts` passes before every commit.

---

## File structure (what exists after this plan)

```
lib/state/busy.ts                 modified: export runCriticalWrite (promoted from notifier-store)
lib/state/notifier-store.ts       modified: import runCriticalWrite instead of its private copy
lib/state/db.ts                   modified: V3_SCHEMA (chat tables), SCHEMA_VERSION 3
lib/state/chat-store.ts           NEW: every chat table read/write; the only module touching them
lib/state/index.ts                modified: side-effect import + re-export of chat-store
lib/state/__tests__/chat-store.test.ts        NEW
lib/daemon/events-bus.ts          modified: head() on the bus interface
lib/daemon/handlers/events.ts     modified: events:head handler
lib/daemon/handlers/chat.ts       NEW: thin typed chat handlers
lib/daemon/__tests__/chat-handlers.test.ts    NEW
packages/rt-client/src/commands.ts            modified: chat:* + events:head catalog entries
packages/rt-client/src/client.ts              modified: exported chat wrappers
packages/rt-client/src/settings/registry-defs.ts  modified: four chat.* settings
commands/chat.ts                  NEW: the CLI
commands/__tests__/chat.test.ts   NEW
lib/module-registry.ts            modified: register commands/chat.ts
skills/rt-chat/SKILL.md           NEW
e2e/chat.test.ts                  NEW: the wake-protocol integration tests
```

`lib/state/chat-store.ts` is one file because rooms, members, and messages are read and written together on nearly every operation (a post reads membership to compute recipients; a join reads message ids to seed a cursor). Splitting by table would put a transaction boundary in the wrong place.

---

### Task 1: Promote `runCriticalWrite` out of notifier-store

RT-48 has two SQLITE_BUSY policies: `persistOrWarn` (warn and swallow; caches converge next cycle) and a bounded-retry variant for writes whose loss is permanent. The second one is **private to `lib/state/notifier-store.ts`**, so chat cannot use it. Chat posts are unambiguously that class — the daemon's `busy_timeout` is 250ms, a dropped INSERT loses a message forever, and because `post` prints nothing on success the loss is invisible to author, recipients, and viewer at once.

**Files:**
- Modify: `lib/state/busy.ts`
- Modify: `lib/state/notifier-store.ts` (delete the private copy, import the shared one)
- Test: `lib/state/__tests__/busy.test.ts`

**Interfaces:**
- Consumes: `isBusyError` from `lib/state/busy.ts` (already there).
- Produces: `export function runCriticalWrite<T>(op: string, fn: () => T, context: Record<string, unknown>): T | undefined`

- [ ] **Step 1: Read the existing implementation you are promoting**

Read `lib/state/notifier-store.ts` around the private `runQueueWrite` and `logQueueError`. Move the behavior verbatim — bounded attempts, `Bun.sleepSync` between them, ERROR log and `undefined` return on exhaustion, rethrow of non-busy errors. Do not redesign it.

- [ ] **Step 2: Write the failing test**

```ts
// lib/state/__tests__/busy.test.ts
import { expect, test } from "bun:test";
import { runCriticalWrite } from "../busy.ts";

test("returns the value when fn succeeds", () => {
  expect(runCriticalWrite("t", () => 42, {})).toBe(42);
});

test("retries a busy error and returns the eventual value", () => {
  let calls = 0;
  const value = runCriticalWrite("t", () => {
    calls++;
    if (calls < 2) { const e = new Error("database is locked"); (e as { code?: string }).code = "SQLITE_BUSY"; throw e; }
    return "ok";
  }, {});
  expect(value).toBe("ok");
  expect(calls).toBe(2);
});

test("returns undefined after exhausting attempts on a busy error", () => {
  const value = runCriticalWrite("t", () => {
    const e = new Error("database is locked"); (e as { code?: string }).code = "SQLITE_BUSY"; throw e;
  }, {});
  expect(value).toBeUndefined();
});

test("rethrows a non-busy error rather than retrying", () => {
  expect(() => runCriticalWrite("t", () => { throw new Error("syntax error"); }, {})).toThrow("syntax error");
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `bun test lib/state/__tests__/busy.test.ts`
Expected: FAIL — `runCriticalWrite` is not exported from `busy.ts`.

- [ ] **Step 4: Move the implementation into `busy.ts`**

Cut the private `runQueueWrite` and its `logQueueError` helper out of `notifier-store.ts` and add them to `lib/state/busy.ts`, renaming the exported one to `runCriticalWrite`. Keep the attempt count and sleep interval at their current values. Keep the existing module doc's explanation of *why* two policies exist — that is a constraint the code cannot show.

- [ ] **Step 5: Point notifier-store at the shared helper**

In `lib/state/notifier-store.ts`, import `runCriticalWrite` from `./busy.ts` and replace every `runQueueWrite(` call site. Behavior must not change.

- [ ] **Step 6: Run the full suite**

Run: `bun test lib commands packages scripts`
Expected: PASS, including every pre-existing notifier-store test. If a notifier test fails, you changed behavior — revert and move the code without edits.

- [ ] **Step 7: Commit**

```bash
git add lib/state/busy.ts lib/state/notifier-store.ts lib/state/__tests__/busy.test.ts
git commit -m "chat: promote the bounded-retry busy policy to lib/state/busy.ts

Chat posts need the notify_queue policy, not the cache one: a dropped
INSERT loses a message permanently and post prints nothing on success,
so the loss is invisible to author, recipients and viewer at once.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Chat schema and the rooms/members store

**Files:**
- Modify: `lib/state/db.ts` (add `V3_SCHEMA`, bump `SCHEMA_VERSION` to 3)
- Create: `lib/state/chat-store.ts`
- Modify: `lib/state/index.ts`
- Test: `lib/state/__tests__/chat-store.test.ts`

**Interfaces:**
- Consumes: `openStateDb(path)` and `getStateDb()` from `lib/state/db.ts`; `persistOrWarn` from `lib/state/busy.ts`.
- Produces:
  - `export interface ChatMember { room: string; handle: string; joinedAt: number; lastReadId: number; wakeOn: WakeMode; lastSeenAt?: number; armedAt?: number; cwd?: string; pane?: string }`
  - `export type WakeMode = "mention" | "all" | "none"`
  - `export function isValidChatName(name: string): boolean`
  - `export function joinRoom(args: { room: string; handle: string; wakeOn?: WakeMode; cwd?: string; pane?: string }, db?: Database): { handle: string; memberCount: number; unread: number }`
  - `export function leaveRoom(room: string, handle: string, db?: Database): void`
  - `export function listRooms(handle: string, db?: Database): RoomSummary[]`
  - `export function listMembers(room: string, db?: Database): ChatMember[]`

- [ ] **Step 1: Write the failing test**

```ts
// lib/state/__tests__/chat-store.test.ts
import { expect, test } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { openStateDb } from "../db.ts";
import { isValidChatName, joinRoom, leaveRoom, listMembers, listRooms } from "../chat-store.ts";

let n = 0;
function freshDb() {
  return openStateDb(join(tmpdir(), `chat-test-${process.pid}-${n++}.db`));
}

test("rejects names outside the charset", () => {
  expect(isValidChatName("build")).toBe(true);
  expect(isValidChatName("acme-dev-42")).toBe(true);
  expect(isValidChatName("has@sigil")).toBe(false);
  expect(isValidChatName("has/slash")).toBe(false);
  expect(isValidChatName("HasUpper")).toBe(false);
  expect(isValidChatName("")).toBe(false);
});

test("join creates the room and reports being alone", () => {
  const db = freshDb();
  const r = joinRoom({ room: "build", handle: "a" }, db);
  expect(r.memberCount).toBe(1);
  expect(r.unread).toBe(0);
  expect(listRooms("a", db).map(x => x.room)).toEqual(["build"]);
});

test("a colliding handle gets a numeric suffix and the resolved handle is persisted", () => {
  const db = freshDb();
  joinRoom({ room: "build", handle: "a", cwd: "/one" }, db);
  const second = joinRoom({ room: "build", handle: "a", cwd: "/two" }, db);
  expect(second.handle).toBe("a-2");
  expect(listMembers("build", db).map(m => m.handle).sort()).toEqual(["a", "a-2"]);
});

test("rejoining from the same context keeps the handle rather than suffixing again", () => {
  const db = freshDb();
  joinRoom({ room: "build", handle: "a", cwd: "/one" }, db);
  const again = joinRoom({ room: "build", handle: "a", cwd: "/one" }, db);
  expect(again.handle).toBe("a");
  expect(listMembers("build", db)).toHaveLength(1);
});

test("wakeOn defaults to mention and round-trips when set", () => {
  const db = freshDb();
  joinRoom({ room: "build", handle: "a" }, db);
  joinRoom({ room: "build", handle: "b", wakeOn: "all" }, db);
  const byHandle = Object.fromEntries(listMembers("build", db).map(m => [m.handle, m.wakeOn]));
  expect(byHandle).toEqual({ a: "mention", b: "all" });
});

test("leave drops membership", () => {
  const db = freshDb();
  joinRoom({ room: "build", handle: "a" }, db);
  leaveRoom("build", "a", db);
  expect(listMembers("build", db)).toHaveLength(0);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test lib/state/__tests__/chat-store.test.ts`
Expected: FAIL — no module `../chat-store.ts`.

- [ ] **Step 3: Add the schema**

In `lib/state/db.ts`, add a `V3_SCHEMA` constant beside the existing `V1_SCHEMA`/`V2_SCHEMA`, append it to the single `db.exec(V1_SCHEMA + V2_SCHEMA + V3_SCHEMA)` call, and bump `SCHEMA_VERSION` to `3`. Every statement is `IF NOT EXISTS`, so replaying against an already-v2 db is a no-op — do **not** add a per-version branch, and do **not** touch the `user_version === 0` legacy-import guard.

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
  mentions   TEXT,
  reply_to   INTEGER,
  posted_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_messages_room_id ON chat_messages(room, id);
CREATE TABLE IF NOT EXISTS chat_members (
  room          TEXT NOT NULL,
  handle        TEXT NOT NULL,
  joined_at     INTEGER NOT NULL,
  last_read_id  INTEGER NOT NULL DEFAULT 0,
  wake_on       TEXT NOT NULL DEFAULT 'mention',
  last_seen_at  INTEGER,
  armed_at      INTEGER,
  cwd           TEXT,
  pane          TEXT,
  PRIMARY KEY (room, handle)
);
```

`reply_to` ships unused. It is one nullable column now versus a migration later, and it is the only piece of the deferred message-protocol worth pre-paying for.

- [ ] **Step 4: Write `lib/state/chat-store.ts`**

Module doc should state the one non-obvious constraint: this is the only module that touches the chat tables, and rooms/members/messages live in one file because a post reads membership inside the same transaction that writes the message.

`isValidChatName` is `/^[a-z0-9._-]+$/.test(name)`. Both exclusions are load-bearing and the comment should say so — `@` is the mention sigil, `/` would reshape the wake topic glob.

`joinRoom` in one `db.transaction`: upsert `chat_rooms`; look for an existing member row whose `cwd` matches (that is a rejoin — keep its handle); otherwise find a free handle by appending `-2`, `-3`… ; insert the member with `last_read_id` seeded to the room's current `MAX(id)` so a joiner is not woken by history; return the resolved handle, member count, and unread count.

Follow `lib/state/endpoint-claims-store.ts` for shape: hoisted SQL string constants, a `RowType` interface, a `rowToX` mapper, `db: Database = getStateDb()` as the last parameter.

- [ ] **Step 5: Register in the barrel**

In `lib/state/index.ts`, add the side-effect import and re-export block for `chat-store.ts`. Chat registers **no** `LEGACY_IMPORTS` entry — there is no legacy JSON — which puts it with `endpoint-claims-store.ts` and `run-history-store.ts`. The barrel test asserts importing the barrel opens no database; keep all db access inside functions.

- [ ] **Step 6: Run the tests**

Run: `bun test lib/state/`
Expected: PASS, including `barrel.test.ts` and `db.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add lib/state/db.ts lib/state/chat-store.ts lib/state/index.ts lib/state/__tests__/chat-store.test.ts
git commit -m "chat: schema v3 and the rooms/members store

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Messages — post, recipients, read, mark

The recipient computation added here is consumed by **both** the post path and Task 8's wait path. It must be one exported function called by both. If they diverge — most easily by the wait path forgetting to exclude the agent's own posts — an agent's own message makes its next `wait` exit immediately, every time, forever.

**Files:**
- Modify: `lib/state/chat-store.ts`
- Test: `lib/state/__tests__/chat-store.test.ts`

**Interfaces:**
- Consumes: everything from Task 2; `runCriticalWrite` from Task 1.
- Produces:
  - `export function parseMentions(body: string): string[]`
  - `export function recipientsFor(room: string, authorHandle: string, mentions: string[], db?: Database): string[]`
  - `export function postMessage(args: { room: string; handle: string; body: string }, db?: Database): { id: number; recipients: string[] } | undefined`
  - `export function readUnread(handle: string, room: string | undefined, limit: number, db?: Database): { room: string; messages: ChatMessage[] }[]`
  - `export function listMessages(args: { room: string; before?: number; limit: number }, db?: Database): ChatMessage[]`
  - `export function markRead(handle: string, room?: string, db?: Database): void`
  - `export function unreadWakingCount(handle: string, db?: Database): { room: string; count: number; mentions: number }[]`

- [ ] **Step 1: Write the failing test**

```ts
test("parses mentions and ignores an email-shaped token", () => {
  expect(parseMentions("hi @alice and @bob-2")).toEqual(["alice", "bob-2"]);
  expect(parseMentions("mail me at a@b.com")).toEqual([]);
  expect(parseMentions("@here everyone")).toEqual(["here"]);
});

test("recipients: mention mode wakes only on being named, and never the author", () => {
  const db = freshDb();
  joinRoom({ room: "r", handle: "a" }, db);
  joinRoom({ room: "r", handle: "b" }, db);
  expect(recipientsFor("r", "a", [], db)).toEqual([]);
  expect(recipientsFor("r", "a", ["b"], db)).toEqual(["b"]);
  expect(recipientsFor("r", "a", ["a"], db)).toEqual([]);
});

test("recipients: wakeOn all wakes without a mention; none never wakes", () => {
  const db = freshDb();
  joinRoom({ room: "r", handle: "a" }, db);
  joinRoom({ room: "r", handle: "b", wakeOn: "all" }, db);
  joinRoom({ room: "r", handle: "c", wakeOn: "none" }, db);
  expect(recipientsFor("r", "a", [], db)).toEqual(["b"]);
  expect(recipientsFor("r", "a", ["c"], db)).toEqual([]);
});

test("@here wakes every member except the author and the none-mode members", () => {
  const db = freshDb();
  joinRoom({ room: "r", handle: "a" }, db);
  joinRoom({ room: "r", handle: "b" }, db);
  joinRoom({ room: "r", handle: "c", wakeOn: "none" }, db);
  expect(recipientsFor("r", "a", ["here"], db).sort()).toEqual(["b"]);
});

test("read returns unread, advances the cursor, and is empty on a second call", () => {
  const db = freshDb();
  joinRoom({ room: "r", handle: "a" }, db);
  joinRoom({ room: "r", handle: "b" }, db);
  postMessage({ room: "r", handle: "a", body: "one" }, db);
  const first = readUnread("b", undefined, 20, db);
  expect(first[0]!.messages.map(m => m.body)).toEqual(["one"]);
  expect(readUnread("b", undefined, 20, db)).toEqual([]);
});

test("listMessages does not advance any cursor", () => {
  const db = freshDb();
  joinRoom({ room: "r", handle: "a" }, db);
  joinRoom({ room: "r", handle: "b" }, db);
  postMessage({ room: "r", handle: "a", body: "one" }, db);
  const before = listMembers("r", db).map(m => m.lastReadId);
  listMessages({ room: "r", limit: 20 }, db);
  expect(listMembers("r", db).map(m => m.lastReadId)).toEqual(before);
});

test("a last_read_id ahead of MAX(id) is clamped rather than hanging", () => {
  const db = freshDb();
  joinRoom({ room: "r", handle: "a" }, db);
  joinRoom({ room: "r", handle: "b" }, db);
  postMessage({ room: "r", handle: "a", body: "@b one" }, db);
  db.run("UPDATE chat_members SET last_read_id = 999999 WHERE handle = 'b';");
  expect(unreadWakingCount("b", db)).toEqual([]);
  postMessage({ room: "r", handle: "a", body: "@b two" }, db);
  expect(unreadWakingCount("b", db)[0]!.count).toBe(1);
});

test("mark advances without returning messages", () => {
  const db = freshDb();
  joinRoom({ room: "r", handle: "a" }, db);
  joinRoom({ room: "r", handle: "b" }, db);
  postMessage({ room: "r", handle: "a", body: "one" }, db);
  markRead("b", "r", db);
  expect(readUnread("b", undefined, 20, db)).toEqual([]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test lib/state/__tests__/chat-store.test.ts`
Expected: FAIL — `parseMentions` is not exported.

- [ ] **Step 3: Implement**

`parseMentions`: match `/(?<![A-Za-z0-9._-])@([a-z0-9._-]+)/g` and dedupe. The lookbehind is what keeps `a@b.com` from reading as a mention of `b.com`; that is a constraint the regex cannot show, so it earns a comment.

`recipientsFor`: read `chat_members` for the room; include a member if `wake_on = 'all'`, or `wake_on = 'mention'` and the member is in `mentions`, or `mentions` contains `here`; exclude `wake_on = 'none'`; exclude `authorHandle`. Returns handles sorted, for deterministic tests.

`postMessage`: wrap the INSERT in `runCriticalWrite` — **not** `persistOrWarn`. Return `{ id, recipients }`, or `undefined` if the write was dropped after its retry budget so the caller can report failure rather than print nothing and lie. Store `mentions` as a JSON array.

**Clamp an ahead cursor.** Every read of `last_read_id` clamps it to the
room's `MAX(id)` first. A cursor above the max can only mean a recreated
`state.db` — ids only grow within one generation — and left alone it makes
unread permanently empty, which looks exactly like a hung agent that never
wakes. Same class, cause, and fix as the events bus's `Math.min(after, head)`.

`readUnread` in one transaction: select `id > last_read_id` per joined room (or the one named), cap at `limit`, then set `last_read_id` to the highest id **actually returned** — not to `MAX(id)`, or a capped read silently marks unseen messages read.

- [ ] **Step 4: Run the tests**

Run: `bun test lib/state/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/state/chat-store.ts lib/state/__tests__/chat-store.test.ts
git commit -m "chat: messages, mention parsing, and the shared recipient rule

recipientsFor is called by both the post path and the wait path's unread
check; divergence there makes an agent's own post wake it forever.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Presence — arm, touch, disarm, and the startup clear

**Files:**
- Modify: `lib/state/chat-store.ts`
- Modify: `lib/daemon.ts` — inside `startDaemon()`, alongside the existing `openBranchCacheStore()` call
- Modify: `lib/state/__tests__/source-guards.test.ts` — extend the existing "daemon startup opens state.db before serving" guard
- Test: `lib/state/__tests__/chat-store.test.ts`

**Interfaces:**
- Produces:
  - `export function armMember(room: string | undefined, handle: string, db?: Database): void`
  - `export function touchMember(handle: string, db?: Database): void`
  - `export function disarmMember(handle: string, db?: Database): void`
  - `export function clearAllArmed(db?: Database): number`

- [ ] **Step 1: Write the failing test**

```ts
test("arm sets armed_at, disarm clears it, touch updates last_seen_at", () => {
  const db = freshDb();
  joinRoom({ room: "r", handle: "a" }, db);
  armMember(undefined, "a", db);
  expect(listMembers("r", db)[0]!.armedAt).toBeGreaterThan(0);
  touchMember("a", db);
  expect(listMembers("r", db)[0]!.lastSeenAt).toBeGreaterThan(0);
  disarmMember("a", db);
  expect(listMembers("r", db)[0]!.armedAt).toBeUndefined();
});

test("clearAllArmed clears every row and reports how many it cleared", () => {
  const db = freshDb();
  joinRoom({ room: "r", handle: "a" }, db);
  joinRoom({ room: "r", handle: "b" }, db);
  armMember(undefined, "a", db);
  armMember(undefined, "b", db);
  expect(clearAllArmed(db)).toBe(2);
  expect(listMembers("r", db).every(m => m.armedAt === undefined)).toBe(true);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test lib/state/__tests__/chat-store.test.ts`
Expected: FAIL — `armMember` is not exported.

- [ ] **Step 3: Implement the four functions**

All four use `persistOrWarn`, not `runCriticalWrite`: presence is regenerable on the next poll cycle, so it is the cache class.

- [ ] **Step 4: Call `clearAllArmed` at daemon startup, before serving**

In `lib/daemon.ts`'s `startDaemon()`, call `clearAllArmed()` beside the
existing `openBranchCacheStore()` call — which is to say **before**
`startSocketServer(` and `startApiServer(`. Both halves matter:

- *Why clear at all:* no waiter outlives the daemon (`events-bus.close()` settles every waiter, then closes the db), so any `armed_at` still set at boot is stale by definition. The agents cannot clear their own rows — `chat:disarm` is a daemon handler and the daemon is the thing that died, so each `rt chat wait` exits 69 with its row untouched. Skip this and every member reads as *live — will hear you* for ten minutes after each restart while every agent is disarmed, with nothing recovering it because the Stop hook must never re-arm after 69.
- *Why before serving:* run it after the socket is listening and an agent that arms in the gap has its fresh `armed_at` wiped — the mirror-image bug, a genuinely armed agent rendered deaf.

- [ ] **Step 5: Lock the ordering with a source guard**

`lib/state/__tests__/source-guards.test.ts` already has a
`describe("daemon startup opens state.db before serving")` block that slices
`startDaemon(`'s body and asserts `openBranchCacheStore()`'s index is less
than both `startSocketServer(` and `startApiServer(`. Add `clearAllArmed()` to
that same block with the same two assertions. A prose instruction to "call it
before serving" is exactly the kind of ordering that gets refactored away;
this is how the repo already prevents that.

- [ ] **Step 6: Run the full suite**

Run: `bun test lib commands packages scripts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/state/chat-store.ts lib/state/__tests__/chat-store.test.ts lib/state/__tests__/source-guards.test.ts lib/daemon.ts
git commit -m "chat: presence columns and the startup clear of armed_at

No waiter outlives the daemon, so every armed_at set at boot is stale.
The clear runs before serving: after the socket listens, an agent arming
in the gap would have its fresh armed_at wiped.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `events:head`

The wait path needs the journal head. Both `events:list` shapes are wrong for it: `limit`-bearing calls return the **last delivered event's** id rather than `maxId()` when `events.length === limit`, so `{limit: 1}` returns the *oldest* matching wake event and replays every historical wake forever; and a no-`limit` call means `after = 0`, and since `eventsAfter` applies the glob **in JS after** `SELECT ... WHERE id > ?`, it materializes the entire journal — all global bus traffic, payloads included — on the daemon thread, once per arm.

**Files:**
- Modify: `lib/daemon/events-bus.ts`
- Modify: `lib/daemon/handlers/events.ts`
- Modify: `packages/rt-client/src/commands.ts`
- Test: `lib/daemon/__tests__/events-bus.test.ts` (existing file)

**Interfaces:**
- Produces: `head(): number` on the bus interface; command `"events:head": { payload: Record<string, never>; data: { cursor: number } }`.

- [ ] **Step 1: Write the failing test**

```ts
test("head returns the journal max id and does not fetch rows", () => {
  const bus = makeTestBus();
  expect(bus.head()).toBe(0);
  const { id } = bus.emit({ topic: "chat/wake/a" });
  expect(bus.head()).toBe(id);
});
```

Use whatever bus construction the existing tests in that file already use.

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test lib/daemon/__tests__/events-bus.test.ts`
Expected: FAIL — `bus.head` is not a function.

- [ ] **Step 3: Implement**

Add `head` to the `EventsBus` interface and return the existing `maxId()`. `maxIdStmt` is already prepared in that module and already used by `list`, `wait`, and `close` — this adds no state and no waiter interaction. Add the `events:head` handler beside `events:emit`/`events:wait`/`events:list` and its catalog entry.

- [ ] **Step 4: Run the tests**

Run: `bun test lib/daemon/ packages/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/daemon/events-bus.ts lib/daemon/handlers/events.ts packages/rt-client/src/commands.ts lib/daemon/__tests__/events-bus.test.ts
git commit -m "chat: add events:head for race-free wake arming

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Daemon handlers, catalog entries, and rt-client wrappers

The exported wrappers here are **plan 2's entire dependency**. No `/api/chat/*` REST rows ship — the viewer reaches the daemon through rt-client over the unix socket, so nothing chat-related is exposed over TCP and `needsToken()` is untouched.

**Files:**
- Create: `lib/daemon/handlers/chat.ts`
- Modify: `lib/daemon/command-router.ts` (register the handlers as the events handlers are)
- Modify: `packages/rt-client/src/commands.ts`
- Modify: `packages/rt-client/src/client.ts` and `packages/rt-client/src/index.ts`
- Test: `lib/daemon/__tests__/chat-handlers.test.ts`

**Interfaces:**
- Consumes: every store function from Tasks 2–4, imported **through the barrel** `lib/state/index.ts`.
- Produces, in `client.ts` — **exact signatures, because plan 2 is written against them.** All go through `rtCommand` and therefore all resolve to `{ ok: false, error }` rather than throwing, daemon-down included:

```ts
export function chatJoin(a: { room: string; handle: string; wakeOn?: WakeMode; cwd?: string; pane?: string }, o?: RtClientOptions): Promise<RtResponse<{ handle: string; memberCount: number; unread: number }>>;
export function chatLeave(a: { room: string; handle: string }, o?: RtClientOptions): Promise<RtResponse<Record<string, never>>>;
export function chatPost(a: { room: string; handle: string; body: string }, o?: RtClientOptions): Promise<RtResponse<{ id: number; recipients: string[] }>>;
export function chatRead(a: { handle: string; room?: string; limit?: number }, o?: RtClientOptions): Promise<RtResponse<{ rooms: { room: string; messages: ChatMessage[] }[] }>>;
export function chatRooms(a: { handle: string }, o?: RtClientOptions): Promise<RtResponse<{ rooms: RoomSummary[] }>>;
export function chatWho(a: { room: string }, o?: RtClientOptions): Promise<RtResponse<{ members: ChatMember[] }>>;
export function chatMark(a: { handle: string; room?: string }, o?: RtClientOptions): Promise<RtResponse<Record<string, never>>>;
export function chatMessages(a: { room: string; before?: number; limit?: number }, o?: RtClientOptions): Promise<RtResponse<{ messages: ChatMessage[] }>>;
export function chatArm(a: { handle: string; room?: string }, o?: RtClientOptions): Promise<RtResponse<Record<string, never>>>;
export function chatTouch(a: { handle: string }, o?: RtClientOptions): Promise<RtResponse<Record<string, never>>>;
export function chatDisarm(a: { handle: string }, o?: RtClientOptions): Promise<RtResponse<Record<string, never>>>;
export function eventsHead(o?: RtClientOptions): Promise<RtResponse<{ cursor: number }>>;
```

`ChatMember`, `ChatMessage`, `RoomSummary`, and `WakeMode` are re-exported from `index.ts` too — plan 2 imports the types, not just the functions.

- [ ] **Step 1: Write the failing test**

```ts
// lib/daemon/__tests__/chat-handlers.test.ts
import { expect, test } from "bun:test";
import { handleChat } from "../handlers/chat.ts";

test("chat:join returns the resolved handle and member count", async () => {
  const res = await handleChat("chat:join", { room: "build", handle: "a" });
  expect(res.ok).toBe(true);
  expect(res.data).toMatchObject({ handle: "a", memberCount: 1 });
});

test("chat:join rejects an invalid handle with a reason rather than normalizing it", async () => {
  const res = await handleChat("chat:join", { room: "build", handle: "Has@Sigil" });
  expect(res.ok).toBe(false);
  expect(res.error).toContain("handle");
});

test("chat:post returns the message id and the recipients it woke", async () => {
  await handleChat("chat:join", { room: "r", handle: "a" });
  await handleChat("chat:join", { room: "r", handle: "b" });
  const res = await handleChat("chat:post", { room: "r", handle: "a", body: "@b hi" });
  expect(res.ok).toBe(true);
  expect(res.data).toMatchObject({ recipients: ["b"] });
});
```

Isolate the db the way the other daemon handler tests in this directory do; do not let a test touch the real `state.db`.

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test lib/daemon/__tests__/chat-handlers.test.ts`
Expected: FAIL — no module `../handlers/chat.ts`.

- [ ] **Step 3: Write the handlers**

Thin — validate, delegate to the store, shape the response. Handlers own **no** logic that Task 3 already owns.

`chat:post` is the one with real sequencing, and the order is an invariant a comment should state:

1. `postMessage(...)` — the row must **commit** before any emit, or a woken agent reads the pointer and finds no row.
2. Emit `chat/<room>/msg` with `{ id }`.
3. Emit `chat/wake/<handle>` with `{ id, room }` for each recipient returned by step 1.

Emit payloads carry pointers, never prose — chat owns the message store; the journal is the doorbell.

- [ ] **Step 4: Add catalog entries and client wrappers**

Add each `chat:*` to `commands.ts` with exact payload and data types, then the exported wrapper in `client.ts` following `listRuns`/`getRun` exactly, re-exported from `index.ts`. Types must match the store's interfaces exactly — a drift here is a tsc error, which is the point of the catalog.

- [ ] **Step 5: Run the tests**

Run: `bun test lib commands packages scripts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/daemon/handlers/chat.ts lib/daemon/command-router.ts packages/rt-client/src lib/daemon/__tests__/chat-handlers.test.ts
git commit -m "chat: daemon handlers, command catalog, and rt-client wrappers

The wrappers are plan 2's entire dependency: the viewer reaches the
daemon over the unix socket, so no /api/chat/* rows ship and
needsToken() is untouched.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: The CLI — everything except `wait`

**Files:**
- Create: `commands/chat.ts`
- Modify: `lib/module-registry.ts`
- Modify: `packages/rt-client/src/settings/registry-defs.ts`
- Test: `commands/__tests__/chat.test.ts`

**Interfaces:**
- Consumes: the rt-client wrappers from Task 6.
- Produces: `export async function chat(args: string[]): Promise<void>` — the verb dispatcher.

**Verbs** (eight; `wait` lands in Task 8):

| command | behavior |
|---|---|
| `rt chat join <room> [--as <h>] [--wake-on mention\|all\|none]` | join, creating the room if absent |
| `rt chat leave <room>` | drop membership; kill any armed waiter |
| `rt chat post <room> <text>` | post; **prints nothing on success** |
| `rt chat read [room] [--limit 20] [--full] [--since <dur>]` | print unread across joined rooms or one; advance the cursor |
| `rt chat rooms` | rooms, member counts, unread, last activity |
| `rt chat who [room]` | members with status, cwd, branch, pane |
| `rt chat mark [room]` | advance the cursor without printing |
| `rt chat wait` | Task 8 |

- [ ] **Step 1: Write the failing test**

```ts
test("join prints the member count so a typo is visible", async () => {
  const out = await runChat(["join", "buidl"]);
  expect(out).toContain("1 member");
  expect(out).toContain("you are alone here");
});

test("post prints nothing on success", async () => {
  await runChat(["join", "r"]);
  expect(await runChat(["post", "r", "hello"])).toBe("");
});

test("an invalid room name is rejected with the reason", async () => {
  const { code, stderr } = await runChatRaw(["join", "Bad/Name"]);
  expect(code).not.toBe(0);
  expect(stderr).toContain("[a-z0-9._-]");
});

test("--json emits a parseable object for every verb", async () => {
  await runChat(["join", "r"]);
  expect(() => JSON.parse(await runChat(["rooms", "--json"]))).not.toThrow();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test commands/__tests__/chat.test.ts`
Expected: FAIL — no module `commands/chat.ts`.

- [ ] **Step 3: Implement the dispatcher and verbs**

Follow `commands/events.ts` for argument parsing (`positional`, `flagValue`, `parseDuration`) and for the `--json` convention.

Identity resolution is **client-side** — `HERDR_PANE_ID` and the cwd's repo/branch exist only in this process, never in the daemon — so the resolved handle travels in every payload. Order: `--as` → `chat.handle` (user scope) → herdr pane title via `HERDR_PANE_ID` → `<repo>-<branch>` slugified → `<user>-<host>` slugified.

`rooms` output:

```
#dev-42   3 members   2 unread (1 mention)   last 4m ago
#build     6 members   —                      last 2h ago
```

- [ ] **Step 4: Register the command and the settings keys**

Add `"./commands/chat.ts": () => import("../commands/chat.ts")` to `lib/module-registry.ts` — as `commands/events.ts` is registered — or the compiled binary's dynamic import fails at runtime.

Add four defs to `packages/rt-client/src/settings/registry-defs.ts`: `chat.handle`, `chat.humanHandle` (default `matt`), `chat.push.provider`, `chat.push.target`. RT-50 moved this table out of `lib/settings/registry.ts`, which is now only a re-export barrel — do not add them there.

- [ ] **Step 5: Run the tests**

Run: `bun test lib commands packages scripts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add commands/chat.ts commands/__tests__/chat.test.ts lib/module-registry.ts packages/rt-client/src/settings/registry-defs.ts
git commit -m "chat: the CLI verbs, module registration, and settings defs

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: `rt chat wait` — the wake protocol

The highest-risk task in the plan. Read the spec's **Wake protocol** section in full before writing a line; the step ordering is the feature.

**Files:**
- Modify: `commands/chat.ts`
- Test: `commands/__tests__/chat.test.ts`, `e2e/chat.test.ts`

**Interfaces:**
- Consumes: `eventsHead`, `chatArm`, `chatTouch`, `chatDisarm`, and the `events:wait` handler via rt-client.
- Produces: the `wait` verb.

**The wait path, in this exact order:**

1. **Snapshot the journal head** via `events:head`.
2. `chat:arm`.
3. Check for unread that *would have woken this handle* — using `recipientsFor`'s rule, author-exclusion included. If found: `chat:disarm`, print one line, exit 0.
4. Otherwise call the `events:wait` handler with pattern `chat/wake/<me>` and `after` = the step-1 cursor.
5. On wake: print one line, `chat:disarm`, exit 0.

**Why step 1 precedes step 3:** `events:wait` with no `after` snapshots `head = maxId()` at registration and delivers only ids above it. Check-then-arm without a cursor leaves a window — process spawn plus IPC — in which a post commits and emits *below* the new waiter's head, seen by neither the check nor the wait. The agent then blocks holding an unread mention until some later message happens to wake it. That window falls exactly when an agent finishes a turn and re-arms, which is when a peer is most likely replying.

**Chat drives the `events:wait` handler directly, one round at a time — never `rt events wait`.** That CLI owns its own `while (true)` loop and never returns between polls, prints events-shaped JSON, and its `fail()` exits 1 rather than 69. Chat owns its loop, its exit codes, and its single-line output, and calls `chat:touch` each round so presence rides the loop.

- [ ] **Step 1: Write the failing tests**

```ts
test("wait exits 124 on timeout", async () => {
  await runChat(["join", "r"]);
  const { code } = await runChatRaw(["wait", "--timeout", "1s"]);
  expect(code).toBe(124);
});

test("wait exits 69 when the daemon is unreachable", async () => {
  const { code } = await runChatRaw(["wait"], { sock: "/nonexistent.sock" });
  expect(code).toBe(69);
});

test("wait refuses to double-arm", async () => {
  await runChat(["join", "r"]);
  const first = spawnChat(["wait"]);
  const { code, stderr } = await runChatRaw(["wait"]);
  expect(code).not.toBe(0);
  expect(stderr).toContain("already armed");
  first.kill();
});

test("the success path prints exactly one line", async () => {
  const src = await Bun.file("commands/chat.ts").text();
  const waitFn = src.slice(src.indexOf("async function chatWait"));
  expect(waitFn.match(/console\.log/g) ?? []).toHaveLength(1);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test commands/__tests__/chat.test.ts`
Expected: FAIL — no `wait` verb.

- [ ] **Step 3: Implement**

The pidfile is keyed on **handle alone**, under the rt dir — not `(room, handle)`. A room-less `wait` has no room component to key on, and because the wake topic is per-handle, two `--room`-scoped waiters for one handle are both woken by a message to either room, which is the double-wake the lock exists to prevent.

`--room` filters on the wake payload's `room` and **silently re-arms** on a non-matching wake, since the topic is per-handle. Without `--room`, a wake from any joined room exits.

Exit line format — one line, no transcript:

```
1 new in #build — @mention from repo-tools-main. `rt chat read` to see it, then re-arm.
```

- [ ] **Step 4: Write the integration tests**

```ts
// e2e/chat.test.ts
import { expect, test } from "bun:test";

test("post wakes an armed agent, with exactly one line of output", async () => {
  await rt(["chat", "join", "r", "--as", "listener"]);
  await rt(["chat", "join", "r", "--as", "poster"]);
  const waiter = Bun.spawn(["rt", "chat", "wait", "--as", "listener"], { stdout: "pipe" });
  await waitUntilArmed("listener");
  await rt(["chat", "post", "r", "@listener ping", "--as", "poster"]);
  const code = await waiter.exited;
  const out = await new Response(waiter.stdout).text();
  expect(code).toBe(0);
  expect(out.trimEnd().split("\n")).toHaveLength(1);
  expect(out).toContain("#r");
});

test("restart gap: a post with nobody armed is delivered on the next arm", async () => {
  await rt(["chat", "join", "r", "--as", "listener"]);
  await rt(["chat", "join", "r", "--as", "poster"]);
  await rt(["chat", "post", "r", "@listener while you were out", "--as", "poster"]);
  const started = Date.now();
  const { code, stdout } = await rtRaw(["chat", "wait", "--as", "listener", "--timeout", "30s"]);
  expect(code).toBe(0);
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(stdout).toContain("1 new");
});

test("wake policy: mention wakes only when named; all wakes always; none never", async () => {
  await rt(["chat", "join", "r", "--as", "poster"]);
  await rt(["chat", "join", "r", "--as", "m"]);
  await rt(["chat", "join", "r", "--as", "a", "--wake-on", "all"]);
  await rt(["chat", "join", "r", "--as", "n", "--wake-on", "none"]);
  const mention = Bun.spawn(["rt", "chat", "wait", "--as", "m", "--timeout", "3s"]);
  const all = Bun.spawn(["rt", "chat", "wait", "--as", "a", "--timeout", "3s"]);
  const none = Bun.spawn(["rt", "chat", "wait", "--as", "n", "--timeout", "3s"]);
  await waitUntilArmed("m", "a", "n");
  await rt(["chat", "post", "r", "no mention here", "--as", "poster"]);
  expect(await mention.exited).toBe(124);
  expect(await all.exited).toBe(0);
  expect(await none.exited).toBe(124);
});

test("the arm race: a post landing between the unread check and the wait is not lost", async () => {
  // The injection point is AFTER step 3's unread check and BEFORE the
  // events:wait call. Injecting anywhere earlier in the step-1-to-step-4
  // window proves nothing: step 3 catches those posts even with the step-1
  // cursor deleted, so the test would pass against the exact regression it
  // exists to catch. RT_CHAT_TEST_PRE_WAIT_HOOK is the seam that makes the
  // narrow window reachable; it exists only for this test.
  await rt(["chat", "join", "r", "--as", "listener"]);
  await rt(["chat", "join", "r", "--as", "poster"]);
  const waiter = Bun.spawn(["rt", "chat", "wait", "--as", "listener", "--timeout", "20s"], {
    env: { ...process.env, RT_CHAT_TEST_PRE_WAIT_HOOK: "rt chat post r '@listener raced' --as poster" },
  });
  expect(await waiter.exited).toBe(0);
});

test("read-only handlers mutate nothing", async () => {
  await rt(["chat", "join", "r", "--as", "a"]);
  await rt(["chat", "join", "r", "--as", "b"]);
  await rt(["chat", "post", "r", "@b hello", "--as", "a"]);
  const before = snapshotChatTables();
  await rt(["chat", "rooms", "--as", "b"]);
  await rt(["chat", "who", "r", "--as", "b"]);
  await rtCommand("chat:messages", { room: "r", limit: 20 });
  expect(snapshotChatTables()).toEqual(before);
});

test("daemon restart disarms everyone", async () => {
  await rt(["chat", "join", "r", "--as", "listener"]);
  const waiter = Bun.spawn(["rt", "chat", "wait", "--as", "listener"]);
  await waitUntilArmed("listener");
  await restartDaemon();
  // The armed_at assertion is the load-bearing one and must survive any later
  // simplification: the status assertion below only fails against broken code
  // while last_seen_at is inside the 10-minute window, so a slow or paused run
  // would read deaf and pass anyway.
  expect(memberRow("r", "listener").armed_at).toBeNull();
  expect(await rtJson(["chat", "who", "r"])).not.toMatchObject({ members: [{ status: "live" }] });
  waiter.kill();
});
```

`snapshotChatTables()` selects every row of `chat_members` and `chat_messages`
ordered by primary key and returns them as one comparable structure — a
whole-table snapshot, not `last_read_id` alone, because the realistic drift is
a future `chat:who` that stamps `last_seen_at` while rendering presence.
`waitUntilArmed(...handles)` polls `chat:who` until each handle's `armed_at`
is set; do not use a fixed sleep, which makes the wake tests flaky under load.

- [ ] **Step 5: Run everything**

Run: `bun test lib commands packages scripts && bun test --preload ./e2e/setup.ts --timeout 60000 e2e/chat.test.ts`
Expected: PASS.

- [ ] **Step 6: Verify the race test actually guards**

Temporarily delete the step-1 cursor (pass no `after` to `events:wait`), re-run the arm-race test, and confirm it **fails**. Restore. Paste both outputs into your report — a race test that passes both ways is worthless, and this is the only way to know.

- [ ] **Step 7: Commit**

```bash
git add commands/chat.ts commands/__tests__/chat.test.ts e2e/chat.test.ts
git commit -m "chat: the wake protocol

Head snapshot before the unread check, then arm with that cursor: a post
landing between a bare check and waiter registration emits below the new
waiter's head and is seen by neither.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: The skill and the Stop hook

**Files:**
- Create: `skills/rt-chat/SKILL.md`
- Create: `skills/rt-chat/hooks/rearm.sh` — the Stop hook shim
- Modify: `skills/rt-chat/SKILL.md` — document installing it into `~/.claude/settings.json`
- Test: `commands/__tests__/chat.test.ts` — one test for the shim's exit-code branching

**Interfaces:**
- Consumes: the CLI from Tasks 7–8.

- [ ] **Step 1: Write the skill**

`skills/rt-chat/SKILL.md`, frontmatter `name: rt:chat`, matching the local convention (`skills/` holds `rt-create-plugin`, `rt-docs`, `rt-release`, `rt-sdm-connect`). One skill covering the whole CLI surface behind a gate — the shape the herdr skill uses, which lives in the **herdr** repo, not this one.

Description trigger: *use when asked to join or coordinate in an agent chat room, when told you are working alongside other agents, or when you need to reach an agent under a different account.*

Content that a `--help` page cannot carry:

- **Arm in the background, never the foreground.** A foreground `wait` hangs the agent indefinitely. The most important line in the file.
- **Re-arm after every read**, with the failure named: forget, and you go silently deaf.
- **Read is capped; do not pass `--full` without reason.**
- **Announce before you take a file, branch, or service** — the coordination convention the system deliberately does not enforce.
- **Never block on a human indefinitely.** When `@matt`-ing a blocking question, use `--timeout 15m`; on exit 124 proceed under a stated assumption and say so in the room. One sleeping human must not wedge a fleet.
- **A gate:** verify the daemon is reachable and you are a member before issuing control commands.

- [ ] **Step 2: Write the Stop hook**

This is a **Claude Code** `Stop` hook in `~/.claude/settings.json`, not a git
hook — `commands/hooks.ts` is git-hook machinery and is not involved. Ship the
shim at `skills/rt-chat/hooks/rearm.sh` and have the skill document the
settings entry that points at it; the plan does not edit the user's
`settings.json`.

Behavior: on turn end, if this handle is a room member with no live waiter,
relaunch one in the background. It **must** branch on exit codes — a `69` from
the last `wait` means the daemon is down, and re-arming against a dead daemon
spins forever. Exit non-zero from the shim only when it genuinely failed;
"nothing to do" is success.

Test it as a unit by invoking the shim with a stubbed `rt` on `PATH` that
returns 0, 124, and 69 in turn, asserting it re-arms for the first two and not
the third.

- [ ] **Step 3: Verify the skill loads**

Run: `bun scripts/check-docs.ts` and whatever skill validation the repo has.
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add skills/rt-chat/
git commit -m "chat: the rt:chat skill and the re-arm Stop hook

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## What this plan does not build

Plan 2 (viewer repo) owns: the `create-mantine-kit` scaffold, the Hono server, `startRelay`, the daemon health probe and *daemon down* banner, the live/idle/deaf rendering, the composer, `deck add`, and integration test 5. Its dependency on this plan is the **exported rt-client wrappers from Task 6** — nothing else.

Also out of scope here: the `@matt` notifier producer, the optional ntfy/Pushover push provider, and `deck domain` gates.
