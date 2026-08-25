# rt chat presence (plan 3) Implementation Plan — DRAFT, pending Matt's review of the spec

> **Status: DRAFT.** The spec (`docs/superpowers/specs/2026-08-24-rt-chat-presence-design.md`, PR #80) is reviewer-approved but not yet Matt-approved. Execute nothing from this plan until it is.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sign-in/sign-out presence (the buddy roster), DMs including the human, and the hook layer that keeps deets fresh and delivers waiting messages — the AIM model on top of plan 1's rooms.

**Architecture:** A `chat_presence` table keyed on session id (two heartbeats: session vs tail), a `chat_dms` table for DM rooms keyed by participant hash, seven new verbs on `rt chat`, a session file that makes handle resolution stay local, and a `chat` Claude Code plugin carrying the sign-in/out/away skills plus `UserPromptSubmit`/`SessionEnd`/`SessionStart` hooks. Everything reaches the daemon through the shipped `chat:*` handler seam.

**Tech Stack:** Bun, SQLite (`lib/state`), the RT-48 daemon handler/router pattern, `@mattstack/rt-client`, Claude Code plugin (skills + `hooks/hooks.json`).

**Spec:** `docs/superpowers/specs/2026-08-24-rt-chat-presence-design.md` — read it before Task 1; on any conflict, the spec wins. Its base is `docs/superpowers/specs/2026-08-23-rt-chat-design.md`.

**Repos touched:** `repo-tools` (everything but the plugin) and `mattstack-marketplace` (the `chat` plugin, Task 8). **Plan-level choice the spec left open:** the revised `rt:chat` skill stays in `repo-tools/skills/rt-chat` (it is versioned with the CLI it teaches); the plugin ships the three new user-facing skills and the hooks, and its `chat:sign-in` skill defers to `rt:chat` for the arm discipline rather than duplicating it.

## Global Constraints

- **The migration runner replays every version's schema.** Only `IF NOT EXISTS` statements; **no `ALTER TABLE`** (spec, Data model). A v5 dry-run-over-v4 test gates this.
- **Two heartbeats, never one.** `last_seen_at` is written by `sign-in`/`pulse` only; `tail_seen_at` by `chat:touch` only; `pulse` never writes `chat_members.last_seen_at`. Everywhere a status is computed, "tail heartbeat" means `COALESCE(tail_seen_at, armed_at)`.
- **One reclaim predicate:** holder signed out, or session heartbeat > 1h **and** tail heartbeat > 10m/absent. Stated once (`RECLAIMABLE_SQL`) and used everywhere.
- **Resolution position 0** is the session file; `--as` on any verb other than `sign-in` while signed in is refused. The arm line is bare `rt chat tail`.
- **The handle charset never sees `%` or `:`** — labels via the identity codec only (RT-62); serialized identities are keys, never display.
- **Barrel rule (RT-48):** everything outside `lib/state/` imports store APIs through `lib/state/index.ts`.
- **Clean-code comments only.** A comment states a constraint the code cannot show.
- **Commits:** prefix `chat-presence:`, trailer `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- **Test gate:** `bun run test && bunx tsc --noEmit && sh scripts/repo-purity.sh` before every commit (repo-tools); the plugin repo has no gate beyond `bun test` of its fixtures.

---

## File structure (what exists after this plan)

```
# repo-tools
lib/state/db.ts                          MODIFY: v4 — chat_presence, chat_dms; startup clear covers both
lib/state/presence-store.ts              NEW: sign-in/out, heartbeats, statuses, reclaim, prune, buddies
lib/state/dm-store.ts                    NEW: dmRoomFor (hash id, chat_dms row, memberships incl. the human)
lib/state/chat-store.ts                  MODIFY: postMessage mentions param; joinRoom guard scoped; join refuses DM rooms
lib/state/index.ts                       MODIFY: barrel exports
lib/daemon/handlers/chat.ts              MODIFY: 7 new handlers; session-id enforcement; who/rooms presence-joined
lib/command-tree-def.ts                  MODIFY: new verbs
packages/rt-client/src/commands.ts       MODIFY: chat:sign-in … chat:pulse catalog entries
packages/rt-client/src/client.ts,index.ts MODIFY: wrappers + types
commands/chat.ts                         MODIFY: verbs, session file, room derivation, tail reclaim exit, statuses
lib/chat-session.ts                      NEW: the session file (read/write/delete/resolve)
skills/rt-chat/SKILL.md                  MODIFY: sign-in entry point, bare arm line, 4 statuses, DMs
e2e/tests/chat-presence2.test.ts         NEW: the spec's e2e list

# mattstack-marketplace
plugins/chat/plugin.json                 NEW
plugins/chat/skills/sign-in/SKILL.md     NEW   (also sign-out/, away/)
plugins/chat/hooks/hooks.json            NEW: UserPromptSubmit → pulse; SessionEnd → sign-out; SessionStart(resume|compact|fork) → re-arm notice
plugins/chat/hooks/pulse.sh              NEW: the thin shell hooks call (jq session_id → rt chat pulse --json → additionalContext)
```

---

### Task 1: Hook-contract verification spike

The spec conditions two mechanisms on undocumented behaviour; prove both before anything is built on them.

**Files:**
- Create: `.superpowers/sdd/2026-08-24-rt-chat-presence/hook-verification.md` (findings report — git-ignored workspace)

- [ ] **Step 1: Prove `CLAUDE_CODE_SESSION_ID` equals the hook's `session_id`**

Register a throwaway `UserPromptSubmit` hook in a scratch project's `.claude/settings.json` that writes its stdin to a temp file, run one prompt in a fresh `claude` session there, and compare the captured `session_id` with `echo $CLAUDE_CODE_SESSION_ID` from inside that session. Record both values.

- [ ] **Step 2: Prove `additionalContext` injection on `UserPromptSubmit` and `SessionStart`**

Same scratch hook, returning `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"MARKER-12345"}}`; confirm the model sees MARKER-12345 (ask it to repeat any marker in its context). Repeat for `SessionStart` with `source: resume` (resume the session).

- [ ] **Step 3: Record and gate**

Write findings (values, Claude Code version, exact JSON shapes) to the report file. **If either fails, stop the plan and surface it** — the pulse hook (Task 8) and the reclaimed-notice path depend on both.

---

### Task 2: Schema v4 — `chat_presence` and `chat_dms`

**Files:**
- Modify: `lib/state/db.ts`
- Test: `lib/state/__tests__/db-migration.test.ts` (extend)

**Interfaces:**
- Produces: the two tables exactly as the spec's Data model writes them (`chat_presence` with `last_seen_at` + `tail_seen_at` + `signed_out_at`; `chat_dms(room PK, a, b, created_at, UNIQUE(a,b))`), `SCHEMA_VERSION` bumped to 4, and the daemon startup clear covering `chat_presence.armed_at`.

- [ ] **Step 1: Write the failing tests**

```ts
test("v4 adds chat_presence and chat_dms", () => {
  const db = openStateDb(freshPath());
  expect(db.query("SELECT name FROM sqlite_master WHERE name IN ('chat_presence','chat_dms')").all()).toHaveLength(2);
  expect(db.query("PRAGMA user_version").get()).toMatchObject({ user_version: 4 });
});

