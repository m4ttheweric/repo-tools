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

import { execFileSync, execSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";

import { getDaemonLogger } from "../daemon-logger.ts";
import { RT_DIR } from "../daemon-config.ts";
import { repoDataDir } from "../rt-paths.ts";
import { readJson, writeJson } from "../json-store.ts";
import {
  findDesktopStash,
  getCurrentBranch,
  getRemoteDefaultBranch,
  hasUncommittedChanges,
  popStash,
  stashChanges,
} from "../git-ops.ts";
import { loadParkingLotConfig } from "../parking-lot-config.ts";
import { loadSyncConfig, matchRule } from "../sync-config.ts";
// Namespace import so tests can spy on the kill step.
import * as wtKill from "./worktree-process-kill.ts";
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

// rt drives git inside target repos but must never fire their hooks (repo
// stealth). A broken husky post-checkout/post-merge hook otherwise makes the
// checkout exit non-zero *after* it already succeeded, surfacing as a spurious
// "checkout-failed" even though the branch switched fine. Disable hooks on every
// mutating command by pointing hooksPath at a nonexistent dir.
const NO_HOOKS = "-c core.hooksPath=/dev/null";

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

export interface ParkOptions {
  /** Kill workload processes rooted in the worktree before parking.
   *  Callers pass loadParkingLotConfig().killProcesses. */
  killProcesses?: boolean;
}

export function park(
  worktreePath: string,
  repoPath: string,
  sourceBranch: string | null,
  index: number,
  opts: ParkOptions = {},
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

  // 2.5. The feature is done — stop its workload (dev servers, watchers)
  //      before touching the tree. Failure here never blocks the park.
  if (opts.killProcesses) {
    try {
      wtKill.killWorktreeProcesses(worktreePath);
    } catch (err) {
      log.warn({ err, worktreePath }, "worktree process kill failed; parking anyway");
    }
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
      execSync(`git ${NO_HOOKS} checkout "${parkBranch}"`, { cwd: worktreePath, stdio: "pipe" });
    } else {
      execSync(`git ${NO_HOOKS} checkout -b "${parkBranch}" "${defaultRef}"`, { cwd: worktreePath, stdio: "pipe" });
      log.info({ parkBranch, defaultRef }, `created ${parkBranch} from ${defaultRef}`);
    }
  } catch (err) {
    return { ok: false, action: "checkout-failed", detail: String(err) };
  }

  // 6. Fast-forward. If parking-lot/N was just created off defaultRef this is
  //    a no-op; if it existed already we advance it.
  try {
    execSync(`git ${NO_HOOKS} merge --ff-only "${defaultRef}"`, { cwd: worktreePath, stdio: "pipe" });
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

/** One entry from `git status --porcelain`. */
interface DirtyEntry { status: string; path: string; }

function listDirtyEntries(cwd: string): DirtyEntry[] {
  let out: string;
  try {
    out = execSync("git status --porcelain", { cwd, encoding: "utf8", stdio: "pipe" });
  } catch (err) {
    log.warn({ err, cwd }, "git status failed during ff-sweep");
    return [];
  }

  const entries: DirtyEntry[] = [];
  for (const line of out.split("\n")) {
    if (line.length < 4) continue;
    const status = line.slice(0, 2);
    let path = line.slice(3);
    // Rename/copy entries read "old -> new"; the destination is what's dirty.
    const arrow = path.indexOf(" -> ");
    if (arrow !== -1) path = path.slice(arrow + 4);
    // git quotes paths containing specials (C-style escapes).
    if (path.startsWith('"') && path.endsWith('"')) {
      try { path = JSON.parse(path) as string; } catch { path = path.slice(1, -1); }
    }
    entries.push({ status, path });
  }
  return entries;
}

/**
 * Whether a tracked file's local change is pure whitespace relative to HEAD.
 * Compared against HEAD (not the index) so a staged whitespace-only edit counts.
 */
function isWhitespaceOnlyChange(cwd: string, path: string): boolean {
  try {
    execFileSync("git", ["diff", "HEAD", "--ignore-all-space", "--exit-code", "--", path], {
      cwd, stdio: "pipe",
    });
    return true; // exit 0 → nothing left once whitespace is ignored
  } catch {
    return false;
  }
}

/**
 * Decide what to do with each dirty path before a fast-forward.
 *
 * `discard` covers tracked modifications to files the repo's sync.json
 * declares auto-resolvable with `strategy: "theirs"`, whose local diff is pure
 * whitespace. These are generated artifacts that drift by a trailing newline
 * and are rebuilt by the next build; the declaration says upstream wins.
 *
 * Everything else is stashed and restored, never discarded... a background
 * sweep must not destroy content it didn't generate. That deliberately
 * includes substantive changes to declared files: the declaration is about
 * regenerable drift, not about giving the daemon licence to delete real edits.
 */
function classifyDirtyForFastForward(
  worktreePath: string,
  repoName: string,
  entries: DirtyEntry[],
): { discard: string[]; stashRest: boolean } {
  const rules = loadSyncConfig(repoDataDir(repoName)).autoResolve;
  const discard: string[] = [];
  let stashRest = false;

  for (const e of entries) {
    const untracked = e.status === "??";
    const modified  = !untracked && e.status.includes("M");
    if (
      modified &&
      matchRule(e.path, rules)?.strategy === "theirs" &&
      isWhitespaceOnlyChange(worktreePath, e.path)
    ) {
      discard.push(e.path);
    } else {
      stashRest = true;
    }
  }

  return { discard, stashRest };
}

export function fastForwardParkedWorktrees(
  repoName: string,
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
    const entries = listDirtyEntries(wt.path);
    let discarded: string[] = [];
    let stashName: string | null = null;

    if (entries.length > 0) {
      const { discard, stashRest } = classifyDirtyForFastForward(wt.path, repoName, entries);

      // Reset declared generated drift to HEAD (covers staged + unstaged).
      for (const path of discard) {
        try {
          execFileSync("git", ["checkout", "HEAD", "--", path], { cwd: wt.path, stdio: "pipe" });
          discarded.push(path);
        } catch (err) {
          log.warn({ err, worktree: wt.path, path }, "failed to reset declared generated file; will stash instead");
        }
      }

      // Anything left gets stashed under the slot's Desktop-compatible marker
      // so it is recoverable by hand even if the restore below fails.
      if (stashRest || hasUncommittedChanges(wt.path)) {
        try {
          stashChanges(wt.path, wt.branch!);
          stashName = findDesktopStash(wt.path, wt.branch!)?.name ?? "stash@{0}";
        } catch (err) {
          log.warn({ err, branch: wt.branch, worktree: wt.path }, `ff-sweep: could not stash ${wt.branch}, leaving it behind`);
          continue;
        }
      }
    }

    let advanced = false;
    try {
      execSync(`git ${NO_HOOKS} merge --ff-only "${defaultRef}"`, { cwd: wt.path, stdio: "pipe" });
      advanced = true;
    } catch (err) {
      // Branch has diverged or is already up to date... expected, not a failure.
      log.debug({ err, branch: wt.branch, worktree: wt.path }, "ff-only skipped (diverged or already up to date)");
    }

    // Always attempt the restore, including when the ff was a no-op: we took
    // the user's changes, so we owe them back regardless of the merge outcome.
    if (stashName) {
      try {
        popStash(wt.path, stashName);
      } catch (err) {
        log.warn(
          { err, branch: wt.branch, worktree: wt.path, stashName },
          `ff-sweep: stash ${stashName} did not reapply cleanly in ${wt.path}... it is preserved, restore it with: git stash pop ${stashName}`,
        );
        continue;
      }
    }

    if (advanced) {
      log.info(
        { branch: wt.branch, worktree: wt.path, defaultRef, discarded, stashed: Boolean(stashName) },
        `fast-forwarded ${wt.branch} → ${defaultRef}`
          + (discarded.length ? ` (reset ${discarded.length} generated file${discarded.length > 1 ? "s" : ""})` : "")
          + (stashName ? " (stashed and restored local changes)" : ""),
      );
    }
  }
}

export function checkAndPark(env: ParkingEnv): void {
  const config = loadParkingLotConfig();
  if (!config.enabled) return;

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
    const result = park(wt.path, repoPath, branch, idx, { killProcesses: config.killProcesses });
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
      fastForwardParkedWorktrees(repoName, repoPath, worktrees);
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
  /**
   * Commits the worktree's `parking-lot/<index>` branch trails the local
   * `origin/master` ref by, or null when the slot branch doesn't exist yet or
   * staleness wasn't requested. Reads the already-fetched remote ref rather
   * than fetching, so it costs one rev-list per slot and no network.
   */
  slotBehind?: number | null;
}

/** How far `ref` trails `defaultRef`, or null if either ref is unresolvable. */
function countBehind(repoPath: string, ref: string, defaultRef: string): number | null {
  try {
    const out = execFileSync("git", ["rev-list", "--count", `${ref}..${defaultRef}`], {
      cwd: repoPath, encoding: "utf8", stdio: "pipe",
    });
    const n = parseInt(out.trim(), 10);
    return Number.isNaN(n) ? null : n;
  } catch {
    return null;
  }
}

/**
 * Current worktree → parking-lot-index bindings for a single repo, reconciling
 * against `git worktree list` on the fly. Used by `rt parking-lot status`.
 *
 * `withStaleness` adds a rev-list per slot; the park pickers skip it so their
 * hot path stays a single `git worktree list`.
 */
export function describeRepoBindings(
  repoName: string,
  repoPath: string,
  opts: { withStaleness?: boolean } = {},
): WorktreeBinding[] {
  const worktrees = listWorktrees(repoPath);
  const indexes   = reconcileIndexMap(repoName, worktrees.map(w => w.path));
  const defaultRef = opts.withStaleness
    ? (getRemoteDefaultBranch(repoPath) ?? "origin/master")
    : null;

  return worktrees.map(w => {
    const index = indexes[w.path] ?? 0;
    const binding: WorktreeBinding = { path: w.path, branch: w.branch, index };
    if (defaultRef && index) {
      binding.slotBehind = countBehind(repoPath, `parking-lot/${index}`, defaultRef);
    }
    return binding;
  });
}

// ─── Exposed for tests ───────────────────────────────────────────────────────

export const __test__ = {
  reconcileIndexMap,
  loadIndexMap,
  saveIndexMap,
  STATE_PATH,
};
