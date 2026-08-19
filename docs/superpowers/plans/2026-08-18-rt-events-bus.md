# rt events bus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An optional event bus in the rt daemon — `rt events emit/wait/tail/list` — with a SQLite journal, glob topics, and caller-held cursors, so panes get race-free push communication with replay.

**Architecture:** A self-contained bus unit (`lib/daemon/events-bus.ts`) owns the SQLite journal and the in-memory waiter registry; thin typed handlers expose `events:emit|wait|list` through the existing `handleCommand` seam, which grows an optional `AbortSignal` parameter for connection-lifetime waiter cleanup. The CLI implements blocking `wait` as a cursor-threaded long-poll loop; `tail` is pure client-side composition.

**Tech Stack:** Bun, `bun:sqlite` (WAL), `Bun.Glob`, existing rt daemon seams (socket-server, api-server, command-router, rt-client catalog).

**Spec:** `docs/superpowers/specs/2026-08-18-rt-events-bus-design.md` — read it before starting any task.

## Global Constraints

- **No sync-exec on the daemon thread** (MAT-222). Synchronous `bun:sqlite` calls are fine; spawning processes synchronously is not. This feature never spawns anything.
- **One glob matcher everywhere:** `matchTopic()` built on `Bun.Glob` (`*` does not cross `/`, `**` does). Never SQLite's `GLOB` operator.
- **Every wait/list response carries `cursor`**, including empty ones.
- **Daemon-side wait cap: 240_000 ms**, clamped regardless of client input (socket idle timeout is 255s).
- **Cap expiry is `{ok: true, data: {events: [], cursor}}`** — never `ok: false`. `timedOut` exists only at the CLI level, exit code **124**.
- **Retention:** delete rows older than 7 days, always keeping the newest 50_000.
- **Logging:** domain events at `debug` via a `childLogger("events")`; the seams already log outcomes. Never add outcome logging in handlers.
- **Footguns:** new CLI module MUST be registered in `lib/module-registry.ts`; the daemon must be restarted before new handlers exist.
- All commits on a feature branch: `git checkout -b goodwinmattheweric/rt-44-events-bus` from `main` before Task 1.

---

### Task 1: Bus core — journal, matcher, emit, list

**Files:**
- Create: `lib/daemon/events-bus.ts`
- Test: `lib/daemon/__tests__/events-bus.test.ts`

**Interfaces:**
- Consumes: nothing new (`bun:sqlite`, `pino` Logger type).
- Produces (later tasks compile against these exact shapes):

```ts
export interface BusEvent { id: number; topic: string; payload: unknown; emittedAt: number }
export interface WaitResult { events: BusEvent[]; cursor: number }
export interface EventsBus {
  emit(topic: string, payload?: unknown): number;                 // returns new rowid
  list(opts: { pattern: string; after?: number; limit?: number }): WaitResult;
  wait(opts: { pattern: string; after?: number; waitMs?: number; signal?: AbortSignal }): Promise<WaitResult>; // Task 2
  sweep(): number;                                                // Task 3; deleted-row count
  waiterCount(): number;                                          // Task 2; for tests
  close(): void;
}
export function matchTopic(pattern: string, topic: string): boolean;
export function createEventsBus(opts: { dbPath: string; log: Logger }): EventsBus;
```

- [ ] **Step 1: Write the failing tests**

```ts
// lib/daemon/__tests__/events-bus.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import pino from "pino";
import { createEventsBus, matchTopic, type EventsBus } from "../events-bus.ts";

const log = pino({ level: "silent" });

describe("matchTopic", () => {
  test("bare topic matches itself only", () => {
    expect(matchTopic("job/x/question", "job/x/question")).toBe(true);
    expect(matchTopic("job/x/question", "job/x/report")).toBe(false);
  });
  test("* matches one segment, not across slashes", () => {
    expect(matchTopic("job/x/*", "job/x/question")).toBe(true);
    expect(matchTopic("job/*", "job/x/question")).toBe(false);
  });
  test("** matches across segments", () => {
    expect(matchTopic("job/**", "job/x/question")).toBe(true);
  });
});

describe("events bus journal", () => {
  let dir: string;
  let bus: EventsBus;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rt-events-"));
    bus = createEventsBus({ dbPath: join(dir, "events.db"), log });
  });
  afterEach(() => {
    bus.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("emit returns monotonically increasing ids", () => {
    const a = bus.emit("job/x/question", { q: "hi" });
    const b = bus.emit("job/x/report");
    expect(b).toBe(a + 1);
  });

  test("list returns matching events after cursor, with cursor = max id in journal", () => {
    bus.emit("job/x/question", { q: 1 });
    const id2 = bus.emit("job/y/question", { q: 2 });
    const id3 = bus.emit("job/x/report");
    const res = bus.list({ pattern: "job/x/*", after: 0 });
    expect(res.events.map(e => e.topic)).toEqual(["job/x/question", "job/x/report"]);
    expect(res.events[0]!.payload).toEqual({ q: 1 });
    expect(res.cursor).toBe(id3);
    // `after` excludes everything at or before it
    const res2 = bus.list({ pattern: "job/**", after: id2 });
    expect(res2.events.map(e => e.id)).toEqual([id3]);
  });

  test("list with no matches still returns the current cursor", () => {
    const id = bus.emit("other/topic");
    const res = bus.list({ pattern: "job/**" });
    expect(res.events).toEqual([]);
    expect(res.cursor).toBe(id);
  });

  test("limit applies after the glob filter", () => {
    bus.emit("noise/1");
    bus.emit("job/x/a");
    bus.emit("noise/2");
    bus.emit("job/x/b");
    bus.emit("job/x/c");
    const res = bus.list({ pattern: "job/x/*", after: 0, limit: 2 });
    expect(res.events.map(e => e.topic)).toEqual(["job/x/a", "job/x/b"]);
    expect(res.cursor).toBe(res.events[1]!.id); // truncated list: cursor = last delivered
  });

  test("journal survives close/reopen (WAL file db)", () => {
    bus.emit("job/x/a", { keep: true });
    bus.close();
    bus = createEventsBus({ dbPath: join(dir, "events.db"), log });
    const res = bus.list({ pattern: "job/x/*", after: 0 });
    expect(res.events).toHaveLength(1);
    expect(res.events[0]!.payload).toEqual({ keep: true });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test lib/daemon/__tests__/events-bus.test.ts`
Expected: FAIL — cannot find module `../events-bus.ts`.

- [ ] **Step 3: Implement the bus core**