test("a v5 dry-run over a v4 database does not throw", () => {
  // The runner replays every version's schema when user_version is behind;
  // only IF NOT EXISTS statements survive that. An ALTER here bricks rt at
  // the NEXT bump, not this one — which is why this test exists now.
  const db = openStateDb(freshPath());
  db.run("PRAGMA user_version = 3");
  expect(() => openStateDb(db.filename)).not.toThrow();
});

test("startup clear covers presence arming", () => {
  const db = openStateDb(freshPath());
  db.run("INSERT INTO chat_presence (session_id, handle, base_handle, signed_in_at, last_seen_at, armed_at) VALUES ('s1','a','a',1,1,1)");
  clearAllArmed(db);
  expect(db.query("SELECT armed_at FROM chat_presence").get()).toMatchObject({ armed_at: null });
});
```

- [ ] **Step 2: Run them to verify they fail** — `bun test lib/state/__tests__/db-migration.test.ts` → FAIL (no tables).
- [ ] **Step 3: Implement** — append the two `CREATE TABLE IF NOT EXISTS` blocks (copy the spec's SQL verbatim, comments included) as `V4_SCHEMA`, bump `SCHEMA_VERSION`, extend `clearAllArmed` to both tables.
- [ ] **Step 4: Gate** — `bun run test && bunx tsc --noEmit` → PASS.
- [ ] **Step 5: Commit** — `chat-presence: schema v4 — presence and dm tables`.

---

### Task 3: The presence store

**Files:**
- Create: `lib/state/presence-store.ts`
- Modify: `lib/state/index.ts`, `lib/state/chat-store.ts` (dual-write in `armMember`/`touchMember`/`disarmMember`; guard scoping in `joinRoom`)
- Test: `lib/state/__tests__/presence-store.test.ts`

**Interfaces:**
- Produces (all sync, `db: Database = getStateDb()` last param, like chat-store):
  ```ts
  export type BuddyStatus = "live" | "idle" | "deaf" | "offline";
  export interface PresenceRow { sessionId: string; handle: string; baseHandle: string; cwd?: string; repo?: string; branch?: string; pane?: string; statusText?: string; signedInAt: number; lastSeenAt: number; tailSeenAt?: number; armedAt?: number; signedOutAt?: number; }
  export function signIn(args: { sessionId: string; baseHandle: string; cwd?: string; repo?: string; branch?: string; pane?: string; statusText?: string; now?: number }, db?): { handle: string; reclaimed: boolean };
  export function signOut(sessionId: string, db?): void;
  export function setAway(sessionId: string, text: string | null, db?): void;
  export function pulseSession(args: { sessionId: string; cwd?: string; repo?: string; branch?: string; pane?: string; now?: number }, db?): void;   // last_seen_at + deets; NEVER tail_seen_at
  export function buddyStatus(row: Pick<PresenceRow, "signedOutAt" | "lastSeenAt" | "tailSeenAt" | "armedAt">, now: number): BuddyStatus;
  export function listBuddies(now: number, db?): Array<PresenceRow & { status: BuddyStatus }>;   // prunable rows excluded
  export function presenceForHandle(handle: string, db?): PresenceRow | null;
  export function assertSessionOwnsHandle(handle: string, sessionId: string | undefined, db?): void;  // throws "handle reclaimed" ONLY when a presence row exists and mismatches a provided sessionId
  export function prunePresence(now: number, db?): number;   // signed out >24h ago, or last_seen_at >24h old
  ```
- Consumes: nothing outside `lib/state`.

- [ ] **Step 1: Write the failing tests** — the spec's Testing list, store section, verbatim as cases:

```ts
const now = 1_700_000_000_000;
const MIN = 60_000, HOUR = 3_600_000;

