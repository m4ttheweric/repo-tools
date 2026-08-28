/**
 * Worktree reconciler — brings the on-disk registry back in line with git
 * ground truth, then reacts to the MR transitions that end a tree's life.
 * Task 12 extends `runOnce` in place with the freshen and replenish/shrink
 * passes, so structure here is deliberately left open for that: each duty is
 * a standalone step `runOnce` calls per repo, and `createWorktreeReconciler`'s
 * returned object is the single surface later tasks add to (e.g.
 * `creationInFlight`).
 */

import { basename, join } from "path";
import { realpathSync } from "fs";
import type { Logger } from "pino";
import { rtDir } from "../rt-paths.ts";
import { getKvValue, hasKvValue, importLegacyJsonFile, renameLegacyOutOfTheWay, setKvValue } from "../state/index.ts";
import {
  findByBranch,
  findByPath,
  loadRegistry,
  registryEpoch,
  saveRegistry,
  type TreeKind,
  type TreeRecord,
} from "../worktree/registry.ts";
import {
  branchExistsLocalAsync,
  currentBranchAsync,
  findDesktopStashAsync,
  gitOk,
  headSha,
  listWorktreesAsync,
  MUTATING_TIMEOUT_MS,
  remoteDefaultRef,
  runGit,
  stashChangesAsync,
  type WorktreeEntry,
} from "../worktree/git-async.ts";
import { isTreeLocked, withTreeLock } from "../worktree/locks.ts";
import { ensureWorktreeRegistryRekeyed } from "../repo-index.ts";
import { createTree, scrapTree, type CreateDeps } from "../worktree/create.ts";
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
import { killWorktreeProcesses } from "./worktree-process-kill.ts";
import { reapExpiredTrash, reapTrashInRoots } from "../worktree/trash.ts";

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

export interface ReconcileDeps {
  repoName: string;
  repoPath: string;
  emit: (type: string, data: unknown) => void;
  log: Logger;
  /**
   * Test-only seam, invoked right after an attempt captures its registry
   * snapshot and epoch — the exact window a competing writer (a provision
   * claim, a dispose prune) lands in on the shared event loop. Production
   * callers never pass it.
   */
  onAfterLoad?: (attempt: number) => void;
}

/** One attempt's outcome: its trees, or "a concurrent write invalidated me". */
type PassResult = { trees: TreeRecord[] } | { conflict: true };

/** Attempts before a contended pass gives up and leaves the work to the next tick. */
const RECONCILE_MAX_ATTEMPTS = 3;

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
 * — a pass that keeps losing simply skips its save and lets the next tick redo
 * it, since every correction here is derived from ground truth and idempotent.
 */
export async function reconcileRepoRegistry(deps: ReconcileDeps): Promise<TreeRecord[]> {
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

async function reconcilePass(deps: ReconcileDeps, attempt: number): Promise<PassResult> {
  const { repoName, repoPath, emit, log } = deps;

  await runGit(repoPath, ["worktree", "prune"]);

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
    // Check and save in one synchronous block — an await between them would
    // reopen the very window this closes.
    if (registryEpoch(repoName) !== epoch) return { conflict: true };
    saveRegistry(repoName, trees);
  }

  return { trees };
}

// ─── Merge reactor (spec §6.2) ───────────────────────────────────────────────

/**
 * The reactor's own memory, at `~/.mattstack/rt/worktree-reactor-state.json`.
 *
 * `mrState` is the last-seen MR state per `<repo>:<branch>`, compared against
 * the live cache to find `opened → merged|closed` edges. A branch the file has
 * never seen fails the `prev === "opened"` gate, which is what makes a cold
 * boot on an already-merged cache entry a no-op rather than a mass disposal.
 *
 * `fired` is keyed by MR, not branch: `disposed:<repo>:<mr-iid>:<state>`.
 * Branch keys are wrong here because this design derives branch names from
 * tickets, so a recut MR reuses the branch and a branch-keyed fire would
 * silently never act a second time. The MR's keys are pruned when it returns
 * to `opened`.
 */
interface ReactorState {
  mrState: Record<string, string | null>;
  fired: string[];
}

const REACTOR_STATE_NS = "worktree-reactor";
const REACTOR_STATE_KEY = "state";

/** Retired storage location — kept only so a leftover pre-migration file can be imported once, then renamed out of the way. */
export function reactorStatePath(): string {
  return join(rtDir(), "worktree-reactor-state.json");
}

