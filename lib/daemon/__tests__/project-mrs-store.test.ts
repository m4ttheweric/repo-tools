/**
 * lib/daemon/project-mrs-store.ts behavioral suite, migrated to the
 * openStateDb(tempPath) seam (RT-48 Task 4). Every test opens its own fresh
 * temp-dir db — no cross-test sharing, matching the old fresh-tmpfile-per-
 * test isolation. HOME isolation is handled by the repo-wide bun test
 * preload (test-setup.ts) — never removed here.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  createProjectMRs, freshnessOf,
  rekeyProjectMrDemandsTable, rekeyProjectMrsMetaTable, rekeyProjectMrsTable,
} from "../project-mrs-store.ts";
import { closeStateDb, getStateDb, openStateDb, SCHEMA_VERSION } from "../../state/index.ts";
import type { PullRequest } from "@mattstack/glance";

function tmpDb(): Database {
  const dir = mkdtempSync(join(tmpdir(), "rt-pmrs-"));
  return openStateDb(join(dir, "state.db"), "cli");
}

function tmpStore() {
  return createProjectMRs(tmpDb());
}

/** Minimal PullRequest-shaped object; the store treats prs as opaque JSON. */
function pr(iid: number, over: Partial<PullRequest> = {}): PullRequest {
  return {
    id: `gitlab:mr:${iid}`, iid, title: `MR ${iid}`, state: "opened",
    sourceBranch: `feat-${iid}`, targetBranch: "main",
    webUrl: `https://gitlab.example/g/p/-/merge_requests/${iid}`,
    divergedCommitsCount: null,
    ...over,
  } as unknown as PullRequest;
}

describe("upsert", () => {
  test("no record + null projectPath → no-op", () => {
    const s = tmpStore();
    expect(s.upsert("repo", null, pr(1), "mutation")).toEqual([]);
    expect(s.read("repo")).toBeUndefined();
  });

  test("writes entry, returns changed iid, keeps terminal states", () => {
    const s = tmpStore();
    s.fullSync("repo", "g/p", [pr(1)], Date.now());
    expect(s.upsert("repo", null, pr(2, { state: "merged" } as any), "events")).toEqual([2]);
    expect(s.read("repo")!.mrs[2]!.pr.state).toBe("merged");
    expect(s.read("repo")!.source).toBe("events");
  });

  // upsert replaces the entry wholesale, same as applyDelta -- an
  // events-path upsert of a tagged MR must carry the tag forward or it
  // desyncs from the SQL project_mr_sections row.
  test("preserves an existing codeownerSections tag on the replacement entry", () => {
    const s = tmpStore();
    s.fullSync("repo", "g/p", [pr(1)], Date.now() - 10_000);
    s.setSectionTags("repo", { 1: ["Acme"] });
    s.upsert("repo", null, pr(1, { title: "updated" } as any), "events");
    expect(s.read("repo")!.mrs[1]!.pr.title).toBe("updated");
    expect(s.read("repo")!.mrs[1]!.codeownerSections).toEqual(["Acme"]);
  });
});