test("a base held by a live row is suffixed; the suffix is stable", () => {
  const db = fresh();
  expect(signIn({ sessionId: "s1", baseHandle: "x", now }, db).handle).toBe("x");
  expect(signIn({ sessionId: "s2", baseHandle: "x", now }, db).handle).toBe("x-2");
  expect(signIn({ sessionId: "s3", baseHandle: "x", now }, db).handle).toBe("x-3");
});

test("an idle holder is never reclaimed, even before it arms", () => {
  const db = fresh();
  signIn({ sessionId: "s1", baseHandle: "x", cwd: "/w", now }, db);           // signed in, not armed
  const r = signIn({ sessionId: "s2", baseHandle: "x", cwd: "/w", now: now + MIN }, db);
  expect(r).toMatchObject({ handle: "x-2", reclaimed: false });
});

test("a stale same-seat row is reclaimed by deletion and the handle comes back", () => {
  const db = fresh();
  signIn({ sessionId: "s1", baseHandle: "x", cwd: "/w", pane: "3", now }, db);
  const r = signIn({ sessionId: "s2", baseHandle: "x", cwd: "/w", pane: "3", now: now + 2 * HOUR }, db);
  expect(r).toMatchObject({ handle: "x", reclaimed: true });
  expect(db.query("SELECT COUNT(*) c FROM chat_presence").get()).toMatchObject({ c: 1 });
});

test("a live tail blocks reclaim even when the session heartbeat is hours old", () => {
  const db = fresh();
  signIn({ sessionId: "s1", baseHandle: "x", now }, db);
  db.run("UPDATE chat_presence SET armed_at = ?, tail_seen_at = ? WHERE session_id = 's1'", [now + 3 * HOUR, now + 3 * HOUR]);
  expect(signIn({ sessionId: "s2", baseHandle: "x", now: now + 3 * HOUR + MIN }, db).handle).toBe("x-2");
});

test("buddyStatus: table order, first match wins, tail heartbeat is COALESCE(tail_seen_at, armed_at)", () => {
  expect(buddyStatus({ signedOutAt: now }, now)).toBe("offline");
  expect(buddyStatus({ lastSeenAt: now - 25 * HOUR }, now)).toBe("offline");
  expect(buddyStatus({ lastSeenAt: now, armedAt: now - 20 * MIN }, now)).toBe("deaf");                       // armed, no touch, 20m
  expect(buddyStatus({ lastSeenAt: now - 2 * HOUR, armedAt: now, tailSeenAt: now }, now)).toBe("live");      // prompt-starved but touching
  expect(buddyStatus({ lastSeenAt: now, armedAt: now }, now)).toBe("live");                                  // just armed, tail_seen_at NULL
  expect(buddyStatus({ lastSeenAt: now - 2 * HOUR }, now)).toBe("deaf");                                     // unarmed, session stale
  expect(buddyStatus({ lastSeenAt: now }, now)).toBe("idle");
});

