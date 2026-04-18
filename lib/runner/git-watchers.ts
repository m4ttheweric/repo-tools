/**
 * Git HEAD watchers for the runner.
 *
 * Each lane is bound to one repo. A single fs.watch on that repo's git-common
 * dir, filtered to `HEAD`, catches branch switches from the main worktree.
 * Linked worktrees keep their HEAD under `.git/worktrees/<name>/HEAD`, so a
 * second recursive watch on that subdir covers them too.
 *
 * Debounce: `git checkout` touches dozens of .git/ files in rapid succession,
 * producing a storm of FSEvents. Without debouncing, each one calls spawnSync
 * on the render path, blocking key handling for seconds. 150ms is enough for
 * git to finish writing HEAD before we read it.
 *
 * Retry: even with debounce, a very-fresh HEAD may not yet reflect the new
 * branch. Callers receive `onChange(laneId)` and decide whether to retry
 * (this module just tells you *when*, not *what* changed).
 */

import { existsSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// ─── Branch reading ──────────────────────────────────────────────────────────

/**
 * Returns the common .git directory for any worktree path.
 * `git rev-parse --git-common-dir` always returns the main repo's .git dir,
 * even when called from a linked worktree — so this is the right thing to watch
 * for a lane (one watcher covers all worktrees of that repo).
 */
export function repoGitDir(worktreePath: string): string | null {
  try {
    const result = spawnSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: worktreePath, encoding: "utf8",
    });
    if (result.status !== 0) return null;
    const gitDir = result.stdout.trim();
    return gitDir.startsWith("/") ? gitDir : join(worktreePath, gitDir);
  } catch {
    return null;
  }
}

export function readCurrentBranch(worktreePath: string): string | null {
  try {
    const result = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: worktreePath, encoding: "utf8",
    });
    return result.status === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Async parallel-friendly variant of readCurrentBranch. Used at startup to avoid
 * 10× serial spawnSync stalls (~30ms each) before first render.
 */
export async function readCurrentBranchAsync(worktreePath: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: worktreePath,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return code === 0 ? stdout.trim() : null;
  } catch {
    return null;
  }
}

// ─── Watcher pool ────────────────────────────────────────────────────────────

/**
 * Minimal lane shape the pool needs. The full LaneConfig carries much more, but
 * this module stays decoupled from it — keeping the import graph one-way
 * (runner.tsx depends on git-watchers.ts, not the reverse).
 */
export interface GitWatcherLane {
  id:      string;
  entries: Array<{ worktree?: string }>;
}

export interface GitWatcherPool {
  /** Reconcile watchers against the current lane set: add new, drop removed. */
  sync(lanes: GitWatcherLane[]): void;
  /** Close every watcher and cancel pending debounce timers. */
  dispose(): void;
}

/**
 * Create a pool of per-lane git HEAD watchers. `onChange(laneId)` fires once,
 * debounced ~150ms after the last HEAD event for that lane.
 *
 * Watcher keys in the internal map:
 *   "<laneId>"      — main .git dir watcher (non-recursive, HEAD filter)
 *   "<laneId>:wt"   — recursive worktrees/ watcher (optional, may not exist)
 */
export function createGitWatcherPool(onChange: (laneId: string) => void): GitWatcherPool {
  const watchers = new Map<string, FSWatcher>();
  const debounce = new Map<string, ReturnType<typeof setTimeout>>();
  const DEBOUNCE_MS = 150;

  function fire(laneId: string): void {
    const existing = debounce.get(laneId);
    if (existing) clearTimeout(existing);
    debounce.set(
      laneId,
      setTimeout(() => {
        debounce.delete(laneId);
        onChange(laneId);
      }, DEBOUNCE_MS),
    );
  }

  return {
    sync(lanes) {
      const activeLaneIds = new Set(lanes.map((l) => l.id));

      // Remove watchers for lanes that no longer exist.
      // ":wt" companion watchers share the fate of their parent lane — strip
      // the suffix before checking against the active set.
      for (const [key, w] of watchers) {
        const baseId = key.endsWith(":wt") ? key.slice(0, -3) : key;
        if (!activeLaneIds.has(baseId)) {
          try { w.close(); } catch { /* */ }
          watchers.delete(key);
        }
      }

      // Add a watcher for each lane that has at least one entry with a worktree.
      // Watch only the git common dir's HEAD-adjacent files (not the entire
      // .git dir recursively) so the watcher only fires on real branch changes
      // and not on every git operation (fetch, gc, ref updates, etc.).
      for (const lane of lanes) {
        if (watchers.has(lane.id)) continue;
        const anyWorktree = lane.entries.find((e) => e.worktree)?.worktree;
        if (!anyWorktree) continue;
        const gitDir = repoGitDir(anyWorktree);
        if (!gitDir || !existsSync(gitDir)) continue;

        try {
          const w = watch(gitDir, (_evt, filename) => {
            if (filename === "HEAD") fire(lane.id);
          });
          watchers.set(lane.id, w);

          // Linked worktrees have their HEAD under .git/worktrees/<name>/HEAD.
          const worktreesDir = join(gitDir, "worktrees");
          if (existsSync(worktreesDir)) {
            try {
              const ww = watch(worktreesDir, { recursive: true }, (_evt, filename) => {
                if (filename?.endsWith("HEAD")) fire(lane.id);
              });
              watchers.set(`${lane.id}:wt`, ww);
            } catch { /* worktrees subdir watch failed — main HEAD watcher still active */ }
          }
        } catch { /* fs.watch not available for this path */ }
      }
    },

    dispose() {
      for (const t of debounce.values()) clearTimeout(t);
      debounce.clear();
      for (const w of watchers.values()) {
        try { w.close(); } catch { /* */ }
      }
      watchers.clear();
    },
  };
}
