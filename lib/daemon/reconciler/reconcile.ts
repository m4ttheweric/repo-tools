/**
 * Reconcile duty: brings the on-disk worktree registry back in line with git
 * ground truth (spec §4). Extracted from worktree-reconciler.ts (R014); the
 * step's contract (`ReconcileDeps` in, `TreeRecord[]` out) is unchanged.
 */

import { basename, dirname } from "path";
import { existsSync } from "fs";
import type { Logger } from "pino";
import { canon } from "../../fs-canon.ts";
import {
  loadRegistry,
  registryEpoch,
  saveRegistry,
  type TreeKind,
  type TreeRecord,
} from "../../worktree/registry.ts";
import { listWorktreesAsync, runGit, type WorktreeEntry } from "../../worktree/git-async.ts";
import { isTreeLocked } from "../../worktree/locks.ts";
import { scrapTree, type CreateDeps } from "../../worktree/create.ts";
import { loadWorktreeAppConfig } from "../../worktree/config.ts";

export interface ReconcileDeps {
  repoName: string;
  repoPath: string;
  emit: (type: string, data: unknown) => void;
  log: Logger;
  /**
   * Test-only seam, invoked right after an attempt captures its registry
   * snapshot and epoch... the exact window a competing writer (a provision
   * claim, a dispose prune) lands in on the shared event loop. Production
   * callers never pass it.
   */
  onAfterLoad?: (attempt: number) => void;
}

/** One attempt's outcome: its trees, or "a concurrent write invalidated me". */
type PassResult = { trees: TreeRecord[] } | { conflict: true };

/** Attempts before a contended pass gives up and leaves the work to the next tick. */
const RECONCILE_MAX_ATTEMPTS = 3;

/** Consecutive misses before a registry path absent from git ground truth is dropped: ~15 min at the 5-min cadence rides out a transient unmount, and still cleans up a real removal within a cache window. */
export const MISSING_PRUNE_PASSES = 3;

/**
 * Reconcile one repo's worktree registry against git ground truth (spec §4).
 *
 * Order matters:
 *  1. `git worktree prune` FIRST... an `rm -rf`'d tree otherwise leaves git's
 *     stale worktree registration holding the path/branch, which blocks a
 *     later create from reusing the same name. Skipped for this pass when any
 *     registered tree's parent directory is currently unreadable (S063: a
 *     network-mount blip must not be read as a mass removal).
 *  2. (d) orphaned `creating` entries (no held lock) are scrapped before (a)
 *     evaluates existence, since an in-flight (locked) `creating` entry has
 *     no git worktree yet and must not be pruned out from under the create.
 *  3. (a) registry entries with no matching git/disk worktree are held for
 *     `MISSING_PRUNE_PASSES` consecutive passes (S063), then pruned.
 *  4. (b) git worktrees unknown to the registry are adopted (main/unmanaged).
 *  5. (c) every remaining registered tree's `branch` is set to git ground
 *     truth; kind/state/owner are left untouched.
 *  6. (e) duplicate branches across registered trees are left as-is...
 *     surfaced elsewhere (findByBranch / T13's list handler).
 *
 * Concurrency: this is the one registry writer that saves a WHOLE snapshot
 * taken before a long run of git awaits. Every other writer is a synchronous
 * fresh-load → mutate → save of one row, so per-tree locks are enough for them;
 * they are not enough here, because reconcile holds no lock on the trees it
 * rewrites (and taking a repo-wide one would reintroduce the coarse locking
 * this design avoids). Instead each attempt captures `registryEpoch` with its
 * snapshot and re-checks it in the same synchronous block as its save: if
 * anyone else wrote in between, the snapshot is stale and the whole pass is
 * retried against fresh state rather than overwriting them. Retries are bounded
 *... a pass that keeps losing simply skips its save and lets the next tick redo
 * it, since every correction here is derived from ground truth and idempotent.
 */
export async function reconcileRepo(deps: ReconcileDeps): Promise<TreeRecord[]> {
  for (let attempt = 1; attempt <= RECONCILE_MAX_ATTEMPTS; attempt++) {
    const result = await reconcilePass(deps, attempt);
    if (!("conflict" in result)) return result.trees;
    deps.log.debug?.(
      { repo: deps.repoName, attempt },
      "reconcile: registry changed mid-pass; retrying against a fresh snapshot",
    );
  }
  deps.log.warn(
    { repo: deps.repoName, attempts: RECONCILE_MAX_ATTEMPTS },
    "reconcile: registry kept changing mid-pass; skipping this pass's save",
  );
  return loadRegistry(deps.repoName);
}

/** Back-compat alias: pre-extraction callers (handlers/worktree.ts, the big
 *  reconciler test suite) import this name directly. */
export const reconcileRepoRegistry = reconcileRepo;

