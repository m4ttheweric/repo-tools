/**
 * Worktree reconciler... brings the on-disk registry back in line with git
 * ground truth, then reacts to the MR transitions that end a tree's life.
 * Task 12 extends `runOnce` in place with the freshen and replenish/shrink
 * passes, so structure here is deliberately left open for that: each duty is
 * a standalone step `runOnce` calls per repo, and `createWorktreeReconciler`'s
 * returned object is the single surface later tasks add to (e.g.
 * `creationInFlight`).
 */

import { isAbsolute, join, relative, resolve } from "path";
import type { Logger } from "pino";
import { loadRegistry } from "../worktree/registry.ts";
import { MR_TERMINAL_STATES } from "../enrich.ts";
import { ensureWorktreeRegistryRekeyed } from "../repo-index.ts";
import {
  loadWorktreeAppConfig,
  loadWorktreeRepoConfig,
  worktreeSettingsDeclared,
} from "../worktree/config.ts";
import { reapExpiredTrash, reapTrashInRoots } from "../worktree/trash.ts";
import {
  MISSING_PRUNE_PASSES,
  reconcileRepo,
  reconcileRepoRegistry,
  __test__ as reconcileTest,
} from "./reconciler/reconcile.ts";
import {
  detectTransitions,
  __test__ as reactorTest,
} from "./reconciler/reactor.ts";
import {
  backoffDelayMs,
  freshenRepo,
  __test__ as freshenTest,
} from "./reconciler/freshen.ts";
import {
  withCreateLock,
  replenishAndShrink,
  poolCounts,
  createBackoff,
  hasFreeDiskGb,
  WORKTREE_ONDECK_CEILING,
  WORKTREE_MIN_FREE_DISK_GB,
} from "./reconciler/replenish.ts";

export type { ReconcileDeps } from "./reconciler/reconcile.ts";
export type { ReactorDeps } from "./reconciler/reactor.ts";
export type { FreshenDeps } from "./reconciler/freshen.ts";
export { reconcileRepo, reconcileRepoRegistry, detectTransitions, freshenRepo, withCreateLock };

export interface ReconcilerDeps {
  cache: { entries: Record<string, any> };
  repoIndex: () => Record<string, string>;
  emit: (type: string, data: unknown) => void;
  log: Logger;
}

// Freshen (spec §6.3) lives in ./reconciler/freshen.ts; replenish and shrink
// (spec §6.4) live in ./reconciler/replenish.ts, imported above.

/**
 * Reap duty, two sweeps with different clocks.
 *
 * Crash leftovers... sibling `.trash-*` dirs from a disposal whose detached
 * delete died (daemon crash, reboot)... are reaped immediately: nobody will
 * ever look at them again, so a crash costs disk and nothing else. Both roots
 * are swept, the repo's default `.worktrees` and whatever root the repo config
 * declares, because a root that changed after a disposal still has the old
 * root's leftovers in it.
 *
 * Retained trees (`<root>/.trash/<name>-<epoch>` entries under each of the
 * same two roots, where disposal parks trees stripped-but-recoverable
 * (RT-51)) are reaped only past the retention window. Sweeping both roots,
 * not just the tree's current default, is what lets a legacy pool root and
 * the new default pool root both drain during migration.
 */
/**
 * Whether `root` is repoPath itself or a strict ancestor of it...
 * sanitizeRoot (lib/worktree/config.ts) has no such check, so a value like
 * `${repoRoot}/..` sweeps the parent directory shared by every sibling repo
 * for `.trash-*` names. An unrelated, dedicated external root (the
 * documented `root: "~/wt"` case) is fine to sweep... it's a repo-specific
 * destination nothing else shares... so this only refuses the ancestor
 * shape, not "root lies outside repoPath" in general.
 */
