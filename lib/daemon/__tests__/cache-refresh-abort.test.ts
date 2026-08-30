/**
 * RT-91 core: a refresh cycle that hits its deadline stops doing work rather
 * than walking every remaining repo in the background. The coalescer aborts the
 * cycle's AbortSignal at the deadline; refreshCacheImpl checks it at the
 * repo-loop seam and bails. Enrichment (GitLab/Linear) and worktree listing are
 * spied; the branch-cache store is real over one temp state.db. HOME isolation
 * is the repo-wide preload (test-setup.ts).
 */

import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Logger } from "pino";

import * as enrichModule from "../../enrich.ts";
import * as gitAsync from "../../worktree/git-async.ts";
import * as notifierModule from "../../notifier.ts";
import * as repoTrackingModule from "../../repo-tracking.ts";
import { createCacheRefresher } from "../cache-refresh.ts";
import { getBranchCacheStore, openStateDb } from "../../state/index.ts";

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

const silentLog = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;

test("a cycle that hits the deadline stops before the next repo", async () => {
  const A = "abortwire-a";
  const B = "abortwire-b";
  const db = openStateDb(join(tempDir("rt-abortwire-db-"), "state.db"), "cli");
  const cache = getBranchCacheStore(db);

  spyOn(repoTrackingModule, "loadRepoTracking").mockReturnValue({
    [A]: { mode: "poll", caches: ["branches"] },
    [B]: { mode: "poll", caches: ["branches"] },
  });
  spyOn(gitAsync, "listWorktreesAsync").mockImplementation(async (repoPath: string) => [
    { path: repoPath, branch: `wt-${repoPath}`, isBare: false },
  ]);
  spyOn(gitAsync, "listWorktreeRootsAsync").mockResolvedValue([]);
  spyOn(notifierModule.__test__.getDefaultNotifier(), "notify").mockImplementation(() => {});

  // A's enrichment outlasts the deadline; the signal aborts while it sleeps, so
  // the loop must break before reaching B.
  const enriched: string[] = [];
  spyOn(enrichModule, "refreshAllMRs").mockImplementation(
    async (_branches, _remoteUrl, _onError, repoName) => {
      enriched.push(repoName!);
      if (repoName === A) await new Promise((r) => setTimeout(r, 300));
    },
  );

  const refresh = createCacheRefresher({
    log: silentLog,
    cache,
    refreshStatusRef: { lastRefreshAt: 0, lastSuccessAt: 0, failedRepos: 0, enrichErrors: 0 },
    portCacheRef: { ports: [], updatedAt: 0 },
    repoIndex: () => ({ [A]: tempDir("rt-abortwire-a-"), [B]: tempDir("rt-abortwire-b-") }),
    broadcast: () => {},
    statusSnapshot: async () => ({}),
    reconcileSubscriptions: async () => {},
    cycleDeadlineMs: 50,
  });

  await refresh();                              // returns at the deadline (~50ms)
  await new Promise((r) => setTimeout(r, 500));  // let the orphaned cycle reach the seam

  expect(enriched).toContain(A);
  expect(enriched).not.toContain(B); // aborted before advancing to B
}, 20_000);
