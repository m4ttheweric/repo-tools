/**
 * Filesystem listing + live-refresh helpers for rt nav.
 *
 * Pure helpers live here (not in commands/nav.ts) so `bun test lib`
 * covers them. commands/nav.ts owns the interactive loop.
 */

import { readdirSync, statSync } from "fs";
import { join } from "path";

export interface DirListing {
  folders: string[];
  files: string[];
}

export const cmp = (a: string, b: string) =>
  a.localeCompare(b, undefined, { sensitivity: "base" });

// ─── Sorting ────────────────────────────────────────────────────────────────

export type SortKey = "name" | "modified" | "created" | "size" | "kind";

export interface SortState {
  key: SortKey;
  /** Flips the key's natural direction (see SORT_OPTIONS). */
  reverse: boolean;
}

/** Name ascending: what nav has always done, and what it still opens with. */
export const DEFAULT_SORT: SortState = { key: "name", reverse: false };

/**
 * The sort menu, in display order.
 *
 * Each key has a natural direction chosen to be the useful one rather than the
 * numerically ascending one: newest and largest first, because that is what you
 * are looking for when you sort by date or size at all. `reverse` flips it.
 */
export const SORT_OPTIONS: {
  key: SortKey;
  label: string;
  forward: string;
  reversed: string;
}[] = [
  { key: "name", label: "Name", forward: "A to Z", reversed: "Z to A" },
  { key: "modified", label: "Date Modified", forward: "newest first", reversed: "oldest first" },
  { key: "created", label: "Date Created", forward: "newest first", reversed: "oldest first" },
  { key: "size", label: "Size", forward: "largest first", reversed: "smallest first" },
  { key: "kind", label: "Kind", forward: "by extension", reversed: "by extension, Z to A" },
];

/** Human wording for a sort state, e.g. "Date Modified, newest first". */
export function sortLabel(sort: SortState): string {
  const opt = SORT_OPTIONS.find((o) => o.key === sort.key) ?? SORT_OPTIONS[0]!;
  return `${opt.label}, ${sort.reverse ? opt.reversed : opt.forward}`;
}

export function isDefaultSort(sort: SortState): boolean {
  return sort.key === DEFAULT_SORT.key && sort.reverse === DEFAULT_SORT.reverse;
}

/** One entry plus the stat fields the non-name sorts need. */
export interface EntryMeta {
  name: string;
  mtimeMs: number;
  birthtimeMs: number;
  size: number;
}

/** Lowercased extension after the final dot, or "" when there is none. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  // A leading dot is a dotfile, not an extension: ".gitignore" has no kind.
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * Order entries by the given sort, returning just the names.
 *
 * Name is always the tiebreak, and the tiebreak is never reversed, so entries
 * that compare equal on the primary key stay in a stable, readable order.
 */
export function sortEntries(entries: EntryMeta[], sort: SortState): string[] {
  const dir = sort.reverse ? -1 : 1;
  const byName = (a: EntryMeta, b: EntryMeta) => cmp(a.name, b.name);
  const primary = (a: EntryMeta, b: EntryMeta): number => {
    switch (sort.key) {
      case "modified":
        return b.mtimeMs - a.mtimeMs;
      case "created":
        return b.birthtimeMs - a.birthtimeMs;
      case "size":
        return b.size - a.size;
      case "kind":
        return cmp(extensionOf(a.name), extensionOf(b.name));
      default:
        return byName(a, b);
    }
  };
  return [...entries]
    .sort((a, b) => dir * primary(a, b) || byName(a, b))
    .map((e) => e.name);
}

/**
 * List one directory level. Dotfiles are excluded unless showHidden.
 *
 * Folders and files are returned as separate groups and sorted independently,
 * so folders stay above files no matter which sort is active. Every non-name
 * sort is free here: the stat needed to tell a folder from a file already
 * carries mtime, birthtime, and size.
 */
export function listEntries(
  dir: string,
  showHidden: boolean,
  sort: SortState = DEFAULT_SORT,
): DirListing {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { folders: [], files: [] };
  }
  const folders: EntryMeta[] = [];
  const files: EntryMeta[] = [];
  for (const name of entries) {
    if (!showHidden && name.startsWith(".")) continue;
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(join(dir, name));
    } catch {
      continue; // broken symlink etc. — skip (matches prior nav behavior)
    }
    const meta: EntryMeta = {
      name,
      mtimeMs: st.mtimeMs,
      birthtimeMs: st.birthtimeMs,
      size: st.size,
    };
    (st.isDirectory() ? folders : files).push(meta);
  }
  return { folders: sortEntries(folders, sort), files: sortEntries(files, sort) };
}

/** POSIX single-quote escaping: ' -> '\'' wrapped in single quotes. Still used by lib/nav-watch.ts. */
export function shellQuote(s: string): string {
  return "'" + s.replaceAll("'", "'\\''") + "'";
}

// ─── Live refresh ───────────────────────────────────────────────────────────

export interface DirWatchDeps {
  /** Registers `listener` against `dir`, returning a handle to unregister it. */
  watch: (dir: string, listener: () => void) => { close(): void };
}

export interface DirWatchOpts {
  /** Directory to watch, non-recursively. */
  dir: string;
  /** Fires (after debouncing) when the directory changed. */
  onChange: () => void;
  debounceMs?: number;
  onError?: (err: unknown) => void;
  deps?: Partial<DirWatchDeps>;
}

const POLL_INTERVAL_MS = 250;

/**
 * Polls the directory's mtime instead of subscribing to fs.watch. On Darwin
 * 25 (macOS 26), directory-level fs.watch is backed by FSEvents, and FSEvents
 * was confirmed to deliver zero add/remove notifications on this OS build —
 * the same wall lib/nav-watch.ts hit for the fzf-era picker (see its own
 * defaultWatch for the full account). A directory's mtime changes whenever an
 * entry is added, removed, or renamed, so polling it is a reliable substitute.
 * Do not "optimize" this back to fs.watch(dir, ...) without first confirming
 * FSEvents actually delivers directory events on the target OS.
 */
const defaultWatch: DirWatchDeps["watch"] = (dir, listener) => {
  const mtime = () => {
    try {
      return statSync(dir).mtimeMs;
    } catch {
      // Directory gone; report as a distinct value so its disappearance
      // fires the listener once, then compares equal thereafter.
      return -1;
    }
  };
  let last = mtime();
  const timer = setInterval(() => {
    const curr = mtime();
    if (curr !== last) {
      last = curr;
      listener();
    }
  }, POLL_INTERVAL_MS);
  timer.unref();
  return { close: () => clearInterval(timer) };
};

/**
 * Debounced directory-change notifier for a live nav session: a burst of
 * filesystem events collapses into one `onChange` call, `debounceMs` after
 * the last one arrives. The caller re-lists and pushes a `handle.update`
 * from `onChange`; this module has no idea what a "row" is.
 */
export function startDirWatch(opts: DirWatchOpts): { stop(): void } {
  const watch = opts.deps?.watch ?? defaultWatch;
  const debounceMs = opts.debounceMs ?? 150;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let watcher: { close(): void } | null = null;

  try {
    watcher = watch(opts.dir, () => {
      if (stopped) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (!stopped) opts.onChange();
      }, debounceMs);
    });
  } catch (err) {
    // Unsupported filesystem or missing permissions: nav just won't
    // live-refresh this directory.
    opts.onError?.(err);
  }

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      try {
        watcher?.close();
      } catch {
        // Already closed.
      }
    },
  };
}