describe("fullSync reconcile", () => {
  test("replaces stale entries and prunes stale absentees", () => {
    const s = tmpStore();
    const t0 = Date.now() - 10_000;
    s.fullSync("repo", "g/p", [pr(1), pr(2)], t0);
    const changed = s.fullSync("repo", "g/p", [pr(1, { title: "updated" } as any)], Date.now() - 1000);
    expect(changed).toContain(1);
    expect(changed).toContain(2);            // pruned counts as changed
    expect(s.read("repo")!.mrs[1]!.pr.title).toBe("updated");
    expect(s.read("repo")!.mrs[2]).toBeUndefined();
  });

  test("concurrent upsert survives: entry with fetchedAt > syncStartedAt is kept", () => {
    const s = tmpStore();
    const syncStartedAt = Date.now() - 5000;
    s.fullSync("repo", "g/p", [pr(1)], syncStartedAt - 1);
    s.upsert("repo", null, pr(1, { state: "merged" } as any), "mutation"); // fetchedAt = now > syncStartedAt
    s.fullSync("repo", "g/p", [pr(1)], syncStartedAt);                     // stale sync result says opened
    expect(s.read("repo")!.mrs[1]!.pr.state).toBe("merged");               // mutation won
  });

  // Spec test 6: an upsert with fetchedAt newer than syncStartedAt survives
  // a concurrent fullSync PRUNE (not just a stale-value overwrite) — the
  // prune loop's own fetchedAt guard, now exercised inside the one-txn-per-
  // repo fullSync design.
  test("[spec test 6] mid-sync upsert of a NEW mr survives the same fullSync's prune pass", () => {
    const s = tmpStore();
    const syncStartedAt = Date.now() - 5000;
    s.fullSync("repo", "g/p", [pr(1)], syncStartedAt - 1);
    s.upsert("repo", null, pr(9), "events"); // arrives after the sync started, absent from its result set
    const changed = s.fullSync("repo", "g/p", [pr(1)], syncStartedAt); // sync result predates the upsert
    expect(s.read("repo")!.mrs[9]).toBeDefined();  // survives the prune pass
    expect(s.read("repo")!.mrs[1]).toBeDefined();
    expect(changed).not.toContain(9);              // never touched by this sync — not pruned, not "changed"
  });

  test("mid-sync-created entry survives pruning", () => {
    const s = tmpStore();
    const syncStartedAt = Date.now() - 5000;
    s.fullSync("repo", "g/p", [], syncStartedAt - 1);
    s.upsert("repo", null, pr(9), "events"); // arrives after record exists... see note below
    s.fullSync("repo", "g/p", [], syncStartedAt); // sync result predates the event
    expect(s.read("repo")!.mrs[9]).toBeDefined();
  });

  test("null diverged in sync preserves an existing non-null value", () => {
    const s = tmpStore();
    s.fullSync("repo", "g/p", [pr(1)], Date.now() - 10_000);
    s.upsert("repo", null, pr(1, { divergedCommitsCount: 3 } as any), "events");
    s.fullSync("repo", "g/p", [pr(1, { divergedCommitsCount: null } as any)], Date.now());
    expect((s.read("repo")!.mrs[1]!.pr as any).divergedCommitsCount).toBe(3);
  });

  test("listSyncedAt records the sync START time", () => {
    const s = tmpStore();
    const started = Date.now() - 1234;
    s.fullSync("repo", "g/p", [pr(1)], started);
    expect(s.read("repo")!.listSyncedAt).toBe(started);
  });
});

describe("findBySourceBranch / persistence", () => {
  test("findBySourceBranch matches any stored state", () => {
    const s = tmpStore();
    s.fullSync("repo", "g/p", [pr(1), pr(2, { state: "merged", sourceBranch: "feat-2" } as any)], Date.now());
    expect(s.findBySourceBranch("repo", "feat-1")!.iid).toBe(1);
    expect(s.findBySourceBranch("repo", "feat-2")!.iid).toBe(2);
    expect(s.findBySourceBranch("repo", "nope")).toBeNull();
  });

  test("findBySourceBranch prefers an open match over a lower-iid terminal one (branch reuse)", () => {
    const s = tmpStore();
    s.fullSync("repo", "g/p", [pr(1, { state: "merged", sourceBranch: "reused" } as any)], Date.now());
    expect(s.findBySourceBranch("repo", "reused")!.iid).toBe(1);   // only the merged one exists so far
    s.upsert("repo", "g/p", pr(99, { state: "opened", sourceBranch: "reused" } as any), "events");
    expect(s.findBySourceBranch("repo", "reused")!.iid).toBe(99);  // open wins even though it's the higher iid
  });

  test("findBySourceBranch with no open entry falls back to the newest terminal one", () => {
    const s = tmpStore();
    s.fullSync("repo", "g/p", [
      pr(1, { state: "merged", sourceBranch: "reused-2" } as any),
      pr(5, { state: "closed", sourceBranch: "reused-2" } as any),
    ], Date.now());
    expect(s.findBySourceBranch("repo", "reused-2")!.iid).toBe(5);  // newest terminal, not lowest iid
  });

  test("reads as empty when the db is fresh (no legacy file, no prior writes)", () => {
    const s = tmpStore();
    expect(s.read("repo")).toBeUndefined();
  });

  test("writes are immediate: a second store opened on the same db path sees them without any flush call", () => {
    const dir = mkdtempSync(join(tmpdir(), "rt-pmrs-"));
    const dbPath = join(dir, "state.db");
    const dbA = openStateDb(dbPath, "cli");
    const s = createProjectMRs(dbA);
    s.fullSync("repo", "g/p", [pr(1)], Date.now());

    const dbB = openStateDb(dbPath, "cli");
    const reloaded = createProjectMRs(dbB);
    expect(reloaded.read("repo")!.mrs[1]!.pr.iid).toBe(1);
    dbA.close();
    dbB.close();
  });
});