function normalizeReactorState(raw: Partial<ReactorState> | null | undefined): ReactorState {
  return {
    mrState: raw?.mrState ?? {},
    fired: Array.isArray(raw?.fired) ? raw.fired : [],
  };
}

function loadReactorState(): ReactorState {
  if (hasKvValue(REACTOR_STATE_NS, REACTOR_STATE_KEY)) {
    return normalizeReactorState(getKvValue<Partial<ReactorState>>(REACTOR_STATE_NS, REACTOR_STATE_KEY, {}));
  }

  const result = importLegacyJsonFile<ReactorState>(reactorStatePath(), (json) => {
    const state = normalizeReactorState(json as Partial<ReactorState> | null);
    setKvValue(REACTOR_STATE_NS, REACTOR_STATE_KEY, state);
    return state;
  }, { verifyPersisted: () => hasKvValue(REACTOR_STATE_NS, REACTOR_STATE_KEY) });
  return result.imported ? result.value! : normalizeReactorState({});
}

function saveReactorState(state: ReactorState, log: Logger): void {
  try {
    setKvValue(REACTOR_STATE_NS, REACTOR_STATE_KEY, state);
    renameLegacyOutOfTheWay(reactorStatePath());
  } catch (err) {
    log.warn({ err }, "worktree reactor: could not persist state");
  }
}

/** Branch-keyed MR cache entry, as the daemon holds it (`ctx.cache.entries`). */
interface ReactorCacheEntry {
  mr?: { iid?: number; state?: string | null } | null;
  repoName?: string;
}

export interface ReactorDeps {
  repoName: string;
  repoPath: string;
  /** Branch-keyed MR cache (daemon `ctx.cache.entries`). */
  cacheEntries: Record<string, ReactorCacheEntry>;
  emit: (type: string, data: unknown) => void;
  log: Logger;
}

const TERMINAL_STATES = new Set(["merged", "closed"]);

/**
 * What one tree's reaction did, which is also what the snapshot is allowed to
 * do afterwards:
 *  - `done`  — nothing to react to (wrong kind, job disposal, main already
 *              moved on). The edge is spent; advance the snapshot.
 *  - `fired` — the reaction happened (disposed / flipped disposable /
 *              auto-returned). Advance the snapshot AND record the fired key
 *              so a cache churn can't re-notify.
 *  - `retry` — the reaction failed for a mechanical, transient reason. The
 *              snapshot must stay at "opened" or the edge never re-arms; this
 *              is the correctness fix over the harvested parking-lot version,
 *              which advanced the snapshot unconditionally and so silently
 *              defeated its own retry.
 */
type Reaction = "done" | "fired" | "retry";

/** Load-mutate-save one registry row without clobbering concurrent edits. */
function patchTree(repoName: string, path: string, patch: (rec: TreeRecord) => void): void {
  const trees = loadRegistry(repoName);
  const rec = trees.find((t) => t.path === path);
  if (!rec) return;
  patch(rec);
  saveRegistry(repoName, trees);
}

function markDisposable(deps: ReactorDeps, rec: TreeRecord, reason: string): void {
  patchTree(deps.repoName, rec.path, (r) => {
    r.state = "disposable";
    r.disposableReason = reason;
  });
  deps.emit("worktree:disposable", {
    repo: deps.repoName,
    tree: rec.name,
    path: rec.path,
    branch: rec.branch,
    reason,
  });
  deps.log.info(
    { repo: deps.repoName, tree: rec.name, reason },
    `worktree ${rec.name} is disposable: ${reason}`,
  );
}

/**
 * Return the main clone to its default branch after its branch merged.
 *
 * Harvested from `park()` minus the parking-slot branch: verify main is still
 * on the merged branch, stop its workload, stash-and-LEAVE any dirt under the
 * GitHub Desktop-compatible marker keyed to the branch that left, check out the
 * default branch, fast-forward it. The stash is deliberately never popped — it
 * belongs to the merged branch, not to the default branch main now sits on.
 *
 * Any mechanical failure returns "retry" so the snapshot holds and the next
 * pass tries again; main has no disposable-equivalent state to park a failure
 * in, so without the retry a transient failure would strand main on a dead
 * branch forever.
 */
