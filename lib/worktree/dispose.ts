/**
 * Dispose guard + removal (spec §8).
 *
 * Disposal is the only destructive verb in the lifecycle, so the guard is the
 * feature: five checks, in a fixed order, each returning a stable refusal
 * string the reactor records as `disposableReason` and the CLI prints. The
 * order matters — cheap, local, categorical checks first, then the ones that
 * can hit the network (fetch) or someone else's coordination state (leases).
 *
 * `force` overrides guards 2-5 and never guard 1: "main" and "unmanaged" trees
 * are categorically not rt's to delete, no matter what the caller asks for.
 */

import { statusPorcelainAsync, gitOk, isAncestorAsync, remoteDefaultRef, remoteRefExists, runGit } from "./git-async.ts";
import { loadRegistry, saveRegistry, type TreeRecord } from "./registry.ts";
import { hasFreshAttendantLease } from "./lease.ts";
import { loadSyncConfig, matchRule } from "../sync-config.ts";
import { repoDataDir } from "../rt-paths.ts";
import { killWorktreeProcesses } from "../daemon/worktree-process-kill.ts";

/** Merge-reactor disposals ignore claims younger than this (stale-event protection). */
const GRACE_MS = 10 * 60_000;

const FETCH_TIMEOUT_MS = 2 * 60_000;

// ─── Dirty classification (harvested from parking-lot.ts, execSync → runGit) ──

/** One entry from `git status --porcelain`. */
interface DirtyEntry { status: string; path: string; }

