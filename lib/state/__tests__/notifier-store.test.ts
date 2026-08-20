/**
 * lib/state/notifier-store.ts — the notifier kv state blob and the
 * notify_queue durable queue. See
 * docs/superpowers/specs/2026-08-20-rt-statedb.md — "Tables (v1)" (`kv`,
 * `notify_queue`), "Store-by-store" item 4, spec test 9 (queue durability,
 * peek non-destructive, remove-by-event_id both paths) and test 13's
 * notifier half (kv round-trip / missing-row cold start).
 *
 * HOME isolation is handled by the repo-wide bun test preload
 * (test-setup.ts) — never removed here. Stores are constructed via
 * openStateDb(tempPath) per the spec's test convention.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openStateDb } from "../db.ts";
import {
  drainNotificationQueue,
  enqueueNotification,
  getNotifierStateBlob,
  isNotificationQueued,
  peekNotificationQueue,
  removeQueuedNotification,
  setNotifierStateBlob,
  type NotificationEvent,
} from "../notifier-store.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rt-notifier-store-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function openDb(): Database {
  return openStateDb(join(dir, "state.db"), "cli");
}

function event(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    id: crypto.randomUUID(),
    title: "Pipeline Failed",
    message: "branch-a",
    category: "pipeline_failed",
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("notify_queue — spec test 9", () => {
  test("enqueue survives across a new handle (daemon restart) and drain returns it once", () => {
    const db1 = openDb();
    const e = event();
    enqueueNotification(e, db1);
    db1.close();

    // A fresh handle on the same file — simulates the daemon restarting.
    const db2 = openDb();
    const drained = drainNotificationQueue(db2);
    expect(drained).toEqual([e]);

    // Draining again returns nothing — it was removed, not just read.
    expect(drainNotificationQueue(db2)).toEqual([]);
    db2.close();
  });

  test("peek does not delete", () => {
    const db = openDb();
    const e = event();
    enqueueNotification(e, db);

    expect(peekNotificationQueue(db)).toEqual([e]);
    expect(peekNotificationQueue(db)).toEqual([e]); // still there
    expect(drainNotificationQueue(db)).toEqual([e]); // still drainable after peeking
    db.close();
  });

  test("drain preserves FIFO order across multiple enqueues", () => {
    const db = openDb();
    const e1 = event({ id: "a" });
    const e2 = event({ id: "b" });
    const e3 = event({ id: "c" });
    enqueueNotification(e1, db);
    enqueueNotification(e2, db);
    enqueueNotification(e3, db);

    expect(drainNotificationQueue(db).map((e) => e.id)).toEqual(["a", "b", "c"]);
    db.close();
  });

  test("remove-by-event_id: the pushToTray-success path removes exactly that event", () => {
    const db = openDb();
    const keep = event({ id: "keep" });
    const gone = event({ id: "gone" });
    enqueueNotification(keep, db);
    enqueueNotification(gone, db);

    removeQueuedNotification("gone", db);

    expect(peekNotificationQueue(db).map((e) => e.id)).toEqual(["keep"]);
    db.close();
  });

  test("remove-by-event_id: the 10s tray-fallback timer's path removes exactly that event", () => {
    const db = openDb();
    const keep = event({ id: "keep" });
    const gone = event({ id: "gone" });
    enqueueNotification(keep, db);
    enqueueNotification(gone, db);

    // isNotificationQueued is what the fallback timer checks before
    // deciding whether to fall back and remove.
    expect(isNotificationQueued("gone", db)).toBe(true);
    removeQueuedNotification("gone", db);
    expect(isNotificationQueued("gone", db)).toBe(false);

    expect(peekNotificationQueue(db).map((e) => e.id)).toEqual(["keep"]);
    db.close();
  });

  test("removing an event_id that isn't queued is a no-op, not an error", () => {
    const db = openDb();
    expect(() => removeQueuedNotification("nonexistent", db)).not.toThrow();
    expect(peekNotificationQueue(db)).toEqual([]);
    db.close();
  });
});

describe("notify_queue — bounded retry on SQLITE_BUSY", () => {
  test("enqueue does not throw when the write lock is held past the retry budget; the write is lost", () => {
    const dbPath = join(dir, "state.db");
    // Daemon flavor: short busy_timeout, matching where enqueueNotification
    // actually runs in production (spec "The database") and keeping this
    // test fast — a cli-flavor 5000ms busy_timeout would make each of the
    // 3 retry attempts individually block for seconds.
    const db = openStateDb(dbPath, "daemon");

    // A second connection holds the write lock for the entire retry budget,
    // guaranteeing every attempt sees SQLITE_BUSY.
    const blocker = new Database(dbPath);
    blocker.exec("PRAGMA busy_timeout = 0;");
    blocker.exec("BEGIN IMMEDIATE;");

    const started = Date.now();
    try {
      expect(() => enqueueNotification(event({ id: "lost" }), db)).not.toThrow();
    } finally {
      blocker.exec("ROLLBACK;");
      blocker.close();
    }
    const elapsedMs = Date.now() - started;

    // 3 attempts means 2 inter-attempt sleeps — bounds the retry actually
    // happened, not just "attempt once and give up".
    expect(elapsedMs).toBeGreaterThanOrEqual(30);

    // The blocker only released AFTER the retry budget was exhausted, so
    // the write is genuinely gone — the notify_queue EXCEPTION's cost
    // ("notification may be lost") is real, not silently recovered.
    expect(peekNotificationQueue(db)).toEqual([]);
    db.close();
  });

  test("remove-by-event_id also retries bounded and does not throw", () => {
    const dbPath = join(dir, "state.db");
    const db = openStateDb(dbPath, "daemon");
    enqueueNotification(event({ id: "keep-me" }), db);

    const blocker = new Database(dbPath);
    blocker.exec("PRAGMA busy_timeout = 0;");
    blocker.exec("BEGIN IMMEDIATE;");
    try {
      expect(() => removeQueuedNotification("keep-me", db)).not.toThrow();
    } finally {
      blocker.exec("ROLLBACK;");
      blocker.close();
    }

    // The DELETE never got through the lock — the row is still there.
    expect(peekNotificationQueue(db).map((e) => e.id)).toEqual(["keep-me"]);
    db.close();
  });
});

describe("kv — notifier state blob round-trip (spec test 13, notifier half)", () => {
  interface FakeState { branches: Record<string, number>; fired: string[]; }

  test("missing kv row is cold-start: returns the caller's fallback", () => {
    const db = openDb();
    const fallback: FakeState = { branches: {}, fired: [] };
    expect(getNotifierStateBlob(fallback, db)).toEqual(fallback);
    db.close();
  });

  test("read-modify-write survives across two cycles", () => {
    const db = openDb();
    const fallback: FakeState = { branches: {}, fired: [] };

    // Cycle 1: cold start, write a first snapshot.
    let state = getNotifierStateBlob(fallback, db);
    expect(state).toEqual(fallback);
    state = { branches: { "branch-a": 1 }, fired: ["k1"] };
    setNotifierStateBlob(state, db);

    // Cycle 2: read back exactly what cycle 1 wrote, modify, write again.
    const reread = getNotifierStateBlob<FakeState>(fallback, db);
    expect(reread).toEqual({ branches: { "branch-a": 1 }, fired: ["k1"] });
    const updated: FakeState = { branches: { "branch-a": 2, "branch-b": 1 }, fired: ["k1", "k2"] };
    setNotifierStateBlob(updated, db);

    expect(getNotifierStateBlob<FakeState>(fallback, db)).toEqual(updated);
    db.close();
  });

  test("a fresh handle on the same file sees the last write (daemon restart)", () => {
    const dbPath = join(dir, "state.db");
    const db1 = openStateDb(dbPath, "cli");
    setNotifierStateBlob({ branches: { x: 1 }, fired: [] } as FakeState, db1);
    db1.close();

    const db2 = openStateDb(dbPath, "cli");
    expect(getNotifierStateBlob<FakeState>({ branches: {}, fired: [] }, db2)).toEqual({ branches: { x: 1 }, fired: [] });
    db2.close();
  });
});
