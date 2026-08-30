/**
 * Merge reactor duty (spec §6.2): detects `opened -> merged|closed` MR
 * transitions and reacts (dispose, mark disposable, auto-return main), plus
 * the fired-ledger GC (R049): a `disposed:<repo>:<iid>:*` key is dropped once
 * its MR's cache entry is gone (the branch-cache GC already bounds that set),
 * so a reopened MR under the same iid re-notifies instead of the ledger
 * growing forever.
 */

import { join } from "path";
import type { Logger } from "pino";
import { canon } from "../../fs-canon.ts";
import { rtDir } from "../../rt-paths.ts";
import { getKvValue, hasKvValue, importLegacyJsonFile, renameLegacyOutOfTheWay, setKvValue } from "../../state/index.ts";
import { findByBranch, loadRegistry, type TreeRecord } from "../../worktree/registry.ts";
import { patchTree } from "../../worktree/patch.ts";
import { MR_TERMINAL_STATES } from "../../enrich.ts";
import {
  branchExistsLocalAsync,
  currentBranchAsync,
  findDesktopStashAsync,
  gitOk,
  listWorktreesAsync,
  MUTATING_TIMEOUT_MS,
  remoteDefaultRef,
  runGit,
  stashChangesAsync,
} from "../../worktree/git-async.ts";
import { withTreeLock } from "../../worktree/locks.ts";
import { branchOf } from "../../state/branch-cache.ts";
import { classifyDirtyAsync, disposeTree } from "../../worktree/dispose.ts";
import { loadWorktreeAppConfig, type WorktreeAppConfig } from "../../worktree/config.ts";
import { killWorktreeProcesses } from "../worktree-process-kill.ts";

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
 * to `opened`, and (R049) when the MR's cache entry vanishes entirely.
 */
interface ReactorState {
  mrState: Record<string, string | null>;
  fired: string[];
}

const REACTOR_STATE_NS = "worktree-reactor";
const REACTOR_STATE_KEY = "state";

/** Retired storage location... kept only so a leftover pre-migration file can be imported once, then renamed out of the way. */
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

/**
 * What one tree's reaction did, which is also what the snapshot is allowed to
 * do afterwards:
 *  - `done` ... nothing to react to (wrong kind, job disposal, main already
 *              moved on). The edge is spent; advance the snapshot.
 *  - `fired`... the reaction happened (disposed / flipped disposable /
 *              auto-returned). Advance the snapshot AND record the fired key
 *              so a cache churn can't re-notify.
 *  - `retry`... the reaction failed for a mechanical, transient reason. The
 *              snapshot must stay at "opened" or the edge never re-arms; this
 *              is the correctness fix over the harvested parking-lot version,
 *              which advanced the snapshot unconditionally and so silently
 *              defeated its own retry.
 */
type Reaction = "done" | "fired" | "retry";

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
 * default branch, fast-forward it. The stash is deliberately never popped... it
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
      `auto-return skipped: neither ${defaultBranch} nor ${defaultRef} exists... set the repo's default branch`,
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
    // A failure here never blocks the return.
    try {
      // Sibling trees' paths never belong to this kill, even a nested checkout
      // whose cwd sits underneath rec.path.
      const siblings = loadRegistry(repoName)
        .filter((t) => t.path !== rec.path)
        .map((t) => t.path);
      const { terminated } = await killWorktreeProcesses(rec.path, { excludePaths: siblings });
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

  // disposeTree's joinedMr looks up by the BARE branch (its own contract,
  // unaware of the composite `${identity}:${branch}` keys this repo's
  // cache map now carries): hand it a bare-keyed, this-repo-only view so a
  // same-named branch in another repo can never shadow the real entry.
  const scopedEntries: Record<string, ReactorCacheEntry> = {};
  for (const [key, entry] of Object.entries(deps.cacheEntries)) {
    if (entry.repoName && entry.repoName !== deps.repoName) continue;
    scopedEntries[branchOf(key)] = entry;
  }

  const outcome = await disposeTree(
    {
      repoName: deps.repoName,
      repoPath: deps.repoPath,
      cacheEntries: scopedEntries as Record<string, { mr: any; repoName?: string }>,
      emit: deps.emit,
      log: deps.log,
      killProcesses: appConfig.killProcesses,
    },
    rec,
    { auto: true },
  );
  if (outcome.disposed) return "fired";

  // "remove-failed" is mechanical and transient (a locked file, a busy
  // directory)... the tree is still perfectly claimable, so it must NOT be
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
        `MR reopened... ${rec.name} is claimed again`,
      );
    });
  }
}