describe("applyDelta", () => {
  test("upserts every incoming pr, including terminal states", () => {
    const s = tmpStore();
    s.fullSync("repo", "g/p", [pr(1), pr(2)], Date.now() - 10_000);
    const deltaStartedAt = Date.now();
    const changed = s.applyDelta("repo", "g/p", [
      pr(1, { title: "updated in delta" } as any),
      pr(3, { state: "merged" } as any),
    ], deltaStartedAt);
    expect(changed.sort()).toEqual([1, 3]);
    expect(s.read("repo")!.mrs[1]!.pr.title).toBe("updated in delta");
    expect(s.read("repo")!.mrs[2]).toBeDefined(); // absent from delta → untouched, not pruned
    expect(s.read("repo")!.mrs[3]!.pr.state).toBe("merged");
  });

  test("creates the record when missing, source defaults to poll", () => {
    const s = tmpStore();
    const deltaStartedAt = Date.now();
    s.applyDelta("repo", "g/p", [pr(1)], deltaStartedAt);
    const record = s.read("repo")!;
    expect(record.projectPath).toBe("g/p");
    expect(record.source).toBe("poll");
    expect(record.deltaSyncedAt).toBe(deltaStartedAt);
  });

  test("leaves source untouched when the record already exists", () => {
    const s = tmpStore();
    s.fullSync("repo", "g/p", [pr(1)], Date.now() - 10_000);
    s.upsert("repo", null, pr(2), "events"); // source → "events"
    expect(s.read("repo")!.source).toBe("events");
    s.applyDelta("repo", "g/p", [pr(1)], Date.now());
    expect(s.read("repo")!.source).toBe("events"); // applyDelta does not touch source
  });

  test("bumps deltaSyncedAt, not listSyncedAt", () => {
    const s = tmpStore();
    const listSyncedAt = Date.now() - 60_000;
    s.fullSync("repo", "g/p", [pr(1)], listSyncedAt);
    const deltaStartedAt = Date.now();
    s.applyDelta("repo", "g/p", [pr(1)], deltaStartedAt);
    const record = s.read("repo")!;
    expect(record.listSyncedAt).toBe(listSyncedAt);
    expect(record.deltaSyncedAt).toBe(deltaStartedAt);
  });

  test("entry fetchedAt is 'now', not deltaStartedAt", () => {
    const s = tmpStore();
    const deltaStartedAt = Date.now() - 5000; // fetch took a while
    s.applyDelta("repo", "g/p", [pr(1)], deltaStartedAt);
    expect(s.read("repo")!.mrs[1]!.fetchedAt).toBeGreaterThan(deltaStartedAt);
  });
});