```ts
// lib/daemon/events-bus.ts
/**
 * Events bus — the daemon's optional pane-communication backend (RT-44).
 *
 * A SQLite journal (~/.rt/events.db, WAL) plus an in-memory waiter registry.
 * Topics are plain strings the daemon never interprets; consumers match with
 * Bun.Glob patterns and hold their own cursors (rowids). See the spec:
 * docs/superpowers/specs/2026-08-18-rt-events-bus-design.md
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";
import type { Logger } from "pino";

export interface BusEvent { id: number; topic: string; payload: unknown; emittedAt: number }
export interface WaitResult { events: BusEvent[]; cursor: number }

export interface EventsBus {
  emit(topic: string, payload?: unknown): number;
  list(opts: { pattern: string; after?: number; limit?: number }): WaitResult;
  wait(opts: { pattern: string; after?: number; waitMs?: number; signal?: AbortSignal }): Promise<WaitResult>;
  sweep(): number;
  waiterCount(): number;
  close(): void;
}

// One matcher for wait AND list. Bun.Glob: `*` does not cross `/`, `**` does.
// Never use SQLite's GLOB operator — its `*` crosses slashes, which would make
// wait and list match different event sets for the same pattern.
const globCache = new Map<string, Bun.Glob>();
export function matchTopic(pattern: string, topic: string): boolean {
  let glob = globCache.get(pattern);
  if (!glob) { glob = new Bun.Glob(pattern); globCache.set(pattern, glob); }
  return glob.match(topic);
}

interface EventRow { id: number; topic: string; payload: string | null; emittedAt: number }

function rowToEvent(row: EventRow): BusEvent {
  let payload: unknown = null;
  if (row.payload != null) {
    try { payload = JSON.parse(row.payload); } catch { payload = row.payload; }
  }
  return { id: row.id, topic: row.topic, payload, emittedAt: row.emittedAt };
}

export function createEventsBus(opts: { dbPath: string; log: Logger }): EventsBus {
  const log = opts.log.child({ module: "events" });
  // Self-sufficient about its parent dir — daemon.ts constructs the bus at
  // module scope, before startDaemon()'s mkdirSync(RT_DIR) runs.
  mkdirSync(dirname(opts.dbPath), { recursive: true });
  const db = new Database(opts.dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      topic     TEXT NOT NULL,
      payload   TEXT,
      emittedAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_topic_id ON events(topic, id);
  `);

  const insertStmt = db.prepare(
    "INSERT INTO events (topic, payload, emittedAt) VALUES (?, ?, ?) RETURNING id",
  );
  const afterStmt = db.prepare("SELECT id, topic, payload, emittedAt FROM events WHERE id > ? ORDER BY id");
  const maxIdStmt = db.prepare("SELECT COALESCE(MAX(id), 0) AS maxId FROM events");

  const maxId = (): number => (maxIdStmt.get() as { maxId: number }).maxId;

  /** Matching events with id > after (glob filtered in JS — see matchTopic). */
  const eventsAfter = (pattern: string, after: number, limit?: number): BusEvent[] => {
    const rows = afterStmt.all(after) as EventRow[];
    const matched = rows.filter(r => matchTopic(pattern, r.topic)).map(rowToEvent);
    return limit != null ? matched.slice(0, limit) : matched;
  };

  return {
    emit(topic, payload) {
      const row = insertStmt.get(
        topic,
        payload === undefined ? null : JSON.stringify(payload),
        Date.now(),
      ) as { id: number };
      log.debug({ topic, id: row.id }, "event emitted");
      return row.id;
    },

    list({ pattern, after, limit }) {
      const events = eventsAfter(pattern, after ?? 0, limit);
      // Truncated result: cursor points at the last DELIVERED event so the
      // caller's next `after` resumes exactly where this page ended.
      // Untruncated (or empty) result: cursor is the journal head.
      const cursor = events.length && limit != null && events.length === limit
        ? events[events.length - 1]!.id
        : maxId();
      return { events, cursor };
    },

    wait() { throw new Error("implemented in Task 2"); },
    sweep() { throw new Error("implemented in Task 3"); },
    waiterCount() { return 0; },

    close() { db.close(); },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test lib/daemon/__tests__/events-bus.test.ts`
Expected: PASS (all journal + matcher tests).

- [ ] **Step 5: Typecheck and commit**

```bash
bunx tsc --noEmit
git add lib/daemon/events-bus.ts lib/daemon/__tests__/events-bus.test.ts
git commit -m "feat(events): bus core — sqlite journal, glob matcher, emit/list (RT-44)"
```

---

### Task 2: Blocking wait — waiter registry, cap, abort cleanup, ahead-cursor clamp

**Files:**
- Modify: `lib/daemon/events-bus.ts`
- Test: `lib/daemon/__tests__/events-bus.test.ts` (append)

**Interfaces:**
- Consumes: Task 1's `createEventsBus` internals.
- Produces: working `wait(opts)` and `waiterCount()` exactly as typed in Task 1.

**Semantics (from spec — implement precisely):**
1. Snapshot `maxId` at registration. Clamp: `effAfter = after == null ? maxId : Math.min(after, maxId)` (an `after` beyond the journal head can only be a stale db generation; clamping degrades to "from now on").
2. **Atomic check-then-register:** query for events `> effAfter`; if non-empty resolve immediately; otherwise add the waiter — with NO `await` anywhere between the query and the registration (Bun is single-threaded and `bun:sqlite` is synchronous, so this is atomicity for free; an `await` opens a missed-insert window).
3. `waitMs` clamped daemon-side: `Math.min(Math.max(waitMs ?? 240_000, 0), 240_000)`.
4. Cap expiry resolves `{events: [], cursor: maxId-at-registration}` — a NORMAL result.
5. `signal` abort removes the waiter and resolves `{events: [], cursor}` (resolve, not reject — the connection is gone; nobody reads it; rejecting risks unhandled-rejection noise).
6. Every `emit` scans the registry; each matching waiter gets `eventsAfter(pattern, afterId)` and resolves with `cursor` = last delivered id. Timer cleared, waiter removed.

- [ ] **Step 1: Write the failing tests (append to the bus test file)**

```ts
describe("events bus wait", () => {
  let dir: string;
  let bus: EventsBus;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rt-events-"));
    bus = createEventsBus({ dbPath: join(dir, "events.db"), log });
  });
  afterEach(() => {
    bus.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("wait resolves immediately when matching events already exist past cursor", async () => {
    const id = bus.emit("job/x/question", { q: 1 });
    const res = await bus.wait({ pattern: "job/x/*", after: 0 });
    expect(res.events.map(e => e.id)).toEqual([id]);
    expect(res.cursor).toBe(id);
  });

  test("wait blocks then wakes on a matching emit", async () => {
    const p = bus.wait({ pattern: "job/x/*" });          // no after → from now on
    expect(bus.waiterCount()).toBe(1);
    const id = bus.emit("job/x/report", { done: true });
    const res = await p;
    expect(res.events.map(e => e.id)).toEqual([id]);
    expect(res.cursor).toBe(id);
    expect(bus.waiterCount()).toBe(0);
  });

  test("non-matching emit does not wake the waiter", async () => {
    const p = bus.wait({ pattern: "job/x/*", waitMs: 150 });
    bus.emit("other/topic");
    const res = await p; // resolves via cap expiry
    expect(res.events).toEqual([]);
  });

  test("cap expiry returns empty events WITH the registration-time cursor", async () => {
    const preId = bus.emit("seed/event");
    const res = await bus.wait({ pattern: "job/**", waitMs: 100 });
    expect(res.events).toEqual([]);
    expect(res.cursor).toBe(preId);
    expect(bus.waiterCount()).toBe(0);
  });

  test("abort removes the waiter and resolves empty", async () => {
    const ac = new AbortController();
    const p = bus.wait({ pattern: "job/**", signal: ac.signal, waitMs: 240_000 });
    expect(bus.waiterCount()).toBe(1);
    ac.abort();
    const res = await p;
    expect(res.events).toEqual([]);
    expect(bus.waiterCount()).toBe(0);
  });

  test("empty expiry advances the cursor to the registration-time head, not the caller's after", async () => {
    const a = bus.emit("job/x/seen");
    bus.emit("noise/1");
    const head = bus.emit("noise/2");
    // Caller is caught up on job/* (cursor a); newer events are all non-matching.
    const res = await bus.wait({ pattern: "job/**", after: a, waitMs: 100 });
    expect(res.events).toEqual([]);
    expect(res.cursor).toBe(head); // NOT a — empty polls must not rescan the non-matching tail forever
  });

  test("ahead cursor (stale db generation) clamps to journal head instead of hanging", async () => {
    bus.emit("job/x/a");
    const p = bus.wait({ pattern: "job/**", after: 99_999, waitMs: 240_000 });
    const id = bus.emit("job/x/b"); // must wake it — clamp made effAfter = head
    const res = await p;
    expect(res.events.map(e => e.id)).toEqual([id]);
  });

  test("no-await atomicity: emit racing registration is not lost", async () => {
    // Deterministic given single-threaded Bun: the emit lands after wait()
    // returns its promise, so it must be delivered via the waiter path.
    const p = bus.wait({ pattern: "job/**", waitMs: 5_000 });
    const id = bus.emit("job/race");
    const res = await p;
    expect(res.events.map(e => e.id)).toEqual([id]);
  });
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `bun test lib/daemon/__tests__/events-bus.test.ts`
Expected: FAIL — "implemented in Task 2" throws.

- [ ] **Step 3: Implement wait**

Replace the `wait()` / `waiterCount()` stubs; add near the top of `createEventsBus`:

```ts
  const MAX_WAIT_MS = 240_000; // under the 255s socket idle timeout; the daemon clamp, not the client's
  interface Waiter {
    pattern: string;
    afterId: number;
    resolve: (r: WaitResult) => void;
    timer: ReturnType<typeof setTimeout>;
    onAbort?: () => void;
    signal?: AbortSignal;
  }
  const waiters = new Set<Waiter>();

  const settle = (w: Waiter, result: WaitResult): void => {
    if (!waiters.has(w)) return;
    waiters.delete(w);
    clearTimeout(w.timer);
    if (w.signal && w.onAbort) w.signal.removeEventListener("abort", w.onAbort);
    w.resolve(result);
  };
```

and in the returned object:

```ts
    wait({ pattern, after, waitMs, signal }) {
      const head = maxId();
      const effAfter = after == null ? head : Math.min(after, head);
      // Atomic check-then-register: NO await between this query and waiters.add.
      const ready = eventsAfter(pattern, effAfter);
      if (ready.length) {
        return Promise.resolve({ events: ready, cursor: ready[ready.length - 1]!.id });
      }
      const capMs = Math.min(Math.max(waitMs ?? MAX_WAIT_MS, 0), MAX_WAIT_MS);
      // Empty results return `head` (the registration-time journal head), NOT
      // effAfter: with a caller cursor below the head, effAfter would never
      // advance past non-matching traffic, so every empty re-poll would
      // rescan an ever-growing tail. Any matching event <= head would have
      // resolved the catch-up above, so advancing to head skips only
      // non-matching rows. (This is the spec's "snapshots the max rowid at
      // waiter registration".)
      return new Promise<WaitResult>((resolve) => {
        const w: Waiter = {
          pattern,
          afterId: effAfter,
          resolve,
          signal,
          timer: setTimeout(() => settle(w, { events: [], cursor: head }), capMs),
        };
        if (signal) {
          w.onAbort = () => {
            log.debug({ pattern }, "waiter aborted (connection closed)");
            settle(w, { events: [], cursor: head });
          };
          if (signal.aborted) { clearTimeout(w.timer); resolve({ events: [], cursor: head }); return; }
          signal.addEventListener("abort", w.onAbort, { once: true });
        }
        waiters.add(w);
      });
    },

    waiterCount() { return waiters.size; },
```

and extend `emit` to wake waiters (after the insert):

```ts
      for (const w of [...waiters]) {
        if (!matchTopic(w.pattern, topic)) continue;
        const events = eventsAfter(w.pattern, w.afterId);
        if (events.length) {
          log.debug({ pattern: w.pattern, delivered: events.length }, "waiter woken");
          settle(w, { events, cursor: events[events.length - 1]!.id });
        }
      }
```

Also make `close()` settle all pending waiters (`for (const w of [...waiters]) settle(w, { events: [], cursor: maxId() })` — guard `maxId()` before `db.close()`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test lib/daemon/__tests__/events-bus.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
bunx tsc --noEmit
git add lib/daemon/events-bus.ts lib/daemon/__tests__/events-bus.test.ts
git commit -m "feat(events): blocking wait with waiter registry, cap, abort cleanup (RT-44)"
```

---

### Task 3: Retention sweep

**Files:**
- Modify: `lib/daemon/events-bus.ts`
- Test: `lib/daemon/__tests__/events-bus.test.ts` (append)

**Interfaces:**
- Produces: working `sweep(): number` as typed in Task 1. Rule: delete rows where `emittedAt` is older than 7 days AND the row is not among the newest 50_000. AUTOINCREMENT keeps ids monotonic across deletes (never reset the sequence).

- [ ] **Step 1: Write the failing tests (append)**

```ts
describe("events bus retention", () => {
  let dir: string;
  let bus: EventsBus;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rt-events-"));
    bus = createEventsBus({ dbPath: join(dir, "events.db"), log, retentionFloor: 3 });
  });
  afterEach(() => {
    bus.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("sweep deletes old rows beyond the floor, keeps recent and floor rows", () => {
    // 5 old events (emittedAt 8 days ago) + 1 fresh one
    const oldTs = Date.now() - 8 * 24 * 60 * 60 * 1000;
    for (let i = 0; i < 5; i++) bus.emitAt(`old/${i}`, undefined, oldTs);
    bus.emit("fresh/1");
    const deleted = bus.sweep();
    // 6 total, floor keeps newest 3 (old/3 old/4 fresh/1 by id), age keeps fresh/1;
    // deletable = old/0..old/2 → 3 rows
    expect(deleted).toBe(3);
    const res = bus.list({ pattern: "**", after: 0 });
    expect(res.events.map(e => e.topic)).toEqual(["old/3", "old/4", "fresh/1"]);
  });

  test("ids stay monotonic after a sweep (AUTOINCREMENT)", () => {
    const oldTs = Date.now() - 8 * 24 * 60 * 60 * 1000;
    for (let i = 0; i < 5; i++) bus.emitAt(`old/${i}`, undefined, oldTs);
    const lastBefore = bus.emit("fresh/1");
    bus.sweep();
    expect(bus.emit("fresh/2")).toBe(lastBefore + 1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test lib/daemon/__tests__/events-bus.test.ts`
Expected: FAIL — `retentionFloor` option and `emitAt` unknown, `sweep` throws.

- [ ] **Step 3: Implement**

Add to the factory opts: `retentionFloor?: number` (default `50_000`) and `retentionMs?: number` (default `7 * 24 * 60 * 60 * 1000`). Add a test-only `emitAt(topic, payload, emittedAt)` method to the `EventsBus` interface (documented as test seam — it is `emit` with an explicit timestamp and the same waiter wake-up). Implement `sweep()`:

```ts
    sweep() {
      const cutoff = Date.now() - retentionMs;
      const { changes } = db.run(
        `DELETE FROM events
         WHERE emittedAt < ?
           AND id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT ?)`,
        [cutoff, retentionFloor],
      );
      if (changes > 0) log.debug({ deleted: changes }, "retention sweep");
      return changes;
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test lib/daemon/__tests__/events-bus.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
bunx tsc --noEmit
git add lib/daemon/events-bus.ts lib/daemon/__tests__/events-bus.test.ts
git commit -m "feat(events): retention sweep — 7d age, 50k floor (RT-44)"
```

---

### Task 4: Seam — AbortSignal threading + socket idle timeout

**Files:**
- Modify: `lib/daemon.ts` (handleCommand, routeCommand)
- Modify: `lib/daemon/socket-server.ts` (pass `req.signal`, set `idleTimeout: 255`)
- Modify: `lib/daemon/api-server.ts` (pass `req.signal` on the `handleCommand` call sites)
- Modify: `lib/daemon/handlers/types.ts` (widen `Handler`)
- Test: `lib/daemon/__tests__/events-seam.test.ts` (new — signal plumbing only)

**Interfaces:**
- Produces: `handleCommand(cmd: string, payload: any, signal?: AbortSignal)`; `Handler = (payload: any, signal?: AbortSignal) => Promise<any>`. Existing handlers ignore the new optional parameter — zero changes to them. `TypedHandlers` stays payload-only (catalog commands that need the signal — only `events:wait` — are declared in the `HandlerMap` part with the widened signature; see Task 5).

- [ ] **Step 1: Write the failing test**

```ts
// lib/daemon/__tests__/events-seam.test.ts
import { describe, test, expect } from "bun:test";
import type { Handler } from "../handlers/types.ts";

describe("handler signal seam", () => {
  test("Handler type admits a (payload, signal) implementation", async () => {
    const h: Handler = async (_payload, signal) => ({ ok: true, aborted: signal?.aborted ?? null });
    const ac = new AbortController();
    expect(await h({}, ac.signal)).toEqual({ ok: true, aborted: false });
    expect(await h({})).toEqual({ ok: true, aborted: null });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx tsc --noEmit && bun test lib/daemon/__tests__/events-seam.test.ts`
Expected: tsc FAILS — `Handler` takes one parameter.

- [ ] **Step 3: Implement**

In `lib/daemon/handlers/types.ts`:

```ts
export type Handler    = (payload: any, signal?: AbortSignal) => Promise<any>;
```

In `lib/daemon.ts`, thread the signal (keep logging identical):

```ts
async function handleCommand(cmd: string, payload: any, signal?: AbortSignal): Promise<any> {
  // ...unchanged body, but call:
  const result = await routeCommand(cmd, payload, signal);
}

async function routeCommand(cmd: string, payload: any, signal?: AbortSignal): Promise<any> {
  const routed = routedHandlers[cmd];
  if (routed) return routed(payload, signal);
  // ...switch unchanged
}
```

Note: `statusSnapshot: () => handleCommand("tray:status", {})` at daemon.ts:112 still compiles (signal optional).

In `lib/daemon/socket-server.ts`: add `idleTimeout: 255,` to the `Bun.serve` options (with a comment: raises Bun's implicit 10s default so long-poll `events:wait` requests aren't reaped; it raises a cap, never holds connections open), and change the call to `handleCommand(cmd, payload, req.signal)`.

In `lib/daemon/api-server.ts`: change all three `handleCommand(...)` call sites (lines ~133, ~140, ~162) to append `req.signal`.

- [ ] **Step 4: Run tests + full unit suite to verify nothing broke**

Run: `bunx tsc --noEmit && bun test lib`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/daemon.ts lib/daemon/socket-server.ts lib/daemon/api-server.ts lib/daemon/handlers/types.ts lib/daemon/__tests__/events-seam.test.ts
git commit -m "feat(daemon): thread request AbortSignal through the command seam; 255s socket idle timeout (RT-44)"
```

---

### Task 5: Catalog entries, daemon handlers, wiring (router, pollers, REST)

**Files:**
- Modify: `packages/rt-client/src/commands.ts` (three catalog entries)
- Create: `lib/daemon/handlers/events.ts`
- Modify: `lib/daemon/command-router.ts` (spread new factory; new `eventsBus` opt)
- Modify: `lib/daemon.ts` (instantiate bus, pass to router, sweep interval, close on cleanup)
- Modify: `lib/daemon/api-server.ts` + `lib/daemon/api-auth.ts` (REST routes + token gate)
- Test: `lib/daemon/__tests__/events-handlers.test.ts`

**Interfaces:**
- Consumes: `EventsBus` from Task 1/2/3; widened `Handler` from Task 4.
- Produces catalog entries (exact):

```ts
// in Commands interface (packages/rt-client/src/commands.ts)
"events:emit": { payload: { topic: string; payload?: unknown }; data: { id: number } };
"events:wait": { payload: { pattern: string; after?: number; waitMs?: number }; data: { events: EventsBusEvent[]; cursor: number } };
"events:list": { payload: { pattern: string; after?: number; limit?: number }; data: { events: EventsBusEvent[]; cursor: number } };
// plus, exported from commands.ts (duplicated shape on purpose — rt-client
// cannot import daemon internals):
export interface EventsBusEvent { id: number; topic: string; payload: unknown; emittedAt: number }
```

Add all three names to `COMMAND_NAMES`. Producer signature for the handler factory (this exact type — a bare `HandlerMap` index signature does NOT satisfy `TypedHandlers`' required keys, so `events:wait` must be declared as a named member with the widened signature; the widened member is assignable to `TypedHandlers`' payload-only signature because the extra parameter is optional):

```ts
import type { CommandResult } from "./types.ts";

export function createEventsHandlers(
  bus: EventsBus,
  broadcast: (type: string, data: any) => void,
): Pick<TypedHandlers, "events:emit" | "events:list"> & {
  "events:wait": (
    payload: Commands["events:wait"]["payload"],
    signal?: AbortSignal,
  ) => Promise<CommandResult<"events:wait">>;
} & HandlerMap;
```

Also update `lib/daemon/__tests__/rt-client-commands.test.ts` (the catalog exhaustiveness test): its `buildRoutedHandlers({...})` call (~line 34) must gain the new `eventsBus` opt — add `eventsBus: createEventsBus({ dbPath: ":memory:", log: pino({ level: "silent" }) })` with `import pino from "pino"` (do NOT reuse the file's existing logger stub — it has no `.child`, which `createEventsBus` calls at construction). Handlers are assembled there, never invoked, and `:memory:` needs no cleanup. No assertion changes are needed — the test iterates `COMMAND_NAMES` automatically.

- [ ] **Step 1: Write the failing tests**

```ts
// lib/daemon/__tests__/events-handlers.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import pino from "pino";
import { createEventsBus, type EventsBus } from "../events-bus.ts";
import { createEventsHandlers } from "../handlers/events.ts";

const log = pino({ level: "silent" });

describe("events handlers", () => {
  let dir: string;
  let bus: EventsBus;
  let frames: Array<{ type: string; data: any }>;
  let handlers: ReturnType<typeof createEventsHandlers>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rt-events-"));
    bus = createEventsBus({ dbPath: join(dir, "events.db"), log });
    frames = [];
    handlers = createEventsHandlers(bus, (type, data) => frames.push({ type, data }));
  });
  afterEach(() => {
    bus.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("events:emit validates topic, returns id, broadcasts an event frame", async () => {
    const bad = await handlers["events:emit"]({ topic: "" } as any);
    expect(bad.ok).toBe(false);
    const res = await handlers["events:emit"]({ topic: "job/x/q", payload: { a: 1 } });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.id).toBeGreaterThan(0);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.type).toBe("event");
    expect(frames[0]!.data.topic).toBe("job/x/q");
  });

  test("events:list coerces string after/limit (REST query params)", async () => {
    await handlers["events:emit"]({ topic: "job/x/a" });
    await handlers["events:emit"]({ topic: "job/x/b" });
    const res = await handlers["events:list"]({ pattern: "job/**", after: "0", limit: "1" } as any);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.events).toHaveLength(1);
  });

  test("events:wait passes the abort signal through to the bus", async () => {
    const ac = new AbortController();
    const p = handlers["events:wait"]({ pattern: "job/**", waitMs: 240_000 }, ac.signal);
    ac.abort();
    const res = await p;
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.events).toEqual([]);
    expect(bus.waiterCount()).toBe(0);
  });

  test("events:wait rejects missing pattern", async () => {
    const res = await handlers["events:wait"]({} as any);
    expect(res.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test lib/daemon/__tests__/events-handlers.test.ts`
Expected: FAIL — no `handlers/events.ts`.

- [ ] **Step 3: Implement**

Catalog first (`packages/rt-client/src/commands.ts` — the three entries, `EventsBusEvent`, and `COMMAND_NAMES` additions, exactly as in Interfaces above). Then:

```ts
// lib/daemon/handlers/events.ts
/**
 * events:* — the daemon's optional pane-communication bus (RT-44).
 * Thin validation + delegation; the bus owns journal and waiter semantics.
 * Spec: docs/superpowers/specs/2026-08-18-rt-events-bus-design.md
 */

import type { Commands } from "../../../packages/rt-client/src/commands.ts";
import type { CommandResult, HandlerMap, TypedHandlers } from "./types.ts";
import type { EventsBus } from "../events-bus.ts";

const num = (v: unknown): number | undefined => {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

// events:wait is declared as a named member (not left to the HandlerMap index
// signature — that would fail TypedHandlers' required-key check in
// buildRoutedHandlers) with the widened (payload, signal?) shape, which stays
// assignable to TypedHandlers' payload-only signature.
export function createEventsHandlers(
  bus: EventsBus,
  broadcast: (type: string, data: any) => void,
): Pick<TypedHandlers, "events:emit" | "events:list"> & {
  "events:wait": (
    payload: Commands["events:wait"]["payload"],
    signal?: AbortSignal,
  ) => Promise<CommandResult<"events:wait">>;
} & HandlerMap {
  return {
    "events:emit": async (payload: Commands["events:emit"]["payload"]) => {
      const topic = typeof payload?.topic === "string" ? payload.topic.trim() : "";
      if (!topic) return { ok: false as const, error: "missing topic" };
      const id = bus.emit(topic, payload.payload);
      broadcast("event", { id, topic, payload: payload.payload ?? null, emittedAt: Date.now() });
      return { ok: true as const, data: { id } };
    },

    "events:list": async (payload: Commands["events:list"]["payload"]) => {
      const pattern = typeof payload?.pattern === "string" && payload.pattern ? payload.pattern : "";
      if (!pattern) return { ok: false as const, error: "missing pattern" };
      const { events, cursor } = bus.list({ pattern, after: num(payload.after), limit: num(payload.limit) });
      return { ok: true as const, data: { events, cursor } };
    },

    // Widened-Handler shape: receives the request AbortSignal from the seam
    // so a dead client's waiter is removed instead of lingering to the cap.
    "events:wait": async (payload: Commands["events:wait"]["payload"], signal?: AbortSignal) => {
      const pattern = typeof payload?.pattern === "string" && payload.pattern ? payload.pattern : "";
      if (!pattern) return { ok: false as const, error: "missing pattern" };
      const { events, cursor } = await bus.wait({
        pattern,
        after: num(payload.after),
        waitMs: num(payload.waitMs),
        signal,
      });
      return { ok: true as const, data: { events, cursor } };
    },
  };
}
```

Wiring in `lib/daemon.ts` (after `hooksGuard`, before `buildRoutedHandlers`):

```ts
import { createEventsBus } from "./daemon/events-bus.ts";
import { join } from "path";
// ...
const eventsBus = createEventsBus({ dbPath: join(RT_DIR, "events.db"), log });
// hourly retention sweep — cheap; rides its own interval rather than pollers
// because it needs no poller deps
setInterval(() => eventsBus.sweep(), 60 * 60 * 1000);
```

Pass `eventsBus` into `buildRoutedHandlers` opts and spread `...createEventsHandlers(opts.eventsBus, broadcast)` in `command-router.ts`. Add `eventsBus.close()` to the `cleanup` wrapper in daemon.ts (alongside `cron.dispose()`).

REST (`lib/daemon/api-server.ts`): add to `REST_ROUTES`:

```ts
  "/api/events/emit":   { cmd: "events:emit", method: "POST" },
  "/api/events":        { cmd: "events:list", method: "GET" },
```

and to `API_INDEX.endpoints` (two lines mirroring the existing format). In `lib/daemon/api-auth.ts` `needsToken`, add:

```ts
  if (pathname === "/api/events/emit") return true;
```

plus a matching assertion in `lib/daemon/__tests__/api-auth.test.ts` (mirror the existing shutdown/reconnect cases).

- [ ] **Step 4: Run the full unit suite**

Run: `bunx tsc --noEmit && bun test lib`
Expected: PASS — including the MAT-31 intersection proof in `buildRoutedHandlers` (a missing handler for a new catalog entry fails tsc here).

- [ ] **Step 5: Commit**

```bash
git add packages/rt-client/src/commands.ts lib/daemon/handlers/events.ts lib/daemon/command-router.ts lib/daemon.ts lib/daemon/api-server.ts lib/daemon/api-auth.ts lib/daemon/__tests__/events-handlers.test.ts lib/daemon/__tests__/api-auth.test.ts
git commit -m "feat(events): catalog entries, typed handlers, daemon wiring, REST routes (RT-44)"
```

**Post-task note for the human:** `packages/rt-client` changes are consumed as file-copy deps by mr-board and gitq — run `bun install` there after this lands (existing convention, not part of this plan).

---

### Task 6: CLI verbs — `rt events emit|wait|tail|list`

**Files:**
- Create: `commands/events.ts`
- Modify: `lib/command-tree-def.ts` (new `events` node)
- Modify: `lib/module-registry.ts` (**mandatory** — compiled binary breaks without it)
- Test: `lib/__tests__/events-cli.test.ts` (pure helpers: duration parsing, poll-loop step logic)

**Interfaces:**
- Consumes: `daemonQuery(cmd, payload, timeoutMs)` from `lib/daemon-client.ts` (null ⇒ daemon unavailable); catalog payload/data shapes from Task 5.
- Produces CLI behavior (exact, skills will hard-code against this):
  - `rt events emit <topic> [--json '<json>']` → prints `{"ok":true,"id":N}`, exit 0. Invalid `--json` → error to stderr, exit 1, **no IPC call**.
  - `rt events wait <pattern> [--after <cursor>] [--timeout <dur>]` → blocks; on events prints `{"ok":true,"events":[...],"cursor":N}` exit 0; on timeout prints `{"ok":true,"timedOut":true,"cursor":N}` exit **124**; daemon unavailable → stderr message, exit 1.
  - `rt events list <pattern> [--after <cursor>] [--limit <n>]` → prints `{"ok":true,"events":[...],"cursor":N}` exit 0.
  - `rt events tail <pattern> [--after <cursor>]` → with `--after`, replays the journal from that cursor first; without it, starts from now (same default as `wait` — a follow-mode consumer must not get a 50k-event history dump). Then the same poll loop as `wait`, printing one event JSON per line (NDJSON), forever until Ctrl-C.
  - Durations: `<n>ms|s|m|h` suffix; bare number = seconds; no `--timeout` = wait forever.
  - Exported for tests: `parseDuration(s: string): number | null` (ms, null on garbage) and `nextWaitMs(deadline: number | null, now: number): number` (`min(240_000, deadline - now)`, or 240_000 when deadline is null).

- [ ] **Step 1: Write the failing tests**

```ts
// lib/__tests__/events-cli.test.ts
import { describe, test, expect } from "bun:test";
import { parseDuration, nextWaitMs } from "../../commands/events.ts";

describe("parseDuration", () => {
  test("suffixes", () => {
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("5m")).toBe(300_000);
    expect(parseDuration("2h")).toBe(7_200_000);
  });
  test("bare number = seconds", () => expect(parseDuration("45")).toBe(45_000));
  test("garbage is null", () => {
    expect(parseDuration("abc")).toBeNull();
    expect(parseDuration("")).toBeNull();
    expect(parseDuration("-5s")).toBeNull();
  });
});

describe("nextWaitMs", () => {
  test("no deadline → full daemon cap", () => expect(nextWaitMs(null, 1_000)).toBe(240_000));
  test("distant deadline → clamped to cap", () => expect(nextWaitMs(1_000_000, 0)).toBe(240_000));
  test("near deadline → remaining time", () => expect(nextWaitMs(5_000, 2_000)).toBe(3_000));
  test("passed deadline → 0", () => expect(nextWaitMs(1_000, 5_000)).toBe(0));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test lib/__tests__/events-cli.test.ts`
Expected: FAIL — no `commands/events.ts`.

- [ ] **Step 3: Implement the command module**

```ts
// commands/events.ts
/**
 * rt events — optional event bus for panes and skills (RT-44).
 *
 *   rt events emit <topic> [--json '{...}']            publish
 *   rt events wait <pattern> [--after N] [--timeout D] blocking subscribe (long-poll)
 *   rt events tail <pattern> [--after N]               follow-mode NDJSON stream
 *   rt events list <pattern> [--after N] [--limit N]   read the journal
 *
 * All output is JSON (skills consume it). Cursors are caller-held: every
 * response carries `cursor`; pass it back via --after. Timeout exits 124.
 * Spec: docs/superpowers/specs/2026-08-18-rt-events-bus-design.md
 */

import { daemonQuery } from "../lib/daemon-client.ts";

const DAEMON_WAIT_MS = 240_000;          // daemon clamps to this too
const IPC_TIMEOUT_MS = DAEMON_WAIT_MS + 10_000; // client abort must outlive the daemon cap

export function parseDuration(s: string): number | null {
  const m = /^(\d+)(ms|s|m|h)?$/.exec(s.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 10);
  const unit = m[2] ?? "s";
  return n * (unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000);
}

export function nextWaitMs(deadline: number | null, now: number): number {
  if (deadline == null) return DAEMON_WAIT_MS;
  return Math.max(0, Math.min(DAEMON_WAIT_MS, deadline - now));
}

function fail(msg: string): never {
  console.error(`rt events: ${msg}`);
  process.exit(1);
}

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

// Index-based scan (not value comparison — a positional that EQUALS a flag's
// value, e.g. `rt events wait 42 --after 42`, must still parse).
const FLAGS_WITH_VALUES = new Set(["--json", "--after", "--timeout", "--limit"]);
function positional(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      if (FLAGS_WITH_VALUES.has(a)) i++; // skip the flag's value slot
      continue;
    }
    return a;
  }
  return undefined;
}

export async function eventsEmit(args: string[]): Promise<void> {
  const topic = positional(args);
  if (!topic) fail("usage: rt events emit <topic> [--json '<json>']");
  let payload: unknown;
  const raw = flagValue(args, "--json");
  if (raw !== undefined) {
    try { payload = JSON.parse(raw); } catch { fail(`--json is not valid JSON: ${raw}`); }
  }
  const res = await daemonQuery("events:emit", { topic, payload }, 10_000);
  if (!res) fail("daemon unavailable — the event bus needs the rt daemon (rt daemon start)");
  if (!res.ok) fail(res.error ?? "emit failed");
  console.log(JSON.stringify({ ok: true, id: res.data.id }));
}

/** Shared poll loop for wait (one round) and tail (endless). */
async function pollOnce(pattern: string, after: number | undefined, waitMs: number) {
  const res = await daemonQuery("events:wait", { pattern, after, waitMs }, IPC_TIMEOUT_MS);
  if (!res) fail("daemon unavailable — the event bus needs the rt daemon (rt daemon start)");
  if (!res.ok) fail(res.error ?? "wait failed");
  return res.data as { events: any[]; cursor: number };
}

export async function eventsWait(args: string[]): Promise<void> {
  const pattern = positional(args);
  if (!pattern) fail("usage: rt events wait <pattern> [--after <cursor>] [--timeout <dur>]");
  let after = flagValue(args, "--after") !== undefined ? Number(flagValue(args, "--after")) : undefined;
  if (after !== undefined && !Number.isFinite(after)) fail("--after must be a number");
  let deadline: number | null = null;
  const t = flagValue(args, "--timeout");
  if (t !== undefined) {
    const ms = parseDuration(t);
    if (ms == null) fail(`--timeout: bad duration "${t}" (use 30s, 5m, 500ms, or bare seconds)`);
    deadline = Date.now() + ms;
  }

  while (true) {
    const waitMs = nextWaitMs(deadline, Date.now());
    if (waitMs === 0) {
      console.log(JSON.stringify({ ok: true, timedOut: true, cursor: after ?? null }));
      process.exit(124);
    }
    const data = await pollOnce(pattern, after, waitMs);
    after = data.cursor; // ALWAYS thread the cursor — empty responses included
    if (data.events.length) {
      console.log(JSON.stringify({ ok: true, events: data.events, cursor: data.cursor }));
      return;
    }
  }
}

export async function eventsList(args: string[]): Promise<void> {
  const pattern = positional(args);
  if (!pattern) fail("usage: rt events list <pattern> [--after <cursor>] [--limit <n>]");
  const payload: Record<string, unknown> = { pattern };
  const after = flagValue(args, "--after");
  if (after !== undefined) payload.after = Number(after);
  const limit = flagValue(args, "--limit");
  if (limit !== undefined) payload.limit = Number(limit);
  const res = await daemonQuery("events:list", payload, 10_000);
  if (!res) fail("daemon unavailable — the event bus needs the rt daemon (rt daemon start)");
  if (!res.ok) fail(res.error ?? "list failed");
  console.log(JSON.stringify({ ok: true, events: res.data.events, cursor: res.data.cursor }));
}

export async function eventsTail(args: string[]): Promise<void> {
  const pattern = positional(args);
  if (!pattern) fail("usage: rt events tail <pattern> [--after <cursor>]");
  let after = flagValue(args, "--after") !== undefined ? Number(flagValue(args, "--after")) : undefined;
  if (after !== undefined && !Number.isFinite(after)) fail("--after must be a number");

  // Catch-up via list, then the same poll loop as wait, forever.
  // No --after means START FROM NOW (same default as wait) — never dump the
  // whole journal on a follow-mode consumer. MAX_SAFE_INTEGER returns zero
  // events plus cursor = journal head (list computes cursor = maxId() for
  // untruncated results).
  const listAfter = after ?? Number.MAX_SAFE_INTEGER;
  const res = await daemonQuery("events:list", { pattern, after: listAfter }, 10_000);
  if (!res) fail("daemon unavailable — the event bus needs the rt daemon (rt daemon start)");
  if (!res.ok) fail(res.error ?? "tail failed");
  for (const ev of res.data.events) console.log(JSON.stringify(ev));
  after = res.data.cursor;

  while (true) {
    const data = await pollOnce(pattern, after, DAEMON_WAIT_MS);
    after = data.cursor;
    for (const ev of data.events) console.log(JSON.stringify(ev));
  }
}
```

- [ ] **Step 4: Wire the command tree and module registry**

In `lib/command-tree-def.ts`, add (mirror the `branch` node's subcommand structure and the existing arg-hint style):

```ts
const eventsSubcommands: Record<string, CommandNode> = {
  emit: {
    description: "Publish an event to a topic",
    module: "./commands/events.ts",
    fn: "eventsEmit",
    args: [
      { name: "Topic", type: "text", placeholder: "job/myherd/report", hint: "Topic string; slash-separated by convention" },
      { name: "Payload", flag: "--json", type: "text", placeholder: "{\"k\":1}", hint: "Optional JSON payload (convention: small pointers, files carry data)" },
    ],
  },
  wait: {
    description: "Block until a matching event lands (long-poll; exit 124 on timeout)",
    module: "./commands/events.ts",
    fn: "eventsWait",
    args: [
      { name: "Pattern", type: "text", placeholder: "job/myherd/*", hint: "Glob pattern (* within a segment, ** across segments)" },
      { name: "After", flag: "--after", type: "text", placeholder: "42", hint: "Cursor from a previous response; omit for only-new events" },
      { name: "Timeout", flag: "--timeout", type: "text", placeholder: "5m", hint: "Give up after this long (30s, 5m, 500ms, bare seconds); omit to wait forever" },
    ],
  },
  tail: {
    description: "Stream matching events as NDJSON until interrupted",
    module: "./commands/events.ts",
    fn: "eventsTail",
    args: [
      { name: "Pattern", type: "text", placeholder: "job/**", hint: "Glob pattern to follow" },
      { name: "After", flag: "--after", type: "text", placeholder: "42", hint: "Start from this cursor (replays the journal first)" },
    ],
  },
  list: {
    description: "Read matching events from the journal (non-blocking)",
    module: "./commands/events.ts",
    fn: "eventsList",
    args: [
      { name: "Pattern", type: "text", placeholder: "job/**", hint: "Glob pattern to match" },
      { name: "After", flag: "--after", type: "text", placeholder: "0", hint: "Only events with id greater than this cursor" },
      { name: "Limit", flag: "--limit", type: "text", placeholder: "100", hint: "Cap the number of returned events" },
    ],
  },
};
```

and in `TREE`: `events: { description: "Optional event bus for panes and skills", subcommands: eventsSubcommands },` (verify the exact subcommand-container key against how `branch` is declared in `TREE` and copy that shape).

In `lib/module-registry.ts`: add `import * as events from "../commands/events.ts";` and `"./commands/events.ts": events,` — **the compiled binary silently lacks the command without this**.

- [ ] **Step 5: Run tests + docs check**

Run: `bunx tsc --noEmit && bun test lib && bun run docs:check`
Expected: PASS. If `docs:check` flags generated docs as stale, run `bun run docs:gen` and include the output in the commit.

- [ ] **Step 6: Commit**

```bash
git add commands/events.ts lib/command-tree-def.ts lib/module-registry.ts lib/__tests__/events-cli.test.ts docs/
git commit -m "feat(events): rt events emit/wait/tail/list CLI verbs (RT-44)"
```

---

### Task 7: E2E — emit → blocked wait → wake across two real processes (the RT-44 spike)

**Files:**
- Create: `e2e/tests/events.test.ts`

**Interfaces:**
- Consumes: `RT_BINARY`, `createTestHome` from `e2e/harness.ts`; `rt --daemon` (foreground daemon, cli.ts:48); the Task 6 CLI contract (output shapes, exit codes).

**Approach:** spawn the compiled binary as a foreground daemon (`rt --daemon`) with an isolated HOME, wait for `~/.rt/rt.sock` to appear, then drive `rt events` as separate child processes — two real processes over the real socket, which is exactly the ticket's spike, kept as a permanent test.

- [ ] **Step 1: Write the test**

```ts
// e2e/tests/events.test.ts
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";
import { createTestHome, RT_BINARY } from "../harness.ts";

async function waitForSocket(sockPath: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(sockPath)) {
    if (Date.now() > deadline) throw new Error(`daemon socket never appeared at ${sockPath}`);
    await Bun.sleep(100);
  }
}

function runRt(args: string[], home: string) {
  return Bun.spawn([RT_BINARY, ...args], {
    env: { ...process.env, HOME: home, RT_SKIP_SETUP: "1", CI: "true" },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function finished(proc: ReturnType<typeof runRt>) {
  const exitCode = await proc.exited;
  return {
    exitCode,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  };
}

describe("rt events (bus e2e)", () => {
  let home: string;
  let cleanup: () => void;
  let daemon: ReturnType<typeof runRt>;

  beforeAll(async () => {
    ({ path: home, cleanup } = createTestHome());
    daemon = runRt(["--daemon"], home);
    await waitForSocket(join(home, ".rt", "rt.sock"));
  });

  afterAll(async () => {
    daemon.kill();
    await daemon.exited;
    cleanup();
  });

  test("emit → blocked wait → wake across two processes", async () => {
    const waiter = runRt(["events", "wait", "job/e2e/*", "--timeout", "20s"], home);
    await Bun.sleep(500); // let the waiter register (blocked, not yet resolved)

    const emit = await finished(runRt(["events", "emit", "job/e2e/report", "--json", '{"n":1}'], home));
    expect(emit.exitCode).toBe(0);
    const emitted = JSON.parse(emit.stdout);
    expect(emitted.ok).toBe(true);

    const woke = await finished(waiter);
    expect(woke.exitCode).toBe(0);
    const result = JSON.parse(woke.stdout);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].topic).toBe("job/e2e/report");
    expect(result.events[0].payload).toEqual({ n: 1 });
    expect(result.cursor).toBe(result.events[0].id);
  }, 30_000);

  test("wait --timeout expires with exit 124 and a cursor", async () => {
    const res = await finished(runRt(["events", "wait", "job/nobody/*", "--timeout", "2s"], home));
    expect(res.exitCode).toBe(124);
    const out = JSON.parse(res.stdout);
    expect(out.timedOut).toBe(true);
  }, 15_000);

  test("cursor replay: a late consumer sees events emitted while it was away", async () => {
    const first = await finished(runRt(["events", "emit", "job/replay/a"], home));
    const firstId = JSON.parse(first.stdout).id;
    await finished(runRt(["events", "emit", "job/replay/b"], home));

    const res = await finished(runRt(["events", "list", "job/replay/*", "--after", String(firstId - 1)], home));
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.events.map((e: any) => e.topic)).toEqual(["job/replay/a", "job/replay/b"]);
  }, 15_000);

  test("journal survives a daemon restart; wait resumes from a held cursor", async () => {
    const pre = await finished(runRt(["events", "emit", "job/restart/before"], home));
    const cursor = JSON.parse(pre.stdout).id;

    daemon.kill();
    await daemon.exited;
    daemon = runRt(["--daemon"], home);
    await waitForSocket(join(home, ".rt", "rt.sock"));

    const waiter = runRt(["events", "wait", "job/restart/*", "--after", String(cursor), "--timeout", "20s"], home);
    await Bun.sleep(500);
    await finished(runRt(["events", "emit", "job/restart/after"], home));

    const woke = await finished(waiter);
    expect(woke.exitCode).toBe(0);
    const out = JSON.parse(woke.stdout);
    expect(out.events.map((e: any) => e.topic)).toEqual(["job/restart/after"]);
  }, 45_000);
});
```

- [ ] **Step 2: Build the binary and run the e2e suite**

```bash
bun build --compile --outfile dist/rt cli.ts   # check scripts/ or the release skill for the exact build invocation if this flag set fails
bun run test:e2e
```
Expected: the new `events.test.ts` PASSES (delete any stale `dist/rt` first — stale binaries are a known footgun). Note: `waitForSocket` may race daemon boot on slow machines; if the first test flakes on socket timing, raise the `Bun.sleep(500)` registration grace to 1000ms before suspecting real bugs.

- [ ] **Step 3: Run everything**

```bash
bunx tsc --noEmit && bun run test:all
```
Expected: green across unit + e2e.

- [ ] **Step 4: Commit**

```bash
git add e2e/tests/events.test.ts
git commit -m "test(events): e2e — cross-process emit/wait/wake, timeout, replay, restart resume (RT-44)"
```

---

## Completion checklist (for the coordinating session, not a subagent)

- [ ] `bunx tsc --noEmit` clean, `bun run test:all` green, e2e includes the four events tests.
- [ ] Restart the real daemon (dev-mode) and smoke: `rt events emit demo/hello --json '{"hi":1}'` in one pane, `rt events wait 'demo/*'` in another — wake observed across real panes (closes RT-44's spike requirement).
- [ ] Update RT-44 in Linear with the outcome; spec + plan links.
- [ ] Remind: `bun install` in mr-board and gitq (rt-client file-copy deps).