test("pulse writes last_seen_at and deets only", () => {
  const db = fresh();
  signIn({ sessionId: "s1", baseHandle: "x", now }, db);
  pulseSession({ sessionId: "s1", branch: "feat", now: now + MIN }, db);
  expect(db.query("SELECT last_seen_at, tail_seen_at, branch FROM chat_presence").get())
    .toMatchObject({ last_seen_at: now + MIN, tail_seen_at: null, branch: "feat" });
});

test("assertSessionOwnsHandle throws only on a mismatched signed handle", () => {
  const db = fresh();
  signIn({ sessionId: "s1", baseHandle: "x", now }, db);
  expect(() => assertSessionOwnsHandle("x", "s1", db)).not.toThrow();
  expect(() => assertSessionOwnsHandle("x", "s2", db)).toThrow(/handle reclaimed/);
  expect(() => assertSessionOwnsHandle("unsigned", "s2", db)).not.toThrow();   // plan-1 path: no presence row, no enforcement
  expect(() => assertSessionOwnsHandle("x", undefined, db)).not.toThrow();      // no session id offered, no enforcement
});

test("prune frees a never-signed-out handle after 24h of silence, keeps the offline window", () => {
  const db = fresh();
  signIn({ sessionId: "s1", baseHandle: "x", now }, db);
  signOut("s1", db);
  expect(prunePresence(now + 2 * HOUR, db)).toBe(0);       // inside the offline window
  expect(prunePresence(now + 25 * HOUR, db)).toBe(1);
});

test("arm starts a new tail epoch: sets armed_at and CLEARS tail_seen_at", () => {
  const db = fresh();
  signIn({ sessionId: "s1", baseHandle: "x", now }, db);
  db.run("UPDATE chat_presence SET tail_seen_at = ?", [now - 20 * MIN]);   // a dead predecessor's last touch
  joinRoom({ room: "r", handle: "x" }, db);
  armMember(undefined, "x", db);
  const row = db.query("SELECT tail_seen_at FROM chat_presence WHERE handle = 'x'").get()!;
  expect(row.tail_seen_at).toBeNull();                                      // COALESCE falls to the fresh armed_at → live, not deaf
});

test("arm/touch/disarm dual-write when a presence row exists, and still work without one", () => {
  const db = fresh();
  signIn({ sessionId: "s1", baseHandle: "x", now }, db);
  joinRoom({ room: "r", handle: "x" }, db);
  armMember(undefined, "x", db);
  touchMember("x", db);
  expect(db.query("SELECT armed_at, tail_seen_at FROM chat_presence WHERE handle = 'x'").get()!.armed_at).toBeTruthy();
  joinRoom({ room: "r", handle: "unsigned" }, db);
  expect(() => armMember(undefined, "unsigned", db)).not.toThrow();            // member columns as in plan 1
});

test("the joinRoom cwd guard is scoped to unsigned handles", () => {
  const db = fresh();
  joinRoom({ room: "a", handle: "x", cwd: "/one" }, db);
  expect(() => joinRoom({ room: "b", handle: "x", cwd: "/two" }, db)).toThrow(/--as/);   // unsigned: as shipped
  const db2 = fresh();
  signIn({ sessionId: "s1", baseHandle: "y", now }, db2);
  joinRoom({ room: "a", handle: "y", cwd: "/one" }, db2);
  expect(() => joinRoom({ room: "b", handle: "y", cwd: "/two" }, db2)).not.toThrow();    // signed: presence owns uniqueness
});
```

- [ ] **Step 2: Run to verify they fail** — `bun test lib/state/__tests__/presence-store.test.ts` → FAIL (no module).
- [ ] **Step 3: Implement** — one `RECLAIMABLE_SQL` fragment (`signed_out_at IS NOT NULL OR (last_seen_at < :hour AND COALESCE(tail_seen_at, armed_at, 0) < :tenMin)`) used by `signIn` (suffix scan `x`, `x-2`, … over non-reclaimable rows; same-seat preference among reclaimable ones; reclaim = DELETE), `prunePresence` at sign-in, and nothing else. `buddyStatus` is a pure function implementing the spec's table in order. Dual-write lives inside `armMember`/`touchMember`/`disarmMember` (presence row updated when `presenceForHandle` hits). `joinRoom`'s collision guard first checks `presenceForHandle(handle)` and skips when signed in.
- [ ] **Step 4: Gate** — full repo gate → PASS.
- [ ] **Step 5: Commit** — `chat-presence: presence store — sign-in, two heartbeats, one reclaim predicate`.

---

### Task 4: The DM store and post mentions

**Files:**
- Create: `lib/state/dm-store.ts`
- Modify: `lib/state/chat-store.ts` (`postMessage` gains `mentions?: string[]` merged with parsed; `joinRoom` refuses DM rooms), `lib/state/index.ts`
- Test: `lib/state/__tests__/dm-store.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function dmRoomFor(x: string, y: string, humanHandle: string, db?): { room: string; created: boolean };   // throws on x === y (no self-DM) and on a truncated-hash collision whose chat_dms row carries a different pair (fail loud, never merge)
  export function dmParticipants(room: string, db?): { a: string; b: string } | null;   // null = not a DM
  export function listDms(handle: string, db?): Array<{ room: string; a: string; b: string }>;
  ```
- Room id: `"dm-" + sha256(sortedA + "\n" + sortedB).slice(0, 12)` (`Bun.CryptoHasher`). Memberships created: both participants `wake_on all`; when neither participant is `humanHandle`, a `humanHandle` membership with `wake_on none`.

- [ ] **Step 1: Write the failing tests**

```ts
test("dm rooms are keyed by the sorted pair, and dotted handles cannot collide", () => {
  const db = fresh();
  const r1 = dmRoomFor("x.y", "z", "matt", db);
  const r2 = dmRoomFor("x", "y.z", "matt", db);
  expect(r1.room).not.toBe(r2.room);
  expect(dmRoomFor("z", "x.y", "matt", db)).toMatchObject({ room: r1.room, created: false });
});