describe("freshnessOf", () => {
  test("is the max of listSyncedAt and deltaSyncedAt", () => {
    const s = tmpStore();
    const listSyncedAt = Date.now() - 60_000;
    s.fullSync("repo", "g/p", [pr(1)], listSyncedAt);
    expect(freshnessOf(s.read("repo")!)).toBe(listSyncedAt);

    const deltaStartedAt = Date.now();
    s.applyDelta("repo", "g/p", [pr(1)], deltaStartedAt);
    expect(freshnessOf(s.read("repo")!)).toBe(deltaStartedAt);
  });

  test("defaults to listSyncedAt when deltaSyncedAt is unset", () => {
    const s = tmpStore();
    const listSyncedAt = Date.now() - 1000;
    s.fullSync("repo", "g/p", [pr(1)], listSyncedAt);
    expect(freshnessOf(s.read("repo")!)).toBe(listSyncedAt);
  });
});

describe("applyDelta guards (review fixes)", () => {
  test("delta preserves an event-fed diverged count when incoming is null", () => {
    const s = tmpStore();
    s.fullSync("repo", "g/p", [pr(1)], Date.now() - 10_000);
    s.upsert("repo", null, pr(1, { divergedCommitsCount: 4 } as any), "events");
    s.applyDelta("repo", "g/p", [pr(1, { divergedCommitsCount: null } as any)], Date.now() - 1000);
    expect((s.read("repo")!.mrs[1]!.pr as any).divergedCommitsCount).toBe(4);
  });

  test("delta never clobbers an entry written after the delta fetch began", () => {
    const s = tmpStore();
    const deltaStartedAt = Date.now() - 5000;
    s.fullSync("repo", "g/p", [pr(1)], deltaStartedAt - 1);
    s.upsert("repo", null, pr(1, { state: "merged" } as any), "mutation"); // fetchedAt = now > deltaStartedAt
    const changed = s.applyDelta("repo", "g/p", [pr(1)], deltaStartedAt);   // stale window says opened
    expect(s.read("repo")!.mrs[1]!.pr.state).toBe("merged");
    expect(changed).toEqual([]);
  });

  // applyDelta replaces entries wholesale, so a tag on the entry must be
  // carried forward the same way divergedCommitsCount already is -- else its
  // SQL project_mr_sections row would outlive the in-memory tag.
  test("delta preserves an existing codeownerSections tag on the replacement entry", () => {
    const s = tmpStore();
    s.fullSync("repo", "g/p", [pr(1)], Date.now() - 10_000);
    s.setSectionTags("repo", { 1: ["Acme"] });
    s.applyDelta("repo", "g/p", [pr(1, { title: "updated" } as any)], Date.now());
    expect(s.read("repo")!.mrs[1]!.pr.title).toBe("updated");
    expect(s.read("repo")!.mrs[1]!.codeownerSections).toEqual(["Acme"]);
  });
});

describe("demand registry", () => {
  test("registerDemand creates a shell record and stores the demand", () => {
    const s = tmpStore();
    expect(s.registerDemand("r", "mr-board:5980", ["alice", "bob"], 100)).toBe(true);
    expect(s.read("r")!.demands!["mr-board:5980"]).toMatchObject({ authors: ["alice", "bob"], declaredAt: 100 });
  });

  test("wholesale replace: newer declaredAt swaps the list entirely", () => {
    const s = tmpStore();
    s.registerDemand("r", "c1", ["alice", "bob"], 100);
    expect(s.registerDemand("r", "c1", ["carol"], 200)).toBe(true);
    expect(s.read("r")!.demands!.c1!.authors).toEqual(["carol"]);
  });

  test("monotonic guard: stale declaredAt is ignored", () => {
    const s = tmpStore();
    s.registerDemand("r", "c1", ["new"], 200);
    expect(s.registerDemand("r", "c1", ["old"], 100)).toBe(false);
    expect(s.read("r")!.demands!.c1!.authors).toEqual(["new"]);
  });

  test("identical re-declaration refreshes lastSeenAt but reports no change", () => {
    const s = tmpStore();
    s.registerDemand("r", "c1", ["alice"], 100);
    const before = s.read("r")!.demands!.c1!.lastSeenAt;
    expect(s.registerDemand("r", "c1", ["alice"], 150)).toBe(false);
    expect(s.read("r")!.demands!.c1!.lastSeenAt).toBeGreaterThanOrEqual(before);
    expect(s.read("r")!.demands!.c1!.declaredAt).toBe(150);
  });

  test("expireDemands drops idle clients and reports them", () => {
    const s = tmpStore();
    s.registerDemand("r", "live-client", ["alice"], Date.now());
    s.read("r")!.demands!["dead-client"] = { authors: ["bob"], declaredAt: 1, lastSeenAt: 1 };
    expect(s.expireDemands("r", 7 * 86_400_000)).toEqual(["dead-client"]);
    expect(s.read("r")!.demands!["live-client"]).toBeDefined();
  });

  test("fullSync on a shell record adopts the real projectPath", () => {
    const s = tmpStore();
    s.registerDemand("r", "c1", ["alice"], 100);
    s.fullSync("r", "g/p", [], Date.now());
    expect(s.read("r")!.projectPath).toBe("g/p");
  });
});

