/**
 * Parking-lot subsystem for the rt daemon.
 *
 * When a worktree's branch has an MR that transitions `opened → merged|closed`,
 * this module "parks" the worktree: stash any dirty tree, check out the
 * worktree's bound `parking-lot/<N>` branch (creating it from origin/master if
 * absent), then fast-forward that branch to the remote default branch.
 *
 * Worktree → parking-lot index mapping is per-repo, 1-based, primary worktree
 * first, persisted at `~/.rt/<repoName>/parking-lot.json` so indexes stay
 * stable across worktree adds/removes. New worktrees claim the next unused
 * positive integer.
 *
 * Transition detection piggybacks on the cache refresh (same `mr.state`
 * signals the notifier uses). We keep our own state file so we only act once
 * per MR and never park on a cold-boot `merged` cache entry.
 */

import { execSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

import { RT_DIR } from "../daemon-config.ts";
import {
  getCurrentBranch,
  getRemoteDefaultBranch,
  hasUncommittedChanges,
  stashChanges,
} from "../git-ops.ts";
import { loadParkingLotConfig } from "../parking-lot-config.ts";
import type { CacheEntry, RepoIndex } from "./handlers/types.ts";

// ─── Persistence ─────────────────────────────────────────────────────────────

const STATE_PATH = join(RT_DIR, "parking-lot-state.json");

interface ParkingLotState {
  /** Last-seen MR state per branch (keyed exactly like the cache). */
  mrState: Record<string, string | null>;
  /** Keys we've already parked on, to avoid re-running if cache churns. */
  fired: string[];
}

function loadState(): ParkingLotState {
  try {
    const raw = JSON.parse(readFileSync(STATE_PATH, "utf8"));
    return {
      mrState: raw?.mrState ?? {},
      fired:   Array.isArray(raw?.fired) ? raw.fired : [],
    };
  } catch {
    return { mrState: {}, fired: [] };
  }
}

function saveState(state: ParkingLotState): void {
  try {
    mkdirSync(RT_DIR, { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch { /* best-effort */ }
}

// ─── Worktree → index mapping (per repo) ─────────────────────────────────────

interface IndexMap { [worktreePath: string]: number; }

function indexFilePath(repoName: string): string {
  return join(RT_DIR, repoName, "parking-lot.json");
}

function loadIndexMap(repoName: string): IndexMap {
  try {
    const raw = JSON.parse(readFileSync(indexFilePath(repoName), "utf8"));
    return raw?.indexes ?? {};
  } catch {
    return {};
  }
}

function saveIndexMap(repoName: string, indexes: IndexMap): void {
  try {
    mkdirSync(join(RT_DIR, repoName), { recursive: true });
    writeFileSync(indexFilePath(repoName), JSON.stringify({ indexes }, null, 2));
  } catch { /* best-effort */ }
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
  } catch {
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

function park(
  worktreePath: string,
  repoPath: string,
  sourceBranch: string,
  index: number,
  log: (msg: string) => void,
): ParkResult {
  const parkBranch = `parking-lot/${index}`;

  // 1. Confirm the worktree is still on the branch we expect. If the user
  //    has already switched away, bail — they've moved on and don't want us
  //    clobbering their current state.
  const current = getCurrentBranch(worktreePath);
  if (current !== sourceBranch) {
    return { ok: false, action: "skip", detail: `worktree is on "${current}", not "${sourceBranch}"` };
  }

  // 2. Refuse to touch the parking-lot branch if another worktree already
  //    has it checked out — git would reject the checkout, but erroring out
  //    cleanly gives a better log.
  const holder = branchCheckedOutElsewhere(repoPath, parkBranch, worktreePath);
  if (holder) {
    return { ok: false, action: "skip", detail: `${parkBranch} is checked out at ${holder}` };
  }

  // 3. Stash if dirty, using the GitHub Desktop-compatible marker so the
  //    existing rt / GitHub Desktop flows can find it later.
  try {
    if (hasUncommittedChanges(worktreePath)) {
      stashChanges(worktreePath, sourceBranch);
      log(`parking-lot: stashed uncommitted changes on "${sourceBranch}"`);
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
      log(`parking-lot: created ${parkBranch} from ${defaultRef}`);
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

  return { ok: true, action: "parked", detail: `${sourceBranch} → ${parkBranch} @ ${defaultRef}` };
}

// ─── Transition detection (called after each cache refresh) ──────────────────

export interface ParkingEnv {
  cache:     { entries: Record<string, CacheEntry> };
  repoIndex: () => RepoIndex;
  log:       (msg: string) => void;
}

const TERMINAL_STATES = new Set(["merged", "closed"]);

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
      env.log(`parking-lot: ${entry.repoName}/${branch} ${mrState} — no matching worktree, skipping`);
      fired.add(fireKey); // don't re-check forever
      continue;
    }

    const idx = indexes[wt.path];
    if (!idx) {
      env.log(`parking-lot: ${entry.repoName}/${branch} ${mrState} — no index for ${wt.path}, skipping`);
      fired.add(fireKey);
      continue;
    }

    env.log(`parking-lot: ${entry.repoName}/${branch} ${mrState} → parking at ${wt.path} (space ${idx})`);
    const result = park(wt.path, repoPath, branch, idx, env.log);
    if (result.ok) {
      env.log(`parking-lot: ✓ ${result.detail}`);
      fired.add(fireKey);
    } else {
      env.log(`parking-lot: ✗ ${result.action}${result.detail ? ` — ${result.detail}` : ""}`);
      // Don't mark fired on failure — we'll retry next tick.
    }
  }

  // Persist fresh MR state snapshot so the next tick has something to compare
  // against. Absent branches (stale cache entries removed) are dropped.
  saveState({ mrState: nextMrState, fired: [...fired] });
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