/**
 * The MR identifiers this repo's cache currently knows about, in the same
 * shape a fired key's `<iid>` segment uses: the MR's numeric iid when the
 * cache carries one, the branch name otherwise. Backs the fired-ledger GC
 * (R049): an id absent here has no cache entry left at all (evicted by the
 * branch-cache's own GC), as opposed to one merely not `opened` right now.
 */
function liveMrIdsForRepo(repoName: string, cacheEntries: Record<string, ReactorCacheEntry>): Set<string> {
  const ids = new Set<string>();
  for (const [mapKey, entry] of Object.entries(cacheEntries)) {
    if (entry.repoName && entry.repoName !== repoName) continue;
    if (!entry.mr) continue;
    const branch = branchOf(mapKey);
    const iid = typeof entry.mr.iid === "number" ? String(entry.mr.iid) : branch;
    ids.add(iid);
  }
  return ids;
}

/**
 * R049: drop `disposed:<repo>:<iid>:*` keys whose MR no longer has ANY cache
 * entry for this repo. This is distinct from the reopen pruning below it:
 * reopen prunes a specific iid it just saw come back to `opened`; this
 * prunes iids the cache has forgotten entirely, which reopen never sees.
 * Without it the ledger only ever grows: a disposed MR whose branch-cache row
 * later ages out (lib/state/branch-cache.ts gc()) leaves its fired key
 * stranded forever, and a recut MR that happens to land on the same iid
 * would then never re-fire.
 */
function gcFiredLedger(repoName: string, fired: Set<string>, liveIds: Set<string>): void {
  const prefix = `disposed:${repoName}:`;
  for (const key of fired) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    const sep = rest.indexOf(":");
    const iid = sep < 0 ? rest : rest.slice(0, sep);
    if (!liveIds.has(iid)) fired.delete(key);
  }
}

/**
 * Detect `opened → merged|closed` MR transitions for one repo and react.
 *
 * Port of `parking-lot.ts` checkAndPark's detector with four deliberate
 * changes: the retry fix (see `Reaction`), MR-keyed fired keys with reopen
 * pruning, the fired-ledger GC (R049), and a merged/closed/reopened dispatch
 * that branches on tree kind and disposal mode instead of parking everything
 * onto a slot branch.
 */
export async function detectTransitions(deps: ReactorDeps): Promise<void> {
  const { repoName, cacheEntries, log } = deps;
  const appConfig = loadWorktreeAppConfig();
  if (!appConfig.enabled) return;

  const state = loadReactorState();
  const fired = new Set(state.fired);
  gcFiredLedger(repoName, fired, liveMrIdsForRepo(repoName, cacheEntries));

  // Snapshots are per repo; other repos' keys ride through untouched so a
  // single-repo pass can't erase their memory, while this repo's stale
  // branches drop out by being rebuilt from the live cache.
  const prefix = `${repoName}:`;
  const nextMrState: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(state.mrState)) {
    if (!key.startsWith(prefix)) nextMrState[key] = value;
  }

  for (const [mapKey, entry] of Object.entries(cacheEntries)) {
    // Unattributed entries (older caches predate repoName) may join any repo;
    // an entry attributed elsewhere never does.
    if (entry.repoName && entry.repoName !== repoName) continue;
    if (!entry.mr) continue;
    const branch = branchOf(mapKey);

    const cur = entry.mr.state ?? null;
    const mrKey = prefix + branch;
    const prev = state.mrState[mrKey] ?? null;
    const iid = typeof entry.mr.iid === "number" ? String(entry.mr.iid) : branch;

    if (cur === "opened") {
      nextMrState[mrKey] = "opened";
      // Reopen: forget this MR's fires so a later merge acts again, and hand
      // any disposable tree back to its owner.
      for (const fireKey of [...fired]) {
        if (fireKey.startsWith(`disposed:${repoName}:${iid}:`)) fired.delete(fireKey);
      }
      await resumeTrees(deps, branch);
      continue;
    }

    nextMrState[mrKey] = cur;
    if (prev !== "opened") continue; // cold-boot safety: unknown prev never fires
    if (!cur || !MR_TERMINAL_STATES.has(cur)) continue;

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

    if (reaction === "retry") nextMrState[mrKey] = "opened";
    else if (reaction === "fired") fired.add(fireKey);
  }

  saveReactorState({ mrState: nextMrState, fired: [...fired] }, log);
}

export const __test__ = {
  reactorStatePath,
  hasReactorState: () => getKvValue<ReactorState | null>(REACTOR_STATE_NS, REACTOR_STATE_KEY, null) !== null,
  loadReactorState,
  saveReactorState,
  gcFiredLedger,
  liveMrIdsForRepo,
};
