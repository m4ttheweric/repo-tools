# rt chat — core (plan 1 of 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `rt chat` — persistent, cross-account chat rooms that agents coordinate in, with a blocking wake that never dumps a transcript into an agent's pane.

**Architecture:** A semantic layer over the RT-44 event bus. Messages live in `state.db` (chat owns them); every post also emits *pointer* events carrying `{id}`, including one `chat/wake/<handle>` per recipient computed daemon-side from membership and `wake_on`. An agent runs `rt chat tail` under Claude Code's `Monitor` with `persistent: true`; the tail streams one line per wake and Monitor turns each line into a notification, so one arming serves the whole session. Nothing in this plan builds a web UI.

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
- **`rt chat tail` prints exactly one line per wake on stdout, and nothing else.** Under Monitor each stdout line is one notification, so this is the "don't flood the agent's pane" guarantee — a property of the binary, not a convention agents follow. Diagnostics go to stderr, which Monitor does not notify on. A source-guard test locks it (Task 8).
- **`rt chat post` prints nothing on success.** Posting must not cost context.
- **`tail` exit codes: `0` clean shutdown, `69` daemon unreachable.** There is no `124` — a tail takes no `--timeout`, because Monitor owns the lifetime. A tail must **exit** rather than block silently when the daemon dies: Monitor treats silence as "nothing happened", and only an ended stream produces the distinguishable *stream ended* notification.
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
e2e/tests/chat.test.ts            NEW: the wake-protocol integration tests
e2e/tests/chat-presence.test.ts   NEW: the daemon-restart disarm test (Task 4)
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
  - `export interface RoomSummary { room: string; memberCount: number; unread: number; mentions: number; lastPostedAt?: number }`
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

The recipient computation added here is consumed by **both** the post path and Task 8's tail path. It must be one exported function called by both. If they diverge — most easily by the tail path forgetting to exclude the agent's own posts — every message an agent posts notifies itself, forever.

**Files:**
- Modify: `lib/state/chat-store.ts`
- Test: `lib/state/__tests__/chat-store.test.ts`

**Interfaces:**
- Consumes: everything from Task 2; `runCriticalWrite` from Task 1.
- Produces:
  - `export interface ChatMessage { id: number; room: string; handle: string; body: string; mentions: string[]; replyTo?: number; postedAt: number }`
  - `export function parseMentions(body: string): string[]`
  - `export function recipientsFor(room: string, authorHandle: string, mentions: string[], db?: Database): string[]`
  - `export function postMessage(args: { room: string; handle: string; body: string }, db?: Database): { id: number; recipients: string[] } | undefined`
  - `export function readUnread(args: { handle: string; room?: string; limit: number; sinceMs?: number }, db?: Database): { room: string; messages: ChatMessage[] }[]`
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
  const first = readUnread({ handle: "b", limit: 20 }, db);
  expect(first[0]!.messages.map(m => m.body)).toEqual(["one"]);
  expect(readUnread({ handle: "b", limit: 20 }, db)).toEqual([]);
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
  expect(readUnread({ handle: "b", limit: 20 }, db)).toEqual([]);
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

`--since` is a store-side filter and cannot be done client-side, so
`sinceMs` threads all the way through: CLI flag → `chatRead` → handler →
`readUnread`, where it becomes an extra `posted_at >= ?` predicate. `--full`
is purely a CLI concern — it passes a large `limit` instead of the default 20
— so it stops at the CLI and needs no store support.

`readUnread` in one transaction: select `id > last_read_id` per joined room (or the one named), cap at `limit`, then set `last_read_id` to the highest id **actually returned** — not to `MAX(id)`, or a capped read silently marks unseen messages read.

- [ ] **Step 4: Run the tests**

Run: `bun test lib/state/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/state/chat-store.ts lib/state/__tests__/chat-store.test.ts
git commit -m "chat: messages, mention parsing, and the shared recipient rule

recipientsFor is called by both the post path and the tail path's unread
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

- *Why clear at all:* no waiter outlives the daemon (`events-bus.close()` settles every waiter, then closes the db), so any `armed_at` still set at boot is stale by definition. The agents cannot clear their own rows — `chat:disarm` is a daemon handler and the daemon is the thing that died, so each `rt chat tail` exits 69 with its row untouched. Skip this and every member reads as *live — will hear you* for ten minutes after each restart while every agent is disarmed, and nothing recovers it until each agent's Monitor reports the ended stream and the agent re-arms.
- *Why before serving:* run it after the socket is listening and an agent that arms in the gap has its fresh `armed_at` wiped — the mirror-image bug, a genuinely armed agent rendered deaf.

- [ ] **Step 5: Add the restart test**

There is no `rt chat` command yet — `commands/chat.ts` arrives in Task 7 — so
this test drives the store and the daemon directly. That is not a compromise:
`armed_at` is the load-bearing assertion, and it fails against broken code
regardless of timing, whereas a `status: "live"` assertion only fails while
`last_seen_at` is inside the 10-minute window. The status-level check belongs
with the CLI in Task 8.

```ts
// e2e/tests/chat-presence.test.ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "path";
import { createTestHome, RT_BINARY } from "../harness.ts";
import { openStateDb } from "../../lib/state/db.ts";
import { armMember, joinRoom } from "../../lib/state/chat-store.ts";

