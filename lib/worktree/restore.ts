/**
 * Restore: rehydrate a retained (RT-51) trash entry back into a live
 * worktree. Disposal's manifest.json is the only durable memory of a
 * disposed tree once its registry row is gone, so every step here reads
 * from it rather than from the (now stale, likely absent) registry.
 *
 * A branch that exists again by the time of a restore is refused rather than
 * clobbered: dispose deleted it, so its reappearance means something new was
 * built on that name and this restore is not the tree that owns it anymore.
 */

import { cpSync, existsSync } from "fs";
import { readdir } from "fs/promises";
import { join } from "path";
import { loadRegistry, saveRegistry, type TreeRecord } from "./registry.ts";
import { loadWorktreeRepoConfig, resolveReadySteps, type WorktreeRepoConfig } from "./config.ts";
import { runReadySteps } from "./ready.ts";
import { branchExistsLocalAsync, runGit, MUTATING_TIMEOUT_MS } from "./git-async.ts";
import {
  readDisposalManifest,
  reapTrashDir,
  retainedTrashRoot,
  type DisposalManifest,
} from "./trash.ts";

export interface RestoreDeps {
  repoName: string;
  repoPath: string;
  emit: (type: string, data: unknown) => void;
  log: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
}

export type RestoreResult =
  | { ok: true; tree: TreeRecord; path: string; readyFailed?: boolean; failedStep?: string }
  | {
      ok: false;
      reason:
        | "not-found"
        | "no-manifest"
        | "branch-elsewhere"
        | "no-head-sha"
        | "path-exists"
        | "worktree-add-failed"
        | "copy-failed"
        | "register-failed";
      detail?: string;
    };

export interface RestorableEntry {
  name: string;
  path: string;
  branch: string | null;
  reason: string;
  disposedAt: string;
  keptUntil: string;
}

/**
 * Both retention roots a tree of this repo could have retired into: the
 * legacy in-clone pool root and whatever `rt.worktrees.root` resolves to
 * today. A tree retains under whichever root it actually lived in at
 * dispose time (trash.ts retireTree), so both must be searched... there is
 * no migration step that moves an old entry when the config changes.
 */
function retentionRootsFor(repoPath: string, cfg: WorktreeRepoConfig): string[] {
  return [retainedTrashRoot(join(repoPath, ".worktrees")), retainedTrashRoot(cfg.root)];
}

interface FoundEntry {
  path: string;
  epoch: number;
  manifest: DisposalManifest | null;
}

/** The newest `<treeName>-<epoch>` entry across every retention root. */
async function findRetainedEntry(roots: string[], treeName: string): Promise<FoundEntry | null> {
  let best: FoundEntry | null = null;
  for (const root of new Set(roots)) {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.startsWith(`${treeName}-`)) continue;
      const epochStr = entry.slice(treeName.length + 1);
      if (!/^\d+$/.test(epochStr)) continue;
      const epoch = Number(epochStr);
      if (best && epoch <= best.epoch) continue;
      const entryPath = join(root, entry);
      const manifest = await readDisposalManifest(entryPath);
      best = { path: entryPath, epoch, manifest };
    }
  }
  return best;
}

/**
 * Every restorable entry across both retention roots (newest first), for the
 * CLI's `--list` and the omitted-arg picker. An entry with no manifest
 * predates RT-51 (or its manifest write failed) and is not restorable, so it
 * is left out rather than offered and then refused.
 */
export async function listRestorableEntries(repoName: string, repoPath: string): Promise<RestorableEntry[]> {
  const cfg = await loadWorktreeRepoConfig(repoName, repoPath);
  const roots = retentionRootsFor(repoPath, cfg);
  const out: RestorableEntry[] = [];
  for (const root of new Set(roots)) {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = join(root, entry);
      const manifest = await readDisposalManifest(entryPath);
      if (!manifest) continue;
      out.push({
        name: manifest.name,
        path: entryPath,
        branch: manifest.branch,
        reason: manifest.reason,
        disposedAt: manifest.disposedAt,
        keptUntil: manifest.keptUntil,
      });
    }
  }
  return out.sort((a, b) => Date.parse(b.disposedAt) - Date.parse(a.disposedAt));
}

/**
 * `git worktree add` from the manifest's head: `-b <branch>` when the tree
 * had one (the caller has already confirmed it doesn't exist anymore),
 * detached otherwise. This both recreates the branch and checks it out in
 * one step: there is nothing to "recreate" separately, git does it as part
 * of the add.
 */
async function addWorktreeFromManifest(
  repoPath: string,
  path: string,
  manifest: DisposalManifest,
): Promise<{ ok: boolean; output?: string }> {
  const args = manifest.branch
    ? ["worktree", "add", "-b", manifest.branch, path, manifest.headSha!]
    : ["worktree", "add", "--detach", path, manifest.headSha!];
  const r = await runGit(repoPath, args, { timeoutMs: MUTATING_TIMEOUT_MS });
  return r.exitCode === 0 ? { ok: true } : { ok: false, output: r.stdout + r.stderr };
}