function isRootAnAncestorOfRepo(repoPath: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(repoPath));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function reapRepoTrash(deps: { repoName: string; repoPath: string; log: Logger }): Promise<void> {
  const { repoName, repoPath, log } = deps;
  const cfg = await loadWorktreeRepoConfig(repoName, repoPath);
  const roots = [join(repoPath, ".worktrees")];
  if (isRootAnAncestorOfRepo(repoPath, cfg.root)) {
    log.warn({ repo: repoName, root: cfg.root, repoPath }, "worktree trash sweep refused a configured root that is an ancestor of the repo");
  } else {
    roots.push(cfg.root);
  }
  const reaped = await reapTrashInRoots(roots, log);
  if (reaped > 0) log.info({ repo: repoName, count: reaped }, "worktree trash reaped");
  const expired = await reapExpiredTrash(roots, log);
  if (expired > 0) log.info({ repo: repoName, count: expired }, "worktree retention trash reaped");
}

/**
 * Whether a repo has any worktree state worth reconciling: registry entries, or
 * an `rt.worktrees` declaration on any rung stronger than the registry default.
 *
 * Since RT-47 the declaration can live in a settings store as well as in the
 * legacy per-repo config.json, so this asks the reader rather than the file...
 * a repo whose pool config lives ONLY in the team store must still be
 * reconciled. Async for the same reason the reader is (identity derivation);
 * the pass that calls it is async already.
 */
async function repoHasWorktreeActivity(repoName: string, repoPath: string): Promise<boolean> {
  if (loadRegistry(repoName).length > 0) return true;
  return worktreeSettingsDeclared(repoName, repoPath);
}

/**
 * Assembles the worktree reconciler. `runOnce` runs reconcile then the merge
 * reactor per qualifying repo; Task 12 extends it in place with the freshen
 * and replenish/shrink passes.
 */
