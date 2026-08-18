/**
 * Cold create: allocate a fresh ephemeral worktree from scratch.
 *
 * Registry-first ordering is load-bearing: the "creating" entry is written
 * BEFORE `git worktree add` runs, and the tree lock is taken before that
 * write. That way a crash mid-create always leaves a registry row a sweep
 * can find and reconcile, never an orphaned worktree the registry doesn't
 * know about. Any failure after the registry write scraps everything
 * (worktree + on-deck branch + registry row) and reports typed detail.
 */

import { join } from "path";
import {
  loadRegistry,
  saveRegistry,
  usedNames,
  type TreeRecord,
} from "./registry.ts";
import {
  runGit,
  remoteDefaultRef,
  headSha,
  ensureInfoExclude,
  listWorktreesAsync,
} from "./git-async.ts";
import { pickName } from "./names.ts";
import { loadWorktreeRepoConfig, resolveReadySteps, type WorktreeRepoConfig } from "./config.ts";
import { runReadySteps } from "./ready.ts";
import { withTreeLock } from "./locks.ts";
import { reconcileForRepo } from "../daemon/doppler-sync.ts";

const CREATE_TIMEOUT_MS = 5 * 60_000;

/** `git worktree remove` deletes node_modules by hand; a pnpm-scale tree on
 *  APFS routinely outruns runGit's 60s default. */
const REMOVE_TIMEOUT_MS = 5 * 60_000;

/** Longest slice of a failed step's output carried into the log line. */
const MAX_LOGGED_OUTPUT = 2000;

/** The tail of a step's output — a failing install reports at the end, not the start. */
function outputTail(output: string, maxChars: number): string {
  const trimmed = output.trim();
  return trimmed.length <= maxChars ? trimmed : `…${trimmed.slice(-maxChars)}`;
}

export interface CreateDeps {
  repoName: string;
  repoPath: string;
  emit: (type: string, data: unknown) => void;
  log: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
}

export type CreateResult =
  | { ok: true; tree: TreeRecord }
  | { ok: false; error: "create-failed"; failedStep?: string; output?: string }
  | { ok: false; error: "busy" };

export async function createTree(deps: CreateDeps): Promise<CreateResult> {
  const { repoName, repoPath } = deps;
  const cfg = loadWorktreeRepoConfig(repoName, repoPath);
  const existing = loadRegistry(repoName);
  const name = pickName(cfg.namePool, usedNames(existing));
  const path = join(cfg.root, name);

  const defaultRoot = join(repoPath, ".worktrees");
  if (cfg.root === defaultRoot) {
    await ensureInfoExclude(repoPath, ".worktrees/");
  }

  const outcome = await withTreeLock(path, () => runCreate(deps, cfg, name, path));
  if (outcome === "busy") {
    return { ok: false, error: "busy" };
  }
  return outcome;
}

async function runCreate(
  deps: CreateDeps,
  cfg: WorktreeRepoConfig,
  name: string,
  path: string,
): Promise<CreateResult> {
  const { repoName, repoPath, emit, log } = deps;
  const branch = `on-deck/${name}`;

  const rec: TreeRecord = {
    name,
    path,
    kind: "ephemeral",
    state: "creating",
    branch,
    createdAt: new Date().toISOString(),
  };

  // Registry-first: this write must land before any git mutation below.
  const trees = loadRegistry(repoName);
  trees.push(rec);
  saveRegistry(repoName, trees);

  const fail = async (failedStep: string, output: string): Promise<CreateResult> => {
    // The output is the whole diagnosis (which install died, and why); without
    // it the log says only which step's name failed.
    log.warn(
      { repo: repoName, tree: name, failedStep, output: outputTail(output, MAX_LOGGED_OUTPUT) },
      "worktree create failed",
    );
    await scrapTree(deps, rec);
    return { ok: false, error: "create-failed", failedStep, output };
  };

  const defaultRef = await remoteDefaultRef(repoPath);
  const defaultBranchName = defaultRef.replace(/^origin\//, "");

  const fetchResult = await runGit(repoPath, ["fetch", "origin", defaultBranchName], {
    timeoutMs: CREATE_TIMEOUT_MS,
  });
  if (fetchResult.exitCode !== 0) {
    return fail(`git fetch origin ${defaultBranchName}`, fetchResult.stdout + fetchResult.stderr);
  }

  const addResult = await runGit(
    repoPath,
    ["worktree", "add", "-b", branch, path, defaultRef],
    { timeoutMs: CREATE_TIMEOUT_MS },
  );
  if (addResult.exitCode !== 0) {
    return fail(`git worktree add -b ${branch} ${path} ${defaultRef}`, addResult.stdout + addResult.stderr);
  }

  const readySteps = resolveReadySteps(cfg, repoPath);
  const readyResult = await runReadySteps(path, readySteps);
  if (!readyResult.ok) {
    return fail(readyResult.failedStep, readyResult.output);
  }

  const worktreeRoots = (await listWorktreesAsync(repoPath)).map((w) => w.path);
  await reconcileForRepo({ repoName, worktreeRoots });

  const readyStamp = await headSha(path);
  const updated: TreeRecord = {
    ...rec,
    state: "on-deck",
    readyAt: new Date().toISOString(),
    ...(readyStamp ? { readyStamp } : {}),
  };

  const finalTrees = loadRegistry(repoName).map((t) => (t.path === path ? updated : t));
  saveRegistry(repoName, finalTrees);

  emit("worktree:created", { repo: repoName, tree: name, path });
  log.info({ repo: repoName, tree: name, path }, "worktree created");

  return { ok: true, tree: updated };
}

/**
 * Force-remove the worktree, delete its on-deck/<name> branch, and prune the
 * registry entry. Tolerant of partial existence: the worktree may not exist
 * yet (git worktree add never ran or failed before creating it), and the
 * branch may not exist either.
 */
export async function scrapTree(deps: CreateDeps, rec: TreeRecord): Promise<void> {
  await runGit(deps.repoPath, ["worktree", "remove", "--force", rec.path], {
    timeoutMs: REMOVE_TIMEOUT_MS,
  });
  if (rec.branch) {
    await runGit(deps.repoPath, ["branch", "-D", rec.branch]);
  }
  const trees = loadRegistry(deps.repoName).filter((t) => t.path !== rec.path);
  saveRegistry(deps.repoName, trees);
}
