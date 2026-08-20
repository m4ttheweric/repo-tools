/**
 * lib/state/cursors-store.ts — events-cursor persistence over `kv`
 * (ns='events-cursor', k=repoName). See
 * docs/superpowers/specs/2026-08-20-rt-statedb.md — "Tables (v1)" (`kv`),
 * "Store-by-store" item 5, and spec test 13's cursors half (get/set
 * round-trip per repo, missing row = undefined = cold start, legacy
 * import).
 *
 * Migrated from lib/daemon/__tests__/freshness-cursors.test.ts (RT-48 task
 * 7): createCursorStore used to be a file-backed JSON map defined in
 * lib/daemon/freshness.ts; it now lives here over state.db, constructed via
 * the openStateDb(tempPath) seam per the spec's test convention. HOME
 * isolation is handled by the repo-wide bun test preload (test-setup.ts) —
 * never removed here.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openStateDb } from "../db.ts";
import { createCursorStore } from "../cursors-store.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rt-cursors-store-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function openDb(): Database {
  return openStateDb(join(dir, "state.db"), "cli");
}

describe("createCursorStore — spec test 13, cursors half", () => {
  test("missing row is cold-start: get returns undefined", () => {
    const store = createCursorStore(openDb());
    expect(store.get("repo-a")).toBeUndefined();
  });

  test("set persists and get round-trips", () => {
    const db = openDb();
    const store = createCursorStore(db);
    store.set("repo-a", { since: "2026-07-24T00:00:00Z", lastEventId: 42 });
    expect(store.get("repo-a")).toEqual({ since: "2026-07-24T00:00:00Z", lastEventId: 42 });
  });

  test("a fresh handle on the same db file sees the last write (daemon restart)", () => {
    const dbPath = join(dir, "state.db");
    const db1 = openStateDb(dbPath, "cli");
    createCursorStore(db1).set("repo-a", { since: "2026-07-24T00:00:00Z", lastEventId: 42 });
    db1.close();

    const db2 = openStateDb(dbPath, "cli");
    expect(createCursorStore(db2).get("repo-a")).toEqual({ since: "2026-07-24T00:00:00Z", lastEventId: 42 });
    db2.close();
  });

  test("multiple repos coexist as independent rows", () => {
    const store = createCursorStore(openDb());
    store.set("repo-a", { since: null, lastEventId: 1 });
    store.set("repo-b", { since: null, lastEventId: 2 });
    expect(store.get("repo-a")!.lastEventId).toBe(1);
    expect(store.get("repo-b")!.lastEventId).toBe(2);
  });

  test("set overwrites a repo's prior cursor (last-writer-wins per row)", () => {
    const store = createCursorStore(openDb());
    store.set("repo-a", { since: null, lastEventId: 1 });
    store.set("repo-a", { since: "2026-08-01T00:00:00Z", lastEventId: 99 });
    expect(store.get("repo-a")).toEqual({ since: "2026-08-01T00:00:00Z", lastEventId: 99 });
  });

  test("a row whose stored JSON is corrupt reads as cold-start (undefined), not a throw", () => {
    const db = openDb();
    db.query(
      "INSERT INTO kv (ns, k, v, updated_at) VALUES ('events-cursor', 'repo-a', '{not json', 0);",
    ).run();
    expect(createCursorStore(db).get("repo-a")).toBeUndefined();
  });

  test("get for one repo does not see another repo's row", () => {
    const store = createCursorStore(openDb());
    store.set("repo-a", { since: null, lastEventId: 1 });
    expect(store.get("repo-b")).toBeUndefined();
  });
});

describe("legacy import: events-cursors.json → kv rows (ns='events-cursor')", () => {
  test("imports each repo's cursor as its own kv row and renames the source file", () => {
    const dbPath = join(dir, "state.db");
    const legacyPath = join(dir, "events-cursors.json");
    writeFileSync(
      legacyPath,
      JSON.stringify({
        "repo-a": { since: "2026-07-24T00:00:00Z", lastEventId: 42 },
        "repo-b": { since: null, lastEventId: 7 },
      }),
    );

    const db = openStateDb(dbPath, "cli");
    const store = createCursorStore(db);

    expect(store.get("repo-a")).toEqual({ since: "2026-07-24T00:00:00Z", lastEventId: 42 });
    expect(store.get("repo-b")).toEqual({ since: null, lastEventId: 7 });

    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(`${legacyPath}.migrated`)).toBe(true);
    db.close();
  });

  test("an empty legacy map imports cleanly (no rows, still renamed)", () => {
    const dbPath = join(dir, "state.db");
    const legacyPath = join(dir, "events-cursors.json");
    writeFileSync(legacyPath, JSON.stringify({}));

    const db = openStateDb(dbPath, "cli");
    const { n } = db.query("SELECT COUNT(*) as n FROM kv WHERE ns = 'events-cursor';").get() as { n: number };
    expect(n).toBe(0);
    expect(existsSync(`${legacyPath}.migrated`)).toBe(true);
    db.close();
  });

  test("no legacy file present: import is a no-op, store stays cold", () => {
    const dbPath = join(dir, "state.db");
    const db = openStateDb(dbPath, "cli");
    expect(createCursorStore(db).get("repo-a")).toBeUndefined();
    db.close();
  });
});
