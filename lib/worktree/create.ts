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

import { existsSync } from "fs";
import { isAbsolute, join, relative } from "path";
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
import { loadWorktreeRepoConfig, evaluateReadyGate, type WorktreeRepoConfig } from "./config.ts";
import { runReadySteps } from "./ready.ts";
import { withTreeLock } from "./locks.ts";
import { reapTrashDir, trashTree } from "./trash.ts";
import { reconcileForRepo } from "../daemon/doppler-sync.ts";
import { deriveRepoIdentity } from "../settings/identity.ts";
import { MAX_LOGGED_OUTPUT, outputTail } from "../subprocess.ts";

const CREATE_TIMEOUT_MS = 5 * 60_000;

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
  const cfg = await loadWorktreeRepoConfig(repoName, repoPath);
  const existing = loadRegistry(repoName);
  const name = pickName(cfg.namePool, usedNames(existing));
  const path = join(cfg.root, name);

  // The default pool root (RT-52) lives outside the clone, so info/exclude is
  // only needed when a user override points root back inside the repo.
  const rel = relative(repoPath, cfg.root);
  const rootInsideRepo = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  if (rootInsideRepo) {
    await ensureInfoExclude(repoPath, `${rel.split("/")[0]}/`);
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

  // Scopes before ready steps: a step may shell out to `doppler`, which resolves
  // its project from this tree's path and fails "must specify a project" until
  // the path is scoped. The periodic cache-refresh reconcile would scope it
  // later, but only after this create has already failed and scrapped the tree.
  const gitEntries = await listWorktreesAsync(repoPath);
  if (gitEntries === null) {
    log.warn({ repo: repoName, tree: name, path }, "worktree create: git worktree list failed; skipping doppler sync");
  } else {
    const worktreeRoots = gitEntries.map((w) => w.path);
    const derived = await deriveRepoIdentity(repoPath);
    const repoIdentity = derived.kind === "remote" ? derived.id : null;
    await reconcileForRepo({ repoIdentity, worktreeRoots });
  }

  const { steps: readySteps, held } = await evaluateReadyGate(cfg, repoName, repoPath);
  if (held) {
    log.warn({ repo: repoName, tree: name }, "worktree create: team `ready` steps held pending approval; run `rt worktree ready-approve`");
    emit("worktree:ready-held", { repo: repoName, tree: name });
  }
  const readyResult = await runReadySteps(path, readySteps);
  if (!readyResult.ok) {
    return fail(readyResult.failedStep, readyResult.output);
  }

  // A held team ladder means the excluded steps never ran — stamping
  // readyAt/readyStamp here anyway would let a later freshen's
  // changedSince(readyStamp, HEAD) diff look clean and skip a
  // changed:<glob> step that never actually ran, even once approved.
  const readyStamp = held ? null : await headSha(path);
  const updated: TreeRecord = {
    ...rec,
    state: "on-deck",
    ...(held ? {} : { readyAt: new Date().toISOString() }),
    ...(readyStamp ? { readyStamp } : {}),
  };

  const finalTrees = loadRegistry(repoName).map((t) => (t.path === path ? updated : t));
  if (!saveRegistry(repoName, finalTrees)) {
    log.warn(
      { repo: repoName, tree: name, path },
      "worktree create: final registry flip dropped; leaving row creating",
    );
    return { ok: false, error: "create-failed", failedStep: "registry-flip" };
  }

  emit("worktree:created", { repo: repoName, tree: name, path });
  log.info({ repo: repoName, tree: name, path }, "worktree created");

  return { ok: true, tree: updated };
}

/**
 * Get rid of a half-built tree: rename it into trash (see trash.ts) with a
 * detached reap behind it, prune the registration, delete its on-deck/<name>
 * branch, and drop the registry entry. Tolerant of partial existence — the
 * worktree may not exist yet (git worktree add never ran or failed before
 * creating it), and the branch may not exist either — and, since it renames
 * rather than asking git to unlink, it returns instantly however far the
 * install got before the create failed.
 */
/** Whether `path` has a `.git` entry, the one cheap signal a git worktree (or repo) always carries. A desynced registry row pointing at a directory rt never created must fail this, or scrap's rm -rf would trash arbitrary content. */
function looksLikeWorktreeDir(path: string): boolean {
  return existsSync(join(path, ".git"));
}

export async function scrapTree(deps: CreateDeps, rec: TreeRecord): Promise<void> {
  if (existsSync(rec.path) && !looksLikeWorktreeDir(rec.path)) {
    deps.log.warn(
      { repo: deps.repoName, tree: rec.name, path: rec.path },
      "worktree scrap: path exists with no .git entry; refusing to trash a directory rt did not create",
    );
    return;
  }

  const trashed = await trashTree(rec.path, rec.name);
  if (trashed.ok) {
    void reapTrashDir(trashed.trashPath, deps.log);
  } else if (existsSync(rec.path)) {
    // Absent is the normal case here (`git worktree add` may never have run);
    // present-and-unrenameable means the tree is still on disk, so keep its
    // branch and registry record — dropping them would strand a live
    // directory as unmanaged. The reconciler scraps orphaned `creating`
    // entries every pass, so this retries until the rename goes through.
    deps.log.warn(
      { repo: deps.repoName, tree: rec.name, path: rec.path, err: trashed.err },
      "worktree scrap: trash rename failed",
    );
    return;
  }
  // Collects the registration whose directory just went missing. Unconditional:
  // scrap is the tolerant path, and every step below runs on best effort.
  await runGit(deps.repoPath, ["worktree", "prune"]);
  if (rec.branch) {
    await runGit(deps.repoPath, ["branch", "-D", rec.branch]);
  }
  const trees = loadRegistry(deps.repoName).filter((t) => t.path !== rec.path);
  saveRegistry(deps.repoName, trees);
}
