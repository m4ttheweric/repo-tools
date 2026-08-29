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
import { statfsSync } from "fs";
import type { Logger } from "pino";
import {
  findByPath,
  loadRegistry,
  type TreeRecord,
} from "../worktree/registry.ts";
import { patchTree } from "../worktree/patch.ts";
import { MR_TERMINAL_STATES } from "../enrich.ts";
import {
  findDesktopStashAsync,
  headSha,
  MUTATING_TIMEOUT_MS,
  remoteDefaultRef,
  runGit,
  stashChangesAsync,
} from "../worktree/git-async.ts";
import { withTreeLock } from "../worktree/locks.ts";
import { ensureWorktreeRegistryRekeyed } from "../repo-index.ts";
import { createTree } from "../worktree/create.ts";
import { classifyDirtyAsync, disposeTree } from "../worktree/dispose.ts";
import { changedSince, stepsToRun, runReadySteps } from "../worktree/ready.ts";
import { MAX_LOGGED_OUTPUT, outputTail } from "../subprocess.ts";
import {
  loadWorktreeAppConfig,
  loadWorktreeRepoConfig,
  resolveReadySteps,
  worktreeSettingsDeclared,
  type WorktreeAppConfig,
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

export type { ReconcileDeps } from "./reconciler/reconcile.ts";
export type { ReactorDeps } from "./reconciler/reactor.ts";
export { reconcileRepo, reconcileRepoRegistry, detectTransitions };

export interface ReconcilerDeps {
  cache: { entries: Record<string, any> };
  repoIndex: () => Record<string, string>;
  emit: (type: string, data: unknown) => void;
  log: Logger;
}

// ─── Freshen (spec §6.3) ─────────────────────────────────────────────────────

const FRESHEN_FETCH_TIMEOUT_MS = 5 * 60_000;
/** The backoff "pass" unit: failure N waits pass * 2^(N-1), capped below. */
const FRESHEN_PASS_MS = 5 * 60_000;
const FRESHEN_MAX_BACKOFF_MS = 30 * 60_000;

/**
 * Delay after the Nth consecutive failure: one pass, doubled N-1 times, capped.
 * Shared by the freshen retry stamp and the per-repo create backoff (spec §6.4)
 *... both count in passes and both cap at 30 minutes.
 */
function backoffDelayMs(failures: number): number {
  return Math.min(FRESHEN_PASS_MS * 2 ** (failures - 1), FRESHEN_MAX_BACKOFF_MS);
}

export interface FreshenDeps {
  repoName: string;
  repoPath: string;
  emit: (type: string, data: unknown) => void;
  log: Logger;
}

/**
 * Whether a registered tree is a freshen candidate: any on-deck ephemeral
 * tree, or "idle main"... sitting on the default branch with no blocking dirt.
 * A main clone on a feature branch is the merge reactor's concern (auto-return
 * on merge); a main clone with real uncommitted work, even on the default
 * branch, is the user's and must be left alone.
 *
 * `rec.branch` is trusted as ground truth here rather than re-reading git:
 * `reconcileRepoRegistry` (T10) already ran earlier in the same `runOnce` pass
 * and synced it.
 */
async function freshenCandidate(deps: FreshenDeps, rec: TreeRecord): Promise<boolean> {
  if (rec.kind === "ephemeral") return rec.state === "on-deck";
  if (rec.kind !== "main") return false;
  // Idle-main freshen touches the user's own checkout, so it stays opt-in
  // even when ephemeral on-deck freshen is running.
  if (!loadWorktreeAppConfig().enabled) return false;

  const defaultRef = await remoteDefaultRef(rec.path);
  const defaultBranchName = defaultRef.replace(/^origin\//, "");
  if (rec.branch !== defaultBranchName) return false;

  const { blockers } = await classifyDirtyAsync(rec.path);
  return blockers.length === 0;
}

/**
 * Freshen one tree: fetch the default branch, ff-only merge it in, then run
 * whatever ready steps that advance triggers. Caller holds the tree lock and
 * has already verified `freshenCandidate` and that any `nextRetryAt` has
 * passed.
 *
 * `readyStamp` (and therefore future `changedSince` diffs) only advances when
 * a ready step actually ran and succeeded... a ff that triggers nothing hasn't
 * validated anything new, so claiming otherwise would let a later real change
 * hide behind a stamp nothing ever checked.
 */
async function freshenOne(deps: FreshenDeps, rec: TreeRecord): Promise<boolean> {
  const { repoName, log, emit } = deps;
  const fields = { repo: repoName, tree: rec.name, path: rec.path };

  const fail = (): void => {
    const failures = (rec.retryFailures ?? 0) + 1;
    const backoffMs = backoffDelayMs(failures);
    patchTree(repoName, rec.path, (r) => {
      r.retryFailures = failures;
      r.nextRetryAt = new Date(Date.now() + backoffMs).toISOString();
    });
  };

  const defaultRef = await remoteDefaultRef(rec.path);
  const defaultBranchName = defaultRef.replace(/^origin\//, "");

  const fetchResult = await runGit(rec.path, ["fetch", "origin", defaultBranchName], {
    timeoutMs: FRESHEN_FETCH_TIMEOUT_MS,
  });
  if (fetchResult.exitCode !== 0) {
    log.warn({ ...fields, output: fetchResult.stderr.trim() }, "freshen: fetch failed");
    fail();
    return false;
  }

  const classify = await classifyDirtyAsync(rec.path);
  if (classify.discard.length > 0) {
    await runGit(rec.path, ["checkout", "--", ...classify.discard], { timeoutMs: MUTATING_TIMEOUT_MS });
  }

  // Main can gain real edits any time during the fetch's (up to 5 minute)
  // window; a blocker here means the user is mid-edit, not a broken step, so
  // this leaves the tree untouched rather than stashing it out from under them.
  if (rec.kind === "main") {
    const recheck = await classifyDirtyAsync(rec.path);
    if (recheck.blockers.length > 0) {
      log.info({ ...fields }, "freshen: main gained uncommitted work during the fetch window; leaving it untouched");
      return false;
    }
  }

  let stashName: string | null = null;
  const popStash = async (): Promise<boolean> => {
    if (!stashName) return true;
    const pop = await runGit(rec.path, ["stash", "pop", stashName], { timeoutMs: MUTATING_TIMEOUT_MS });
    if (pop.exitCode !== 0) {
      log.warn(
        { ...fields, stashName },
        `freshen: stash ${stashName} did not reapply cleanly in ${rec.path}... it is preserved, restore it with: git stash pop ${stashName}`,
      );
      emit("worktree:stash-conflict", { repo: repoName, tree: rec.name, path: rec.path, stashName });
      return false;
    }
    return true;
  };

  // Blockers stashed under the tree's own branch name (Desktop-compatible
  // marker), harvested from parking-lot.ts's ff-sweep. On-deck trees are
  // expected to be clean by construction; the idle-main case can legitimately
  // have generated-only dirt left after the discard reset above.
  const label = rec.branch ?? rec.name;
  if (classify.blockers.length > 0) {
    const push = await stashChangesAsync(rec.path, label);
    if (push.exitCode !== 0) {
      log.warn(
        { ...fields, output: push.stderr.trim() },
        "freshen: stash push failed; leaving tree and stash untouched",
      );
      fail();
      return false;
    }
    // A resolved marker is required before any pop ... a positional index
    // guess can target an entry this pass never pushed if anything else
    // stashed concurrently, so an unresolved marker aborts rather than guesses.
    const resolved = await findDesktopStashAsync(rec.path, label);
    if (!resolved) {
      log.warn(
        { ...fields },
        "freshen: stash push succeeded but its marker could not be resolved; aborting without a pop",
      );
      fail();
      return false;
    }
    stashName = resolved.name;

    // Mirrors autoReturnMain's re-check: confirm the push actually cleared
    // the tree before the ff runs on top of it.
    const after = await runGit(rec.path, ["status", "--porcelain"], { timeoutMs: MUTATING_TIMEOUT_MS });
    if (after.exitCode !== 0 || after.stdout.trim().length > 0) {
      log.warn({ ...fields }, "freshen: stash did not clear the worktree; aborting");
      await popStash();
      fail();
      return false;
    }
  }

  const ff = await runGit(rec.path, ["merge", "--ff-only", defaultRef], { timeoutMs: MUTATING_TIMEOUT_MS });
  if (ff.exitCode !== 0) {
    log.warn({ ...fields, defaultRef, output: ff.stderr.trim() }, "freshen: fast-forward failed");
    await popStash();
    fail();
    return false;
  }
  if (!(await popStash())) {
    fail();
    return false;
  }

  const cfg = await loadWorktreeRepoConfig(repoName, deps.repoPath);
  const readySteps = resolveReadySteps(cfg, deps.repoPath);
  const changed = rec.readyStamp ? await changedSince(rec.path, rec.readyStamp) : null;
  const toRun = stepsToRun(readySteps, changed);

  const readyResult = await runReadySteps(rec.path, toRun);
  if (!readyResult.ok) {
    log.warn(
      {
        ...fields,
        failedStep: readyResult.failedStep,
        output: outputTail(readyResult.output, MAX_LOGGED_OUTPUT),
      },
      "freshen: ready step failed",
    );
    fail();
    return false;
  }

  const newStamp = toRun.length > 0 ? await headSha(rec.path) : null;
  patchTree(repoName, rec.path, (r) => {
    r.readyAt = new Date().toISOString();
    r.retryFailures = 0;
    delete r.nextRetryAt;
    if (newStamp) r.readyStamp = newStamp;
  });

  emit("worktree:freshened", { repo: repoName, tree: rec.name, path: rec.path });
  log.debug?.(fields, `worktree ${rec.name} freshened`);
  return true;
}

/**
 * Freshen every eligible tree in one repo, each under its own tree lock.
 *
 * `trees` is one snapshot for the whole pass, but candidacy for tree N+1
 * isn't evaluated until tree N's (potentially slow... real fetches, ready
 * steps) freshen finishes, so by the time a later tree's lock is acquired its
 * snapshot `rec` can be minutes stale: a provision claim (T13, same event
 * loop) could have landed in between. Re-reading the registry as the first
 * thing inside the lock and bailing on any state/branch drift closes that
 * window... the alternative is running a ff + ready steps inside a tree a
 * human just claimed.
 */
export async function freshenRepo(
  deps: FreshenDeps,
  opts: { only?: string } = {},
): Promise<string[]> {
  const { repoName, log } = deps;
  const now = Date.now();
  const trees = loadRegistry(repoName);
  const ran: string[] = [];
  for (const rec of trees) {
    if (opts.only && rec.name !== opts.only) continue;
    // Backoff is a shield for the unattended pass, not for a human who just
    // asked for this one tree by name: an explicit `only` retries now.
    if (!opts.only && rec.nextRetryAt && Date.parse(rec.nextRetryAt) > now) continue;
    if (!(await freshenCandidate(deps, rec))) continue;
    const outcome = await withTreeLock(rec.path, async () => {
      const fresh = findByPath(loadRegistry(repoName), rec.path);
      if (!fresh || fresh.state !== rec.state || fresh.branch !== rec.branch) {
        log.debug?.(
          { repo: repoName, tree: rec.name, path: rec.path },
          "freshen: skipping... tree changed since candidacy was decided",
        );
        return false;
      }
      return await freshenOne(deps, fresh);
    });
    if (outcome === true) ran.push(rec.name);
  }
  return ran;
}

// ─── Replenish / shrink (spec §6.4) ──────────────────────────────────────────

/**
 * Per-repo create backoff (spec §6.4): failure N waits one pass doubled N-1
 * times, capped at 30 minutes.
 *
 * A failed `createTree` scraps its own registry row, so there is no on-disk row
 * left to hang retry bookkeeping off... without this, a persistently failing
 * ready step (a broken install costing minutes per attempt) is retried on every
 * cache tick, forever. The state is deliberately in-memory, same as the
 * in-flight creation map above it: a daemon restart clearing the backoff costs
 * one wasted attempt, which is cheaper than persisting a transient.
 */
const createBackoff = new Map<string, { failures: number; nextRetryAt: string }>();

/**
 * S089: a provision's cold `createTree` (handlers/worktree.ts) and this
 * reconciler's own replenish `createTree` can run concurrently for the same
 * repo, both `git fetch origin <branch>` against the same repoPath... the
 * loser fails to lock refs/remotes/origin/<branch>, and that failure gets
 * charged to createBackoff (a 5-to-30-minute replenish hold) for what was
 * really just contention, not a genuine failure. Chained per repoPath so
 * concurrent callers queue instead of racing; a rejected holder still
 * releases the lock for the next one.
 */
const createLocks = new Map<string, Promise<void>>();

export function withCreateLock<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
  const prior = createLocks.get(repoPath) ?? Promise.resolve();
  const ready = prior.catch(() => {}); // a previous holder's rejection must not block the next one
  const result = ready.then(fn);
  const tracked: Promise<void> = result.then(() => undefined, () => undefined);
  createLocks.set(repoPath, tracked);
  void tracked.finally(() => {
    if (createLocks.get(repoPath) === tracked) createLocks.delete(repoPath);
  });
  return result;
}

// Machine-side clamp (S077): no team declaration builds more than this on one laptop.
const WORKTREE_ONDECK_CEILING = 5;
// Room for one tree plus a multi-GB monorepo install's transient peak (2026-08-21 wedge profile).
const WORKTREE_MIN_FREE_DISK_GB = 5;

/**
 * Free disk under `path`, in gigabytes, via statfs. A probe failure (path not
 * yet resolvable, permission) degrades to "enough disk" rather than blocking
 * replenish on a signal that was never meant to gate anything on its own.
 */
async function hasFreeDiskGb(path: string, gb: number): Promise<boolean> {
  try {
    const stats = statfsSync(path);
    return stats.bavail * stats.bsize >= gb * 1024 ** 3;
  } catch {
    return true;
  }
}

/** The active backoff deadline for a repo, or null when creates may run now. */
function createBlockedUntil(repoName: string): string | null {
  const entry = createBackoff.get(repoName);
  if (!entry) return null;
  return Date.parse(entry.nextRetryAt) > Date.now() ? entry.nextRetryAt : null;
}

function noteCreateFailure(repoName: string): { failures: number; nextRetryAt: string } {
  const failures = (createBackoff.get(repoName)?.failures ?? 0) + 1;
  const entry = {
    failures,
    nextRetryAt: new Date(Date.now() + backoffDelayMs(failures)).toISOString(),
  };
  createBackoff.set(repoName, entry);
  return entry;
}

/** On-deck / creating counts used to decide whether to grow or shrink the pool. */
function poolCounts(repoName: string): {
  ready: number;
  totalUnclaimed: number;
  onDeckEntries: TreeRecord[];
} {
  const trees = loadRegistry(repoName);
  const now = Date.now();
  const onDeckEntries = trees.filter((t) => t.kind === "ephemeral" && t.state === "on-deck");
  const creatingEntries = trees.filter((t) => t.kind === "ephemeral" && t.state === "creating");
  const ready = onDeckEntries.filter((t) => !t.nextRetryAt || Date.parse(t.nextRetryAt) <= now).length;
  return { ready, totalUnclaimed: onDeckEntries.length + creatingEntries.length, onDeckEntries };
}

/**
 * Grow the on-deck pool toward `onDeck` (serially... one `createTree` in
 * flight at a time, which `runOnce` awaiting each pass makes natural), then
 * shrink it back down by disposing the stalest ready entries when it's over.
 *
 * Replenish is bounded on both axes. Within a pass it is bounded to the deficit
 * measured once at the start, not re-derived from live state on every
 * iteration: `createTree` scraps its own registry row on failure, so an
 * always-failing config would otherwise re-read "still short" forever and spin
 * this pass indefinitely. Across passes it is bounded by `createBackoff`... the
 * first failure of a pass ends replenish for that repo and holds it off for the
 * doubling backoff window, so a broken ready step costs one multi-minute
 * attempt per window instead of `onDeck` attempts per cache tick.
 */
async function replenishAndShrink(
  deps: FreshenDeps,
  creationPromises: Map<string, Promise<void>>,
  appConfig: WorktreeAppConfig,
): Promise<void> {
  const { repoName, repoPath, emit, log } = deps;
  const cfg = await loadWorktreeRepoConfig(repoName, repoPath);
  // A store rung's onDeck is a team declaration; the ceiling is this machine's
  // own limit and always wins, so it clamps here rather than in the sanitizer.
  const onDeck = Math.min(cfg.onDeck, WORKTREE_ONDECK_CEILING);
  if (onDeck <= 0) return;

  let { ready, totalUnclaimed } = poolCounts(repoName);
  let budget = Math.max(0, onDeck - totalUnclaimed);
  while (budget > 0 && ready < onDeck && totalUnclaimed < onDeck) {
    // Checked per iteration, not once per pass: a failure recorded by the
    // attempt above must end this pass's replenish too, or the pass still
    // burns `onDeck` full builds on the same broken step.
    const blockedUntil = createBlockedUntil(repoName);
    if (blockedUntil) {
      log.debug?.(
        { repo: repoName, nextRetryAt: blockedUntil },
        "replenish: skipped... create backoff in effect",
      );
      break;
    }
    // cfg.root, not repoPath: createTree writes under cfg.root, and the RT-52
    // default root lives off-repo (~/.mattstack/rt/worktrees/<identity>), which
    // can be a different volume than the repo's own filesystem.
    if (!(await hasFreeDiskGb(cfg.root, WORKTREE_MIN_FREE_DISK_GB))) {
      log.warn({ repo: repoName }, "replenish: skipped, free disk below threshold");
      break;
    }
    budget--;
    const p: Promise<void> = withCreateLock(repoPath, () => createTree({ repoName, repoPath, emit, log }))
      .then((result) => {
        if (result.ok) {
          createBackoff.delete(repoName);
          return;
        }
        // "busy" is another holder of the tree lock, not a failing build: it
        // neither earns a backoff nor clears one.
        if (result.error === "busy") return;
        const { failures, nextRetryAt } = noteCreateFailure(repoName);
        log.warn(
          { repo: repoName, error: result.error, failedStep: result.failedStep, failures, nextRetryAt },
          "worktree reconciler: replenish create failed",
        );
      })
      .catch((err) => {
        const { failures, nextRetryAt } = noteCreateFailure(repoName);
        log.warn(
          { err, repo: repoName, failures, nextRetryAt },
          "worktree reconciler: replenish create threw",
        );
      })
      .finally(() => {
        if (creationPromises.get(repoName) === p) creationPromises.delete(repoName);
      });
    creationPromises.set(repoName, p);
    await p;
    ({ ready, totalUnclaimed } = poolCounts(repoName));
  }

  // `attempted` guards against spinning forever on an entry disposeTree keeps
  // refusing (e.g. a guard failure)... each path gets one shrink attempt per
  // pass; a refusal just leaves it for the next pass rather than looping here.
  let counts = poolCounts(repoName);
  const attempted = new Set<string>();
  while (counts.ready > onDeck) {
    const now = Date.now();
    const eligible = counts.onDeckEntries.filter(
      (t) => !attempted.has(t.path) && (!t.nextRetryAt || Date.parse(t.nextRetryAt) <= now),
    );
    if (eligible.length === 0) break;
    const stalest = eligible.reduce((a, b) =>
      Date.parse(a.readyAt ?? a.createdAt) <= Date.parse(b.readyAt ?? b.createdAt) ? a : b,
    );
    attempted.add(stalest.path);
    await withTreeLock(stalest.path, async () => {
      // Same revalidation as freshen: `stalest` is a snapshot from this
      // iteration's `poolCounts()` read; re-check it under the lock before
      // disposing so a claim that landed since (no grace guard applies here...
      // auto is false) can't get its tree deleted out from under it.
      const fresh = findByPath(loadRegistry(repoName), stalest.path);
      if (!fresh || fresh.kind !== "ephemeral" || fresh.state !== "on-deck") {
        log.debug?.(
          { repo: repoName, tree: stalest.name, path: stalest.path },
          "shrink: skipping... tree changed since candidacy was decided",
        );
        return;
      }
      await disposeTree(
        { repoName, repoPath, cacheEntries: {}, emit, log, killProcesses: appConfig.killProcesses },
        fresh,
        { auto: false },
      );
    });
    counts = poolCounts(repoName);
  }
}

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
  freshenOne,
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
