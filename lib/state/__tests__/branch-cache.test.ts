/**
 * lib/state/branch-cache.ts — the single-owner branch-cache store.
 * See docs/superpowers/specs/2026-08-20-rt-statedb.md ("Tables (v1)"
 * branch_cache, "Store-by-store" item 1, "New: branch-cache GC").
 *
 * HOME isolation is handled by the repo-wide bun test preload
 * (test-setup.ts) — never removed here. Stores are constructed via
 * openStateDb(tempPath) per the spec's test convention.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openStateDb } from "../db.ts";
import { getBranchCacheStore, type CacheEntry } from "../branch-cache.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rt-branch-cache-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeEntry(overrides: Partial<CacheEntry> = {}): CacheEntry {
  return {
    ticket: null,
    linearId: "",
    mr: null,
    fetchedAt: Date.now(),
    ...overrides,
  };
}

function rowCount(db: Database, branch: string): number {
  const { n } = db.query("SELECT COUNT(*) as n FROM branch_cache WHERE branch = ?;").get(branch) as { n: number };
  return n;
}

describe("legacy import", () => {
  test("imports branch-cache.json rows, preserving bare branch key and repo NULL when absent", () => {
    const dbPath = join(dir, "state.db");
    const legacyPath = join(dir, "branch-cache.json");
    writeFileSync(
      legacyPath,
      JSON.stringify({
        entries: {
          "feature/with-repo": {
            ticket: { id: "1", identifier: "RT-1", title: "t", description: null, url: "u", stateName: null, stateColor: null, branchName: null },
            linearId: "RT-1",
            mr: null,
            fetchedAt: 1000,
            repoName: "repo-tools",
          },
          "feature/no-repo": {
            ticket: null,
            linearId: "",
            mr: null,
            fetchedAt: 2000,
          },
        },
      }),
    );

    const db = openStateDb(dbPath, "cli");
    const store = getBranchCacheStore(db);

    expect(store.entries["feature/with-repo"]?.repoName).toBe("repo-tools");
    expect(store.entries["feature/with-repo"]?.ticket?.identifier).toBe("RT-1");
    expect(store.entries["feature/no-repo"]?.repoName).toBeUndefined();
    expect(store.entries["feature/no-repo"]?.fetchedAt).toBe(2000);

    const row = db.query("SELECT repo FROM branch_cache WHERE branch = ?;").get("feature/no-repo") as { repo: string | null };
    expect(row.repo).toBeNull();

    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(`${legacyPath}.migrated`)).toBe(true);
    db.close();
  });

  test("drops legacy discussions / discussionsFetchedAt fields at import — never written anywhere", () => {
    const dbPath = join(dir, "state.db");
    const legacyPath = join(dir, "branch-cache.json");
    writeFileSync(
      legacyPath,
      JSON.stringify({
        entries: {
          "feature/legacy-discussions": {
            ticket: null,
            linearId: "",
            mr: null,
            fetchedAt: 3000,
            discussions: [{ id: "d1", notes: [] }],
            discussionsFetchedAt: 3000,
          },
        },
      }),
    );

    const db = openStateDb(dbPath, "cli");

    // The column doesn't exist at all — this is the strongest possible
    // assertion that the legacy field was never written anywhere.
    const columns = (db.query("PRAGMA table_info(branch_cache);").all() as { name: string }[]).map(c => c.name);
    expect(columns).not.toContain("discussions");
    expect(columns).not.toContain("discussionsFetchedAt");

    const store = getBranchCacheStore(db);
    const entry = store.entries["feature/legacy-discussions"] as CacheEntry & { discussions?: unknown; discussionsFetchedAt?: unknown };
    expect(entry).toBeDefined();
    // RT-48 task 5 removed `discussions`/`discussionsFetchedAt` from the
    // CacheEntry type itself (their last readers, discussions-file-store.ts's
    // seed function, are gone) — the cast above is only so this legacy-JSON
    // fixture (which still carries the fields) type-checks; the entry the
    // import actually produced never had them to begin with.
    expect(entry.discussions).toBeUndefined();
    expect(entry.discussionsFetchedAt).toBeUndefined();
    db.close();
  });

  test("a repo-tools dir with no branch-cache.json imports nothing and creates no rows", () => {
    const dbPath = join(dir, "state.db");
    const db = openStateDb(dbPath, "cli");
    const store = getBranchCacheStore(db);
    expect(Object.keys(store.entries)).toEqual([]);
    db.close();
  });
});

describe("two handles, per-row last-writer-wins", () => {
  test("interleaved upserts to different branches both survive", () => {
    const dbPath = join(dir, "state.db");
    const dbA = openStateDb(dbPath, "cli");
    const dbB = openStateDb(dbPath, "cli");
    const storeA = getBranchCacheStore(dbA);
    const storeB = getBranchCacheStore(dbB);

    storeA.put("branch-a", makeEntry({ linearId: "A" }));
    storeB.put("branch-b", makeEntry({ linearId: "B" }));

    storeA.reload();
    expect(storeA.entries["branch-a"]?.linearId).toBe("A");
    expect(storeA.entries["branch-b"]?.linearId).toBe("B");

    dbA.close();
    dbB.close();
  });

  test("same branch written by both handles: the db row reflects the last write", () => {
    const dbPath = join(dir, "state.db");
    const dbA = openStateDb(dbPath, "cli");
    const dbB = openStateDb(dbPath, "cli");
    const storeA = getBranchCacheStore(dbA);
    const storeB = getBranchCacheStore(dbB);

    storeA.put("branch-z", makeEntry({ linearId: "first", fetchedAt: 100 }));
    storeB.put("branch-z", makeEntry({ linearId: "second", fetchedAt: 200 }));

    storeA.reload();
    expect(storeA.entries["branch-z"]?.linearId).toBe("second");
    expect(storeA.entries["branch-z"]?.fetchedAt).toBe(200);
    expect(rowCount(dbA, "branch-z")).toBe(1);

    dbA.close();
    dbB.close();
  });
});

describe("bare-branch upsert semantics", () => {
  test("a no-repoName upsert hits the same row a repoName-bearing write created (no NULL duplicate)", () => {
    const dbPath = join(dir, "state.db");
    const db = openStateDb(dbPath, "cli");
    const store = getBranchCacheStore(db);

    store.put("feature/x", makeEntry({ repoName: "repo-tools", linearId: "first" }));
    expect(rowCount(db, "feature/x")).toBe(1);

    // enrichBranches-style upsert: same bare branch, no repoName available.
    store.put("feature/x", makeEntry({ linearId: "second" }));

    expect(rowCount(db, "feature/x")).toBe(1);
    expect(store.entries["feature/x"]?.linearId).toBe("second");
    db.close();
  });

  test("delete removes the row and the map entry", () => {
    const dbPath = join(dir, "state.db");
    const db = openStateDb(dbPath, "cli");
    const store = getBranchCacheStore(db);

    store.put("feature/y", makeEntry());
    store.delete("feature/y");

    expect(store.entries["feature/y"]).toBeUndefined();
    expect(rowCount(db, "feature/y")).toBe(0);
    db.close();
  });
});

describe("gc — succeeded-repo gating and NULL-repo age rule", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const oldTs = Date.now() - 40 * DAY_MS; // older than the spec's 30-day constant
  const freshTs = Date.now();

  test("prunes a repo's stale rows only when that repo is in succeededRepos", () => {
    const dbPath = join(dir, "state.db");
    const db = openStateDb(dbPath, "cli");
    const store = getBranchCacheStore(db);

    store.put("stale-succeeded", makeEntry({ repoName: "repo-a", fetchedAt: oldTs }));
    store.put("stale-failed", makeEntry({ repoName: "repo-b", fetchedAt: oldTs }));

    store.gc(new Set(["repo-a"]), 30 * DAY_MS);

    expect(store.entries["stale-succeeded"]).toBeUndefined();
    expect(rowCount(db, "stale-succeeded")).toBe(0);

    // repo-b had a swallowed fetch error this cycle (never made it into
    // succeededRepos) — its stale rows must survive (r2 finding 1).
    expect(store.entries["stale-failed"]).toBeDefined();
    expect(rowCount(db, "stale-failed")).toBe(1);
    db.close();
  });

  test("NULL-repo rows are pruned by age alone, regardless of succeededRepos", () => {
    const dbPath = join(dir, "state.db");
    const db = openStateDb(dbPath, "cli");
    const store = getBranchCacheStore(db);

    store.put("stale-no-repo", makeEntry({ fetchedAt: oldTs }));

    store.gc(new Set(), 30 * DAY_MS);

    expect(store.entries["stale-no-repo"]).toBeUndefined();
    expect(rowCount(db, "stale-no-repo")).toBe(0);
    db.close();
  });

  test("rows younger than maxAgeMs survive even for a succeeded repo", () => {
    const dbPath = join(dir, "state.db");
    const db = openStateDb(dbPath, "cli");
    const store = getBranchCacheStore(db);

    store.put("fresh-succeeded", makeEntry({ repoName: "repo-a", fetchedAt: freshTs }));

    store.gc(new Set(["repo-a"]), 30 * DAY_MS);

    expect(store.entries["fresh-succeeded"]).toBeDefined();
    expect(rowCount(db, "fresh-succeeded")).toBe(1);
    db.close();
  });

  test("gc affects both rows and the in-memory map together, atomically observable", () => {
    const dbPath = join(dir, "state.db");
    const db = openStateDb(dbPath, "cli");
    const store = getBranchCacheStore(db);

    store.put("a1", makeEntry({ repoName: "repo-a", fetchedAt: oldTs }));
    store.put("a2", makeEntry({ repoName: "repo-a", fetchedAt: oldTs }));
    store.put("keep", makeEntry({ repoName: "repo-a", fetchedAt: freshTs }));

    store.gc(new Set(["repo-a"]), 30 * DAY_MS);

    expect(Object.keys(store.entries).sort()).toEqual(["keep"]);
    const remaining = db.query("SELECT branch FROM branch_cache;").all() as { branch: string }[];
    expect(remaining.map(r => r.branch).sort()).toEqual(["keep"]);
    db.close();
  });
});

describe("daemon-flavor busy handling", () => {
  /**
   * Spec test 12, on the branch-cache path (RT-48 Task 8; Task 4 shipped the
   * same guarantee for project-mrs and Task 5 for discussions). A held write
   * lock past the connection's busy_timeout must warn and defer, never
   * throw, and never leave rows and the in-memory map disagreeing.
   */
  function holdWriteLock(dbPath: string): { release: () => void } {
    const blocker = new Database(dbPath);
    blocker.exec("PRAGMA busy_timeout = 0;");
    blocker.exec("BEGIN IMMEDIATE;");
    return {
      release: () => { blocker.exec("ROLLBACK;"); blocker.close(); },
    };
  }

  test("put() defers instead of throwing; the in-memory map still takes the write", () => {
    const dbPath = join(dir, "state.db");
    const db = openStateDb(dbPath, "daemon"); // 250ms busy_timeout
    const store = getBranchCacheStore(db);
    const lock = holdWriteLock(dbPath);
    try {
      expect(() => store.put("busy-branch", makeEntry({ repoName: "repo-a" }))).not.toThrow();
      // The map is the daemon's read model (spec "In-memory ownership") —
      // it must carry the enrichment even when the row could not.
      expect(store.entries["busy-branch"]).toBeDefined();
    } finally {
      lock.release();
    }
    db.close();
  }, 10_000);

  test("gc() defers as a unit: neither rows nor the map are evicted when the write is blocked", () => {
    const dbPath = join(dir, "state.db");
    const db = openStateDb(dbPath, "daemon");
    const store = getBranchCacheStore(db);
    store.put("stale-busy", makeEntry({ repoName: "repo-a", fetchedAt: Date.now() - 40 * 24 * 60 * 60 * 1000 }));

    const lock = holdWriteLock(dbPath);
    try {
      expect(() => store.gc(new Set(["repo-a"]), 30 * 24 * 60 * 60 * 1000)).not.toThrow();
      // Rows survived, so the map must too — otherwise the next reload()
      // would resurrect an entry the map had already dropped.
      expect(store.entries["stale-busy"]).toBeDefined();
    } finally {
      lock.release();
    }
    expect(rowCount(db, "stale-busy")).toBe(1);
    db.close();
  }, 10_000);

  test("delete() defers as a unit rather than throwing", () => {
    const dbPath = join(dir, "state.db");
    const db = openStateDb(dbPath, "daemon");
    const store = getBranchCacheStore(db);
    store.put("doomed", makeEntry({ repoName: "repo-a" }));

    const lock = holdWriteLock(dbPath);
    try {
      expect(() => store.delete("doomed")).not.toThrow();
      expect(store.entries["doomed"]).toBeDefined();
    } finally {
      lock.release();
    }
    expect(rowCount(db, "doomed")).toBe(1);
    db.close();
  }, 10_000);
});

describe("getBranchCacheStore — singleton behavior", () => {
  test("the same db handle returns the same store object", () => {
    const dbPath = join(dir, "state.db");
    const db = openStateDb(dbPath, "cli");
    const s1 = getBranchCacheStore(db);
    const s2 = getBranchCacheStore(db);
    expect(s1).toBe(s2);
    db.close();
  });

  test("a different db handle returns a distinct store bound to that handle", () => {
    const dbPathA = join(dir, "a", "state.db");
    const dbPathB = join(dir, "b", "state.db");
    const dbA = openStateDb(dbPathA, "cli");
    const dbB = openStateDb(dbPathB, "cli");
    const sA = getBranchCacheStore(dbA);
    const sB = getBranchCacheStore(dbB);
    expect(sA).not.toBe(sB);

    sA.put("only-in-a", makeEntry());
    expect(sB.entries["only-in-a"]).toBeUndefined();

    dbA.close();
    dbB.close();
  });
});
