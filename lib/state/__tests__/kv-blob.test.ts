/**
 * lib/state/kv-blob.ts — generic whole-value JSON accessor over `kv`.
 *
 * HOME isolation is handled by the repo-wide bun test preload
 * (test-setup.ts) — never removed here. Stores are constructed via
 * openStateDb(tempPath) per the house convention.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openStateDb } from "../db.ts";
import { deleteKvValue, getKvValue, listKvValues, setKvValue } from "../kv-blob.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rt-kv-blob-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function openDb(): Database {
  return openStateDb(join(dir, "state.db"), "cli");
}

interface FakeBlob { count: number; tags: string[] }

describe("getKvValue / setKvValue", () => {
  test("missing row is cold-start: returns the caller's fallback", () => {
    const db = openDb();
    const fallback: FakeBlob = { count: 0, tags: [] };
    expect(getKvValue("worktree-reactor", "state", fallback, db)).toEqual(fallback);
  });

  test("set persists and get round-trips", () => {
    const db = openDb();
    setKvValue("worktree-reactor", "state", { count: 3, tags: ["a"] }, db);
    expect(getKvValue<FakeBlob>("worktree-reactor", "state", { count: 0, tags: [] }, db)).toEqual({ count: 3, tags: ["a"] });
  });

  test("set overwrites the prior value for the same ns+key", () => {
    const db = openDb();
    setKvValue("sdm-scan-cache", "state", { count: 1, tags: [] }, db);
    setKvValue("sdm-scan-cache", "state", { count: 2, tags: ["b"] }, db);
    expect(getKvValue<FakeBlob>("sdm-scan-cache", "state", { count: 0, tags: [] }, db)).toEqual({ count: 2, tags: ["b"] });
  });

  test("different namespaces do not collide even with the same key", () => {
    const db = openDb();
    setKvValue("home-snapshot", "state", { count: 1, tags: [] }, db);
    setKvValue("sdm-state", "state", { count: 2, tags: [] }, db);
    expect(getKvValue<FakeBlob>("home-snapshot", "state", { count: 0, tags: [] }, db).count).toBe(1);
    expect(getKvValue<FakeBlob>("sdm-state", "state", { count: 0, tags: [] }, db).count).toBe(2);
  });

  test("a row whose stored JSON is corrupt reads as the fallback, not a throw", () => {
    const db = openDb();
    db.query("INSERT INTO kv (ns, k, v, updated_at) VALUES ('intercepts', 'rules', '{not json', 0);").run();
    const fallback: FakeBlob = { count: -1, tags: [] };
    expect(getKvValue("intercepts", "rules", fallback, db)).toEqual(fallback);
  });

  test("onCorrupt fires for a present-but-unparseable row", () => {
    const db = openDb();
    db.query("INSERT INTO kv (ns, k, v, updated_at) VALUES ('intercepts', 'rules', '{not json', 0);").run();
    let seen: unknown;
    getKvValue("intercepts", "rules", { count: -1, tags: [] }, db, (err) => { seen = err; });
    expect(seen).toBeDefined();
  });

  test("onCorrupt does NOT fire for a missing row", () => {
    const db = openDb();
    let called = false;
    getKvValue("intercepts", "never-written", { count: -1, tags: [] }, db, () => { called = true; });
    expect(called).toBe(false);
  });

  test("a fresh handle on the same file sees the last write (daemon restart)", () => {
    const dbPath = join(dir, "state.db");
    const db1 = openStateDb(dbPath, "cli");
    setKvValue("repo-index", "repo-a", "/path/to/repo-a", db1);
    db1.close();

    const db2 = openStateDb(dbPath, "cli");
    expect(getKvValue<string>("repo-index", "repo-a", "", db2)).toBe("/path/to/repo-a");
    db2.close();
  });
});

describe("deleteKvValue", () => {
  test("removes the row; a later get falls back", () => {
    const db = openDb();
    setKvValue("worktrees", "repo-a", ["main"], db);
    deleteKvValue("worktrees", "repo-a", db);
    expect(getKvValue<string[]>("worktrees", "repo-a", [], db)).toEqual([]);
  });

  test("deleting a key that was never set is a no-op, not an error", () => {
    const db = openDb();
    expect(() => deleteKvValue("worktrees", "never-set", db)).not.toThrow();
  });
});

describe("listKvValues", () => {
  test("returns every row in the namespace, keyed by k", () => {
    const db = openDb();
    setKvValue("repo-index", "repo-a", "/path/a", db);
    setKvValue("repo-index", "repo-b", "/path/b", db);
    setKvValue("worktrees", "repo-a", ["unrelated-ns"], db);
    expect(listKvValues<string>("repo-index", db)).toEqual({
      "repo-a": "/path/a",
      "repo-b": "/path/b",
    });
  });

  test("an empty namespace returns an empty object", () => {
    const db = openDb();
    expect(listKvValues("repo-index", db)).toEqual({});
  });

  test("a corrupt row is skipped, sibling rows in the same namespace still come back", () => {
    const db = openDb();
    setKvValue("repo-index", "repo-a", "/path/a", db);
    db.query("INSERT INTO kv (ns, k, v, updated_at) VALUES ('repo-index', 'repo-broken', '{not json', 0);").run();
    expect(listKvValues<string>("repo-index", db)).toEqual({ "repo-a": "/path/a" });
  });
});