describe("scope", () => {
  test("setScope stores authors and windowDays", () => {
    const s = tmpStore();
    s.fullSync("r", "g/p", [], Date.now());
    s.setScope("r", { authors: ["bob", "alice"], windowDays: 30 });
    expect(s.read("r")!.scope).toEqual({ authors: ["bob", "alice"], windowDays: 30 });
  });

  test("setScope(repoName, null) clears an existing scope", () => {
    const s = tmpStore();
    s.fullSync("r", "g/p", [], Date.now());
    s.setScope("r", { authors: ["alice"], windowDays: 30 });
    s.setScope("r", null);
    expect(s.read("r")!.scope).toBeUndefined();
  });

  test("setScope on a repo with no record is a no-op either way", () => {
    const s = tmpStore();
    s.setScope("ghost", { authors: ["alice"], windowDays: 30 });
    s.setScope("ghost", null);
    expect(s.read("ghost")).toBeUndefined();
  });
});

describe("section tags", () => {
  test("setSectionTags tags, replaces, and clears per iid", () => {
    const store = tmpStore();
    store.fullSync("r", "g/p", [pr(1), pr(2)], 1000);
    store.setSectionTags("r", { 1: ["Acme"] });
    expect(store.read("r")!.mrs[1]!.codeownerSections).toEqual(["Acme"]);
    expect(store.read("r")!.mrs[2]!.codeownerSections).toBeUndefined();
    store.setSectionTags("r", { 1: [] });
    expect(store.read("r")!.mrs[1]!.codeownerSections).toBeUndefined();
  });

  test("setSectionTags replaceAll clears tags the map does not mention", () => {
    const store = tmpStore();
    store.fullSync("r", "g/p", [pr(1), pr(2)], 1000);
    store.setSectionTags("r", { 1: ["Acme"], 2: ["Beta"] });
    store.setSectionTags("r", { 2: ["Beta"] }, { replaceAll: true });
    expect(store.read("r")!.mrs[1]!.codeownerSections).toBeUndefined();
    expect(store.read("r")!.mrs[2]!.codeownerSections).toEqual(["Beta"]);
  });

  test("fullSync prune drops the pruned row's tag row too", () => {
    const db = tmpDb();
    const store = createProjectMRs(db);
    store.fullSync("r", "g/p", [pr(1)], 1000);
    store.setSectionTags("r", { 1: ["Acme"] });
    store.fullSync("r", "g/p", [], 2000);
    expect(store.read("r")!.mrs[1]).toBeUndefined();
    const rows = db.query("SELECT * FROM project_mr_sections WHERE repo = 'r';").all();
    expect(rows).toHaveLength(0);
  });

  test("registerDemand stores sections and scope round-trips them", () => {
    const store = tmpStore();
    store.registerDemand("r", "board:1", ["ada"], 5, ["Acme"]);
    expect(store.read("r")!.demands!["board:1"]!.sections).toEqual(["Acme"]);
    store.fullSync("r", "g/p", [], 1000);
    store.setScope("r", { authors: ["ada"], sections: ["Acme"], windowDays: 30 });
    expect(store.read("r")!.scope).toEqual({ authors: ["ada"], sections: ["Acme"], windowDays: 30 });
  });
});