async function autoReturnMain(
  deps: ReactorDeps,
  rec: TreeRecord,
  mergedBranch: string,
  appConfig: WorktreeAppConfig,
): Promise<Reaction> {
  const { repoName, log } = deps;
  const fields = { repo: repoName, tree: rec.name, path: rec.path, branch: mergedBranch };

  const current = await currentBranchAsync(rec.path);
  if (current !== mergedBranch) {
    log.debug?.({ ...fields, current }, "auto-return skipped: main is no longer on the merged branch");
    return "done";
  }

  // Resolve and vet the destination BEFORE touching anything. Every step below
  // is destructive-ish (kill, stash) and every failure after them re-arms the
  // edge, so a destination that can never work would stash the user's dirt and
  // then spin on it forever. Both of these are configurations, not transients:
  // they return "done" (edge spent) with one warn, not "retry".
  const defaultRef = await remoteDefaultRef(rec.path);
  const defaultBranch = defaultRef.replace(/^origin\//, "");

  // (a) remoteDefaultRef falls back to "origin/master" unverified, so a repo
  //     whose default is develop/trunk yields a ref that resolves nowhere and a
  //     checkout that can never succeed.
  const haveLocal = await branchExistsLocalAsync(rec.path, defaultBranch);
  const haveRemote = await gitOk(rec.path, ["rev-parse", "--verify", defaultRef]);
  if (!haveLocal && !haveRemote) {
    log.warn(
      { ...fields, defaultRef },
      `auto-return skipped: neither ${defaultBranch} nor ${defaultRef} exists — set the repo's default branch`,
    );
    return "done";
  }

  // (b) git refuses to check out a branch another worktree holds. park()
  //     refused up front for exactly this; without the check the checkout
  //     fails after the stash and retries every pass.
  const gitEntries = await listWorktreesAsync(deps.repoPath);
  if (gitEntries === null) {
    log.warn({ ...fields }, "auto-return: git worktree list failed; retrying next pass");
    return "retry";
  }
  const holder = gitEntries.find(
    (w) => w.branch === defaultBranch && canon(w.path) !== canon(rec.path),
  );
  if (holder) {
    log.warn(
      { ...fields, defaultBranch, holder: holder.path },
      `auto-return skipped: ${defaultBranch} is checked out at ${holder.path}`,
    );
    return "done";
  }

  if (appConfig.killProcesses) {
    // The ruled execSync exception (the process killer is sync by design);
    // a failure here never blocks the return.
    try {
      const { terminated } = killWorktreeProcesses(rec.path);
      if (terminated.length > 0) log.info({ ...fields, count: terminated.length }, "worktree processes terminated");
    } catch (err) {
      log.warn({ err, ...fields }, "auto-return: process kill failed; returning anyway");
    }
  }

  const status = await runGit(rec.path, ["status", "--porcelain"], { timeoutMs: MUTATING_TIMEOUT_MS });
  if (status.exitCode !== 0) {
    log.warn({ ...fields, output: status.stderr.trim() }, "auto-return: git status failed");
    return "retry";
  }
  if (status.stdout.trim().length > 0) {
    await stashChangesAsync(rec.path, mergedBranch);
    const after = await runGit(rec.path, ["status", "--porcelain"], { timeoutMs: MUTATING_TIMEOUT_MS });
    if (after.exitCode !== 0 || after.stdout.trim().length > 0) {
      log.warn({ ...fields }, "auto-return: stash did not clear the worktree");
      return "retry";
    }
    log.info({ ...fields }, `stashed uncommitted changes on "${mergedBranch}"`);
  }

  const checkout = await runGit(rec.path, ["checkout", defaultBranch], { timeoutMs: MUTATING_TIMEOUT_MS });
  if (checkout.exitCode !== 0) {
    log.warn({ ...fields, defaultBranch, output: checkout.stderr.trim() }, "auto-return: checkout failed");
    return "retry";
  }

  const ff = await runGit(rec.path, ["merge", "--ff-only", defaultRef], { timeoutMs: MUTATING_TIMEOUT_MS });
  if (ff.exitCode !== 0) {
    log.warn({ ...fields, defaultRef, output: ff.stderr.trim() }, "auto-return: fast-forward failed");
    return "retry";
  }

  // Ground truth now, not next reconcile: `rt worktree list` must not show
  // main sitting on a branch it already left.
  patchTree(repoName, rec.path, (r) => {
    r.branch = defaultBranch;
  });

  log.info({ ...fields, defaultRef }, `returned ${rec.name} to ${defaultBranch} after ${mergedBranch} merged`);
  return "fired";
}

/** React to one terminal MR state on one registered tree. Caller holds the tree lock. */
async function actOnTree(
  deps: ReactorDeps,
  rec: TreeRecord,
  branch: string,
  mrState: string,
  appConfig: WorktreeAppConfig,
): Promise<Reaction> {
  if (rec.kind === "main") {
    // Closed-without-merge leaves main alone: the branch's commits are still
    // only on that branch, and a closed MR often means recut.
    return mrState === "merged" ? autoReturnMain(deps, rec, branch, appConfig) : "done";
  }
  if (rec.kind !== "ephemeral") return "done";
  // Job trees are the caller's to end, MR or no MR.
  if (rec.disposal === "job") return "done";
  // claimed AND disposable both react, so a reopened-then-merged MR still
  // disposes; on-deck/creating trees never carry MR branches.
  if (rec.state !== "claimed" && rec.state !== "disposable") return "done";

  if (mrState === "closed") {
    markDisposable(deps, rec, "MR closed without merge");
    return "fired";
  }

  const outcome = await disposeTree(
    {
      repoName: deps.repoName,
      repoPath: deps.repoPath,
      cacheEntries: deps.cacheEntries as Record<string, { mr: any; repoName?: string }>,
      emit: deps.emit,
      log: deps.log,
      killProcesses: appConfig.killProcesses,
    },
    rec,
    { auto: true },
  );
  if (outcome.disposed) return "fired";

  // "remove-failed" is mechanical and transient (a locked file, a busy
  // directory) — the tree is still perfectly claimable, so it must NOT be
  // advertised as disposable. Hold the edge and try again next pass.
  if (outcome.refusal === "remove-failed") {
    deps.log.warn(
      { repo: deps.repoName, tree: rec.name, path: rec.path },
      "auto-dispose: worktree removal failed; retrying next pass",
    );
    return "retry";
  }

  markDisposable(deps, rec, outcome.refusal);
  return "fired";
}

/** Worst outcome wins: any retry re-arms the edge, otherwise any fire records it. */
function worse(a: Reaction, b: Reaction): Reaction {
  if (a === "retry" || b === "retry") return "retry";
  if (a === "fired" || b === "fired") return "fired";
  return "done";
}

/** An MR back to `opened` un-disposables the trees on its branch: work resumed. */
async function resumeTrees(deps: ReactorDeps, branch: string): Promise<void> {
  for (const rec of findByBranch(loadRegistry(deps.repoName), branch)) {
    if (rec.kind !== "ephemeral" || rec.state !== "disposable") continue;
    await withTreeLock(rec.path, async () => {
      patchTree(deps.repoName, rec.path, (r) => {
        r.state = "claimed";
        delete r.disposableReason;
      });
      deps.log.info(
        { repo: deps.repoName, tree: rec.name, branch },
        `MR reopened — ${rec.name} is claimed again`,
      );
    });
  }
}

/**
 * Detect `opened → merged|closed` MR transitions for one repo and react.
 *
 * Port of `parking-lot.ts` checkAndPark's detector with three deliberate
 * changes: the retry fix (see `Reaction`), MR-keyed fired keys with reopen
 * pruning, and a merged/closed/reopened dispatch that branches on tree kind
 * and disposal mode instead of parking everything onto a slot branch.
 */
export async function detectTransitions(deps: ReactorDeps): Promise<void> {
  const { repoName, cacheEntries, log } = deps;
  const appConfig = loadWorktreeAppConfig();
  if (!appConfig.enabled) return;

  const state = loadReactorState();
  const fired = new Set(state.fired);

  // Snapshots are per repo; other repos' keys ride through untouched so a
  // single-repo pass can't erase their memory, while this repo's stale
  // branches drop out by being rebuilt from the live cache.
  const prefix = `${repoName}:`;
  const nextMrState: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(state.mrState)) {
    if (!key.startsWith(prefix)) nextMrState[key] = value;
  }

  for (const [branch, entry] of Object.entries(cacheEntries)) {
    // Unattributed entries (older caches predate repoName) may join any repo;
    // an entry attributed elsewhere never does.
    if (entry.repoName && entry.repoName !== repoName) continue;
    if (!entry.mr) continue;

    const cur = entry.mr.state ?? null;
    const key = prefix + branch;
    const prev = state.mrState[key] ?? null;
    const iid = typeof entry.mr.iid === "number" ? String(entry.mr.iid) : branch;

    if (cur === "opened") {
      nextMrState[key] = "opened";
      // Reopen: forget this MR's fires so a later merge acts again, and hand
      // any disposable tree back to its owner.
      for (const fireKey of [...fired]) {
        if (fireKey.startsWith(`disposed:${repoName}:${iid}:`)) fired.delete(fireKey);
      }
      await resumeTrees(deps, branch);
      continue;
    }

    nextMrState[key] = cur;
    if (prev !== "opened") continue; // cold-boot safety: unknown prev never fires
    if (!cur || !TERMINAL_STATES.has(cur)) continue;

    const fireKey = `disposed:${repoName}:${iid}:${cur}`;
    if (fired.has(fireKey)) continue;

    const trees = findByBranch(loadRegistry(repoName), branch);
    if (trees.length === 0) {
      log.debug?.({ repo: repoName, branch, mrState: cur }, "reactor: no registered tree on the branch");
      continue;
    }

    let reaction: Reaction = "done";
    for (const rec of trees) {
      const result = await withTreeLock(rec.path, () => actOnTree(deps, rec, branch, cur, appConfig));
      // A locked tree is someone else's in-flight work; come back next pass.
      reaction = worse(reaction, result === "busy" ? "retry" : result);
    }

    if (reaction === "retry") nextMrState[key] = "opened";
    else if (reaction === "fired") fired.add(fireKey);
  }

  saveReactorState({ mrState: nextMrState, fired: [...fired] }, log);
}