test("a daemon restart clears every armed_at", async () => {
  const { path: home, cleanup } = createTestHome();
  const dbPath = join(home, ".mattstack", "rt", "state.db");
  const db = openStateDb(dbPath);
  joinRoom({ room: "r", handle: "listener" }, db);
  armMember(undefined, "listener", db);
  db.close();

  await startDaemonForHome(home);
  await stopDaemonForHome(home);
  await startDaemonForHome(home);

  const after = openStateDb(dbPath);
  const row = after.query("SELECT armed_at FROM chat_members WHERE handle = 'listener';").get() as { armed_at: number | null };
  expect(row.armed_at).toBeNull();
  after.close();
  cleanup();
});
```

`startDaemonForHome` / `stopDaemonForHome` spawn `RT_BINARY` with `HOME` set
to the test home and wait on the socket — copy the `waitForSocket` helper and
the `children[]`/`afterAll` reaping from `e2e/tests/events.test.ts`, which
does exactly this.

- [ ] **Step 6: Lock the ordering with a source guard**

`lib/state/__tests__/source-guards.test.ts` already has a
`describe("daemon startup opens state.db before serving")` block that slices
`startDaemon(`'s body and asserts `openBranchCacheStore()`'s index is less
than both `startSocketServer(` and `startApiServer(`. Add `clearAllArmed()` to
that same block with the same two assertions. A prose instruction to "call it
before serving" is exactly the kind of ordering that gets refactored away;
this is how the repo already prevents that.

- [ ] **Step 7: Run the full suite**

Run: `bun test lib commands packages scripts && bun test --preload ./e2e/setup.ts --timeout 60000 e2e/tests/chat-presence.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add lib/state/chat-store.ts lib/state/__tests__/chat-store.test.ts lib/state/__tests__/source-guards.test.ts lib/daemon.ts e2e/tests/chat-presence.test.ts
git commit -m "chat: presence columns and the startup clear of armed_at

No waiter outlives the daemon, so every armed_at set at boot is stale.
The clear runs before serving: after the socket listens, an agent arming
in the gap would have its fresh armed_at wiped.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `events:head`

The tail path needs the journal head. Both `events:list` shapes are wrong for it: `limit`-bearing calls return the **last delivered event's** id rather than `maxId()` when `events.length === limit`, so `{limit: 1}` returns the *oldest* matching wake event and replays every historical wake forever; and a no-`limit` call means `after = 0`, and since `eventsAfter` applies the glob **in JS after** `SELECT ... WHERE id > ?`, it materializes the entire journal — all global bus traffic, payloads included — on the daemon thread, once per tail start.

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
  const id = bus.emit("chat/wake/a");
  expect(bus.head()).toBe(id);
});
```

Use whatever bus construction the existing tests in that file already use.
`emit` is `emit(topic: string, payload?: unknown): number` — a topic string
and a returned id, not an object either way.

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
export function chatRead(a: { handle: string; room?: string; limit?: number; sinceMs?: number }, o?: RtClientOptions): Promise<RtResponse<{ rooms: { room: string; messages: ChatMessage[] }[] }>>;
export function chatRooms(a: { handle: string }, o?: RtClientOptions): Promise<RtResponse<{ rooms: RoomSummary[] }>>;
export function chatWho(a: { room: string }, o?: RtClientOptions): Promise<RtResponse<{ members: ChatMember[] }>>;
export function chatMark(a: { handle: string; room?: string }, o?: RtClientOptions): Promise<RtResponse<Record<string, never>>>;
export function chatMessages(a: { room: string; before?: number; limit?: number }, o?: RtClientOptions): Promise<RtResponse<{ messages: ChatMessage[] }>>;
export function chatArm(a: { handle: string; room?: string }, o?: RtClientOptions): Promise<RtResponse<Record<string, never>>>;
export function chatTouch(a: { handle: string }, o?: RtClientOptions): Promise<RtResponse<Record<string, never>>>;
export function chatDisarm(a: { handle: string }, o?: RtClientOptions): Promise<RtResponse<Record<string, never>>>;
export function chatUnreadWaking(a: { handle: string; room?: string }, o?: RtClientOptions): Promise<RtResponse<{ rooms: { room: string; count: number; mentions: number }[] }>>;
export function eventsHead(o?: RtClientOptions): Promise<RtResponse<{ cursor: number }>>;
```

`ChatMember`, `ChatMessage`, `RoomSummary`, and `WakeMode` are re-exported from `index.ts` too — plan 2 imports the types, not just the functions.

- [ ] **Step 1: Write the failing test**

```ts
// lib/daemon/__tests__/chat-handlers.test.ts
import { expect, test } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { openStateDb } from "../../state/db.ts";
import { createChatHandlers } from "../handlers/chat.ts";

let n = 0;
function freshHandlers(emitEvent: (topic: string, payload?: unknown) => number = () => 0) {
  const db = openStateDb(join(tmpdir(), `chat-h-${process.pid}-${n++}.db`));
  return createChatHandlers({ db, emitEvent });
}

test("chat:join returns the resolved handle and member count", async () => {
  const h = freshHandlers();
  const res = await h["chat:join"]({ room: "build", handle: "a" });
  expect(res.ok).toBe(true);
  expect(res.data).toMatchObject({ handle: "a", memberCount: 1 });
});

test("chat:join rejects an invalid handle with a reason rather than normalizing it", async () => {
  const h = freshHandlers();
  const res = await h["chat:join"]({ room: "build", handle: "Has@Sigil" });
  expect(res.ok).toBe(false);
  expect(res.error).toContain("handle");
});

test("chat:post returns the recipients and emits one wake event per recipient", async () => {
  const emitted: string[] = [];
  const h = freshHandlers((topic) => { emitted.push(topic); return 0; });
  await h["chat:join"]({ room: "r", handle: "a" });
  await h["chat:join"]({ room: "r", handle: "b" });
  const res = await h["chat:post"]({ room: "r", handle: "a", body: "@b hi" });
  expect(res.ok).toBe(true);
  expect(res.data).toMatchObject({ recipients: ["b"] });
  expect(emitted).toEqual(["chat/r/msg", "chat/wake/b"]);
});

test("chat:unread-waking reports what would wake a handle without advancing its cursor", async () => {
  const h = freshHandlers();
  await h["chat:join"]({ room: "r", handle: "a" });
  await h["chat:join"]({ room: "r", handle: "b" });
  await h["chat:post"]({ room: "r", handle: "a", body: "@b hi" });
  expect((await h["chat:unread-waking"]({ handle: "b" })).data)
    .toMatchObject({ rooms: [{ room: "r", count: 1, mentions: 1 }] });
  expect((await h["chat:unread-waking"]({ handle: "b" })).data)
    .toMatchObject({ rooms: [{ room: "r", count: 1, mentions: 1 }] });
});
```

**The handler shape is a `createChatHandlers` factory returning a keyed map**,
matching `createEventsHandlers` and every other module in
`lib/daemon/handlers/`; `buildRoutedHandlers` spreads them
(`command-router.ts`) and callers invoke `handlers["chat:join"](payload)`.
There is no `handleX(cmd, payload)` dispatcher anywhere in this codebase — do
not invent one. The factory taking a `db` is also what gives these tests their
isolation seam, so no test touches the real `state.db`.

The second `chat:unread-waking` assertion is deliberate: calling it twice must
return the same thing. It is the one read in the wake path that must **not**
advance a cursor.

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test lib/daemon/__tests__/chat-handlers.test.ts`
Expected: FAIL — no module `../handlers/chat.ts`.

- [ ] **Step 3: Write the handlers**

Thin — validate, delegate to the store, shape the response. Handlers own **no**
logic that Task 3 already owns.

`chat:unread-waking` wraps `unreadWakingCount` and is **not optional**: it is
the only way Task 8's tail path can run its step-3 catch-up. `chat:read` cannot
substitute — it advances the cursor, which step 3 must not do — and
`chat:rooms`' generic unread cannot encode the predicate, which depends on
each member's `wake_on`.

`chat:post` returns `ok: false` when `postMessage` returns `undefined`: the
retry budget was exhausted and the message is lost. Returning `ok: true` there
would make the one path where silence is wrong indistinguishable from the
normal silent success.

`chat:messages` defaults `limit` to 50 when omitted, so plan 2 knows what an
omitted limit means.

`chat:post` is the one with real sequencing, and the order is an invariant a comment should state:

1. `postMessage(...)` — the row must **commit** before any emit, or a woken agent reads the pointer and finds no row.
2. Emit `chat/<room>/msg` with `{ id }`.
3. Emit `chat/wake/<handle>` with `{ id, room }` for each recipient returned by step 1.

Emit payloads carry pointers, never prose — chat owns the message store; the journal is the doorbell.

- [ ] **Step 4: Add catalog entries and client wrappers**

Add each `chat:*` to `commands.ts` with exact payload and data types, then the exported wrapper in `client.ts` following `listRuns`/`getRun` exactly, re-exported from `index.ts`. Types must match the store's interfaces exactly — a drift here is a tsc error, which is the point of the catalog.

- [ ] **Step 5: Add the read-only invariant test**

```ts
test("the read-only handlers mutate nothing", async () => {
  const h = freshHandlers();
  await h["chat:join"]({ room: "r", handle: "a" });
  await h["chat:join"]({ room: "r", handle: "b" });
  await h["chat:post"]({ room: "r", handle: "a", body: "@b hello" });
  const before = snapshotChatTables(h.db);
  await h["chat:rooms"]({ handle: "b" });
  await h["chat:who"]({ room: "r" });
  await h["chat:messages"]({ room: "r", limit: 20 });
  await h["chat:unread-waking"]({ handle: "b" });
  expect(snapshotChatTables(h.db)).toEqual(before);
});
```

`snapshotChatTables(db)` selects every row of `chat_members` and
`chat_messages` ordered by primary key and returns one comparable structure —
a **whole-table** snapshot, not `last_read_id` alone. The realistic drift is a
future `chat:who` that stamps `last_seen_at` while rendering presence, which a
column-specific assertion would sail straight past. Holding this at the
handler keeps it true if these are ever exposed over REST, where a mutating
"read" becomes a live vulnerability.

- [ ] **Step 6: Run the tests**

Run: `bun test lib commands packages scripts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/daemon/handlers/chat.ts lib/daemon/command-router.ts packages/rt-client/src lib/daemon/__tests__/chat-handlers.test.ts
git commit -m "chat: daemon handlers, command catalog, and rt-client wrappers

The wrappers are plan 2's entire dependency: the viewer reaches the
daemon over the unix socket, so no /api/chat/* rows ship and
needsToken() is untouched.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: The CLI — everything except `tail`

**Files:**
- Create: `commands/chat.ts`
- Modify: `lib/module-registry.ts`
- Modify: `packages/rt-client/src/settings/registry-defs.ts`
- Test: `commands/__tests__/chat.test.ts`

**Interfaces:**
- Consumes: the rt-client wrappers from Task 6.
- Produces: `export async function chat(args: string[]): Promise<void>` — the verb dispatcher.

**Verbs** (eight; `tail` lands in Task 8):

| command | behavior |
|---|---|
| `rt chat join <room> [--as <h>] [--wake-on mention\|all\|none]` | join, creating the room if absent |
| `rt chat leave <room>` | drop membership **only** — the waiter kill lands in Task 8 with the pidfile |
| `rt chat post <room> <text>` | post; **prints nothing on success** |
| `rt chat read [room] [--limit 20] [--full] [--since <dur>]` | print unread across joined rooms or one; advance the cursor |
| `rt chat rooms` | rooms, member counts, unread, last activity |
| `rt chat who [room]` | members with status, cwd, branch, pane |
| `rt chat mark [room]` | advance the cursor without printing |
| `rt chat tail` | Task 8 |

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

`runChat(args)` / `runChatRaw(args)` / `spawnChat(args)` are this file's local
helpers: invoke the `chat` export against a temp HOME and return stdout, or
`{ code, stdout, stderr }`, or the live process. Define them at the top of the
test file.

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

### Task 8: `rt chat tail` — the wake protocol

The highest-risk task in the plan. Read the spec's **Wake protocol** section in full before writing a line; the step ordering is the feature.

**Files:**
- Modify: `commands/chat.ts`
- Test: `commands/__tests__/chat.test.ts`, `e2e/chat.test.ts`

**Interfaces:**
- Consumes, all via rt-client: `eventsHead`, `chatUnreadWaking` (step 3's check — it reports what would wake a handle **without** advancing a cursor), `chatArm`, `chatTouch`, `chatDisarm`, and the `events:wait` handler.
- Produces: the `tail` verb.

**How it is run.** `tail` is a long-lived process launched under Claude Code's
`Monitor` with `persistent: true`, **not** `Bash` with `run_in_background`.
Monitor turns each stdout line into its own notification and stays armed for
the session; a backgrounded Bash process delivers one notification and dies,
which is what the earlier design's re-arm discipline, Stop hook, and `124`
timeout all existed to compensate for. Verified against the live harness:
an event woke a fully idle session, a second event arrived from the same
arming with no re-arm, and the stream ending produced its own distinguishable
notification.

**The tail path, in this exact order:**

1. **Snapshot the journal head** via `events:head`.
2. `chat:arm`.
3. Emit one line per unread message that *would have woken this handle* —
   using `recipientsFor`'s rule, author-exclusion included. This is the
   catch-up, and it closes the restart gap.
4. Loop: call the `events:wait` handler with pattern `chat/wake/<me>` and
   `after` = the step-1 cursor, thread the returned cursor into the next call,
   emit one line per wake, and call `chat:touch` each round.
5. On daemon-unreachable: print one line naming it, `chat:disarm`, exit **69**.
   Never block silently — Monitor reads silence as "nothing happened", so a
   hung tail is indistinguishable from a quiet room.

**Why step 1 precedes step 3:** `events:wait` with no `after` snapshots `head = maxId()` at registration and delivers only ids above it. Reading the database and *then* registering without a cursor leaves a window — process spawn plus IPC — in which a post commits and emits *below* the new waiter's head, seen by neither the catch-up nor the stream. That message reaches nobody until some later one happens to arrive. The transport change does not touch this window: it is between the `chat_messages` read and waiter registration, both of which are unchanged.

**Chat drives the `events:wait` handler directly, one round at a time — never `rt events wait`.** That CLI owns its own `while (true)` loop and never returns between polls, prints events-shaped JSON, and its `fail()` exits 1 rather than 69. Chat owns its loop, its exit codes, and its per-line output, and calls `chat:touch` each round so presence rides the loop.

- [ ] **Step 1: Write the failing tests**

```ts
test("tail exits 69 when the daemon is unreachable, rather than hanging", async () => {
  const { code } = await runChatRaw(["tail"], { sock: "/nonexistent.sock" });
  expect(code).toBe(69);
});

test("tail takes no --timeout", async () => {
  // Monitor owns the lifetime via persistent: true. A tail that could time
  // out would end its own stream and look like a dead feed.
  const { code, stderr } = await runChatRaw(["tail", "--timeout", "1s"]);
  expect(code).not.toBe(0);
  expect(stderr).toContain("--timeout");
});

test("tail refuses to double-arm", async () => {
  await runChat(["join", "r"]);
  const first = spawnChat(["tail"]);
  const { code, stderr } = await runChatRaw(["tail"]);
  expect(code).not.toBe(0);
  expect(stderr).toContain("already armed");
  first.kill();
});

test("every stdout write in the tail path is exactly one line", async () => {
  // Under Monitor each stdout line is one notification, so a multi-line write
  // floods the agent's context. Diagnostics must go to stderr.
  const src = await Bun.file("commands/chat.ts").text();
  const tailFn = src.slice(src.indexOf("async function chatTail"));
  const logs = tailFn.match(/console\.log\([^)]*\)/g) ?? [];
  expect(logs.every(l => !l.includes("\\n"))).toBe(true);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test commands/__tests__/chat.test.ts`
Expected: FAIL — no `tail` verb.

- [ ] **Step 3: Implement**

**`leave` gains its tail kill here, not in Task 7**, because the pidfile it
needs is introduced below. Extend `leave` to remove the pidfile and signal the
process once this task's lock exists.

**The test seam.** Between step 3 and step 4, if `RT_CHAT_TEST_PRE_WAIT_MARKER`
is set, create that file and block until it is removed, giving up after 2
seconds. It names a **path**, never a command — a seam that evaluated a shell
string from the environment would hand arbitrary code execution to anyone who
can set env on an `rt chat tail` invocation. This is the only way the arm-race
window is reachable from a test.

The pidfile is keyed on **handle alone**, under the rt dir — not `(room, handle)`. A room-less tail has no room component to key on, and because the wake topic is per-handle, two `--room`-scoped tails for one handle both emit on a message to either room. Lower stakes than under the one-shot design — duplicate notifications rather than corrupted wake state — but still worth the lock.

`--room` filters on the wake payload's `room` and **silently skips** a non-matching wake, continuing the stream. Without `--room`, every wake from any joined room emits.

Line format — one line per wake, no transcript, and no "then re-arm" instruction, because there is nothing to re-arm:

```
1 new in #build — @mention from repo-tools-main. `rt chat read` to see it.
```

- [ ] **Step 4: Write the integration tests**

E2E tests live in **`e2e/tests/`**, not `e2e/`; `harness.ts`, `fixtures.ts`,
and `setup.ts` sit at the `e2e/` root. **Build this file on
`e2e/tests/events.test.ts`**, which is the precedent in every respect that
matters here: it uses `createTestHome` and `RT_BINARY` from `../harness.ts`,
has local `waitForSocket()` and `freePort()` helpers, and — the part chat
cannot skip — keeps a `children[]` array so `afterAll` reaps processes
orphaned by a mid-test assertion failure. Chat's tests spawn **long-lived**
`tail` processes that never exit on their own; without that reaping, one
failed assertion leaves a tail running for the life of the suite and hangs
it. This matters more than it did under the one-shot design, where a stranded
waiter at least died at its own `--timeout`.

**Copy `events.test.ts`'s two-function helper split verbatim — do not
collapse it into one.** `runRt(args, home, extraEnv?)` spawns `[RT_BINARY, ...args]` with
a **hermetic env** (`HOME`, an explicit `PATH`, `RT_SKIP_SETUP`, `CI`,
`RT_API_PORT`; never `...process.env`), pushes the process into `children[]`,
and **returns the process**. `finished(proc)` awaits `exited` and collects
stdout/stderr. Every chat test that blocks a waiter needs the handle, so a
helper that spawns *and* awaits cannot serve them.

Three things go wrong the moment a test reaches for a bare
`Bun.spawn(["rt", …])` instead:

1. `"rt"` resolves from the developer's `PATH`, not the binary `e2e/setup.ts`
   just compiled from the working tree — the test exercises whatever rt is
   installed, or fails with ENOENT where none is.
2. Without an explicit env the child inherits the ambient one and talks to the
   **real** `~/.mattstack/rt/state.db` and the **real running daemon** — on a
   developer's machine the wake tests would join real rooms, post real
   messages, and wake real agents. `events.test.ts`'s own comment records that
   this class of leak caused the original port-9401 collision.
3. It never reaches `children[]`, so the blocking waiters become exactly the
   processes `afterAll` cannot reap.

Also define `waitUntilArmed(home, room, ...handles)`, polling `chat:who` until
each handle's `armed_at` is set — **never a fixed sleep**; `events.test.ts`
uses `await Bun.sleep(500)` for this and chat deliberately does not, because a
fixed sleep makes the wake tests flaky under load.

**`home` is the first parameter for the same reason `runRt` takes it, and the
trap here is subtler than the spawn one.** This helper reaches the daemon
without spawning a child, so it is invisible to any sweep of `Bun.spawn` call
sites — but `defaultSock()` resolves `process.env.HOME ?? homedir()`, and only
the *children* get the test home, through `runRt`. The test process itself has
some **other** HOME — the throwaway temp dir `test-setup.ts` repoints it to
under the bunfig preload, or the developer's real home — and either way it is
not the home the daemon under test is running in. A home-less
`waitUntilArmed` therefore polls the wrong socket, never observes the test
handle armed, and spins to its deadline, failing the post→wake and wake-policy
tests while the feature works perfectly.

`test-setup.ts`'s own module doc draws this same line — *"e2e fixtures pass
their own explicit HOME when spawning the binary, so this never reaches
them"* — which is why unit-test helpers (`runChat`, `freshDb`,
`freshHandlers`) correctly take no `home` while every e2e helper does. Implement it either as
`finished(runRt(["chat", "who", room, "--json"], home))`, or through rt-client
with an explicit `sockPath: join(home, ".mattstack", "rt", "rt.sock")`, which
`RtClientOptions` already accepts. **Every helper that touches the daemon takes
`home`, whether or not it spawns.**

And `until(pred)`, polling a predicate to a deadline — a pure predicate, so it
needs neither `home` nor env.

```ts
// e2e/tests/chat.test.ts
import { expect, test } from "bun:test";

// A tail never exits on its own, so tests read LINES from a live process
// rather than awaiting an exit code. `nextLine(proc, ms)` resolves the next
// stdout line or rejects on timeout; define it beside the other helpers.

test("a post emits one line on a running tail", async () => {
  await finished(runRt(["chat", "join", "r", "--as", "listener"], home));
  await finished(runRt(["chat", "join", "r", "--as", "poster"], home));
  const tail = runRt(["chat", "tail", "--as", "listener"], home);
  await waitUntilArmed(home, "r", "listener");
  await finished(runRt(["chat", "post", "r", "@listener ping", "--as", "poster"], home));
  const line = await nextLine(tail, 5_000);
  expect(line).toContain("#r");
  expect(line.split("\n")).toHaveLength(1);
  tail.kill();
});

test("THREE mentions arrive on ONE arming", async () => {
  // The property the whole transport rests on. Under the previous
  // backgrounded-Bash design the second message reached nobody, because the
  // process had already exited delivering the first.
  await finished(runRt(["chat", "join", "r", "--as", "listener"], home));
  await finished(runRt(["chat", "join", "r", "--as", "poster"], home));
  const tail = runRt(["chat", "tail", "--as", "listener"], home);
  await waitUntilArmed(home, "r", "listener");
  for (const n of ["one", "two", "three"]) {
    await finished(runRt(["chat", "post", "r", `@listener ${n}`, "--as", "poster"], home));
    expect(await nextLine(tail, 5_000)).toContain("#r");
  }
  expect(tail.killed).toBe(false);
  tail.kill();
});

test("restart gap: a post with no tail running is emitted by the catch-up", async () => {
  await finished(runRt(["chat", "join", "r", "--as", "listener"], home));
  await finished(runRt(["chat", "join", "r", "--as", "poster"], home));
  await finished(runRt(["chat", "post", "r", "@listener while you were out", "--as", "poster"], home));
  const tail = runRt(["chat", "tail", "--as", "listener"], home);
  expect(await nextLine(tail, 5_000)).toContain("1 new");
  tail.kill();
});

test("wake policy: mention emits only when named; all always; none never", async () => {
  await finished(runRt(["chat", "join", "r", "--as", "poster"], home));
  await finished(runRt(["chat", "join", "r", "--as", "m"], home));
  await finished(runRt(["chat", "join", "r", "--as", "a", "--wake-on", "all"], home));
  await finished(runRt(["chat", "join", "r", "--as", "n", "--wake-on", "none"], home));
  const mention = runRt(["chat", "tail", "--as", "m"], home);
  const all = runRt(["chat", "tail", "--as", "a"], home);
  const none = runRt(["chat", "tail", "--as", "n"], home);
  await waitUntilArmed(home, "r", "m", "a", "n");
  await finished(runRt(["chat", "post", "r", "no mention here", "--as", "poster"], home));
  await expect(nextLine(mention, 2_000)).rejects.toThrow();
  expect(await nextLine(all, 2_000)).toContain("#r");
  await expect(nextLine(none, 2_000)).rejects.toThrow();
  [mention, all, none].forEach(p => p.kill());
});

test("a dead daemon ends the stream rather than going quiet", async () => {
  // Monitor reads silence as "nothing happened", so a tail that blocks on a
  // dead daemon is indistinguishable from a room with no traffic.
  await finished(runRt(["chat", "join", "r", "--as", "listener"], home));
  const tail = runRt(["chat", "tail", "--as", "listener"], home);
  await waitUntilArmed(home, "r", "listener");
  await stopDaemonForHome(home);
  expect((await finished(tail)).exitCode).toBe(69);
});

test("the arm race: a post landing between the catch-up and the stream is not lost", async () => {
  // The injection point is AFTER step 3's catch-up and BEFORE the events:wait
  // call. Injecting anywhere earlier in the step-1-to-step-4 window proves
  // nothing: step 3 catches those posts even with the step-1 cursor deleted,
  // so the test would pass against the exact regression it exists to catch.
  // RT_CHAT_TEST_PRE_WAIT_MARKER names a FILE, never a command: the CLI
  // creates it at that point and blocks until it is removed, so the test can
  // post inside the window. A seam that evaluated a shell string from the
  // environment would be arbitrary code execution in a shipped binary.
  const marker = join(tmpdir(), `chat-race-${process.pid}`);
  await finished(runRt(["chat", "join", "r", "--as", "listener"], home));
  await finished(runRt(["chat", "join", "r", "--as", "poster"], home));
  const tail = runRt(["chat", "tail", "--as", "listener"], home,
    { RT_CHAT_TEST_PRE_WAIT_MARKER: marker });
  await until(() => existsSync(marker));
  await finished(runRt(["chat", "post", "r", "@listener raced", "--as", "poster"], home));
  rmSync(marker);
  expect(await nextLine(tail, 10_000)).toContain("#r");
  tail.kill();
});
```



- [ ] **Step 5: Run everything**

Run: `bun test lib commands packages scripts && bun test --preload ./e2e/setup.ts --timeout 60000 e2e/tests/chat.test.ts`
Expected: PASS.

- [ ] **Step 6: Verify the race test actually guards**

Temporarily delete the step-1 cursor (pass no `after` to `events:wait`), re-run the arm-race test, and confirm it **fails**. Restore. Paste both outputs into your report — a race test that passes both ways is worthless, and this is the only way to know.

- [ ] **Step 7: Commit**

```bash
git add commands/chat.ts commands/__tests__/chat.test.ts e2e/tests/chat.test.ts
git commit -m "chat: the wake protocol

Head snapshot before the unread check, then arm with that cursor: a post
landing between a bare check and waiter registration emits below the new
waiter's head and is seen by neither.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: The skill and the Stop hook

**Files:**
- Create: `skills/rt-chat/SKILL.md` — the only file this task produces

**Interfaces:**
- Consumes: the CLI from Tasks 7–8.

- [ ] **Step 1: Write the skill**

`skills/rt-chat/SKILL.md`, frontmatter `name: rt:chat`, matching the local convention (`skills/` holds `rt-create-plugin`, `rt-docs`, `rt-release`, `rt-sdm-connect`). One skill covering the whole CLI surface behind a gate — the shape the herdr skill uses, which lives in the **herdr** repo, not this one.

Description trigger: *use when asked to join or coordinate in an agent chat room, when told you are working alongside other agents, or when you need to reach an agent under a different account.*

Content that a `--help` page cannot carry:

- **Arm once, with `Monitor` and `persistent: true`** — never `Bash` with `run_in_background`, which delivers one notification and dies, leaving the agent silently deaf after the first message. The most important line in the file, and the one an agent is likeliest to get wrong, because backgrounded Bash is the more familiar tool.
- **Do not re-arm after reading.** One Monitor serves the whole session; a second tail notifies twice for every message. Re-arm only after a *stream ended* notification, which means the feed died — and check the daemon first if the exit was 69.
- **Read is capped; do not pass `--full` without reason.**
- **Announce before you take a file, branch, or service** — the coordination convention the system deliberately does not enforce.
- **Never block on a human at all.** Ask `@matt`, state the assumption you are proceeding under, and keep working — the reply arrives as a notification whenever it comes. A tail does not block, so there is no wait to bound and no timeout to choose.
- **A gate:** verify the daemon is reachable and you are a member before issuing control commands.

**No Stop hook ships.** An earlier draft of this plan included one to re-arm
agents that forgot, because a backgrounded one-shot dies after a single
notification. Monitor stays armed for the session, so there is nothing to
re-arm and the hook has no job. Do not add one back without revisiting the
transport decision in the spec's **Wake protocol**.

- [ ] **Step 2: Verify the skill loads**

Run: `bun scripts/check-docs.ts` and whatever skill validation the repo has.
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add skills/rt-chat/
git commit -m "chat: the rt:chat skill

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Notify Matt on mention (the desk path)

Spec **Notifications**. This appeared in the spec's Rollout but in neither
plan's task list — it is rt-side work, so it lands here. Optional push is
**Task 11**: independent deliverable, different module, different failure
modes, and shippable separately.

**The integration point with Task 11, and the constant that enforces it.**
`notifyEnabled(category, ...)` passes `category` straight into
`notify(title, message, url, category, pids)`, so it becomes `event.category`.
This task emits **`"chat_mention"`** (it must: that same string is the
`NOTIFICATION_TYPES` prefs key) and Task 11 filters on exactly that value.

**Export it as a constant rather than repeating the literal:**

```ts
export const CHAT_NOTIFICATION_CATEGORY = "chat_mention";
```

in `lib/notifier.ts`, used by all three sites — the `NOTIFICATION_TYPES`
entry's `key`, this task's `notifyEnabled` call, and Task 11's filter.

**The identifier may be refactored freely; the string value may not.** It is
persisted: `isEnabled` reads `prefs[key]` out of the `rt.notifications`
setting on disk, which is a fourth copy no constant can reach. Change the value
and every code site updates atomically and every test still passes — but a user
who had switched chat notifications off has `{"chat_mention": false}` stored,
the lookup becomes `prefs["<new>"]` → `undefined` → `undefined !== false` →
**enabled**, and their preference silently reverts. All fourteen existing
`NOTIFICATION_TYPES` keys share this property: the value is a persistence
contract, not an implementation detail. Written
as three separate literals, a divergence between producer and consumer is
silent: no type error, no failing test, and push simply never fires. Through
the constant it cannot diverge at all. This is not style — an earlier draft of
this plan had Task 10 emitting `"chat_mention"` while Task 11 filtered
`"chat"`, and every test passed.

**Files:**
- Modify: `lib/daemon/handlers/chat.ts`
- Modify: `lib/notifier.ts` — a `chat_mention` entry in `NOTIFICATION_TYPES`; an optional trailing `id` on `notify()` and `notifyEnabled()`
- Test: `lib/daemon/__tests__/chat-handlers.test.ts`

**Interfaces:**
- Consumes, all from `lib/notifier.ts`: `notifyEnabled`, `peekNotifications`, `drainNotifications`, `loadNotificationPrefs`, `saveNotificationPrefs`; plus `getSetting` for `chat.humanHandle`.
- Produces: no new exports; `notify` and `notifyEnabled` gain an optional trailing `id`.

- [ ] **Step 1: Write the failing tests**

**These read the default db, not `h.db`, and that is not a slip.** `notify()`
calls `enqueueNotification(event)` with no db argument, so it writes to the
process-wide `getStateDb()` singleton — the handler's injected db never reaches
the notifier. Asserting `peekNotificationQueue(h.db)` would read an empty queue
forever while the feature works correctly. The bunfig preload repoints `HOME`
per test process, so the default db is already throwaway.

```ts
beforeEach(() => { drainNotifications(); });

test("notifies on a mention even when the human has never joined the room", async () => {
  // The common case, not an edge: agents create rooms via join-creates and
  // Matt is not a member until he posts. Gating this on recipientsFor -- which
  // reads chat_members and can only return members -- means the desk never
  // rings for the very question the skill tells agents to ask him.
  const h = freshHandlers();
  await h["chat:join"]({ room: "r", handle: "agent" });
  await h["chat:post"]({ room: "r", handle: "agent", body: "@matt ok to force-release?" });
  expect(peekNotifications()).toHaveLength(1);
});

test("notifies even when the human is a member with wake_on none", async () => {
  // Plausible for a human who does not want a waiter armed; his wake setting
  // must not silently disable his desk notifications.
  const h = freshHandlers();
  await h["chat:join"]({ room: "r", handle: "agent" });
  await h["chat:join"]({ room: "r", handle: "matt", wakeOn: "none" });
  await h["chat:post"]({ room: "r", handle: "agent", body: "@matt still there?" });
  expect(peekNotifications()).toHaveLength(1);
});

test("does not notify on a mention of anyone else", async () => {
  const h = freshHandlers();
  await h["chat:join"]({ room: "r", handle: "agent" });
  await h["chat:post"]({ room: "r", handle: "agent", body: "@nobody hello" });
  expect(peekNotifications()).toHaveLength(0);
});

test("chat_mention disabled in prefs suppresses the notification entirely", async () => {
  const saved = loadNotificationPrefs();
  try {
    saveNotificationPrefs({ ...saved, chat_mention: false });
    const h = freshHandlers();
    await h["chat:join"]({ room: "r", handle: "agent" });
    await h["chat:post"]({ room: "r", handle: "agent", body: "@matt hi" });
    expect(peekNotifications()).toHaveLength(0);
  } finally {
    saveNotificationPrefs(saved);
  }
});
```

The spread-and-restore in the last test is required: `saveNotificationPrefs`
does `setSetting("rt.notifications", prefs, "user")`, replacing the **whole
blob**, so a bare `{ chat_mention: false }` would wipe every other preference
for anything running afterward.

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test lib/daemon/__tests__/chat-handlers.test.ts`
Expected: tests 1 and 2 **FAIL** (nothing is enqueued). Tests 3 and 4 assert
`toHaveLength(0)` and therefore **pass before any implementation exists** —
that is expected, not a sign you are done. They are guards against
over-notifying, and they only become meaningful once tests 1 and 2 are green.

- [ ] **Step 3: Implement**

Enqueue one notification when **`parseMentions(body)`** contains the
`chat.humanHandle` setting (default `matt`).

**Deliberately `parseMentions`, not the recipient set.** `recipientsFor` reads
`chat_members`, so it can only ever return members of the room — and Matt is
typically not one: agents create rooms through join-creates, and he becomes a
member only when he posts. Gating on it would mean `@matt` in an
agent-created room produces no notification at all, while the skill is
simultaneously telling agents to `@matt` a blocking question and wait 15
minutes. It would also let a member with `wake_on = 'none'` silently disable
his own desk alerts. The spec's wording is unqualified — mentioning the human
handle adds one producer to the queue — and this is that, independent of
membership and `wake_on`.

**Call `notifyEnabled()` — not `notify()`, and certainly not the store's
`enqueueNotification`.** Three layers, and picking the wrong one breaks
something different each time:

- The **store's `enqueueNotification`** writes straight to `notify_queue`,
  bypassing the tray push and the WebSocket broadcast hook. `notify()` is the
  only path to `pushToTray`.
- **`notify()`** does both but respects no user preference. Every other
  notification in rt is switchable; chat would be the only kind Matt cannot
  turn off, and it would not appear in the prefs UI at all.
- **`notifyEnabled(category, title, message, url?, pids?)`** checks
  `isEnabled(loadNotificationPrefs(), category)` and then calls `notify()`.
  That is the correct entry point.

```ts
notifyEnabled(CHAT_NOTIFICATION_CATEGORY, `#${room}`, `${authorHandle}: ${body}`,
              undefined, undefined, `chat:${messageId}`);
```

`notifyEnabled` is the right layer and there is precedent:
`lib/daemon/discussions-store.ts` uses it as `(overrides.notify ?? notifyEnabled)("new_comment", ...)`
for exactly this shape of one-off emitter. (Grepping `notifyEnabled(` will not
find that call — the identifier is not followed by a paren.) The in-module
emitters instead use `if (isEnabled(prefs, key)) notify(...)` because they
already hold `prefs` for a whole cycle; `chat:post` does not.

Two additive changes to `lib/notifier.ts` make the call work:

1. **A `chat_mention` entry in `NOTIFICATION_TYPES`** —
   `{ key: CHAT_NOTIFICATION_CATEGORY, label: "Chat mention", description: "When an agent mentions you in a chat room" }`,
   with the constant declared above it.
   That array is the user-facing on/off list; without an entry the preference
   is invisible even though `isEnabled` would honor it. Non-breaking:
   `isEnabled` is `prefs[key] !== false`, so an unset key defaults to on.
2. **A trailing optional `id` on both `notify()` and `notifyEnabled()`.**
   `notify` is `notify(title, message, url?, category?, pids?)` today and
   generates `crypto.randomUUID()` internally; `notifyEnabled` forwards no id
   at all, so without threading it through both, chat's id would be silently
   replaced by a UUID. Chat needs a *stable* one: `chat:<messageId>` is unique
   per message and repeatable, so a redelivery cannot double-notify, which is
   what the already-exported `isNotificationQueued` exists to check. Optional
   and defaulted, so every current caller is unaffected — including
   `discussions-store`'s, which passes four arguments against a
   `(category, title, message, url?) => void` type that a function with extra
   optional parameters stays assignable to.

- [ ] **Step 4: Run the suite**

Run: `bun test lib commands packages scripts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/daemon/handlers/chat.ts lib/notifier.ts lib/daemon/__tests__/chat-handlers.test.ts
git commit -m "chat: notify Matt on mention

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Optional push to a phone

Off by default. The desk path (Task 10) is complete without this, so it is
independently droppable.

**v1 supports ntfy only.** Pushover needs a fixed endpoint plus `token` and
`user` credentials in the form body, which `chat.push.target` has nowhere to
hold — adding it means a third setting and a credential path, and that is not
worth it before the feature has been used once. `chat.push.provider` is
validated against `"ntfy"` and rejects anything else with a message saying so,
which keeps the setting name honest about its future without shipping a
half-specified provider.

**The integration point with Task 10 — read this before writing the filter.**
Task 10 emits its notification through
`notifyEnabled(CHAT_NOTIFICATION_CATEGORY, ...)`,
and `notifyEnabled` passes its category straight into
`notify(title, message, url, category, pids)`, so every real chat notification
arrives here with **`event.category === CHAT_NOTIFICATION_CATEGORY`** (whose
value is `"chat_mention"`).

**Import `CHAT_NOTIFICATION_CATEGORY` from `lib/notifier.ts` and filter on it.
Do not write the literal.** Task 10 declares it, and it is also the
`NOTIFICATION_TYPES` prefs key, so the value cannot differ between producer and
consumer. Repeating the literal here is how this went wrong once already: an
earlier draft filtered `"chat"` while Task 10 emitted `"chat_mention"`, and
because the tests below fabricate their own events, all of them passed while no
`@matt` mention would ever have been pushed.

**Files:**
- Modify: `lib/notifier.ts` — the push producer, beside `pushToTray` inside `notify()`
- Test: `lib/__tests__/notifier-push.test.ts`

`chat.push.provider` and `chat.push.target` are **already registered by Task 7
Step 4** — this task only reads them and adds no settings defs.

**Interfaces:**
- Consumes: `CHAT_NOTIFICATION_CATEGORY`, `notify`, `peekNotifications`, `drainNotifications` from `lib/notifier.ts` (the constant is declared in Task 10); `getSetting` for `chat.push.provider` / `chat.push.target` (registered in Task 7); `createChatHandlers` from `lib/daemon/handlers/chat.ts` for the end-to-end test; `setSetting(key, value, scope)` in tests.

- [ ] **Step 1: Write the failing tests**

All four go through the default db and the default prefs blob, so both need
resetting between tests — without the `beforeEach` drain, test 2 sees test 1's
event and every count assertion is off by the number of tests that ran first.

```ts
const push = () => {
  setSetting("chat.push.provider", "ntfy", "user");
  setSetting("chat.push.target", "https://ntfy.sh/x", "user");
};

beforeEach(() => {
  drainNotifications();
  // Settings need the same reset the queue gets. Without clearing the
  // provider, test 1 passes only because it happens to run before the first
  // push() call, and reordering the file breaks it.
  setSetting("chat.push.provider", "", "user");
  setSetting("chat.push.target", "", "user");
});

// Every spy carries a mock implementation. A bare spyOn(globalThis, "fetch")
// CALLS THROUGH, so the moment the category filter regresses, the last test
// makes a real network POST to ntfy.sh from the suite.
const inert = () => spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));

test("no provider configured sends nothing anywhere", async () => {
  const fetchSpy = inert();
  notify("#r", "agent: @matt hi", undefined, "chat_mention");
  await Bun.sleep(0);
  expect(fetchSpy).not.toHaveBeenCalled();
});

test("a chat_mention notification is pushed when a provider is configured", async () => {
  push();
  const fetchSpy = inert();
  notify("#r", "agent: @matt hi", undefined, "chat_mention");
  await Bun.sleep(0);
  expect(fetchSpy).toHaveBeenCalledWith("https://ntfy.sh/x", expect.objectContaining({ method: "POST" }));
});

test("a failing push does not fail the notification", async () => {
  push();
  spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
  expect(() => notify("#r", "agent: @matt hi", undefined, "chat_mention")).not.toThrow();
  await Bun.sleep(0);
  expect(peekNotifications()).toHaveLength(1);
});

test("a non-chat notification is never pushed", async () => {
  push();
  const fetchSpy = inert();
  notify("MR ready", "something else", undefined, "general");
  await Bun.sleep(0);
  expect(fetchSpy).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Add the end-to-end test — the one that drives the real producer**

Every test above fabricates its event by calling `notify()` directly, which is
exactly why a wrong filter looked correct: the tests chose the category, so
they agreed with whatever the filter said. This one goes through `chat:post`,
so the category comes from the production path and the producer/consumer
contract is actually exercised.

```ts
test("a real @matt mention through chat:post reaches the push provider", async () => {
  push();
  const fetchSpy = inert();
  const h = createChatHandlers({
    db: openStateDb(join(tmpdir(), `chat-push-${process.pid}.db`)),
    emitEvent: () => 0,
  });
  await h["chat:join"]({ room: "r", handle: "agent" });
  await h["chat:post"]({ room: "r", handle: "agent", body: "@matt ok to force-release?" });
  await Bun.sleep(0);
  expect(fetchSpy).toHaveBeenCalledWith("https://ntfy.sh/x", expect.objectContaining({ method: "POST" }));
});
```

**Construct the handlers inline; do not reach for `freshHandlers()`.** That
helper is file-local to Task 6's `lib/daemon/__tests__/chat-handlers.test.ts`
and is not exported — this task writes `lib/__tests__/notifier-push.test.ts`,
a different file, and is the first task to need handlers from outside it. The
handler's db does not matter to this assertion: it asserts on `fetchSpy`, and
`notify()` writes to `getStateDb()` regardless of what db the handler was
given, so a minimal construction is enough.

**This is the load-bearing test in the task.** The four above are all
satisfiable by a wrong-but-self-consistent implementation; this one is not. If
the constant were ever bypassed and the two sides diverged again, this is the
only test that would go red.

`notify()` is synchronous and pushes fire-and-forget, so each test awaits a
microtask turn before asserting. There is no `deliver()` function — dispatch is
inline in `notify()` and this task does not extract one.

- [ ] **Step 3: Run them to verify they fail**

Run: `bun test lib/__tests__/notifier-push.test.ts`
Expected: FAIL — no fetch is ever made.

- [ ] **Step 4: Implement**

Beside the existing `pushToTray(event)` call inside `notify()`. That is
`notify()`'s fire-and-forget dispatch point, **not** the request path — the
post has already returned and stored its message before any outbound call
happens, so "a failed push must not fail the post" costs nothing rather than
needing a try/catch around a network call in `chat:post`.

The ntfy request is `POST <chat.push.target>` with the message as the body and
a `Title` header:

```ts
fetch(target, { method: "POST", headers: { Title: event.title }, body: event.message })
  .catch(err => warnPushFailed(err));
```

**There is no logger in scope in `lib/notifier.ts`** — it imports no logging
module. Do **not** add a top-level `daemon-logger` import: `lib/state/busy.ts`
carries a comment explaining that doing so leaks `daemon-logger`'s
`~/Library` pino-roll side effect into every consumer, and `lib/notifier.ts`
is reachable from CLI paths with the same exposure. Follow `busy.ts`'s lazy
dynamic import on the warn path only:

```ts
let logHandle: Promise<...> | undefined;
function warnPushFailed(err: unknown): void {
  logHandle ??= import("./daemon-logger.ts").then(m => m.getDaemonLogger());
  void logHandle.then(h => h.childLogger("chat-push").warn({ err }, "chat push failed"));
}
```

**Push only when `event.category === CHAT_NOTIFICATION_CATEGORY`.** That filter
is not optional.
`notify()` handles *every* notification type — its `category` parameter
defaults to `"general"` and every emitter in the module routes through it — so
without the check, setting `chat.push.provider` would send Matt's phone MR
updates, pipeline alerts, and runaway-process warnings rather than `@matt`
mentions. And filtering on the *wrong* string — `"chat"` rather than
`"chat_mention"` — pushes nothing at all while every test still passes. The settings are named `chat.push.*` and the spec frames push as the
`@matt` path, so the intended scope is unambiguous.

**Absent by default:** with no provider configured nothing is sent anywhere and
no third-party dependency is required. A failed push logs at `warn` and is not
retried — the message is already stored and the desk notification already
queued, so failing here would discard work that succeeded.

- [ ] **Step 5: Run the suite**

Run: `bun test lib commands packages scripts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/notifier.ts lib/__tests__/notifier-push.test.ts
git commit -m "chat: optional ntfy push for @matt mentions

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## What this plan does not build

Plan 2 (viewer repo) owns: the `create-mantine-kit` scaffold, the Hono server, `startRelay`, the daemon health probe and *daemon down* banner, the live/idle/deaf rendering, the composer, `deck add`, and integration test 5. Its dependency on this plan is the **exported rt-client wrappers from Task 6** — nothing else.

Also out of scope here: `deck domain` gates, which land with the viewer.
