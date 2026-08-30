/**
 * Freshen duty (spec §6.3): fast-forwards on-deck ephemeral trees and opted-in
 * idle main clones onto the default branch, then reruns whatever ready steps
 * that advances. The step's contract (`FreshenDeps` in, freshened tree names
 * out) is stable.
 */

import type { Logger } from "pino";
import {
  findByPath,
  loadRegistry,
  type TreeRecord,
} from "../../worktree/registry.ts";
import { patchTree } from "../../worktree/patch.ts";
import {
  findDesktopStashAsync,
  headSha,
  MUTATING_TIMEOUT_MS,
  remoteDefaultRef,
  runGit,
  stashChangesAsync,
} from "../../worktree/git-async.ts";
import { withTreeLock } from "../../worktree/locks.ts";
import { classifyDirtyAsync } from "../../worktree/dispose.ts";
import { changedSince, stepsToRun, runReadySteps } from "../../worktree/ready.ts";
import { MAX_LOGGED_OUTPUT, outputTail } from "../../subprocess.ts";
import {
  loadWorktreeAppConfig,
  loadWorktreeRepoConfig,
  resolveReadySteps,
} from "../../worktree/config.ts";

const FRESHEN_FETCH_TIMEOUT_MS = 5 * 60_000;
/** The backoff "pass" unit: failure N waits pass * 2^(N-1), capped below. */
const FRESHEN_PASS_MS = 5 * 60_000;
const FRESHEN_MAX_BACKOFF_MS = 30 * 60_000;

/**
 * Delay after the Nth consecutive failure: one pass, doubled N-1 times, capped.
 * Shared by the freshen retry stamp and the per-repo create backoff (spec §6.4)
 *... both count in passes and both cap at 30 minutes.
 */
export function backoffDelayMs(failures: number): number {
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
 * whatever ready steps that advances triggers. Caller holds the tree lock and
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

export const __test__ = {
  freshenCandidate,
  freshenOne,
  freshenRepo,
};