export function createWorktreeReconciler(deps: ReconcilerDeps): {
  kick: () => void;
  runOnce: () => Promise<void>;
  /** The live `createTree` promise replenish kicked off for `repoName`, or
   *  null when nothing is in flight. Task 13's provision handler awaits this
   *  instead of racing its own create against replenish's. */
  creationInFlight: (repoName: string) => Promise<void> | null;
  /** Whether a `kick()`-triggered pass is currently running. Test-only: lets a
   *  test that calls `kick()` (deliberately not awaited... that's the point of
   *  `kick`) poll for true completion instead of guessing at a sleep, so no
   *  background pass survives into a later test's HOME once its own
   *  `beforeEach` repoints that (shared, global) env var. */
  passInFlight: () => boolean;
  /**
   * Run `fn` with the reconciler held: any pass in flight is awaited first,
   * and `kick()` starts no new pass until `fn` settles (one queued kick fires
   * on release). A holder rewrites registry paths that a concurrent pass would
   * read as "no matching worktree" and prune, taking the pool's claim state
   * with it. Holders serialize, so `fn` must not take the hold again.
   */
  withReconcilerHeld: <T>(fn: () => Promise<T>) => Promise<T>;
} {
  let inFlight: Promise<void> | null = null;
  /** Non-null while a holder owns the reconciler. */
  let hold: Promise<void> | null = null;
  let kickQueued = false;
  /**
   * True once the current pass's per-repo loop has begun processing at
   * least one repo. Two kicks that both land before this flips (the common
   * "two synchronous kicks" case) still collapse to one pass... the
   * upcoming loop reads fresh state regardless. A kick landing after it
   * flips might be about a repo this pass has already stepped past (e.g. a
   * provision claiming the last on-deck tree right after replenish ran for
   * it), so it queues a follow-up instead of being silently dropped.
   */
  let passStartedWork = false;
  const creationPromises = new Map<string, Promise<void>>();

  async function runOnce(): Promise<void> {
    // Legacy-named registry rows predate identity-keyed indices and must be
    // re-keyed before this pass reads them by identity, or a pre-existing
    // repo's claim state silently stops being reconciled.
    try {
      await ensureWorktreeRegistryRekeyed();
    } catch (err) {
      deps.log.warn({ err }, "worktree reconciler: legacy registry re-key failed");
    }

    const repos = deps.repoIndex();
    // One read for the whole pass: every repo shares the same app-level file.
    const appConfig = loadWorktreeAppConfig();

    for (const [repoName, repoPath] of Object.entries(repos)) {
      passStartedWork = true;
      if (!(await repoHasWorktreeActivity(repoName, repoPath))) continue;
      try {
        await reconcileRepoRegistry({ repoName, repoPath, emit: deps.emit, log: deps.log });
      } catch (err) {
        deps.log.warn({ err, repo: repoName }, "worktree reconciler: reconcile pass failed");
      }
      // Separate catches throughout: any one duty throwing must not cost the
      // next repo (or the next duty) its own pass.
      try {
        await detectTransitions({
          repoName,
          repoPath,
          cacheEntries: deps.cache.entries,
          emit: deps.emit,
          log: deps.log,
        });
      } catch (err) {
        deps.log.warn({ err, repo: repoName }, "worktree reconciler: merge reactor pass failed");
      }

      if (!appConfig.enabled) continue;

      try {
        await freshenRepo({ repoName, repoPath, emit: deps.emit, log: deps.log });
      } catch (err) {
        deps.log.warn({ err, repo: repoName }, "worktree reconciler: freshen pass failed");
      }
      try {
        await replenishAndShrink(
          { repoName, repoPath, emit: deps.emit, log: deps.log },
          creationPromises,
          appConfig,
        );
      } catch (err) {
        deps.log.warn({ err, repo: repoName }, "worktree reconciler: replenish/shrink pass failed");
      }
      try {
        await reapRepoTrash({ repoName, repoPath, log: deps.log });
      } catch (err) {
        deps.log.warn({ err, repo: repoName }, "worktree reconciler: trash reap pass failed");
      }
    }
  }

  function kick(): void {
    if (hold) {
      kickQueued = true;
      return;
    }
    if (inFlight) {
      // Two kicks landing before this pass has stepped into its per-repo
      // loop still collapse to one pass; once it has, a kick might be about
      // a repo already stepped past (its replenish already ran this pass),
      // so queue a follow-up rather than dropping it silently.
      if (passStartedWork) kickQueued = true;
      return;
    }
    passStartedWork = false;
    const p = runOnce()
      .catch((err) => {
        deps.log.warn({ err }, "worktree reconciler: kick failed");
      })
      .finally(() => {
        if (inFlight === p) inFlight = null;
        if (kickQueued) {
          kickQueued = false;
          kick();
        }
      });
    inFlight = p;
  }

  async function withReconcilerHeld<T>(fn: () => Promise<T>): Promise<T> {
    // Claiming the hold must stay synchronous from the last `hold` read to the
    // assignment below, or two woken waiters both see null and both run.
    while (hold) await hold;
    let release!: () => void;
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      // A pass that started before the hold was taken still reads the rows the
      // holder is about to rewrite, so it has to finish first.
      while (inFlight) await inFlight;
      return await fn();
    } finally {
      hold = null;
      release();
      if (kickQueued) {
        kickQueued = false;
        kick();
      }
    }
  }

  function creationInFlight(repoName: string): Promise<void> | null {
    return creationPromises.get(repoName) ?? null;
  }

  function passInFlight(): boolean {
    return inFlight !== null;
  }

  return { kick, runOnce, creationInFlight, passInFlight, withReconcilerHeld };
}

export const __test__ = {
  detectTransitions,
  reapRepoTrash,
  reactorStatePath: reactorTest.reactorStatePath,
  hasReactorState: reactorTest.hasReactorState,
  loadReactorState: reactorTest.loadReactorState,
  saveReactorState: reactorTest.saveReactorState,
  freshenRepo,
  freshenOne: freshenTest.freshenOne,
  replenishAndShrink,
  poolCounts,
  backoffDelayMs,
  createBackoff,
  MISSING_PRUNE_PASSES,
  hasFreeDiskGb,
  WORKTREE_ONDECK_CEILING,
  WORKTREE_MIN_FREE_DISK_GB,
  MR_TERMINAL_STATES,
  reconcilePass: reconcileTest.reconcilePass,
};