test("an agent<->agent dm carries the human wake_on none; a dm with the human does not add him twice", () => {
  const db = fresh();
  const { room } = dmRoomFor("a", "b", "matt", db);
  expect(listMembers(room, db).map(m => [m.handle, m.wakeOn]).sort()).toEqual([["a","all"],["b","all"],["matt","none"]]);
  const { room: r2 } = dmRoomFor("a", "matt", "matt", db);
  expect(listMembers(r2, db).map(m => m.handle).sort()).toEqual(["a", "matt"]);
});

test("a self-DM is refused", () => {
  expect(() => dmRoomFor("a", "a", "matt", fresh())).toThrow(/your own/i);
});

test("join refuses a DM room", () => {
  const db = fresh();
  const { room } = dmRoomFor("a", "b", "matt", db);
  expect(() => joinRoom({ room, handle: "c" }, db)).toThrow(/is a DM/);
});

test("postMessage merges explicit mentions with parsed ones", () => {
  const db = fresh();
  const { room } = dmRoomFor("a", "b", "matt", db);
  const msg = postMessage({ room, handle: "a", body: "ping", mentions: ["b"] }, db);
  expect(JSON.parse(db.query("SELECT mentions FROM chat_messages WHERE id = ?").get(msg!.id)!.mentions)).toEqual(["b"]);
});

test("a dm post wakes the other participant; the human's post wakes both", () => {
  const db = fresh();
  const { room } = dmRoomFor("a", "b", "matt", db);
  expect(recipientsFor(room, "a", ["b"], db)).toEqual(["b"]);       // wake_on all: b wakes even unmentioned
  expect(recipientsFor(room, "matt", [], db).sort()).toEqual(["a", "b"]);
});
```

- [ ] **Step 2: Run to verify they fail** → FAIL (no module).
- [ ] **Step 3: Implement.** `dmRoomFor` inserts `chat_rooms` + `chat_dms` + memberships in one transaction. `joinRoom` refuses when `dmParticipants(room)` is non-null. `postMessage`'s `mentions` param is deduped-merged into the stored JSON *and* into the recipients/notifier path, so `dm matt …` from an agent notifies the desk (the plan-1 notifier keys on the human handle appearing in mentions).
- [ ] **Step 4: Gate** → PASS.  **Step 5: Commit** — `chat-presence: dm store — hashed ids, the human's row, mentions param`.

---

### Task 5: Daemon handlers and rt-client wrappers

**Files:**
- Modify: `lib/daemon/handlers/chat.ts`, `packages/rt-client/src/commands.ts`, `packages/rt-client/src/client.ts`, `packages/rt-client/src/index.ts`, `packages/rt-client/package.json` (minor bump)
- Test: `lib/daemon/__tests__/chat-handlers.test.ts` (extend), `packages/rt-client/test/registry.test.ts` (count bump)

**Interfaces:**
- Produces handlers (payload → data), all thin over the stores:
  ```
  chat:sign-in   { sessionId, baseHandle, cwd?, repo?, branch?, pane?, statusText? } → { handle, reclaimed, room? }   // room join happens CLIENT-side after this returns; see Task 6
  chat:sign-out  { sessionId } → {}                                     // CLI adds --quiet (hook path: suppress output)
  chat:away      { sessionId, text }  /  chat:back { sessionId } → {}
  chat:buddies   {} → { buddies: Array<PresenceRow & { status }> }
  chat:pulse     { sessionId, cwd?, repo?, branch?, pane? } → { unread: { dms, mentions, rooms }, status, reclaimed: false } — or refuses "handle reclaimed"
  chat:dm        { from, to, body, sessionId? } → { room, id, recipients }
  ```
