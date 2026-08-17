/**
 * Worktree reconciler — brings the on-disk registry back in line with git
 * ground truth. First slice (Task 10): registry reconcile only. Tasks 11-12
 * extend `runOnce` in place with the merge reactor, freshen, and
 * replenish/shrink passes, so structure here is deliberately left open for
 * that: `reconcileRepoRegistry` is a standalone step `runOnce` calls per
 * repo, and `createWorktreeReconciler`'s returned object is the single
 * surface later tasks add to (e.g. `creationInFlight`).
 */

import { basename, join } from "path";
import { realpathSync } from "fs";
import type { Logger } from "pino";
import { readJson } from "../json-store.ts";
import { repoDataDir } from "../rt-paths.ts";
import {
  loadRegistry,
  saveRegistry,
  type TreeKind,
  type TreeRecord,
} from "../worktree/registry.ts";
import { runGit, listWorktreesAsync, type WorktreeEntry } from "../worktree/git-async.ts";
import { isTreeLocked } from "../worktree/locks.ts";
import { scrapTree, type CreateDeps } from "../worktree/create.ts";

export interface ReconcilerDeps {
  cache: { entries: Record<string, any> };
  repoIndex: () => Record<string, string>;
  emit: (type: string, data: unknown) => void;
  log: Logger;
}

/** realpathSync defensively; a path that doesn't (yet) exist compares as-is. */
function canon(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Reconcile one repo's worktree registry against git ground truth (spec §4).
 *
 * Order matters:
 *  1. `git worktree prune` FIRST — an `rm -rf`'d tree otherwise leaves git's
 *     stale worktree registration holding the path/branch, which blocks a
 *     later create from reusing the same name.
 *  2. (d) orphaned `creating` entries (no held lock) are scrapped before (a)
 *     evaluates existence, since an in-flight (locked) `creating` entry has
 *     no git worktree yet and must not be pruned out from under the create.
 *  3. (a) registry entries with no matching git/disk worktree are pruned.
 *  4. (b) git worktrees unknown to the registry are adopted (main/unmanaged).
 *  5. (c) every remaining registered tree's `branch` is set to git ground
 *     truth; kind/state/owner are left untouched.
 *  6. (e) duplicate branches across registered trees are left as-is —
 *     surfaced elsewhere (findByBranch / T13's list handler).
 */
export async function reconcileRepoRegistry(deps: {
  repoName: string;
  repoPath: string;
  emit: (type: string, data: unknown) => void;
  log: Logger;
}): Promise<TreeRecord[]> {
  const { repoName, repoPath, emit, log } = deps;

  await runGit(repoPath, ["worktree", "prune"]);

  let trees = loadRegistry(repoName);
  let changed = false;
  const createDeps: CreateDeps = { repoName, repoPath, emit, log };

  // (d) creating entries with no held lock -> scrap, no recreate. Entries
  // still locked (genuinely in-flight) pass through untouched. Scrapping
  // mutates git state (worktree remove + branch -D), so the git listing used
  // by (a)-(c) below is captured AFTER this loop, not before.
  const afterScrap: TreeRecord[] = [];
  for (const rec of trees) {
    if (rec.state === "creating" && !isTreeLocked(rec.path)) {
      log.info({ repo: repoName, tree: rec.name, path: rec.path }, "reconcile: scrapping orphaned creating tree");
      await scrapTree(createDeps, rec);
      changed = true;
      continue;
    }
    afterScrap.push(rec);
  }
  trees = afterScrap;

  const gitEntries = await listWorktreesAsync(repoPath);
  const gitByCanon = new Map<string, WorktreeEntry>();
  for (const entry of gitEntries) {
    gitByCanon.set(canon(entry.path), entry);
  }

  // (a) registry paths missing from git/disk -> prune entry. `creating`
  // entries are exempt: they legitimately have no git worktree yet.
  const afterPrune: TreeRecord[] = [];
  for (const rec of trees) {
    if (rec.state === "creating") {
      afterPrune.push(rec);
      continue;
    }
    if (gitByCanon.has(canon(rec.path))) {
      afterPrune.push(rec);
    } else {
      log.info({ repo: repoName, tree: rec.name, path: rec.path }, "reconcile: pruning registry entry with no matching worktree");
      changed = true;
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
    saveRegistry(repoName, trees);
  }

  return trees;
}

/** Whether a repo has any worktree state worth reconciling: registry entries or a declared "worktrees" config. */
function repoHasWorktreeActivity(repoName: string): boolean {
  if (loadRegistry(repoName).length > 0) return true;
  const configPath = join(repoDataDir(repoName), "config.json");
  const raw = readJson<{ worktrees?: unknown }>(configPath, {});
  return raw.worktrees !== undefined;
}

/**
 * Assembles the worktree reconciler. This slice's `runOnce` only runs the
 * registry reconcile pass per qualifying repo; Tasks 11-12 extend `runOnce`
 * in place to add the merge reactor, freshen, and replenish/shrink passes.
 */
export function createWorktreeReconciler(deps: ReconcilerDeps): {
  kick: () => void;
  runOnce: () => Promise<void>;
} {
  let inFlight: Promise<void> | null = null;

  async function runOnce(): Promise<void> {
    const repos = deps.repoIndex();
    for (const [repoName, repoPath] of Object.entries(repos)) {
      if (!repoHasWorktreeActivity(repoName)) continue;
      try {
        await reconcileRepoRegistry({ repoName, repoPath, emit: deps.emit, log: deps.log });
      } catch (err) {
        deps.log.warn({ err, repo: repoName }, "worktree reconciler: repo pass failed");
      }
    }
  }

  function kick(): void {
    if (inFlight) return;
    const p = runOnce()
      .catch((err) => {
        deps.log.warn({ err }, "worktree reconciler: kick failed");
      })
      .finally(() => {
        if (inFlight === p) inFlight = null;
      });
    inFlight = p;
  }

  return { kick, runOnce };
}