async function reconcilePass(deps: ReconcileDeps, attempt: number): Promise<PassResult> {
  const { repoName, repoPath, emit, log } = deps;

  // A `creating` row has no git worktree yet, so it never counts against
  // readability; any other row whose parent dir can't be listed right now is
  // a transient mount blip, not evidence its worktree was removed, so the
  // sweep that would otherwise register that removal is skipped this pass.
  const rootsReadable = loadRegistry(repoName).every(
    (t) => t.state === "creating" || existsSync(dirname(t.path)),
  );
  if (rootsReadable) {
    await runGit(repoPath, ["worktree", "prune"]);
  } else {
    log.info({ repo: repoName }, "reconcile: a pool root is unreadable this pass; skipping git worktree prune");
  }

  let trees = loadRegistry(repoName);
  let epoch = registryEpoch(repoName);
  deps.onAfterLoad?.(attempt);
  let changed = false;
  const createDeps: CreateDeps = { repoName, repoPath, emit, log };

  // (d) creating entries with no held lock -> scrap, no recreate. Entries
  // still locked (genuinely in-flight) pass through untouched. Scrapping
  // mutates git state (worktree remove + branch -D), so the git listing used
  // by (a)-(c) below is captured AFTER this loop, not before.
  //
  // This is the one mutating step in an otherwise read-only reconcile, so
  // (unlike (a)-(c)/(e), which only ever sync the registry file to ground
  // truth) it is gated on the app-level enabled flag same as freshen/replenish.
  const appConfig = loadWorktreeAppConfig();
  const afterScrap: TreeRecord[] = [];
  let scrapped = false;
  for (const rec of trees) {
    if (appConfig.enabled && rec.state === "creating" && !isTreeLocked(rec.path)) {
      log.info({ repo: repoName, tree: rec.name, path: rec.path }, "reconcile: scrapping orphaned creating tree");
      await scrapTree(createDeps, rec);
      scrapped = true;
      continue;
    }
    afterScrap.push(rec);
  }
  trees = afterScrap;

  if (scrapped) {
    // scrapTree persists its own removal (fresh-load → filter → save), so the
    // scrap is already on disk and has already bumped the epoch. (A scrap
    // whose rename failed keeps its record for retry and writes nothing; the
    // re-read below is correct either way.) Re-read from
    // that write instead of carrying the pre-scrap snapshot forward: anything
    // another writer landed during the scrap's git awaits is in the file now,
    // and re-capturing the epoch here is what keeps our own intentional write
    // from reading as somebody else's.
    trees = loadRegistry(repoName);
    epoch = registryEpoch(repoName);
  }

  const gitEntries = await listWorktreesAsync(repoPath);
  if (gitEntries === null) {
    // Nothing to save: the scrap above already persisted itself, and writing
    // this snapshot back would be exactly the stale-snapshot clobber.
    log.warn({ repo: repoName, repoPath }, "reconcile: git worktree list failed; skipping this repo's pass");
    return { trees };
  }
  const gitByCanon = new Map<string, WorktreeEntry>();
  for (const entry of gitEntries) {
    gitByCanon.set(canon(entry.path), entry);
  }

  // (a) registry paths missing from git/disk -> held for MISSING_PRUNE_PASSES
  // consecutive passes (S063: a transiently missing directory, e.g. a network
  // mount blip, must not orphan the row and poison its name), then pruned.
  // `creating` entries are exempt: they legitimately have no git worktree yet.
  const afterPrune: TreeRecord[] = [];
  for (const rec of trees) {
    if (rec.state === "creating") {
      afterPrune.push(rec);
      continue;
    }
    if (gitByCanon.has(canon(rec.path))) {
      if (rec.missCount) {
        delete rec.missCount;
        changed = true;
      }
      afterPrune.push(rec);
    } else {
      const misses = (rec.missCount ?? 0) + 1;
      if (misses < MISSING_PRUNE_PASSES) {
        rec.missCount = misses;
        changed = true;
        afterPrune.push(rec);
        log.info({ repo: repoName, tree: rec.name, path: rec.path, misses }, "reconcile: worktree path missing, holding");
      } else {
        log.info({ repo: repoName, tree: rec.name, path: rec.path }, "reconcile: pruning registry entry after sustained absence");
        changed = true;
      }
    }
  }
  trees = afterPrune;

  // (b) git paths unknown to registry -> adopt. The first porcelain entry is
  // always the main clone.
  const known = new Set(trees.map((t) => canon(t.path)));
  let mainRegistered = trees.some((t) => t.kind === "main");
  for (const entry of gitEntries) {
    const c = canon(entry.path);
    if (known.has(c)) continue;

    const isMain = entry === gitEntries[0] && !mainRegistered;
    const kind: TreeKind = isMain ? "main" : "unmanaged";
    if (isMain) mainRegistered = true;

    const rec: TreeRecord = {
      name: basename(entry.path),
      path: entry.path,
      kind,
      branch: entry.branch,
      createdAt: new Date().toISOString(),
    };
    trees.push(rec);
    known.add(c);
    changed = true;
    log.info({ repo: repoName, tree: rec.name, kind, path: rec.path }, "reconcile: adopted worktree into registry");
  }

  // (c) ground-truth branch sync for every registered tree git still knows
  // about. kind/state/owner are never touched here.
  for (const rec of trees) {
    const entry = gitByCanon.get(canon(rec.path));
    if (entry && rec.branch !== entry.branch) {
      rec.branch = entry.branch;
      changed = true;
    }
  }

  // (e) duplicate branches across registered trees: leave records as-is.

  if (changed) {
    // Check and save in one synchronous block... an await between them would
    // reopen the very window this closes.
    if (registryEpoch(repoName) !== epoch) return { conflict: true };
    saveRegistry(repoName, trees);
  }

  return { trees };
}

export const __test__ = {
  reconcilePass,
  RECONCILE_MAX_ATTEMPTS,
};