- `chat:arm` / `chat:touch` / `chat:disarm` / `chat:away` / `chat:sign-out` / `chat:pulse` call `assertSessionOwnsHandle` (enforced only when a presence row exists AND a sessionId was provided — the unsigned plan-1 path keeps working).
- `chat:who` returns presence-joined statuses; `chat:rooms` marks DM rooms (`kind: "dm"`, display pair) by left-joining `chat_dms`.
- rt-client: wrappers `chatSignIn`, `chatSignOut`, `chatAway`, `chatBack`, `chatBuddies`, `chatPulse`, `chatDm` + types; catalog entries beside the twelve shipped ones.

- [ ] **Step 1: Write the failing tests** (extend the existing in-process handler harness):

```ts
test("sign-in assigns and a second same-base session gets the suffix", async () => {
  const h = freshHandlers();
  expect((await h["chat:sign-in"]({ sessionId: "s1", baseHandle: "x" })).data).toMatchObject({ handle: "x" });
  expect((await h["chat:sign-in"]({ sessionId: "s2", baseHandle: "x" })).data).toMatchObject({ handle: "x-2" });
});

test("a reclaimed handle refuses the old session's pulse with the reason", async () => {
  const h = freshHandlers();
  await h["chat:sign-in"]({ sessionId: "s1", baseHandle: "x" });
  h.db.run("UPDATE chat_presence SET last_seen_at = last_seen_at - 7200000");
  await h["chat:sign-in"]({ sessionId: "s2", baseHandle: "x" });
  const res = await h["chat:pulse"]({ sessionId: "s1" });
  expect(res.ok).toBe(false);
  expect(res.error).toContain("handle reclaimed");
});

test("chat:dm creates once, posts with the recipient in mentions, and reports recipients", async () => {
  const h = freshHandlers();
  await h["chat:sign-in"]({ sessionId: "s1", baseHandle: "a" });
  await h["chat:sign-in"]({ sessionId: "s2", baseHandle: "b" });
  const res = await h["chat:dm"]({ from: "a", to: "b", body: "ping" });
  expect(res.ok).toBe(true);
  expect(res.data.recipients).toEqual(["b"]);
});

test("chat:rooms marks a dm and chat:who carries presence statuses", async () => { /* kind: "dm" on the dm row; status fields present */ });
```

- [ ] **Step 2: FAIL** (unknown handlers). **Step 3: Implement** — handlers thin, stores do the work; `chat:pulse` computes unread via `unreadWakingCount` + DM filter and heartbeats first. **Step 4:** registry count test updated; `bun run build` in `packages/rt-client` (dist-freshness). **Step 5: Gate → Commit** — `chat-presence: daemon handlers and rt-client wrappers`.

---

### Task 6: CLI — the session file, sign-in/out, room derivation

**Files:**
- Create: `lib/chat-session.ts`
- Modify: `commands/chat.ts`, `lib/command-tree-def.ts`
- Test: `commands/__tests__/chat.test.ts` (extend), `lib/__tests__/chat-session.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // lib/chat-session.ts
  export interface ChatSession { sessionId: string; handle: string; baseHandle: string; signedInAt: number; room?: string; lastCwd?: string; lastBranchReadAt?: number; }
  export function sessionFilePath(sessionId: string): string;          // ~/.mattstack/rt/chat/sessions/<id>.json
  export function readChatSession(sessionId: string | undefined): ChatSession | null;   // null on mismatch or absence
  export function writeChatSession(s: ChatSession): void;
  export function deleteChatSession(sessionId: string): void;
  export function currentSessionId(args: string[]): string | undefined; // --session flag, else CLAUDE_CODE_SESSION_ID
  ```
- `resolveHandle` gains position 0 (the session file) and refuses `--as` when signed in, on every verb but `sign-in`.
- Room derivation: `deriveRoomForCwd(cwd)` — `findGitRoot` gate; remote-kind → slugified last segment; path-kind → slugified last two segments of the main worktree realpath; null when not in a work tree.

- [ ] **Step 1: Write the failing tests**

