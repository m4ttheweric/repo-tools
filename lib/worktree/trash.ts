/**
 * Trash-and-reap: how rt makes a worktree directory go away.
 *
 * `git worktree remove` unlinks the tree file by file. On a pnpm-scale
 * node_modules that is minutes of syscalls, and it runs inline in whatever
 * verb asked for the disposal — so `rt worktree dispose` blocked for as long
 * as the tree was big, and the timeout that bounded it killed the unlink
 * mid-flight, leaving a half-deleted directory that was neither a worktree nor
 * gone.
 *
 * So disposal renames instead: one same-volume rename into a sibling
 * `.trash-<name>-<epoch>` directory. That is atomic and instant regardless of
 * tree size, and it either happened or it didn't — never half. Everything
 * after it (prune, branch -D, registry) is fast and keys off the same fact:
 * the tree dir is no longer at rec.path. Verb latency becomes O(seconds).
 *
 * The real unlink is a detached `rm -rf` nobody waits on and nothing times
 * out. If that process (or the whole daemon) dies mid-delete, the leftover is
 * a `.trash-*` directory, which is exactly what the reconciler's reap duty
 * sweeps on a later pass — a crash costs disk, never correctness.
 */

import { readdir, rename } from "fs/promises";
import { basename, dirname, join } from "path";

/** Marks a directory as rt's to delete. Nothing without this prefix is ever reaped. */
export const TRASH_PREFIX = ".trash-";

/** Minimal log surface: pino's, and the plain object the CLI paths pass. */
export interface TrashLog {
  warn: (...args: unknown[]) => void;
}

export type TrashResult = { ok: true; trashPath: string } | { ok: false; err: unknown };

/**
 * The sibling directory `path` gets renamed to. A sibling (not a shared trash
 * root) so the rename never crosses a filesystem, which is what makes it
 * atomic and instant; the epoch stamp keeps repeat disposals of the same tree
 * name from colliding.
 */
export function trashPathFor(path: string, name: string, now: number = Date.now()): string {
  return join(dirname(path), `${TRASH_PREFIX}${name}-${now}`);
}

/**
 * Rename the tree out of the way. Never throws: a busy or unwritable directory
 * comes back as `{ ok: false }` and the caller decides — dispose refuses
 * ("remove-failed"), scrap shrugs, because mid-create the tree may not exist
 * at all.
 */
export async function trashTree(path: string, name: string): Promise<TrashResult> {
  const trashPath = trashPathFor(path, name);
  try {
    await rename(path, trashPath);
    return { ok: true, trashPath };
  } catch (err) {
    return { ok: false, err };
  }
}

/**
 * Delete a trash directory in a detached `rm -rf` with no timeout: nothing
 * upstream waits for it, and a kill mid-unlink is the very failure mode this
 * design exists to remove. The returned promise settles when the child does,
 * for the reconciler's one-at-a-time sweep (and for tests); callers on the
 * dispose path drop it.
 *
 * Refuses any path not named `.trash-*` — the one guard between this and an
 * `rm -rf` of a live worktree.
 */
export async function reapTrashDir(trashPath: string, log: TrashLog): Promise<void> {
  if (!basename(trashPath).startsWith(TRASH_PREFIX)) {
    log.warn({ path: trashPath }, "worktree reap refused: not a trash directory");
    return;
  }

  try {
    const proc = Bun.spawn(["rm", "-rf", "--", trashPath], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      // Survives the CLI process that started it: the point is that no caller
      // has to stay alive for the delete to finish.
      detached: true,
    });
    proc.unref();
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      log.warn({ path: trashPath, exitCode }, "worktree trash reap failed");
    }
  } catch (err) {
    log.warn({ err, path: trashPath }, "worktree trash reap could not be spawned");
  }
}

/**
 * Sweep every `.trash-*` directory out of `roots`, one at a time (a reap is
 * IO-bound and there is never a hurry — this is the crash-leftover path, not
 * the dispose path). A root that does not exist is normal, not an error: a
 * repo may simply never have had a worktree. Returns how many were reaped.
 */
export async function reapTrashInRoots(roots: string[], log: TrashLog): Promise<number> {
  let reaped = 0;
  for (const root of new Set(roots)) {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      continue; // no such root yet
    }
    for (const entry of entries) {
      if (!entry.startsWith(TRASH_PREFIX)) continue;
      await reapTrashDir(join(root, entry), log);
      reaped += 1;
    }
  }
  return reaped;
}