// ─── Freshen (spec §6.3) ─────────────────────────────────────────────────────

const FRESHEN_FETCH_TIMEOUT_MS = 5 * 60_000;
/** The backoff "pass" unit: failure N waits pass * 2^(N-1), capped below. */
const FRESHEN_PASS_MS = 5 * 60_000;
const FRESHEN_MAX_BACKOFF_MS = 30 * 60_000;

/**
 * Delay after the Nth consecutive failure: one pass, doubled N-1 times, capped.
 * Shared by the freshen retry stamp and the per-repo create backoff (spec §6.4)
 * — both count in passes and both cap at 30 minutes.
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
 * tree, or "idle main" — sitting on the default branch with no blocking dirt.
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
 * a ready step actually ran and succeeded — a ff that triggers nothing hasn't
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

  // Blockers stashed under the tree's own branch name (Desktop-compatible
  // marker), harvested from parking-lot.ts's ff-sweep. On-deck trees are
  // expected to be clean by construction; the idle-main case can legitimately
  // have generated-only dirt left after the discard reset above.
  let stashName: string | null = null;
  const label = rec.branch ?? rec.name;
  if (classify.blockers.length > 0) {
    await stashChangesAsync(rec.path, label);
    // A pushed stash whose name we then fail to resolve must still get a
    // restore attempt, not be silently abandoned — "stash@{0}" is the entry
    // we just pushed absent a race with something else stashing concurrently
    // (harvested fallback from parking-lot.ts's ff-sweep).
    stashName = (await findDesktopStashAsync(rec.path, label))?.name ?? "stash@{0}";
  }

  const popStash = async (): Promise<void> => {
    if (!stashName) return;
    const pop = await runGit(rec.path, ["stash", "pop", stashName], { timeoutMs: MUTATING_TIMEOUT_MS });
    if (pop.exitCode !== 0) {
      log.warn(
        { ...fields, stashName },
        `freshen: stash ${stashName} did not reapply cleanly in ${rec.path}... it is preserved, restore it with: git stash pop ${stashName}`,
      );
    }
  };

  const ff = await runGit(rec.path, ["merge", "--ff-only", defaultRef], { timeoutMs: MUTATING_TIMEOUT_MS });
  if (ff.exitCode !== 0) {
    log.warn({ ...fields, defaultRef, output: ff.stderr.trim() }, "freshen: fast-forward failed");
    await popStash();
    fail();
    return false;
  }
  await popStash();

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
 * isn't evaluated until tree N's (potentially slow — real fetches, ready
 * steps) freshen finishes, so by the time a later tree's lock is acquired its
 * snapshot `rec` can be minutes stale: a provision claim (T13, same event
 * loop) could have landed in between. Re-reading the registry as the first
 * thing inside the lock and bailing on any state/branch drift closes that
 * window — the alternative is running a ff + ready steps inside a tree a
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
          "freshen: skipping — tree changed since candidacy was decided",
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
 * left to hang retry bookkeeping off — without this, a persistently failing
 * ready step (a broken install costing minutes per attempt) is retried on every
 * cache tick, forever. The state is deliberately in-memory, same as the
 * in-flight creation map above it: a daemon restart clearing the backoff costs
 * one wasted attempt, which is cheaper than persisting a transient.
 */
