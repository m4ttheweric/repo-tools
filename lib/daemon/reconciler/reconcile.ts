/**
 * Reconcile duty: brings the on-disk worktree registry back in line with git
 * ground truth (spec §4). The step's contract (`ReconcileDeps` in,
 * `TreeRecord[]` out) is stable.
 */

import { basename, dirname, sep } from "path";
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
import { currentBranchAsync, listWorktreesAsync, runGit, type WorktreeEntry } from "../../worktree/git-async.ts";
import { isTreeLocked } from "../../worktree/locks.ts";
import { scrapTree, type CreateDeps } from "../../worktree/create.ts";
import { loadWorktreeAppConfig } from "../../worktree/config.ts";
import { legacyWorktreePoolRoots, worktreePoolRoot } from "../../rt-paths.ts";
import { patchTree } from "../../worktree/patch.ts";

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

/**
 * A tree missing from git is a vanished mount (hold), not a removal (sweep),
 * when its pool root AND the root's parent are both unreadable: an unmount
 * takes its mount point with it, while a removed pool dir (`.worktrees`) leaves
 * its parent clone present (RT-87). Held rows never accrue a miss, so a long
 * outage cannot prune live claim state.
 */
function isHeldByUnreadableMount(treePath: string): boolean {
  const root = dirname(treePath);
  return !existsSync(root) && !existsSync(dirname(root));
}

/** Attempts before a contended pass gives up and leaves the work to the next tick. */
const RECONCILE_MAX_ATTEMPTS = 3;

/** Consecutive misses before a registry path absent from git ground truth is dropped: ~15 min at the 5-min cadence rides out a transient unmount, and still cleans up a real removal within a cache window. */
export const MISSING_PRUNE_PASSES = 3;

/**
 * Pre-RT-95 pool roots embed the raw wire colon, which splits PATH during a
 * tree's installs, so on-deck trees under one can never pass their ready
 * steps again. Flip them disposable (the normal dispose + replenish pipeline
 * rebuilds under the PATH-safe root); claimed trees stay, their work and
 * completed installs are intact. Runs before the pass so this tick's sweep
 * already sees the flipped state. Single-row patchTree writes: no epoch
 * guard needed.
 */
export function healLegacyPoolRoots(deps: Pick<ReconcileDeps, "repoName" | "emit" | "log">): void {
  const current = worktreePoolRoot(deps.repoName);
  const legacyPrefixes = legacyWorktreePoolRoots(deps.repoName)
    .filter((root) => root !== current)
    .map((root) => root + sep);
  if (legacyPrefixes.length === 0) return;
  for (const rec of loadRegistry(deps.repoName)) {
    if (rec.state !== "on-deck" || !legacyPrefixes.some((p) => rec.path.startsWith(p))) continue;
    const flipped = patchTree(deps.repoName, rec.path, (r) => {
      r.state = "disposable";
      r.disposableReason = "legacy pool root (colon path breaks installs)";
    });
    if (!flipped) continue;
    deps.log.info({ repo: deps.repoName, tree: rec.name, path: rec.path }, "reconcile: legacy pool-root tree flipped disposable");
    deps.emit("worktree:disposable", {
      repo: deps.repoName, tree: rec.name, path: rec.path, branch: rec.branch,
      reason: "legacy pool root (colon path breaks installs)",
    });
  }
}


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

/**
 * A claim whose handoff marker is still "pending" was written by a provision
 * that never replied: the daemon died (or was restarted) between the claim
 * write and the handover, so no caller owns the tree. Release it the way
 * rollbackClaim would have. Keyed ONLY on the marker: RT-96's
 * readyPendingAt marks healthy delivered claims mid-background-install and
 * must never match. A held tree lock means the provision is still alive in
 * THIS process; skip it, its own handler will finish or roll back.
 */
export async function releaseStrandedClaims(deps: Pick<ReconcileDeps, "repoName" | "emit" | "log">): Promise<void> {
  for (const rec of loadRegistry(deps.repoName)) {
    if (rec.state !== "claimed" || rec.handoff !== "pending") continue;
    if (isTreeLocked(rec.path)) continue;
    // The registry branch is stale when the death landed between checkout
    // and the branch patch, so git is the authority: only a tree still
    // sitting on its pool branch may rejoin the pool.
    const current = await currentBranchAsync(rec.path);
    const poolBranch = typeof rec.branch === "string" && rec.branch.startsWith("on-deck/") ? rec.branch : null;
    const backToPool = poolBranch !== null && current === poolBranch;
    // Mirror of markHandoffDelivered's CAS: the git await above yielded the
    // event loop, so the handler may have delivered this claim in the gap.
    // Re-check inside the same synchronous load-mutate-save; losing means
    // the caller owns the tree and this pass must not touch it.
    let released = false;
    const flipped = patchTree(deps.repoName, rec.path, (r) => {
      if (r.state !== "claimed" || r.handoff !== "pending") return;
      released = true;
      delete r.handoff;
      delete r.claimedAt;
      delete r.owner;
      delete r.disposal;
      if (backToPool) {
        r.state = "on-deck";
      } else {
        r.state = "disposable";
        if (current) r.branch = current;
        r.disposableReason = "stranded claim (provision died before handover)";
      }
    });
    if (!flipped || !released) continue;
    deps.log.warn({ repo: deps.repoName, tree: rec.name, backToPool }, "reconcile: released a stranded claim");
    if (!backToPool) {
      deps.emit("worktree:disposable", {
        repo: deps.repoName, tree: rec.name, path: rec.path, branch: current ?? rec.branch,
        reason: "stranded claim (provision died before handover)",
      });
    }
  }
}

export async function reconcileRepo(deps: ReconcileDeps): Promise<TreeRecord[]> {
  healLegacyPoolRoots(deps);
  await releaseStrandedClaims(deps);
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
  //
  // A pool root that unmounted takes its own parent (the mount point) with it,
  // while a genuinely removed pool dir leaves its parent present (RT-87). So a
  // missing tree whose pool root AND the root's parent are both unreadable is a
  // vanished mount, not a removal: hold the row without counting a miss, so a
  // long outage never prunes live claim/owner/state. A removed `.worktrees`
  // (parent repo present) sweeps normally.
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
    } else if (isHeldByUnreadableMount(rec.path)) {
      const root = dirname(rec.path);
      log.warn({ repo: repoName, tree: rec.name, root }, "reconcile: pool root and its parent are unreadable (mount blip); holding registry row without counting a miss");
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
