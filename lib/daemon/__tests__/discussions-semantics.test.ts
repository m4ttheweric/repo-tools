import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createDiscussionsFileStore, pruneDiscussionsStore } from "../discussions-file-store.ts";
import { collectSweepTargets } from "../discussions-poller.ts";
import { createProjectMRs } from "../project-mrs-store.ts";
import { openStateDb, getBranchCacheStore } from "../../state/index.ts";
import { composeKey } from "../../state/branch-cache.ts";

const tmp = (n: string) => join(mkdtempSync(join(tmpdir(), "rt-dsem-")), n);
const tmpDb = () => openStateDb(tmp("state.db"), "cli");
// RT-48: project-mrs persistence moved off project-mrs.json to state.db —
// fresh temp db per call, same isolation createProjectMRs(tmp(...), 0) had.
const pmrsStore = () => createProjectMRs(tmpDb());
// RT-48 task 5: discussions persistence moved off discussions.json to
// state.db — createDiscussionsFileStore now takes a db handle, not a path.
const fStoreOver = (db = tmpDb()) => createDiscussionsFileStore(db);
const branchEntry = (repoName: string, iid: number, status = "open") =>
  ({ repoName, mr: { iid, status }, ticket: null, linearId: "", fetchedAt: 0 }) as any;
const openPr = (iid: number, state = "opened") =>
  ({ id: `gitlab:mr:${iid}`, iid, title: "", state, sourceBranch: `b${iid}`, targetBranch: "main", webUrl: "", divergedCommitsCount: null }) as any;

describe("collectSweepTargets", () => {
  test("branch MRs for granted repos + cached-only project MRs; terminal + ungranted skipped", () => {
    const pStore = pmrsStore();
    pStore.fullSync("granted", "g/p", [openPr(10), openPr(11), openPr(12, "merged")], Date.now());
    const fStore = fStoreOver();
    fStore.write("granted", 10, { discussions: [], fetchedAt: 1 });   // cached → swept
    // 11 not cached → NOT swept (demand-following); 12 cached but merged → skipped
    fStore.write("granted", 12, { discussions: [], fetchedAt: 1 });
    const entries = {
      a: branchEntry("granted", 1),
      b: branchEntry("granted", 2, "merged"),
      c: branchEntry("ungranted", 3),
    };
    const tracking = { granted: { mode: "live" as const, caches: ["branches", "discussions"] as any } };
    const targets = collectSweepTargets(entries, tracking, pStore, fStore);
    const key = (t: { repoName: string; iid: number }) => `${t.repoName}:${t.iid}`;
    expect(targets.map(key).sort()).toEqual(["granted:1", "granted:10"]);
  });

  test("branch + project overlap dedups", () => {
    const pStore = pmrsStore();
    pStore.fullSync("r", "g/p", [openPr(1)], Date.now());
    const fStore = fStoreOver();
    fStore.write("r", 1, { discussions: [], fetchedAt: 1 });
    const tracking = { r: { mode: "live" as const, caches: ["discussions"] as any } };
    const targets = collectSweepTargets({ x: branchEntry("r", 1) }, tracking, pStore, fStore);
    expect(targets).toEqual([{ repoName: "r", iid: 1 }]);
  });
});

describe("pruneDiscussionsStore", () => {
  test("removes keys in neither store; keeps union members; skips failed repos", () => {
    const pStore = pmrsStore();
    pStore.fullSync("r", "g/p", [openPr(10)], Date.now());
    const fStore = fStoreOver();
    fStore.write("r", 10, { discussions: [], fetchedAt: 1 });   // in project store → kept
    fStore.write("r", 1,  { discussions: [], fetchedAt: 1 });   // in branch cache → kept
    fStore.write("r", 99, { discussions: [], fetchedAt: 1 });   // orphan → pruned
    fStore.write("failed", 5, { discussions: [], fetchedAt: 1 }); // failed repo → kept
    const removed = pruneDiscussionsStore({
      entries: { a: branchEntry("r", 1) },
      projectStore: pStore,
      failedRepos: new Set(["failed"]),
      store: fStore,
    });
    expect(removed).toBe(1);
    expect(fStore.read("r", 99)).toBeUndefined();
    expect(fStore.read("failed", 5)).toBeDefined();
  });

  // RT-48 review r1 finding 12 / spec "Store-by-store" item 3: branch-cache
  // GC (new in this ticket — branch-cache previously had NO prune at all)
  // shrinks one leg of pruneDiscussionsStore's union-membership check. A
  // discussion whose only anchor was a branch-cache entry that GC evicts,
  // and that never landed in the project-MR store either, becomes an
  // orphan and gets pruned. This is an INTENDED semantic change riding on
  // the new GC, not a parity requirement with the old (never-pruning)
  // discussions.json / branch-cache.json behavior — asserted here as such.
  test("intended: a >30-day-stale branch's discussion prunes once branch-cache GC evicts its only anchor", () => {
    const db = tmpDb();
    const cache = getBranchCacheStore(db);
    const DAY_MS = 24 * 60 * 60 * 1000;
    const staleTs = Date.now() - 40 * DAY_MS;

    cache.put("stale-branch", { repoName: "r", mr: { iid: 42, status: "open" } as any, ticket: null, linearId: "", fetchedAt: staleTs });
    const fStore = createDiscussionsFileStore(db);
    fStore.write("r", 42, { discussions: [], fetchedAt: 1 });
    const pStore = createProjectMRs(db); // this MR never landed in the project-MR store either

    // Before GC: the branch-cache row still anchors the discussion — kept.
    let removed = pruneDiscussionsStore({ entries: cache.entries, projectStore: pStore, store: fStore });
    expect(removed).toBe(0);
    expect(fStore.read("r", 42)).toBeDefined();

    // GC runs (repo "r" refreshed cleanly this cycle — gating per spec
    // "New: branch-cache GC"), evicting the stale row.
    cache.gc(new Set(["r"]), 30 * DAY_MS);
    expect(cache.entries[composeKey("r", "stale-branch")]).toBeUndefined();

    // The union's branch-cache leg just shrank; the discussion is now a
    // true orphan and prunes — intended cleanup, not a regression.
    removed = pruneDiscussionsStore({ entries: cache.entries, projectStore: pStore, store: fStore });
    expect(removed).toBe(1);
    expect(fStore.read("r", 42)).toBeUndefined();
    db.close();
  });
});