describe("persistence — rows mirror the in-memory model", () => {
  test("fullSync writes are visible as project_mrs / project_mrs_meta rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "rt-pmrs-"));
    const db = openStateDb(join(dir, "state.db"), "cli");
    const s = createProjectMRs(db);
    const syncedAt = Date.now();
    s.fullSync("repo", "g/p", [pr(1), pr(2)], syncedAt);

    const mrRows = db.query("SELECT repo, iid, fetched_at FROM project_mrs WHERE repo = ? ORDER BY iid;").all("repo") as any[];
    expect(mrRows.map((r) => r.iid)).toEqual([1, 2]);
    expect(mrRows[0].fetched_at).toBe(syncedAt);

    const meta = db.query("SELECT project_path, list_synced_at, source FROM project_mrs_meta WHERE repo = ?;").get("repo") as any;
    expect(meta).toMatchObject({ project_path: "g/p", list_synced_at: syncedAt, source: "poll" });
    db.close();
  });

  test("fullSync prune deletes the row, not just the in-memory entry", () => {
    const dir = mkdtempSync(join(tmpdir(), "rt-pmrs-"));
    const db = openStateDb(join(dir, "state.db"), "cli");
    const s = createProjectMRs(db);
    s.fullSync("repo", "g/p", [pr(1), pr(2)], Date.now() - 10_000);
    s.fullSync("repo", "g/p", [pr(1)], Date.now());

    const rows = db.query("SELECT iid FROM project_mrs WHERE repo = ?;").all("repo") as any[];
    expect(rows.map((r) => r.iid)).toEqual([1]);
    db.close();
  });

  test("registerDemand and expireDemands mirror project_mr_demands rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "rt-pmrs-"));
    const db = openStateDb(join(dir, "state.db"), "cli");
    const s = createProjectMRs(db);
    s.registerDemand("repo", "client-1", ["alice"], 100);
    expect((db.query("SELECT client FROM project_mr_demands WHERE repo = ?;").all("repo") as any[]).map((r) => r.client)).toEqual(["client-1"]);

    s.expireDemands("repo", -1); // maxIdleMs negative → cutoff in the future → everything idle
    expect(db.query("SELECT client FROM project_mr_demands WHERE repo = ?;").all("repo")).toEqual([]);
    db.close();
  });
});

describe("daemon-flavor busy handling", () => {
  test("a write that hits SQLITE_BUSY past the daemon busy_timeout logs a warn and does not throw; in-memory state still updates", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rt-pmrs-busy-"));
    const dbPath = join(dir, "state.db");
    // Daemon flavor: 250ms busy_timeout (spec "The database").
    const db = openStateDb(dbPath, "daemon");
    const s = createProjectMRs(db);

    // A second connection holds the write lock (BEGIN IMMEDIATE, never
    // committed) for longer than the first connection's busy_timeout, so
    // the first connection's write is guaranteed to see SQLITE_BUSY.
    const blocker = new Database(dbPath);
    blocker.exec("PRAGMA busy_timeout = 0;");
    blocker.exec("BEGIN IMMEDIATE;");
    try {
      expect(() => s.fullSync("repo", "g/p", [pr(1)], Date.now())).not.toThrow();
      // The in-memory model is the source of truth regardless of whether
      // the row persisted (spec: "state converges next poll").
      expect(s.read("repo")!.mrs[1]).toBeDefined();
    } finally {
      blocker.exec("ROLLBACK;");
      blocker.close();
    }

    db.close();
  }, 10_000);
});

