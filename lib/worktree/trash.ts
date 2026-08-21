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

import { mkdir, readdir, rename } from "fs/promises";
import { basename, dirname, join } from "path";

/** Marks a directory as rt's to delete. Nothing without this prefix is ever reaped. */
export const TRASH_PREFIX = ".trash-";

/**
 * The retention store: disposed trees live here (RT-51), stripped of
 * reinstallables, until the reconciler ages them out. Inside `.worktrees` so it
 * is per-repo and shares the repo's volume; the name deliberately lacks the
 * trailing dash so the crash-leftover sweep's `.trash-` prefix match never
 * descends into it.
 */
const RETAIN_DIR = ".trash";

/** How long a retained tree survives before the reconciler reaps it. */
export const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Top-level dirs inside a retained tree that are reinstallable and deleted at
 * dispose time (exact names, plus the `dist-*` family). Mispredicting here
 * costs disk for the retention window, never data — the safe direction.
 */
const STRIP_DIRS = new Set(["node_modules", "dist", ".turbo"]);
const STRIP_PREFIX = "dist-";

/** Minimal log surface: pino's, and the plain object the CLI paths pass. */
export interface TrashLog {
  warn: (...args: unknown[]) => void;
}

export type TrashResult = { ok: true; trashPath: string } | { ok: false; err: unknown };

/**
 * The sibling directory `path` gets renamed to. A sibling (not a shared trash
 * root) so the rename never crosses a filesystem, which is what makes it
 * atomic and instant; the epoch stamp keeps repeat disposals of the same tree
 * name from colliding. A name with a path separator could steer the rename
 * outside the root (and past the basename guard in reapTrashDir), so it is
 * rejected outright.
 */
export function trashPathFor(path: string, name: string, now: number = Date.now()): string {
  if (!name || name.includes("/") || name.includes("\\")) {
    throw new Error(`worktree trash name must be a single path component: ${JSON.stringify(name)}`);
  }
  return join(dirname(path), `${TRASH_PREFIX}${name}-${now}`);
}

/**
 * Rename the tree out of the way. Never throws: a busy or unwritable directory
 * comes back as `{ ok: false }` and the caller decides — dispose refuses
 * ("remove-failed"), scrap shrugs, because mid-create the tree may not exist
 * at all.
 */
export async function trashTree(path: string, name: string): Promise<TrashResult> {
  try {
    const trashPath = trashPathFor(path, name);
    await rename(path, trashPath);
    return { ok: true, trashPath };
  } catch (err) {
    return { ok: false, err };
  }
}

export function retainedTrashRoot(repoPath: string): string {
  return join(repoPath, ".worktrees", RETAIN_DIR);
}

export type RetireResult =
  | { ok: true; trashPath: string; retained: boolean }
  | { ok: false; err: unknown };

/**
 * Rename the tree into the repo's retention store,
 * `<repo>/.worktrees/.trash/<name>-<epoch>`, where it stays recoverable until
 * the reconciler ages it out. When the store can't be used (unwritable, or the
 * rename would cross a volume), falls back to the sibling `.trash-*` rename —
 * the caller sees `retained: false` and reaps it the old way, so disposal
 * never gets stuck behind the retention feature. Never throws.
 */
export async function retireTree(
  path: string,
  name: string,
  repoPath: string,
): Promise<RetireResult> {
  let trashPath: string;
  try {
    if (!name || name.includes("/") || name.includes("\\")) {
      throw new Error(`worktree trash name must be a single path component: ${JSON.stringify(name)}`);
    }
    const root = retainedTrashRoot(repoPath);
    await mkdir(root, { recursive: true });
    trashPath = join(root, `${name}-${Date.now()}`);
  } catch {
    const fallback = await trashTree(path, name);
    return fallback.ok ? { ...fallback, retained: false } : fallback;
  }
  try {
    await rename(path, trashPath);
    return { ok: true, trashPath, retained: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "EXDEV") {
      const fallback = await trashTree(path, name);
      return fallback.ok ? { ...fallback, retained: false } : fallback;
    }
    return { ok: false, err };
  }
}

/** Whether `path` is an entry of a `.trash` retention store. */
function isRetainedEntry(path: string): boolean {
  return basename(dirname(path)) === RETAIN_DIR;
}

/**
 * Delete the reinstallable dirs inside a retained tree in one detached
 * `rm -rf`, leaving everything human-touched in place. Same no-timeout,
 * nobody-waits contract as reapTrashDir; refuses any path that is not inside a
 * `.trash` retention store.
 */
export async function stripTrashDir(trashPath: string, log: TrashLog): Promise<void> {
  if (!isRetainedEntry(trashPath)) {
    log.warn({ path: trashPath }, "worktree strip refused: not a retained trash entry");
    return;
  }

  try {
    const entries = await readdir(trashPath);
    const doomed = entries
      .filter((e) => STRIP_DIRS.has(e) || e.startsWith(STRIP_PREFIX))
      .map((e) => join(trashPath, e));
    if (doomed.length === 0) return;

    const proc = Bun.spawn(["rm", "-rf", "--", ...doomed], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
    });
    proc.unref();
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      log.warn({ path: trashPath, exitCode }, "worktree trash strip failed");
    }
  } catch (err) {
    log.warn({ err, path: trashPath }, "worktree trash strip could not run");
  }
}

/**
 * Age out the retention store: reap every `<name>-<epoch>` entry older than
 * RETENTION_MS. An entry whose name carries no epoch was not written by rt, so
 * it is kept and warned about rather than guessed at. A repo with no store yet
 * is normal. Returns how many were reaped.
 */
export async function reapExpiredTrash(
  repoPath: string,
  log: TrashLog,
  now: number = Date.now(),
): Promise<number> {
  const root = retainedTrashRoot(repoPath);
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      log.warn({ err, root }, "worktree retention sweep could not read trash dir");
    }
    return 0;
  }

  let reaped = 0;
  for (const entry of entries) {
    const epoch = /-(\d+)$/.exec(entry)?.[1];
    if (!epoch) {
      log.warn({ root, entry }, "worktree retention sweep skipped an entry it did not write");
      continue;
    }
    if (now - Number(epoch) <= RETENTION_MS) continue;
    await reapTrashDir(join(root, entry), log);
    reaped += 1;
  }
  return reaped;
}

/**
 * Delete a trash directory in a detached `rm -rf` with no timeout: nothing
 * upstream waits for it, and a kill mid-unlink is the very failure mode this
 * design exists to remove. The returned promise settles when the child does,
 * for the reconciler's one-at-a-time sweep (and for tests); callers on the
 * dispose path drop it.
 *
 * Refuses any path not named `.trash-*` and not inside a `.trash` retention
 * store — the one guard between this and an `rm -rf` of a live worktree.
 */
export async function reapTrashDir(trashPath: string, log: TrashLog): Promise<void> {
  if (!basename(trashPath).startsWith(TRASH_PREFIX) && !isRetainedEntry(trashPath)) {
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
    } catch (err) {
      // A root that never existed is normal; anything else hides stale trash.
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        log.warn({ err, root }, "worktree trash sweep could not read root");
      }
      continue;
    }
    for (const entry of entries) {
      if (!entry.startsWith(TRASH_PREFIX)) continue;
      await reapTrashDir(join(root, entry), log);
      reaped += 1;
    }
  }
  return reaped;
}