```ts
test("position 0: a signed-in session resolves the assigned handle for every verb", async () => {
  const { home } = await signInInProcess({ as: "x" });               // harness helper this task writes
  const out = await runChat(["post", "r", "hello"]);                  // joins + posts as x, not the cwd-derived handle
  expect((await runChat(["who", "r"]))).toContain("x");
});

test("--as while signed in is refused with the reason", async () => {
  await signInInProcess({ as: "x" });
  const { code, stderr } = await runChatRaw(["post", "r", "hi", "--as", "y"]);
  expect(code).not.toBe(0);
  expect(stderr).toMatch(/signed in as x.*sign out/);
});

test("deriveRoomForCwd: remote-kind, path-kind, not-a-worktree", () => {
  expect(__test__.roomForIdentity({ kind: "remote", id: "gitlab.example.com/acme/Acme-Dev" })).toBe("acme-dev");
  expect(__test__.roomForIdentity({ kind: "path", id: "/Users/m/pool/gamma" })).toBe("pool-gamma");
  // findGitRoot gate is exercised through deriveRoomForCwd against a non-repo tmpdir → null
});

test("sign-in prints the identity line and the arm instruction; --no-room and --room work", async () => {
  const out = await runChat(["sign-in", "--as", "x", "--room", "warroom"]);
  expect(out).toMatch(/signed in as x/);
  expect(out).toMatch(/#warroom/);
  expect(out).toMatch(/rt chat tail/);                               // bare — no --as in the arm line
});

test("sign-out deletes the session file and disarms", async () => { /* file gone; presence signed_out_at set */ });
```

- [ ] **Step 2: FAIL.** **Step 3: Implement** — `runSignIn`: resolve base (its own `--as` first), `chatSignIn` → assigned handle, write session file, then client-side `chatJoin` the derived/overridden room (join is client-side because the room needs `findGitRoot` + the identity codec, which are caller-context), print the two lines. `sign-out`: `chatSignOut`, kill the tail via the existing `killChatTail`, delete the file. Wire `resolveHandle` position 0 + the `--as` refusal. **Step 4: Gate → Step 5: Commit** — `chat-presence: sign-in, sign-out, the session file, the repository room`.

---

### Task 7: CLI — buddies, away, dm, pulse, and the tail's reclaim exit

**Files:**
- Modify: `commands/chat.ts`, `lib/command-tree-def.ts`
- Test: `commands/__tests__/chat.test.ts` (extend)

**Interfaces:**
- `rt chat buddies [--json]` renders the roster (sections in Statuses-table order, `offline (last 24h)` collapsed to one line); `who` with no room aliases it. The shipped 5-minute idle/away split in `memberStatus` is replaced by the spec's four statuses via `buddyStatus` (exported through the barrel).
- `rt chat away <text>` / `rt chat back`; `rt chat dm <handle> <text>`; `rt chat pulse --json` (heartbeat + unread summary + status; exit 0 with `{ reclaimed: true }`-shaped error handling per below).
- The tail: `chatTouch` refusals are no longer swallowed blind — a `handle reclaimed` error prints one stdout line (`handle reclaimed — sign in again`) and exits 0; every other touch error stays ignored.

- [ ] **Step 1: Write the failing tests**

```ts
test("buddies renders four sections in table order and names the away text", async () => { /* fixture rows via handlers; assert section order and status words */ });

test("pulse --json returns the unread summary and never writes the tail heartbeat", async () => { /* run pulse; assert tail_seen_at unchanged via who --json */ });

test("the tail exits 0 with one line when its handle is reclaimed", async () => {
  // marker-file harness as in the plan-1 race tests: pre-wait marker holds the
  // tail before its first touch; reclaim the handle through the handlers; release.
  const t = spawnChat(["tail"]);
  await until(hasTailPidfile);
  await reclaimHandleViaHandlers();
  releaseMarker();
  const { exitCode, stdout } = await reap(t);
  expect(exitCode).toBe(0);
  expect(stdout.trim()).toBe("handle reclaimed — sign in again");
});

test("dm posts and the desk notifies when the recipient is the human", async () => { /* dm matt → peekNotifications length 1 */ });
```

- [ ] **Step 2: FAIL.** **Step 3: Implement.** **Step 4: Gate.** **Step 5: Commit** — `chat-presence: buddies, away, dm, pulse; the tail exits on a reclaimed handle`.

---

### Task 8: The `chat` plugin — skills and hooks (mattstack-marketplace)

**Files (in `~/Documents/GitHub/mattstack-marketplace`):**
- Create: `plugins/chat/plugin.json`, `plugins/chat/skills/sign-in/SKILL.md`, `plugins/chat/skills/sign-out/SKILL.md`, `plugins/chat/skills/away/SKILL.md`, `plugins/chat/hooks/hooks.json`, `plugins/chat/hooks/pulse.sh`, `plugins/chat/hooks/session-end.sh`, `plugins/chat/hooks/session-start.sh`
- Test: `plugins/chat/hooks/pulse.test.sh` (fixture stdin → expected stdout), run by the repo's existing test runner if present, else a `bun test` shim

