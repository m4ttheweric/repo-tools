/**
 * Cycle-level branch-cache GC (RT-48 Task 8, spec test 8).
 *
 * Spec: docs/superpowers/specs/2026-08-20-rt-statedb.md "New: branch-cache
 * GC". The STORE's gc() semantics are unit-tested in
 * lib/state/__tests__/branch-cache.test.ts; what this file locks is the
 * CYCLE wiring that feeds it:
 *
 *  - the succeeded-repo set is built from per-repo `onError` counts inside
 *    the refresh loop — `refreshAllMRs` swallows fetch failures into
 *    `onError` and never throws, so a token-expired repo would otherwise
 *    look "clean" and have its frozen rows aged out (review r2 finding 1);
 *  - GC runs BEFORE `pruneDiscussionsStore`, so both prunes see the same
 *    membership in the same cycle (review r2 finding 8);
 *  - `checkAndNotify`'s fired-ledger hygiene sees the post-GC map, so an
 *    evicted branch's keys are dropped in the same cycle.
 *
 * Everything the loop touches that would leave the machine (GitLab/Linear
 * enrichment, tray notifications) or need a real git tree (worktree
 * listing) is spied; the branch-cache / project-MR / discussions stores are
 * REAL, over one temp state.db, because the ordering claim is only
 * meaningful against real prunes. HOME isolation is the repo-wide preload
 * (test-setup.ts); the notifier's kv state rides that HOME, so branch names
 * here are prefixed to stay unique within the process.
 */

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Logger } from "pino";

import * as enrichModule from "../../enrich.ts";
import * as gitAsync from "../../worktree/git-async.ts";
import * as notifierModule from "../../notifier.ts";
import * as repoTrackingModule from "../../repo-tracking.ts";
import * as discussionsModule from "../discussions-file-store.ts";
import * as projectMrsModule from "../project-mrs-store.ts";
import { createCacheRefresher } from "../cache-refresh.ts";
import { createProjectMRs } from "../project-mrs-store.ts";
import { createDiscussionsFileStore } from "../discussions-file-store.ts";
import { getBranchCacheStore, openStateDb, getNotifierStateBlob, setNotifierStateBlob, type CacheEntry } from "../../state/index.ts";
import { composeKey } from "../../state/branch-cache.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const CLEAN = "gcwire-clean";
const FLAKY = "gcwire-flaky";

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

