/**
 * Parking-lot subsystem for the rt daemon.
 *
 * When a worktree's branch has an MR that transitions `opened → merged|closed`,
 * this module "parks" the worktree: stash any dirty tree, check out the
 * worktree's bound `parking-lot/<N>` branch (creating it from origin/master if
 * absent), then fast-forward that branch to the remote default branch.
 *
 * Worktree → parking-lot index mapping is per-repo, 1-based, primary worktree
 * first, persisted at `~/.rt/repos/<repoName>/parking-lot.json` so indexes stay
 * stable across worktree adds/removes. New worktrees claim the next unused
 * positive integer.
 *
 * Transition detection piggybacks on the cache refresh (same `mr.state`
 * signals the notifier uses). We keep our own state file so we only act once
 * per MR and never park on a cold-boot `merged` cache entry.
 */

import { execSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";

import { getDaemonLogger } from "../daemon-logger.ts";
import { RT_DIR } from "../daemon-config.ts";
import { repoDataDir } from "../rt-paths.ts";
import { readJson, writeJson } from "../json-store.ts";
import {
  getCurrentBranch,
  getRemoteDefaultBranch,
  hasUncommittedChanges,
  stashChanges,
} from "../git-ops.ts";
import { loadParkingLotConfig } from "../parking-lot-config.ts";
import type { CacheEntry, RepoIndex } from "./handlers/types.ts";

const log = (await getDaemonLogger()).childLogger("parking-lot");

// ─── Persistence ─────────────────────────────────────────────────────────────

const STATE_PATH = join(RT_DIR, "parking-lot-state.json");

interface ParkingLotState {
  /** Last-seen MR state per branch (keyed exactly like the cache). */
  mrState: Record<string, string | null>;
  /** Keys we've already parked on, to avoid re-running if cache churns. */
  fired: string[];
}

function loadState(): ParkingLotState {
  const raw = readJson<Partial<ParkingLotState>>(STATE_PATH, {});
  return {
    mrState: raw?.mrState ?? {},
    fired:   Array.isArray(raw?.fired) ? raw.fired : [],
  };
}

function saveState(state: ParkingLotState): void {
  try {
    writeJson(STATE_PATH, state);
  } catch (err) {
    log.debug({ err }, "failed to persist parking-lot state (best-effort)");
  }
}

// ─── Worktree → index mapping (per repo) ─────────────────────────────────────

interface IndexMap { [worktreePath: string]: number; }

function indexFilePath(repoName: string): string {
  return join(repoDataDir(repoName), "parking-lot.json");
}

function loadIndexMap(repoName: string): IndexMap {
  const raw = readJson<{ indexes?: IndexMap }>(indexFilePath(repoName), {});
  return raw?.indexes ?? {};
}

function saveIndexMap(repoName: string, indexes: IndexMap): void {
  try {
    writeJson(indexFilePath(repoName), { indexes });
  } catch (err) {
    log.debug({ err }, "failed to persist parking-lot index map (best-effort)");
  }
}

/**
 * Reconcile the on-disk index map with the current `git worktree list`.
 * Primary (listed first by git) gets 1 if unassigned; others claim the next
 * unused positive integer in listing order. Existing entries are preserved
 * so indexes stay stable if a middle worktree is removed.
 */
function reconcileIndexMap(repoName: string, worktreePaths: string[]): IndexMap {
  const map = loadIndexMap(repoName);

  // Drop entries whose worktree no longer exists on disk — keeps the file
  // from growing forever, but we still preserve the numbers of live
  // worktrees.
  for (const p of Object.keys(map)) {
    if (!worktreePaths.includes(p) && !existsSync(p)) delete map[p];
  }

  const used = new Set(Object.values(map));
  let mutated = false;

  for (let i = 0; i < worktreePaths.length; i++) {
    const path = worktreePaths[i]!;
    if (map[path]) continue;

    // Primary worktree (index 0 in git's output) gets 1 by preference.
    let claim = i === 0 && !used.has(1) ? 1 : 0;
    if (!claim) {
      let n = 1;
      while (used.has(n)) n++;
      claim = n;
    }
    map[path] = claim;
    used.add(claim);
    mutated = true;
  }

  if (mutated) saveIndexMap(repoName, map);
  return map;
}

// ─── git helpers (local — narrow-purpose, no execSync wrapper lib) ───────────

interface WorktreeInfo { path: string; branch: string | null; }

function listWorktrees(repoPath: string): WorktreeInfo[] {
  try {
    const out = execSync("git worktree list --porcelain", {
      cwd: repoPath, encoding: "utf8", stdio: "pipe",
    });
    const results: WorktreeInfo[] = [];
    let curPath = "";
    let curBranch: string | null = null;
    for (const line of out.split("\n")) {
      if (line.startsWith("worktree ")) {
        if (curPath) results.push({ path: curPath, branch: curBranch });
        curPath = line.slice("worktree ".length).trim();
        curBranch = null;
      } else if (line.startsWith("branch ")) {
        curBranch = line.slice("branch refs/heads/".length).trim();
      } else if (line.startsWith("detached")) {
        curBranch = null;
      }
    }
    if (curPath) results.push({ path: curPath, branch: curBranch });
    return results;
  } catch (err) {
    log.debug({ err }, "git worktree list failed");
    return [];
  }
}

function branchExistsLocal(cwd: string, branch: string): boolean {
  try {
    execSync(`git rev-parse --verify "refs/heads/${branch}"`, {
      cwd, stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

function branchCheckedOutElsewhere(repoPath: string, branch: string, selfPath: string): string | null {
  for (const wt of listWorktrees(repoPath)) {
    if (wt.path === selfPath) continue;
    if (wt.branch === branch) return wt.path;
  }
  return null;
}

// ─── Parking action ──────────────────────────────────────────────────────────

export interface ParkResult {
  ok: boolean;
  action: string;
  detail?: string;
}

export function park(
  worktreePath: string,
  repoPath: string,
  sourceBranch: string | null,
  index: number,
): ParkResult {
  const parkBranch = `parking-lot/${index}`;

  // 1. Confirm the worktree is still in the state we expect. `sourceBranch` is
  //    null when parking a detached worktree (e.g. a herdr warm-pool entry) —
  //    in that case we expect it to still be detached. Either way, if the user
  //    has switched away, bail rather than clobber their current state.
  const current = getCurrentBranch(worktreePath);
  if (current !== sourceBranch) {
    const detail = sourceBranch
      ? `worktree is on "${current}", not "${sourceBranch}"`
      : `worktree is no longer detached (on "${current}")`;
    return { ok: false, action: "skip", detail };
  }

  // 2. Refuse to touch the parking-lot branch if another worktree already
  //    has it checked out — git would reject the checkout, but erroring out
  //    cleanly gives a better log.
  const holder = branchCheckedOutElsewhere(repoPath, parkBranch, worktreePath);
  if (holder) {
    return { ok: false, action: "skip", detail: `${parkBranch} is checked out at ${holder}` };
  }

  // 3. Stash if dirty, using the GitHub Desktop-compatible marker so the
  //    existing rt / GitHub Desktop flows can find it later. A detached
  //    worktree has no source branch to key the stash to, so fall back to the
  //    parking-lot slot — that's where the worktree is headed and keeps the
  //    stash recoverable (rather than labeling it "<null>").
  const stashLabel = sourceBranch ?? parkBranch;
  try {
    if (hasUncommittedChanges(worktreePath)) {
      stashChanges(worktreePath, stashLabel);
      log.info({ stashLabel }, `stashed uncommitted changes on "${stashLabel}"`);
    }
  } catch (err) {
    return { ok: false, action: "stash-failed", detail: String(err) };
  }

  // 4. Fetch the default branch so the fast-forward can actually advance.
  const defaultRef = getRemoteDefaultBranch(worktreePath) ?? "origin/master";
  const defaultBranch = defaultRef.replace(/^origin\//, "");
  try {
    execSync(`git fetch origin "${defaultBranch}"`, { cwd: worktreePath, stdio: "pipe" });
  } catch (err) {
    return { ok: false, action: "fetch-failed", detail: String(err) };
  }

  // 5. Check out parking-lot/N, creating it off the default branch if missing.
  try {
    if (branchExistsLocal(worktreePath, parkBranch)) {
      execSync(`git checkout "${parkBranch}"`, { cwd: worktreePath, stdio: "pipe" });
    } else {
      execSync(`git checkout -b "${parkBranch}" "${defaultRef}"`, { cwd: worktreePath, stdio: "pipe" });
      log.info({ parkBranch, defaultRef }, `created ${parkBranch} from ${defaultRef}`);
    }
  } catch (err) {
    return { ok: false, action: "checkout-failed", detail: String(err) };
  }

  // 6. Fast-forward. If parking-lot/N was just created off defaultRef this is
  //    a no-op; if it existed already we advance it.
  try {
    execSync(`git merge --ff-only "${defaultRef}"`, { cwd: worktreePath, stdio: "pipe" });
  } catch (err) {
    return { ok: false, action: "ff-failed", detail: String(err) };
  }

  return { ok: true, action: "parked", detail: `${sourceBranch ?? "(detached)"} → ${parkBranch} @ ${defaultRef}` };
}

/**
 * Whether a worktree binding can be manually parked onto its slot.
 *
 * Parkable = it has an allocated slot index and isn't already sitting on that
 * `parking-lot/<index>` branch. Both feature-branch worktrees and detached
 * worktrees (branch === null, e.g. herdr warm-pool entries) qualify — parking a
 * detached worktree claims it onto a clean slot branch off origin/master.
 *
 * Note this is the manual-park predicate. Auto-park (checkAndPark) is
 * deliberately narrower: it only fires on MR open→terminal transitions, which
 * detached worktrees never have, so they are never auto-parked.
 */
export function isParkable(binding: WorktreeBinding): boolean {
  if (!binding.index) return false;
  if (binding.branch === `parking-lot/${binding.index}`) return false;
  return true;
}

// ─── Transition detection (called after each cache refresh) ──────────────────

export interface ParkingEnv {
  cache:     { entries: Record<string, CacheEntry> };
  repoIndex: () => RepoIndex;
}

const TERMINAL_STATES = new Set(["merged", "closed"]);

// ─── Fast-forward already-parked worktrees ────────────────────────────────────

function isParkedBranch(branch: string): boolean {
  return /^parking-lot\/\d+$/.test(branch);
}

function fastForwardParkedWorktrees(
  repoPath: string,
  worktrees: WorktreeInfo[],
): void {
  const parked = worktrees.filter(w => w.branch && isParkedBranch(w.branch));
  if (parked.length === 0) return;

  const defaultRef = getRemoteDefaultBranch(repoPath) ?? "origin/master";
  const defaultBranch = defaultRef.replace(/^origin\//, "");

  try {
    execSync(`git fetch origin "${defaultBranch}"`, { cwd: repoPath, stdio: "pipe" });
  } catch (err) {
    log.debug({ err, repoPath }, "fetch failed during ff-sweep, skipping");
    return;
  }

  for (const wt of parked) {
    if (hasUncommittedChanges(wt.path)) continue;
    try {
      execSync(`git merge --ff-only "${defaultRef}"`, { cwd: wt.path, stdio: "pipe" });
      log.debug({ branch: wt.branch, worktree: wt.path, defaultRef }, `fast-forwarded ${wt.branch} → ${defaultRef}`);
    } catch (err) {
      // Branch has diverged or is already up to date — expected, skip.
      log.debug({ err, branch: wt.branch, worktree: wt.path }, "ff-only skipped (diverged or already up to date)");
    }
  }
}

export function checkAndPark(env: ParkingEnv): void {
  if (!loadParkingLotConfig().enabled) return;

  const state = loadState();
  const fired = new Set(state.fired);
  const nextMrState: Record<string, string | null> = {};

  const repoIndex = env.repoIndex();

  // Build a quick lookup of (repoPath → worktree-path → branch) from git.
  // We do this lazily, only for repos that actually have a live cache entry,
  // so we don't shell out to every repo on every tick.
  const worktreeByRepo = new Map<string, WorktreeInfo[]>();
  const indexMapByRepo = new Map<string, IndexMap>();

  for (const [branch, entry] of Object.entries(env.cache.entries)) {
    const mrState = entry.mr?.state ?? null;
    nextMrState[branch] = mrState;

    if (!entry.repoName) continue;
    const repoPath = repoIndex[entry.repoName];
    if (!repoPath || !existsSync(repoPath)) continue;

    const prev = state.mrState[branch] ?? null;
    if (prev !== "opened") continue;
    if (!mrState || !TERMINAL_STATES.has(mrState)) continue;

    const fireKey = `parked:${entry.repoName}:${branch}:${mrState}`;
    if (fired.has(fireKey)) continue;

    // Lazily discover worktrees + indexes for this repo.
    if (!worktreeByRepo.has(repoPath)) {
      const worktrees = listWorktrees(repoPath);
      worktreeByRepo.set(repoPath, worktrees);
      indexMapByRepo.set(entry.repoName, reconcileIndexMap(entry.repoName, worktrees.map(w => w.path)));
    }

    const worktrees = worktreeByRepo.get(repoPath)!;
    const indexes   = indexMapByRepo.get(entry.repoName)!;

    // Find the worktree currently (or most recently per git) bound to this branch.
    const wt = worktrees.find(w => w.branch === branch);
    if (!wt) {
      log.info({ repoName: entry.repoName, branch, mrState }, `${entry.repoName}/${branch} ${mrState} — no matching worktree, skipping`);
      fired.add(fireKey); // don't re-check forever
      continue;
    }

    const idx = indexes[wt.path];
    if (!idx) {
      log.info({ repoName: entry.repoName, branch, mrState, worktree: wt.path }, `${entry.repoName}/${branch} ${mrState} — no index for ${wt.path}, skipping`);
      fired.add(fireKey);
      continue;
    }

    log.info({ repoName: entry.repoName, branch, mrState, worktree: wt.path, idx }, `${entry.repoName}/${branch} ${mrState} → parking at ${wt.path} (space ${idx})`);
    const result = park(wt.path, repoPath, branch, idx);
    if (result.ok) {
      log.info({ result }, `parked: ${result.detail}`);
      fired.add(fireKey);
    } else {
      log.warn({ result }, `park failed: ${result.action}${result.detail ? ` — ${result.detail}` : ""}`);
      // Don't mark fired on failure — we'll retry next tick.
    }
  }

  // Persist fresh MR state snapshot so the next tick has something to compare
  // against. Absent branches (stale cache entries removed) are dropped.
  saveState({ mrState: nextMrState, fired: [...fired] });

  // Fast-forward any worktree already sitting on a parking-lot branch.
  // We do this for every known repo regardless of whether a park transition
  // fired this tick — these branches substitute for master and must stay current.
  for (const [repoName, repoPath] of Object.entries(repoIndex)) {
    if (!existsSync(repoPath)) continue;
    const worktrees = worktreeByRepo.get(repoPath) ?? listWorktrees(repoPath);
    try {
      fastForwardParkedWorktrees(repoPath, worktrees);
    } catch (err) {
      log.warn({ err, repoName }, `ff-sweep failed for ${repoName}`);
    }
  }
}

// ─── CLI introspection ───────────────────────────────────────────────────────

export interface WorktreeBinding {
  path:   string;
  branch: string | null;
  index:  number;
}

/**
 * Current worktree → parking-lot-index bindings for a single repo, reconciling
 * against `git worktree list` on the fly. Used by `rt parking-lot status`.
 */
export function describeRepoBindings(repoName: string, repoPath: string): WorktreeBinding[] {
  const worktrees = listWorktrees(repoPath);
  const indexes   = reconcileIndexMap(repoName, worktrees.map(w => w.path));
  return worktrees.map(w => ({ path: w.path, branch: w.branch, index: indexes[w.path] ?? 0 }));
}

// ─── Exposed for tests ───────────────────────────────────────────────────────

export const __test__ = {
  reconcileIndexMap,
  loadIndexMap,
  saveIndexMap,
  STATE_PATH,
};