/**
 * Undo `addWorktreeFromManifest` when a later restore step fails: without
 * this, the branch-elsewhere / path-exists guards above refuse every retry
 * forever, since `git worktree add` already recreated both the tree and the
 * branch the retained entry is keyed on.
 */
async function removeCreatedWorktree(
  repoPath: string,
  path: string,
  branch: string | null,
  log: RestoreDeps["log"],
): Promise<void> {
  const removed = await runGit(repoPath, ["worktree", "remove", "--force", path], {
    timeoutMs: MUTATING_TIMEOUT_MS,
  });
  if (removed.exitCode !== 0) {
    log.warn(
      { repoPath, path, output: removed.stdout + removed.stderr },
      "worktree restore: rollback of the created worktree failed",
    );
  }
  if (branch) {
    const branchRemoved = await runGit(repoPath, ["branch", "-D", branch], { timeoutMs: MUTATING_TIMEOUT_MS });
    if (branchRemoved.exitCode !== 0) {
      log.warn(
        { repoPath, branch, output: branchRemoved.stdout + branchRemoved.stderr },
        "worktree restore: rollback of the created branch failed",
      );
    }
  }
}

/**
 * Layers the retained copy's non-git content back over the fresh checkout:
 * `git worktree add` already recreated every tracked file from `headSha`, so
 * only the retained copy's gitignored/untracked files need to move:
 * `.local-dev`, `.env`, anything a build didn't regenerate (the reinstallable
 * dirs were already stripped at dispose time and are simply absent here).
 * `.git` and `manifest.json` are the entry's own bookkeeping and must never
 * be copied over the worktree's real git admin file.
 */
async function copyRetainedContent(entryPath: string, destPath: string): Promise<{ ok: boolean; err?: string }> {
  let entries: string[];
  try {
    entries = await readdir(entryPath);
  } catch (err) {
    return { ok: false, err: String(err) };
  }
  for (const entry of entries) {
    if (entry === ".git" || entry === "manifest.json") continue;
    try {
      cpSync(join(entryPath, entry), join(destPath, entry), { recursive: true, force: true });
    } catch (err) {
      return { ok: false, err: String(err) };
    }
  }
  return { ok: true };
}

export async function restoreTree(deps: RestoreDeps, treeName: string): Promise<RestoreResult> {
  const { repoName, repoPath, emit, log } = deps;
  const cfg = await loadWorktreeRepoConfig(repoName, repoPath);
  const roots = retentionRootsFor(repoPath, cfg);

  const found = await findRetainedEntry(roots, treeName);
  if (!found) return { ok: false, reason: "not-found" };
  const manifest = found.manifest;
  if (!manifest) return { ok: false, reason: "no-manifest" };

  if (manifest.branch && (await branchExistsLocalAsync(repoPath, manifest.branch))) {
    return {
      ok: false,
      reason: "branch-elsewhere",
      detail: `branch "${manifest.branch}" already exists in this repo`,
    };
  }
  if (!manifest.headSha) return { ok: false, reason: "no-head-sha" };

  const path = join(cfg.root, treeName);
  if (existsSync(path)) return { ok: false, reason: "path-exists", detail: path };

  const added = await addWorktreeFromManifest(repoPath, path, manifest);
  if (!added.ok) return { ok: false, reason: "worktree-add-failed", detail: added.output };

  const copied = await copyRetainedContent(found.path, path);
  if (!copied.ok) {
    log.warn(
      { repo: repoName, tree: treeName, path, err: copied.err },
      "worktree restore: copying retained content failed",
    );
    await removeCreatedWorktree(repoPath, path, manifest.branch, log);
    return { ok: false, reason: "copy-failed", detail: copied.err };
  }

  const rec: TreeRecord = {
    name: treeName,
    path,
    kind: "ephemeral",
    state: "claimed",
    branch: manifest.branch,
    createdAt: new Date().toISOString(),
    claimedAt: new Date().toISOString(),
  };
  const trees = loadRegistry(repoName);
  trees.push(rec);
  if (!saveRegistry(repoName, trees)) {
    await removeCreatedWorktree(repoPath, path, manifest.branch, log);
    return { ok: false, reason: "register-failed" };
  }

  // The entry is fully rehydrated into `path` now, so nothing is lost by
  // clearing its retention immediately rather than waiting on RETENTION_MS.
  await reapTrashDir(found.path, log);

  const readySteps = resolveReadySteps(cfg, repoPath);
  const readyResult = await runReadySteps(path, readySteps);

  emit("worktree:restored", { repo: repoName, tree: treeName, path, branch: manifest.branch });
  log.info({ repo: repoName, tree: treeName, path }, "worktree restored");

  if (!readyResult.ok) {
    return { ok: true, tree: rec, path, readyFailed: true, failedStep: readyResult.failedStep };
  }
  return { ok: true, tree: rec, path };
}
