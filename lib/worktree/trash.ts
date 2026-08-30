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

import { mkdir, readdir, readFile, rename, writeFile } from "fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "path";
import { ensureInfoExclude } from "./git-async.ts";

/** Marks a directory as rt's to delete. Nothing without this prefix is ever reaped. */
export const TRASH_PREFIX = ".trash-";

/**
 * The retention store: disposed trees live here (RT-51), stripped of
 * reinstallables, until the reconciler ages them out. A sibling of the pool
 * root the tree itself lived in (see retainedTrashRoot), so it always shares
 * the tree's volume; the name deliberately lacks the trailing dash so the
 * crash-leftover sweep's `.trash-` prefix match never descends into it.
 */
const RETAIN_DIR = ".trash";

/** How long a retained tree survives before the reconciler reaps it. */
export const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * A ms-epoch rt actually wrote (`${name}-${Date.now()}`) is always after
 * this. A trailing small integer — a manual "backup-3" or "notes-42"
 * dropped "with the other trash" — parses as a number just fine and, taken
 * at face value as an epoch, is always ancient; without this floor it gets
 * reaped on the very next pass despite not being rt's to delete.
 */
const EPOCH_FLOOR_MS = Date.UTC(2020, 0, 1);

/** Whether `raw` looks like an epoch rt itself would have written, not merely any integer. */
function looksLikeRtEpoch(raw: string): boolean {
  const n = Number(raw);
  return Number.isInteger(n) && n >= EPOCH_FLOOR_MS;
}

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

/** The retention store for trees whose pool root is `poolRoot`: `<poolRoot>/.trash`. */
export function retainedTrashRoot(poolRoot: string): string {
  return join(poolRoot, RETAIN_DIR);
}

export type RetireResult =
  | { ok: true; trashPath: string; retained: boolean }
  | { ok: false; err: unknown };

/**
 * Rename the tree into a retention store beside the pool root it actually
 * lives in (`dirname(path)`), `<poolRoot>/.trash/<name>-<epoch>`, where it
 * stays recoverable until the reconciler ages it out. No `cfg.root` lookup:
 * whatever root the tree sits in today is the root its trash rides on, so a
 * legacy tree (pool root `<repo>/.worktrees`) retains under the old root and a
 * tree on the new default pool root retains there, with no migration step.
 * When the store can't be used (unwritable, or the rename would cross a
 * volume), falls back to the sibling `.trash-*` rename... the caller sees
 * `retained: false` and reaps it the old way, so disposal never gets stuck
 * behind the retention feature. Never throws.
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
    const poolRoot = dirname(path);
    // Only a pool root INSIDE the clone needs a git info/exclude entry; the
    // default out-of-repo root never shows up in the user's own `git status`
    // at all, so excluding it would be a no-op at best.
    const rel = relative(repoPath, poolRoot);
    if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) {
      await ensureInfoExclude(repoPath, `${rel.split("/")[0]}/`);
    }
    const root = retainedTrashRoot(poolRoot);
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
 * The durable record dispose writes inside a retained entry (RT-51): what the
 * tree was, and how long it survives. It lives beside the tree's own content
 * in the trash dir, not in state.db, so a restore is possible even after a
 * quarantine of the db has erased the registry's memory of the tree ever
 * existing.
 */
export interface DisposalManifest {
  name: string;
  originalPath: string;
  branch: string | null;
  headSha: string | null;
  reason: string;
  disposedAt: string;
  keptUntil: string;
}

const MANIFEST_FILE = "manifest.json";

/**
 * Best-effort: by the time this runs, disposal has already renamed the tree
 * to safety, so a manifest write failure must never fail the dispose call
 * that's still in flight... it only means that entry falls back to the
 * epoch-in-name reap rule instead of `keptUntil`.
 */
export async function writeDisposalManifest(
  trashPath: string,
  manifest: DisposalManifest,
  log: TrashLog,
): Promise<void> {
  if (!isRetainedEntry(trashPath)) {
    log.warn({ path: trashPath }, "worktree manifest write refused: not a retained trash entry");
    return;
  }
  try {
    await writeFile(join(trashPath, MANIFEST_FILE), JSON.stringify(manifest, null, 2));
  } catch (err) {
    log.warn({ err, path: trashPath }, "worktree manifest write failed");
  }
}

/**
 * The manifest inside a retained entry, or null when absent (a pre-RT-51
 * entry, or a fallback sibling `.trash-*` rename that never got one) or
 * corrupt. A shape missing `name`/`keptUntil` is treated the same as absent
 * rather than trusted partially.
 */
export async function readDisposalManifest(trashPath: string): Promise<DisposalManifest | null> {
  try {
    const raw = await readFile(join(trashPath, MANIFEST_FILE), "utf8");
    const parsed = JSON.parse(raw) as Partial<DisposalManifest> | null;
    if (!parsed || typeof parsed.name !== "string" || typeof parsed.keptUntil !== "string") return null;
    return parsed as DisposalManifest;
  } catch {
    return null;
  }
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
 * Age out every root's retention store: reap every `<name>-<epoch>` entry
 * older than RETENTION_MS, under `<root>/.trash` for each root in `roots`.
 * Sweeping every root (not just the tree's current default) is what lets a
 * legacy `<repo>/.worktrees/.trash` and the new pool root's `.trash` both
 * drain, so a repo mid-migration between the two loses nothing. An entry
 * whose name carries no epoch was not written by rt, so it is kept and
 * warned about rather than guessed at. A root with no store yet is normal.
 * Returns how many were reaped, across every root.
 */
export async function reapExpiredTrash(
  roots: string[],
  log: TrashLog,
  now: number = Date.now(),
): Promise<number> {
  let reaped = 0;
  for (const poolRoot of new Set(roots)) {
    const root = retainedTrashRoot(poolRoot);
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        log.warn({ err, root }, "worktree retention sweep could not read trash dir");
      }
      continue;
    }

    for (const entry of entries) {
      const entryPath = join(root, entry);

      // A manifest's keptUntil is authoritative when present (restore extends
      // or clears it); an unparseable value fails CLOSED (kept), never reaped
      // on a guess. Only an entry with NO manifest falls back to the
      // epoch-in-name rule below (pre-RT-51 entries, or a manifest write that
      // itself failed).
      const manifest = await readDisposalManifest(entryPath);
      if (manifest) {
        const keptUntilMs = Date.parse(manifest.keptUntil);
        if (Number.isNaN(keptUntilMs) || now <= keptUntilMs) continue;
        await reapTrashDir(entryPath, log);
        reaped += 1;
        continue;
      }

      const epoch = /-(\d+)$/.exec(entry)?.[1];
      if (!epoch || !looksLikeRtEpoch(epoch)) {
        log.warn({ root, entry }, "worktree retention sweep skipped an entry it did not write");
        continue;
      }
      if (now - Number(epoch) <= RETENTION_MS) continue;
      await reapTrashDir(entryPath, log);
      reaped += 1;
    }
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