**Interfaces:**
- `hooks.json`: `UserPromptSubmit` → `pulse.sh`; `SessionEnd` → `session-end.sh`; `SessionStart` (matchers `resume|compact|fork`) → `session-start.sh`.
- `pulse.sh`: read stdin JSON → `session_id`; if no session file at `~/.mattstack/rt/chat/sessions/<id>.json`, exit 0 silently. Else `rt chat pulse --json --session <id>`; on `handle reclaimed` → emit `additionalContext` with the reclaimed notice (unconditional — the one case the waiting rule stays silent in); on waiting + status ≠ live → emit the waiting line; else exit 0 with no output. Budget 50ms: the script is jq + one rt invocation.
- `session-start.sh`: if a session file exists for `session_id`, emit `additionalContext`: signed-in-as + re-arm-if-not-running notice.
- The skills are thin: `sign-in` runs the verb, then instructs the Monitor arm (deferring to `rt:chat` for discipline); `sign-out` runs the verb and stops the Monitor; `away` runs the verb.

- [ ] **Step 1:** Write `pulse.sh` against a **fixture** rt (a stub script on PATH echoing canned JSON) and a stdin fixture; assert the three outputs (silent, waiting line, reclaimed notice). **Step 2:** FAIL (no script). **Step 3:** Implement all three scripts + `hooks.json` + skills. **Step 4:** Manual verification in a scratch session (Task 1's harness): prompt → context injected. **Step 5: Commit** in mattstack-marketplace — `chat: presence plugin — sign-in/out/away skills, pulse and session hooks`.

---

### Task 9: The `rt:chat` skill revision and docs

**Files:**
- Modify: `skills/rt-chat/SKILL.md`, `lib/command-tree-def.ts` (verb help), `website/docs/reference/chat.mdx` (gen-docs)
- Test: `bun run check-docs` (drift gate)

- [ ] **Step 1:** Revise the skill per the spec's list: entry point *sign in, then arm*; bare `rt chat tail` arm line; `buddies`/`who` and the four statuses; the DM section (including that Matt sees agent↔agent DMs — no private DMs); everything kept from plan 1 (the gate, arm once, read capped, announce-before-taking, never block on a human, stream-ended → re-arm unless you ended it, exit-69 → check the daemon; **plus**: exit-0 "handle reclaimed" → sign in again; a first arm after reclaiming may bounce once with exit 3 — re-arm, it is not a bug).
- [ ] **Step 2:** Regenerate docs (`bun run gen-docs`), update the command tree entries, run `bun run check-docs`. **Step 3: Gate → Commit** — `chat-presence: skill and docs`.

---

### Task 10: e2e — the spec's list

**Files:**
- Create: `e2e/tests/chat-presence2.test.ts`
- Test: `bun test --preload ./e2e/setup.ts --timeout 60000 e2e/tests/chat-presence2`

- [ ] **Step 1: Write the tests** — the spec's e2e bullets, each against the compiled binary under the isolated HOME (the plan-1 harness):
  1. two sign-ins from one worktree under different session ids yield `x` and `x-2` **whether or not the first has armed yet**; both tails arm; a DM to `x-2` wakes only `x-2`.
  2. a tail killed with SIGKILL reads *deaf* within the (test-shortened) threshold while its session keeps pulsing — thresholds injectable via env (`RT_CHAT_TAIL_STALE_MS`, `RT_CHAT_SESSION_STALE_MS`) the same way plan 1 injected `RT_CHAT_BACKOFF_MS`.
  3. `SessionEnd`-style sign-out clears `armed_at`, sets `signed_out_at`, keeps memberships.
  4. `dm matt` produces a desk notification.
  5. the v5 dry-run migration assertion at the binary level (open, downgrade `user_version`, reopen).
- [ ] **Step 2: FAIL. Step 3: implement anything the harness lacks (marker pauses already exist). Step 4: full gate + e2e. Step 5: Commit** — `chat-presence: e2e`.

---

## What this plan does not build

- **The viewer's roster** — plan 2 Tasks 5–7 are re-planned against the spec after Matt approves it; this plan is CLI/daemon/plugin only.
- **Buddy sign-on notifications** (the AIM door sound) — spec Out of scope.
- **`rt chat sign-in` from non-Claude processes beyond `--session`** — scripts get the flag, nothing more.
- **Migration of plan-1 members into presence** — deliberately none: presence starts empty and fills at first sign-in; unsigned members keep working through the member columns.