afterEach(() => {
  mock.restore();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const silentLog = {
  debug() {}, info() {}, warn() {}, error() {},
} as unknown as Logger;

function entry(repoName: string | undefined, iid: number, fetchedAt: number): CacheEntry {
  return {
    ticket: null,
    linearId: "",
    // The discussions prune anchors on `repoName` + `mr.iid`, so a GC'd
    // branch is exactly what makes its discussion an orphan.
    mr: { iid } as CacheEntry["mr"],
    fetchedAt,
    ...(repoName ? { repoName } : {}),
  };
}

interface Wiring {
  cache: ReturnType<typeof getBranchCacheStore>;
  discussions: ReturnType<typeof createDiscussionsFileStore>;
  calls: string[];
  runCycle: () => Promise<void>;
}

/**
 * One cycle of the real `createCacheRefresher` over a real temp state.db,
 * with two tracked repos: CLEAN (refresh reports no errors) and FLAKY
 * (refresh invokes `onError` once and, exactly like the real
 * `refreshAllMRs`, throws nothing).
 */
function wireCycle(): Wiring {
  const db = openStateDb(join(tempDir("rt-gcwire-db-"), "state.db"), "cli");
  const cache = getBranchCacheStore(db);
  const projectStore = createProjectMRs(db);
  const discussions = createDiscussionsFileStore(db);

  spyOn(projectMrsModule, "getProjectMRs").mockReturnValue(projectStore);
  spyOn(discussionsModule, "getDiscussionsFileStore").mockReturnValue(discussions);

  spyOn(repoTrackingModule, "loadRepoTracking").mockReturnValue({
    [CLEAN]: { mode: "poll", caches: ["branches"] },
    [FLAKY]: { mode: "poll", caches: ["branches"] },
  });

  // A real git tree is irrelevant to the GC claim; one branch per repo is
  // enough to make the loop reach the enrichment call and let FLAKY's onError
  // fire (an empty branch list would short-circuit refreshAllMRs entirely and
  // make FLAKY look clean, defeating the test).
  spyOn(gitAsync, "listWorktreesAsync").mockImplementation(async (repoPath: string) => [
    { path: repoPath, branch: `wt-${repoPath}` },
  ]);
  spyOn(gitAsync, "listWorktreeRootsAsync").mockResolvedValue([]);

  spyOn(enrichModule, "refreshAllMRs").mockImplementation(
    async (_branches, _remoteUrl, onError, repoName) => {
      // The r2-finding-1 shape: the error is REPORTED, never thrown.
      if (repoName === FLAKY) onError?.("GitLab MR fetch failed for g/p: 401");
    },
  );

  // Notifications must never reach the tray from a unit test; the fired
  // ledger itself is still real (kv state under the preload HOME).
  spyOn(notifierModule.__test__.getDefaultNotifier(), "notify").mockImplementation(() => {});

  // Call-order probe: the two prunes, in the order the cycle runs them.
  const calls: string[] = [];
  const realGc = cache.gc.bind(cache);
  cache.gc = (repos, maxAgeMs) => { calls.push("gc"); realGc(repos, maxAgeMs); };
  const realPrune = discussionsModule.pruneDiscussionsStore;
  spyOn(discussionsModule, "pruneDiscussionsStore").mockImplementation((opts) => {
    calls.push("discussions-prune");
    return realPrune(opts);
  });

  const refresh = createCacheRefresher({
    log: silentLog,
    cache,
    refreshStatusRef: { lastRefreshAt: 0, lastSuccessAt: 0, failedRepos: 0, enrichErrors: 0 },
    portCacheRef: { ports: [], updatedAt: 0 },
    repoIndex: () => ({ [CLEAN]: tempDir("rt-gcwire-clean-"), [FLAKY]: tempDir("rt-gcwire-flaky-") }),
    broadcast: () => {},
    statusSnapshot: async () => ({}),
    reconcileSubscriptions: async () => {},
  });

  return { cache, discussions, calls, runCycle: refresh };
}

describe("cache-refresh cycle: branch-cache GC", () => {
  test("a repo whose refresh reported an error keeps its >30d rows; a clean repo's are pruned", async () => {
    const { cache, runCycle } = wireCycle();
    const old = Date.now() - 31 * DAY_MS;
    const now = Date.now();

    cache.put("gcwire-clean-stale", entry(CLEAN, 7, old));
    cache.put("gcwire-clean-fresh", entry(CLEAN, 8, now));
    cache.put("gcwire-flaky-stale", entry(FLAKY, 9, old));
    cache.put("gcwire-orphan-stale", entry(undefined, 10, old));

    await runCycle();

    // Clean repo: aged out. Fresh row of the same repo: kept.
    expect(cache.entries[composeKey(CLEAN, "gcwire-clean-stale")]).toBeUndefined();
    expect(cache.entries[composeKey(CLEAN, "gcwire-clean-fresh")]).toBeDefined();
    // Flaky repo: `onError` fired, so the repo never entered succeededRepos
    // and NOTHING of its rows may be aged out this cycle.
    expect(cache.entries[composeKey(FLAKY, "gcwire-flaky-stale")]).toBeDefined();
    // NULL-repo rows are unattributable: prunable by age alone.
    expect(cache.entries["gcwire-orphan-stale"]).toBeUndefined();
  }, 20_000);

  test("GC runs before the discussions prune, so both see the same membership", async () => {
    const { cache, discussions, calls, runCycle } = wireCycle();
    const old = Date.now() - 31 * DAY_MS;
    const now = Date.now();

    cache.put("gcwire-clean-stale", entry(CLEAN, 7, old));
    cache.put("gcwire-clean-fresh", entry(CLEAN, 8, now));
    cache.put("gcwire-flaky-stale", entry(FLAKY, 9, old));

    discussions.write(CLEAN, 7, { discussions: [], fetchedAt: 1 });
    discussions.write(CLEAN, 8, { discussions: [], fetchedAt: 1 });
    discussions.write(FLAKY, 9, { discussions: [], fetchedAt: 1 });

    await runCycle();

    expect(calls).toEqual(["gc", "discussions-prune"]);
    // The ordering, stated in outcomes: 7's only anchor was the branch GC
    // evicted THIS cycle, and the prune that follows sees the evicted map —
    // if the prune ran first it would still see the anchor and keep 7.
    expect(discussions.read(CLEAN, 7)).toBeUndefined();
    expect(discussions.read(CLEAN, 8)).toBeDefined();
    expect(discussions.read(FLAKY, 9)).toBeDefined();
  }, 20_000);

  test("an evicted branch's fired keys are dropped in the same cycle", async () => {
    const { cache, runCycle } = wireCycle();
    const old = Date.now() - 31 * DAY_MS;

    cache.put("gcwire-clean-stale", entry(CLEAN, 7, old));

    const evictedKey = notifierModule.__test__.firedKey("mr:merged", "gcwire-clean-stale");
    const state = getNotifierStateBlob<{ branches: Record<string, unknown>; ports: Record<string, unknown>; fired: string[] }>(
      { branches: {}, ports: {}, fired: [] },
    );
    setNotifierStateBlob({ ...state, fired: [...state.fired, evictedKey] });

    await runCycle();

    expect(cache.entries[composeKey(CLEAN, "gcwire-clean-stale")]).toBeUndefined();
    const after = getNotifierStateBlob<{ fired: string[] }>({ fired: [] });
    expect(after.fired).not.toContain(evictedKey);
  }, 20_000);
});
