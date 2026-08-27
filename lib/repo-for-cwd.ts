/**
 * cwd to repo and branch, without a sync git spawn.
 *
 * The daemon thread never sync-execs (MAT-222): finding a cwd's repo is a
 * `.git` walk plus a repo-index reverse lookup, both plain file reads;
 * finding its branch is the one git call an unsigned pane needs, run async
 * so the daemon loop never blocks.
 */

import { existsSync, readFileSync, realpathSync, statSync } from "fs";
import { dirname, join, resolve as resolvePath } from "path";
import { repoLabel } from "./repo-label.ts";
import { runCapture } from "./subprocess.ts";

export function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Nearest ancestor directory holding a `.git` entry — a plain walk, never a git spawn. */
export function findGitRoot(start: string): string | null {
  let dir = start;
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The MAIN worktree path for `worktreeRoot`: itself when `.git` is a real
 * directory, or — for a linked worktree — the repo its `.git` FILE's
 * `gitdir: <main>/.git/worktrees/<slot>` pointer names, parsed by hand
 * (never `git worktree list`). Null when the pointer is stale or foreign
 * (a worktree whose gitdir survived a home-directory move errors with
 * "fatal: not a git repository" under real git) — this is why the
 * resolution order has a position AFTER the repo-name rung: dropping
 * straight to `<user>-<host>` here would give one shared handle to every
 * broken directory on the machine.
 */
export function resolveMainWorktreePath(worktreeRoot: string): string | null {
  const gitPath = join(worktreeRoot, ".git");
  let stat;
  try {
    stat = statSync(gitPath);
  } catch {
    return null;
  }
  if (stat.isDirectory()) return worktreeRoot;
  if (!stat.isFile()) return null;

  let content: string;
  try {
    content = readFileSync(gitPath, "utf8");
  } catch {
    return null;
  }
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(content);
  if (!match) return null;
  const gitdir = match[1]!.startsWith("/") ? match[1]! : resolvePath(worktreeRoot, match[1]!);

  // "<main>/.git/worktrees/<slot>" → <main>, three levels up.
  const mainPath = dirname(dirname(dirname(gitdir)));
  if (!existsSync(mainPath) || !existsSync(join(mainPath, ".git"))) return null;
  return mainPath;
}

/**
 * Reverse lookup: which repos.json alias names `mainWorktreePath`. Index is an
 * explicit param so the derivation stays testable without a real HOME
 * (carry-forward fixture test). Index keys are serialized identities after the
 * RT-62 re-key (`remote:host%2Fpath`) — a wire form whose `%` and `:` the
 * handle charset forbids — so the alias is the key's display label, never the
 * key itself (repoLabel passes a legacy name-keyed row through unchanged).
 */
export function repoAliasForPath(mainWorktreePath: string, index: Record<string, string>): string | null {
  const target = safeRealpath(mainWorktreePath);
  for (const [name, path] of Object.entries(index)) {
    if (safeRealpath(path) === target) return repoLabel(name);
  }
  return null;
}

/** cwd to the repo's display label using the repo index alone: no git spawn, so it is safe on the daemon thread. */
export function repoForCwd(cwd: string, index: Record<string, string>): string | null {
  const gitRoot = findGitRoot(cwd);
  if (!gitRoot) return null;
  const main = resolveMainWorktreePath(gitRoot);
  if (!main) return null;
  return repoAliasForPath(main, index);
}

/** The one git call an unsigned pane needs, async so the daemon loop never blocks. */
export async function branchForCwd(cwd: string, exec: typeof runCapture = runCapture): Promise<string | undefined> {
  const res = await exec(["git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { timeoutMs: 2_000 });
  if (res.exitCode !== 0) return undefined;
  const branch = res.stdout.trim();
  return branch && branch !== "HEAD" ? branch : undefined;
}