function parseDirtyEntries(porcelain: string): DirtyEntry[] {
  const entries: DirtyEntry[] = [];
  for (const line of porcelain.split("\n")) {
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
async function isWhitespaceOnlyChange(cwd: string, path: string): Promise<boolean> {
  // exit 0 → nothing left once whitespace is ignored
  return gitOk(cwd, ["diff", "HEAD", "--ignore-all-space", "--exit-code", "--", path]);
}

/**
 * Split a worktree's dirt into what may be thrown away and what must not be.
 *
 * `discard` covers tracked modifications to files the repo's sync.json declares
 * auto-resolvable with `strategy: "theirs"`, whose local diff is pure
 * whitespace. These are generated artifacts that drift by a trailing newline
 * and are rebuilt by the next build; the declaration says upstream wins.
 *
 * Everything else is a blocker — disposal refuses and freshen stashes. A
 * background sweep must not destroy content it didn't generate. That
 * deliberately includes substantive changes to declared files: the declaration
 * is about regenerable drift, not licence to delete real edits.
 *
 * One intelligence, two callers (dispose guard 2 and the freshen sweep).
 */
export async function classifyDirtyAsync(
  worktreePath: string,
  repoName: string,
): Promise<{ discard: string[]; blockers: string[] }> {
  const rules = loadSyncConfig(repoDataDir(repoName)).autoResolve;
  const entries = parseDirtyEntries(await statusPorcelainAsync(worktreePath));

  const discard: string[] = [];
  const blockers: string[] = [];

  for (const e of entries) {
    const untracked = e.status === "??";
    const modified  = !untracked && e.status.includes("M");
    if (
      modified &&
      matchRule(e.path, rules)?.strategy === "theirs" &&
      await isWhitespaceOnlyChange(worktreePath, e.path)
    ) {
      discard.push(e.path);
    } else {
      blockers.push(e.path);
    }
  }

  return { discard, blockers };
}

// ─── Dispose ─────────────────────────────────────────────────────────────────

export interface DisposeDeps {
  repoName: string;
  repoPath: string;
  /** Branch-keyed MR cache (daemon `ctx.cache.entries`). */
  cacheEntries: Record<string, { mr: any; repoName?: string }>;
  emit: (type: string, data: unknown) => void;
  log: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
  killProcesses: boolean;
}

export type DisposeOutcome = { disposed: true } | { disposed: false; refusal: string };

/** The MR joined to this tree, if the branch cache knows one for this repo. */
function joinedMr(deps: DisposeDeps, rec: TreeRecord): { iid?: number; sha?: string | null } | null {
  if (!rec.branch) return null;
  const entry = deps.cacheEntries[rec.branch];
  if (!entry || !entry.mr) return null;
  // Entries carry repoName once freshness has attributed them; an unattributed
  // entry is accepted (single-repo caches predate the field).
  if (entry.repoName && entry.repoName !== deps.repoName) return null;
  return entry.mr as { iid?: number; sha?: string | null };
}

/**
 * Guard 3, MR-anchored: under squash/rebase merge the branch tip is never an
 * ancestor of the default branch, and delete-source-branch removes
 * origin/<branch> before the tick sees the merge — so the MR head sha from the
 * branch cache is the only anchor that survives both. Unknown sha → fetch once,
 * then refuse rather than guess.
 */
async function mrAnchorRefusal(deps: DisposeDeps, rec: TreeRecord, sha: string): Promise<string | null> {
  if (!(await gitOk(rec.path, ["cat-file", "-e", sha]))) {
    await runGit(deps.repoPath, ["fetch", "origin"], { timeoutMs: FETCH_TIMEOUT_MS });
    if (!(await gitOk(rec.path, ["cat-file", "-e", sha]))) return "mr-sha-unresolvable";
  }
  return (await isAncestorAsync(rec.path, "HEAD", sha)) ? null : "unpushed";
}

/** Guard 3, no-MR: pushed-but-MR-less branches anchor on their own remote ref. */
async function remoteAnchorRefusal(rec: TreeRecord): Promise<string | null> {
  const anchor =
    rec.branch && (await remoteRefExists(rec.path, rec.branch))
      ? `refs/remotes/origin/${rec.branch}`
      : await remoteDefaultRef(rec.path);
  return (await isAncestorAsync(rec.path, "HEAD", anchor)) ? null : "unpushed";
}

/**
 * Guard the tree, then remove it: worktree, branch, registry entry, event.
 *
 * Returns the refusal reason instead of throwing; callers decide what to do
 * with it (the reactor flips the tree to `disposable` with the reason, the CLI
 * prints it).
 */
export async function disposeTree(
  deps: DisposeDeps,
  rec: TreeRecord,
  opts: { force?: boolean; auto?: boolean },
): Promise<DisposeOutcome> {
  const { repoName, repoPath, emit, log } = deps;
  const force = opts.force === true;
  const auto = opts.auto === true;

  const refuse = (refusal: string): DisposeOutcome => {
    log.info("worktree dispose refused", { repo: repoName, tree: rec.name, refusal });
    return { disposed: false, refusal };
  };

  // 1. Categorical: only rt-built ephemeral trees are rt's to delete. No force.
  if (rec.kind !== "ephemeral") return refuse(`kind-${rec.kind}`);

  let discarded: string[] = [];

  if (!force) {
    // 2. Clean modulo declared generated drift.
    const { discard, blockers } = await classifyDirtyAsync(rec.path, repoName);
    if (blockers.length > 0) return refuse("dirty");
    discarded = discard;

    // 3. Nothing local-only, checked against the right anchor.
    const mr = joinedMr(deps, rec);
    const anchorRefusal =
      auto && mr
        ? typeof mr.sha === "string" && mr.sha.length > 0
          ? await mrAnchorRefusal(deps, rec, mr.sha)
          : "mr-sha-unresolvable"
        : await remoteAnchorRefusal(rec);
    if (anchorRefusal) return refuse(anchorRefusal);

    // 4. Nobody is attending the MR right now.
    if (mr && typeof mr.iid === "number" && hasFreshAttendantLease(mr.iid)) {
      return refuse("attended");
    }

    // 5. Auto only: a just-claimed tree can't be reaped by a stale merge event.
    if (auto && rec.claimedAt) {
      const claimedMs = Date.parse(rec.claimedAt);
      if (!Number.isNaN(claimedMs) && Date.now() - claimedMs < GRACE_MS) return refuse("grace");
    }
  }

  if (deps.killProcesses) {
    const { terminated } = killWorktreeProcesses(rec.path);
    if (terminated.length > 0) {
      log.info("worktree processes terminated", {
        repo: repoName, tree: rec.name, count: terminated.length,
      });
    }
  }

  // --force here is plumbing, not a safety statement: `git worktree remove`
  // refuses on any untracked file, and the guard above (or the caller's
  // explicit force) already made the decision.
  const removal = await runGit(repoPath, ["worktree", "remove", "--force", rec.path]);
  if (removal.exitCode !== 0) {
    // Tolerated (the dir may already be gone by hand), but never silent.
    log.warn("git worktree remove failed during dispose", {
      repo: repoName, tree: rec.name, path: rec.path,
      output: (removal.stdout + removal.stderr).trim(),
    });
  }

  if (rec.branch) {
    // Already-gone branches are expected (the reactor disposes after a merge
    // that may have deleted it), so a failure here is not worth a warning.
    await runGit(repoPath, ["branch", "-D", rec.branch]);
  }

  saveRegistry(repoName, loadRegistry(repoName).filter((t) => t.path !== rec.path));

  emit("worktree:disposed", {
    repo: repoName,
    tree: rec.name,
    path: rec.path,
    branch: rec.branch,
    discarded,
  });
  log.info("worktree disposed", { repo: repoName, tree: rec.name, path: rec.path });

  return { disposed: true };
}
