/**
 * Filesystem listing + preview helpers for rt nav.
 *
 * Pure helpers live here (not in commands/nav.ts) so `bun test lib`
 * covers them. commands/nav.ts owns the interactive loop.
 */

import { readdirSync, statSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";

export interface DirListing {
  folders: string[];
  files: string[];
}

export interface DeepListOpts {
  showHidden: boolean;
  /** Total entry cap (folders + files combined), enforced on both the fd path and the fallback walk. Default 5000. */
  maxResults?: number;
  /** Fallback-walk depth cap. Default 8. (fd path is capped by maxResults only.) */
  maxDepth?: number;
  /** Ordering within the folder group and the file group. Defaults to name, ascending. */
  sort?: SortState;
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

/** Directories the fallback walk never descends into, regardless of showHidden. */
const WALK_SKIP_DIRS = new Set([".git", "node_modules"]);

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

/**
 * Order relative paths from a deep listing.
 *
 * Name sorting needs no stats. The others stat every entry, which measures
 * about 15ms for the 5000-entry cap on APFS, so deep mode gets the full set of
 * sorts rather than an artificial name-only restriction.
 */
function sortRelPaths(root: string, rels: string[], sort: SortState): string[] {
  if (sort.key === "name") {
    const out = [...rels].sort(cmp);
    return sort.reverse ? out.reverse() : out;
  }
  const metas: EntryMeta[] = rels.map((name) => {
    try {
      const st = statSync(join(root, name));
      return { name, mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs, size: st.size };
    } catch {
      // Vanished between listing and stat: keep it, sorted as if empty/epoch.
      return { name, mtimeMs: 0, birthtimeMs: 0, size: 0 };
    }
  });
  return sortEntries(metas, sort);
}

/**
 * Recursively list everything under dir as relative paths.
 * Uses fd when available (honors .gitignore); otherwise a depth-capped
 * readdir walk that skips .git but does NOT parse .gitignore.
 */
export function deepList(
  dir: string,
  opts: DeepListOpts,
  resolveFd: () => string | null = () => Bun.which("fd"),
): DirListing {
  const maxResults = opts.maxResults ?? 5000;
  const sort = opts.sort ?? DEFAULT_SORT;
  const fd = resolveFd();
  if (fd) {
    const common = [
      "--color=never",
      `--max-results=${maxResults}`,
      ...(opts.showHidden ? ["--hidden", "--exclude=.git"] : []),
    ];
    const run = (type: string): string[] => {
      const r = spawnSync(fd, ["--type", type, ...common], {
        cwd: dir,
        encoding: "utf8",
      });
      if (r.status !== 0 || !r.stdout) return [];
      return r.stdout
        .split("\n")
        .filter(Boolean)
        .map((s) => s.replace(/\/$/, ""));
    };
    // Sort before capping, matching the previous behavior for the default sort.
    const folders = sortRelPaths(dir, run("d"), sort).slice(0, maxResults);
    const files = sortRelPaths(dir, run("f"), sort).slice(
      0,
      Math.max(0, maxResults - folders.length),
    );
    return { folders, files };
  }
  const walked = walkFallback(dir, opts.showHidden, opts.maxDepth ?? 8, maxResults);
  return {
    folders: sortRelPaths(dir, walked.folders, sort),
    files: sortRelPaths(dir, walked.files, sort),
  };
}

function walkFallback(
  root: string,
  showHidden: boolean,
  maxDepth: number,
  maxResults: number,
): DirListing {
  const folders: string[] = [];
  const files: string[] = [];
  const full = () => folders.length + files.length >= maxResults;

  const walk = (rel: string, depth: number) => {
    if (depth > maxDepth || full()) return;
    let entries: string[];
    try {
      entries = readdirSync(join(root, rel));
    } catch {
      return;
    }
    entries.sort(cmp);
    for (const name of entries) {
      if (full()) return;
      if (WALK_SKIP_DIRS.has(name)) continue;
      if (!showHidden && name.startsWith(".")) continue;
      const relPath = rel ? `${rel}/${name}` : name;
      let isDir: boolean;
      try {
        isDir = statSync(join(root, relPath)).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        folders.push(relPath);
        walk(relPath, depth + 1);
      } else {
        files.push(relPath);
      }
    }
  };

  walk("", 1);
  return { folders, files };
}

/** POSIX single-quote escaping: ' -> '\'' wrapped in single quotes. */
export function shellQuote(s: string): string {
  return "'" + s.replaceAll("'", "'\\''") + "'";
}

/**
 * Build a shell snippet that lays out help hints column-major into as many
 * columns as fit the available width, reading $FZF_COLUMNS at run time.
 *
 * This is the single layout implementation: nav runs it once (with
 * FZF_COLUMNS faked to the current terminal width) for the initial header,
 * and binds it to fzf's resize event via transform-header so the layout
 * recomputes when the terminal size changes mid-session.
 *
 * With the preview pane open the header only has the left half of the
 * terminal; fzf truncates (not wraps) header lines that overflow.
 */
export function buildHelpHeaderCommand(hints: string[], previewOn: boolean): string {
  const quoted = hints.map(shellQuote).join(" ");
  const cols = "${FZF_COLUMNS:-$(tput cols)}";
  const width = previewOn ? `$(( ${cols} / 2 - 4 ))` : `$(( ${cols} - 4 ))`;
  return (
    `printf '%s\\n' ${quoted} | awk -v w=${width} '` +
    `{ h[NR] = $0; if (length($0) > m) m = length($0) } ` +
    `END { n = NR; nc = int(w / (m + 3)); if (nc < 1) nc = 1; if (nc > n) nc = n; ` +
    `cw = int(w / nc); rows = int((n + nc - 1) / nc); ` +
    `for (r = 1; r <= rows; r++) { line = ""; ` +
    `for (c = 0; c < nc; c++) { i = c * rows + r; ` +
    `if (i <= n) { s = h[i]; while (length(s) < cw) s = s " "; line = line s } } ` +
    `sub(/ +$/, "", line); print line } }'`
  );
}

/** Run a buildHelpHeaderCommand snippet outside fzf, faking FZF_COLUMNS. */
export function renderHelpHeader(command: string, cols: number): string {
  const r = spawnSync("sh", ["-c", command], {
    encoding: "utf8",
    env: { ...process.env, FZF_COLUMNS: String(cols) },
  });
  return (r.stdout ?? "").trimEnd();
}

/** Extensions routed to the image branch, as POSIX `case` classes (no subprocess). */
const IMAGE_CASE_PATTERNS = [
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff", "tif",
  "heic", "avif", "ico", "svg", "jxl", "qoi",
]
  .map((ext) =>
    "*." +
    [...ext].map((c) => `[${c.toLowerCase()}${c.toUpperCase()}]`).join(""),
  )
  .join("|");

/**
 * Shell fragment that renders "$p" as an image, sized to the preview pane.
 *
 * Renderer priority mirrors fzf's own bin/fzf-preview.sh: kitten icat, then
 * chafa, then imgcat, then `file` so an uninstalled machine still prints
 * something readable instead of binary noise.
 *
 * chafa runs with `--probe off` unconditionally: left to itself it probes
 * the controlling tty for protocol support, and inside a preview pane
 * that tty belongs to fzf in raw mode, so the query races fzf's input reader.
 * Probing costs nothing measurable, so there is no reason to allow it.
 *
 * `-f` is pinned only for the terminals this snippet recognizes by env var.
 * For everything else `-f` is left unset on purpose: chafa's own detection
 * reads env vars we do not (GHOSTTY_BIN_DIR, TERMINFO, __CFBundleIdentifier,
 * ...), which covers more terminals than our hardcoded list ever could, and
 * it bottoms out at symbol art rather than a graphics protocol the terminal
 * cannot render. Pinning a format here would override that and downgrade
 * every terminal we did not think to hardcode.
 */
export function buildImagePreviewSnippet(): string {
  // Shell ${...} expansions are escaped as \${...} so TS does not interpolate
  // them, matching the style already used in buildPreviewCommand.
  return (
    `d="\${FZF_PREVIEW_COLUMNS:-80}x\${FZF_PREVIEW_LINES:-24}"; ` +
    `f=""; ` +
    `case "\${TERM_PROGRAM:-}" in ` +
    `ghostty|kitty|WezTerm) f="-f kitty";; ` +
    `iTerm.app) f="-f iterm";; ` +
    `esac; ` +
    `[ -n "\${KITTY_WINDOW_ID:-}" ] && f="-f kitty"; ` +
    `[ "\${TERM:-}" = "xterm-kitty" ] && f="-f kitty"; ` +
    `if [ "$f" = "-f kitty" ] && command -v kitten >/dev/null 2>&1; then ` +
    // kitten's last line is a bare reset with no newline, which makes fzf draw
    // a spurious scroll indicator. Drop it and re-attach the reset above.
    // The escape is a literal ESC byte rather than bash-only $'\e', because
    // fzf runs preview commands with $SHELL -c and $SHELL may be sh.
    `kitten icat --clear --transfer-mode=memory --unicode-placeholder ` +
    `--stdin=no --place="$d@0x0" "$p" | sed '$d' | sed '$s/$/\x1b[m/'; ` +
    `elif command -v chafa >/dev/null 2>&1; then ` +
    // Trailing newline lets fzf render successive images cleanly.
    `chafa --probe off $f -s "$d" "$p"; echo; ` +
    `elif command -v imgcat >/dev/null 2>&1; then ` +
    `imgcat -W "\${d%%x*}" -H "\${d##*x}" "$p"; ` +
    `else file "$p"; fi`
  );
}

/**
 * Build the fzf --preview shell snippet for a nav picker rooted at baseDir.
 *
 * fzf substitutes {1} with the (already shell-quoted) value column, e.g.
 * 'd:src' or 'f:sub/readme.md'. The snippet strips the 2-char kind prefix
 * and joins with baseDir. eza/bat are soft deps; ls/cat are the fallbacks.
 */
export function buildPreviewCommand(baseDir: string): string {
  const base = shellQuote(baseDir);
  return (
    `v={1}; p=${base}"/\${v#??}"; ` +
    `case "$v" in ` +
    // One entry per line: long-format lines overflow the 50% pane and fzf
    // truncates (not wraps), which chops off the filenames themselves.
    `d:*) eza -a1 --color=always "$p" 2>/dev/null || ls -1AF "$p";; ` +
    // Ordered after d:* so a directory named foo.png still lists as a directory.
    `${IMAGE_CASE_PATTERNS}) ${buildImagePreviewSnippet()};; ` +
    `*) bat --color=always --style=numbers "$p" 2>/dev/null || head -c 65536 "$p";; ` +
    `esac`
  );
}