const createBackoff = new Map<string, { failures: number; nextRetryAt: string }>();

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
 * Grow the on-deck pool toward `onDeck` (serially — one `createTree` in
 * flight at a time, which `runOnce` awaiting each pass makes natural), then
 * shrink it back down by disposing the stalest ready entries when it's over.
 *
 * Replenish is bounded on both axes. Within a pass it is bounded to the deficit
 * measured once at the start, not re-derived from live state on every
 * iteration: `createTree` scraps its own registry row on failure, so an
 * always-failing config would otherwise re-read "still short" forever and spin
 * this pass indefinitely. Across passes it is bounded by `createBackoff` — the
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
  if (cfg.onDeck <= 0) return;

  let { ready, totalUnclaimed } = poolCounts(repoName);
  let budget = Math.max(0, cfg.onDeck - totalUnclaimed);
  while (budget > 0 && ready < cfg.onDeck && totalUnclaimed < cfg.onDeck) {
    // Checked per iteration, not once per pass: a failure recorded by the
    // attempt above must end this pass's replenish too, or the pass still
    // burns `onDeck` full builds on the same broken step.
    const blockedUntil = createBlockedUntil(repoName);
    if (blockedUntil) {
      log.debug?.(
        { repo: repoName, nextRetryAt: blockedUntil },
        "replenish: skipped — create backoff in effect",
      );
      break;
    }
    budget--;
    const p: Promise<void> = createTree({ repoName, repoPath, emit, log })
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
  // refusing (e.g. a guard failure) — each path gets one shrink attempt per
  // pass; a refusal just leaves it for the next pass rather than looping here.
  let counts = poolCounts(repoName);
  const attempted = new Set<string>();
  while (counts.ready > cfg.onDeck) {
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
      // disposing so a claim that landed since (no grace guard applies here —
      // auto is false) can't get its tree deleted out from under it.
      const fresh = findByPath(loadRegistry(repoName), stalest.path);
      if (!fresh || fresh.kind !== "ephemeral" || fresh.state !== "on-deck") {
        log.debug?.(
          { repo: repoName, tree: stalest.name, path: stalest.path },
          "shrink: skipping — tree changed since candidacy was decided",
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
 * Crash leftovers — sibling `.trash-*` dirs from a disposal whose detached
 * delete died (daemon crash, reboot) — are reaped immediately: nobody will
 * ever look at them again, so a crash costs disk and nothing else. Both roots
 * are swept, the repo's default `.worktrees` and whatever root the repo config
 * declares, because a root that changed after a disposal still has the old
 * root's leftovers in it.
 *
 * Retained trees — `.worktrees/.trash/<name>-<epoch>` entries, where disposal
 * parks trees stripped-but-recoverable (RT-51) — are reaped only past the
 * retention window.
 */
async function reapRepoTrash(deps: { repoName: string; repoPath: string; log: Logger }): Promise<void> {
  const { repoName, repoPath, log } = deps;
  const cfg = await loadWorktreeRepoConfig(repoName, repoPath);
  const reaped = await reapTrashInRoots([join(repoPath, ".worktrees"), cfg.root], log);
  if (reaped > 0) log.info({ repo: repoName, count: reaped }, "worktree trash reaped");
  const expired = await reapExpiredTrash(repoPath, log);
  if (expired > 0) log.info({ repo: repoName, count: expired }, "worktree retention trash reaped");
}

/**
 * Whether a repo has any worktree state worth reconciling: registry entries, or
 * an `rt.worktrees` declaration on any rung stronger than the registry default.
 *
 * Since RT-47 the declaration can live in a settings store as well as in the
 * legacy per-repo config.json, so this asks the reader rather than the file —
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
   *  test that calls `kick()` (deliberately not awaited — that's the point of
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
  reactorStatePath,
  hasReactorState: () => getKvValue<ReactorState | null>(REACTOR_STATE_NS, REACTOR_STATE_KEY, null) !== null,
  loadReactorState,
  saveReactorState,
  freshenRepo,
  replenishAndShrink,
  poolCounts,
  backoffDelayMs,
  createBackoff,
};
