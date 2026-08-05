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
}

export const cmp = (a: string, b: string) =>
  a.localeCompare(b, undefined, { sensitivity: "base" });

/** Directories the fallback walk never descends into, regardless of showHidden. */
const WALK_SKIP_DIRS = new Set([".git", "node_modules"]);

/** List one directory level. Dotfiles are excluded unless showHidden. */
export function listEntries(dir: string, showHidden: boolean): DirListing {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { folders: [], files: [] };
  }
  const folders: string[] = [];
  const files: string[] = [];
  for (const name of entries) {
    if (!showHidden && name.startsWith(".")) continue;
    let isDir: boolean;
    try {
      isDir = statSync(join(dir, name)).isDirectory();
    } catch {
      continue; // broken symlink etc. — skip (matches prior nav behavior)
    }
    (isDir ? folders : files).push(name);
  }
  folders.sort(cmp);
  files.sort(cmp);
  return { folders, files };
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
    const folders = run("d").sort(cmp).slice(0, maxResults);
    const files = run("f")
      .sort(cmp)
      .slice(0, Math.max(0, maxResults - folders.length));
    return { folders, files };
  }
  return walkFallback(dir, opts.showHidden, opts.maxDepth ?? 8, maxResults);
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