describe("legacy import (project-mrs.json)", () => {
  test("a non-numeric mrs key is skipped; the rest of the file still imports and the file is renamed", () => {
    // A key that Number() turns into NaN would bind NULL into
    // project_mrs.iid (NOT NULL) and throw inside the v0->v1 BEGIN IMMEDIATE
    // transaction — rolling back the WHOLE migration and leaving the source
    // file in place, so every later rt command retries and fails identically.
    // Spec policy for bad legacy input is "corrupt = warn + skip".
    const dir = mkdtempSync(join(tmpdir(), "rt-pmrs-legacy-"));
    const dbPath = join(dir, "state.db");
    const legacyPath = join(dir, "project-mrs.json");
    writeFileSync(
      legacyPath,
      JSON.stringify({
        "repo-tools": {
          projectPath: "g/p",
          listSyncedAt: 111,
          deltaSyncedAt: 222,
          source: "poll",
          mrs: {
            "7": { pr: pr(7), fetchedAt: 700 },
            "not-a-number": { pr: pr(8), fetchedAt: 800 },
            "9": { pr: pr(9), fetchedAt: 900 },
          },
          demands: { "mr-board": { authors: ["matt"], declaredAt: 1, lastSeenAt: 2 } },
        },
      }),
    );

    const db = openStateDb(dbPath, "cli");

    // Migration committed: SCHEMA_VERSION reached, source renamed, nothing rolled back.
    const { user_version } = db.query("PRAGMA user_version;").get() as { user_version: number };
    expect(user_version).toBe(SCHEMA_VERSION);
    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(`${legacyPath}.migrated`)).toBe(true);

    // The good rows landed; only the malformed entry was dropped.
    const s = createProjectMRs(db);
    const rec = s.read("repo-tools")!;
    expect(Object.keys(rec.mrs).sort()).toEqual(["7", "9"]);
    expect(rec.mrs[7]!.fetchedAt).toBe(700);
    expect(rec.mrs[9]!.pr.iid).toBe(9);
    expect(rec.projectPath).toBe("g/p");
    expect(rec.listSyncedAt).toBe(111);
    expect(rec.demands!["mr-board"]!.authors).toEqual(["matt"]);

    db.close();
  });
});

describe("rekeyProjectMrsTable / rekeyProjectMrsMetaTable / rekeyProjectMrDemandsTable", () => {
  const origHome = process.env.HOME;
  let home: string;
  let warnSpy: ReturnType<typeof spyOn<Console, "warn">>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "rt-pmrs-rekey-"));
    process.env.HOME = home;
    closeStateDb();
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    process.env.HOME = origHome;
    closeStateDb();
    rmSync(home, { recursive: true, force: true });
  });

  test("project_mrs and project_mrs_meta rows already keyed by a serialized identity are left untouched", async () => {
    const identity = "remote:gitlab.com%2Fg%2Fr";
    const store = createProjectMRs(getStateDb());
    store.fullSync(identity, "g/p", [pr(1)], Date.now());

    const mrReport = await rekeyProjectMrsTable();
    const metaReport = await rekeyProjectMrsMetaTable();
    expect(mrReport.migrated).toEqual([]);
    expect(metaReport.migrated).toEqual([]);
    // Read under the SAME identity — a re-key that silently moved the row
    // would make this read empty even though nothing was reported migrated.
    expect(store.read(identity)!.mrs[1]!.pr.iid).toBe(1);
  });

  test("a legacy-named project_mr_demands row with no repo-index entry is retained, never dropped", async () => {
    const store = createProjectMRs(getStateDb());
    store.registerDemand("ghost-repo", "board:1", ["alice"], Date.now());

    const report = await rekeyProjectMrDemandsTable();
    expect(report.retained).toEqual(["ghost-repo"]);
    expect(store.read("ghost-repo")!.demands!["board:1"]!.authors).toEqual(["alice"]);
    expect(warnSpy).toHaveBeenCalled();
  });
});
