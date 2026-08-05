/**
 * Shared fzf navigation primitives.
 *
 * Used by nav.ts, run.ts, and rt-render.tsx to avoid duplicating the
 * tab-delimited input builder, fzf argument builder, and output parser.
 *
 * Each command builds its own navigation loop on top of `runNavPicker`,
 * keeping domain-specific state management and key interpretation
 * where they belong.
 */

import { spawnSync } from "child_process";
import { mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { ensureFzf } from "./fzf.ts";
import { startNavWatch } from "./nav-watch.ts";
import { rtDir } from "./rt-paths.ts";
import { T, toHex } from "./tui/palette.ts";

// ─── Types ──────────────────────────────────────────────────────────────────

const NAV_SEPARATOR_PREFIX = "__nav:sep:";

export interface NavOption {
  value: string;
  label: string;
  hint?: string;
  /** Optional ANSI SGR color escape (e.g. "\x1b[36m") applied to label + hint. */
  color?: string;
  /** Marks this option as a visual separator. The cursor skips over it and selecting it re-shows the picker. */
  separator?: boolean;
}

export interface NavResult {
  /** Selected value, or null if nothing was selected. */
  value: string | null;
  /** fzf exit key: "" for Enter, key name for --expect keys, "" for cancel. */
  key: string;
  /** The fzf filter query text (always set, even on cancel — useful for resume). */
  query: string;
}

export interface NavPickerOpts {
  options: NavOption[];
  /** Shown in the border label. */
  message: string;
  /** Full custom header string. Overrides `headerParts` if both are set. */
  header?: string;
  /** Header segments joined with "  ". Ignored if `header` is set. */
  headerParts?: string[];
  /** Extra --expect keys (ctrl-up is always included). */
  expectKeys?: string[];
  /** Pre-fill the fzf filter query. */
  initialQuery?: string;
  /** Value to pre-position the cursor on (calls findResumePosition). */
  resumeValue?: string;
  /** Explicit 1-based cursor position. Overridden by resumeValue. */
  initialPos?: number | null;
  /** Use fzf's exact-match mode. */
  exact?: boolean;
  /** Custom fzf color overrides (appended to default pink border). */
  colorOverrides?: string;
  /**
   * When true, a no-match accept (fzf exit 1 — the user typed a query that
   * matched nothing and pressed Enter) resolves to a NavResult with
   * `value: null` and the typed `query`, instead of null. Lets callers offer a
   * live-search fallback on the typed text. Esc / Ctrl-C (exit 130) still
   * returns null.
   */
  captureQueryOnNoMatch?: boolean;
  /**
   * fzf --preview command. When set, a right-side preview window is shown
   * and ctrl-p toggles it. The command sees the value column as {1}.
   * If the caller lists "ctrl-p" in `expectKeys`, the internal toggle bind is
   * skipped so ctrl-p round-trips instead — letting the caller own preview
   * visibility (pass `previewHidden` on re-show) and know the real state.
   */
  preview?: string;
  /** Start with the preview window hidden (only meaningful with `preview`). */
  previewHidden?: boolean;
  /**
   * Full key-hint text (may be multi-line), hidden until requested. When set,
   * the hints go in the header but start hidden; a sticky one-line footer
   * shows "ctrl-/: commands" and ctrl-/ toggles the hints on and off — all
   * key bindings work either way, only the hint text is hidden. Ignored if
   * `header`/`headerParts` is set.
   */
  helpHeader?: string;
  /**
   * Shell command that re-renders the help header (reading $FZF_COLUMNS),
   * bound to fzf's resize event via transform-header so a multi-line
   * helpHeader re-lays-out when the terminal size changes. Only meaningful
   * with `helpHeader`.
   */
  resizeHeaderCommand?: string;
  /**
   * Live-refresh the list while the picker is open. When set, fzf runs with a
   * --listen socket and field-based cursor tracking, and `dir` is watched for
   * filesystem events; each change re-renders via `render` and reloads fzf in
   * place. Only meaningful for a single directory: callers that list
   * recursively should leave this unset.
   */
  watch?: { dir: string; render: () => NavOption[] };
}

/** Create a separator NavOption. The value is auto-generated; the cursor auto-skips it. */
let sepCounter = 0;
export function navSeparator(label = "──────────────"): NavOption {
  return { value: `${NAV_SEPARATOR_PREFIX}${sepCounter++}__`, label, hint: "", separator: true };
}

// ─── Input builder ──────────────────────────────────────────────────────────

/**
 * Build a tab-delimited input string for fzf from NavOption objects.
 *
 * Format:  value \t [color] bold-label pad \t   hint-or-dim-hint [reset]
 *
 * The second column is `--with-nth=2..` for display; the first column
 * carries the machine-readable value.
 */
export function formatNavInput(options: NavOption[]): string {
  const labelWidth = Math.max(...options.map((o) => o.label.length));
  return options
    .map((o) => {
      const pad = " ".repeat(labelWidth - o.label.length);
      const open = o.color ?? "";
      const close = o.color ? "\x1b[0m" : "";
      const hint = o.hint
        ? o.color
          ? o.hint
          : `\x1b[2m${o.hint}\x1b[22m`
        : "";
      return `${o.value}\t${open}\x1b[1m${o.label}\x1b[22m${pad}\t  ${hint}${close}`;
    })
    .join("\n");
}

// ─── Arg builder ────────────────────────────────────────────────────────────

/** Default header when no header/headerParts are provided. */
const DEFAULT_HEADER = "enter: select  |: OR  !: exclude";

/**
 * Build the fzf CLI argument array.
 *
 * ctrl-up is always added to --expect so callers can detect back-navigation
 * via `result.key === "ctrl-up"`.
 */
export function buildNavArgs(opts: NavPickerOpts, socketPath?: string): string[] {
  const helpMode = !!opts.helpHeader && !opts.header && !opts.headerParts;
  const header =
    opts.header ??
    (opts.headerParts
      ? opts.headerParts.join("  ")
      : helpMode
        ? opts.helpHeader!
        : DEFAULT_HEADER);

  const expectKeys = ["ctrl-up", ...(opts.expectKeys ?? [])];
  const expectStr = expectKeys.join(",");

  return [
    "--ansi",
    "--with-nth=2..",
    "--nth=1",
    "--delimiter=\t",
    "--tabstop=1",
    // Fill the terminal: "~100%" sizes the box to the content and leaves dead
    // space below on a tall terminal. "100%" uses the full height either way.
    "--height=100%",
    "--layout=reverse",
    "--border=rounded",
    `--border-label= ${opts.message} `,
    "--prompt=filter: ",
    `--header=${header}`,
    "--no-mouse",
    "--print-query",
    `--expect=${expectStr}`,
    `--color=border:${toHex(T.pink)},label:${toHex(T.pink)}${opts.colorOverrides ?? ""}`,
    ...(opts.initialQuery ? [`--query=${opts.initialQuery}`] : []),
    ...(opts.exact ? ["--exact"] : []),
    ...(opts.options.some((o) => o.separator)
      ? [
          "--bind", `down:down+transform:[[ {1} == ${NAV_SEPARATOR_PREFIX}* ]] && echo down`,
          "--bind", `up:up+transform:[[ {1} == ${NAV_SEPARATOR_PREFIX}* ]] && echo up`,
        ]
      : []),
    ...(opts.preview
      ? [
          `--preview=${opts.preview}`,
          `--preview-window=right,50%,border-rounded${opts.previewHidden ? ",hidden" : ""}`,
          ...(expectKeys.includes("ctrl-p") ? [] : ["--bind=ctrl-p:toggle-preview"]),
        ]
      : []),
    ...(socketPath
      ? [
          `--listen=${socketPath}`,
          // Field 1 is the value column, so the cursor lands back on the same
          // entry after a reload rather than resetting to the top.
          "--track",
          "--id-nth=1",
        ]
      : []),
    ...(helpMode
      ? [
          "--footer=ctrl-/: commands",
          "--bind=start:hide-header",
          "--bind=ctrl-/:toggle-header",
          ...(opts.resizeHeaderCommand
            ? [`--bind=resize:transform-header(${opts.resizeHeaderCommand})`]
            : []),
        ]
      : []),
  ];
}

// ─── Output parser ──────────────────────────────────────────────────────────

/**
 * Parse fzf's stdout into a NavResult.
 *
 * With --print-query + --expect, fzf always outputs 3 lines:
 *   0: query text
 *   1: key pressed ("" for Enter, key name for --expect keys)
 *   2: selected row (tab-delimited)
 */
export function parseNavOutput(stdout: string): NavResult {
  const lines = stdout.replace(/\n$/, "").split("\n");
  const query = lines[0] ?? "";
  const key = lines[1]?.trim() || "";
  const raw = lines[2]?.trim() ?? "";
  const value = raw.split("\t")[0] || null;
  return { value: value || null, key, query };
}

// ─── Resume position ────────────────────────────────────────────────────────

/**
 * Find the 1-based cursor position of a value in the (possibly filtered)
 * option list, so the cursor can be restored after a round-trip.
 *
 * Runs a second fzf invocation with --filter to determine where `value`
 * lands in the filtered result set.
 */
export function findResumePosition(
  options: NavOption[],
  query: string,
  value: string,
): number | null {
  if (!value) return null;
  if (!query) {
    const idx = options.findIndex((o) => o.value === value);
    return idx >= 0 ? idx + 1 : null;
  }
  const input = options.map((o) => o.value).join("\n");
  const result = spawnSync("fzf", ["--filter", query], {
    input,
    encoding: "utf8",
  });
  if (!result.stdout) return null;
  const lines = result.stdout.split("\n").filter(Boolean);
  const idx = lines.findIndex((line) => line === value);
  return idx >= 0 ? idx + 1 : null;
}

// ─── Main entry point ───────────────────────────────────────────────────────

/**
 * Socket and list-file paths for one picker invocation.
 *
 * Under rtDir() rather than $TMPDIR: macOS caps unix socket paths near 104
 * bytes and /var/folders/... eats most of that budget before the filename.
 */
let navSocketSeq = 0;
function navWatchPaths(): { socketPath: string; listFile: string } {
  // fzf cannot bind --listen (and the whole picker fails, not just live
  // refresh) if ~/.rt does not exist yet, e.g. on a machine's first run.
  mkdirSync(rtDir(), { recursive: true });
  const stem = `nav-${process.pid}-${navSocketSeq++}`;
  return {
    socketPath: join(rtDir(), `${stem}.sock`),
    listFile: join(rtDir(), `${stem}.list`),
  };
}

/**
 * Run an fzf picker and return the parsed result.
 *
 * Returns null when fzf is cancelled (Esc / Ctrl-C / non-zero exit).
 * Otherwise returns a NavResult with the selected value, exit key, and query.
 */
export async function runNavPicker(
  opts: NavPickerOpts,
): Promise<NavResult | null> {
  ensureFzf();

  let currentPos = opts.initialPos ?? null;

  // Retry loop: if the user selects a separator, re-show with cursor past it
  while (true) {
    const input = formatNavInput(opts.options);
    const paths = opts.watch ? navWatchPaths() : null;
    const args = buildNavArgs(opts, paths?.socketPath);

    // Tracks the options behind the most recent live-refresh render, so a
    // separator selected after a reload resolves against what is actually on
    // screen rather than the (by then stale) opts.options captured above.
    // Declared inside the loop so it resets on every re-show, not just once
    // per runNavPicker call.
    let liveOptions: NavOption[] | null = null;

    // Resolve cursor position: resumeValue wins over initialPos/currentPos.
    // When nothing pins the cursor and the list is unfiltered, default to the
    // first non-separator row so the cursor never opens on a heading (a
    // filtered list already excludes separators, so its line 1 is a real row).
    const defaultPos =
      opts.initialQuery
        ? null
        : (() => {
            const i = opts.options.findIndex((o) => !o.separator);
            return i > 0 ? i + 1 : null;
          })();
    const cursorPos =
      (opts.resumeValue
        ? findResumePosition(opts.options, opts.initialQuery ?? "", opts.resumeValue)
        : null) ?? currentPos ?? defaultPos ?? null;

    if (cursorPos !== null) {
      args.push(`--bind=load:pos(${cursorPos})`);
    }

    // Async spawn, not spawnSync: spawnSync blocks the event loop for the
    // lifetime of the picker, which would stop fs.watch callbacks from ever
    // firing for the live-refresh watcher wired up in runNavPicker's caller.
    // fzf reads the keyboard from /dev/tty directly, so a piped stdin is only
    // ever the item list.
    const proc = Bun.spawn(["fzf", ...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    });

    try {
      proc.stdin.write(input);
      await proc.stdin.end();
    } catch {
      // fzf can exit before the list is fully written (esc on a huge listing).
      // The exit code below is what decides the outcome, so an EPIPE here is
      // an expected condition, not an error.
    }

    const w = opts.watch;
    const watcher =
      w && paths
        ? startNavWatch({
            dir: w.dir,
            socketPath: paths.socketPath,
            listFile: paths.listFile,
            initial: input,
            render: () => {
              const next = w.render();
              liveOptions = next;
              return formatNavInput(next);
            },
            onError: (err) =>
              console.error(`  nav: live refresh disabled (${err})`),
          })
        : null;

    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);

    watcher?.stop();
    if (paths) {
      for (const p of [paths.socketPath, paths.listFile]) {
        try {
          unlinkSync(p);
        } catch {
          // Already gone: fzf removes its own socket on exit, and the list file
          // is never written when nothing changed.
        }
      }
    }

    if (exitCode !== 0) {
      if (opts.captureQueryOnNoMatch && exitCode === 1) {
        return parseNavOutput(stdout);
      }
      return null;
    }

    const parsed = parseNavOutput(stdout);

    // If a separator was selected, re-show with cursor on the next real item
    if (parsed.value?.startsWith(NAV_SEPARATOR_PREFIX)) {
      // Resolve against the live-refreshed options when a reload happened
      // during this iteration; opts.options is what the picker STARTED with,
      // which by selection time may no longer match what is on screen.
      const options = liveOptions ?? opts.options;
      const hitIdx = options.findIndex((o) => o.value === parsed.value);
      const nextReal = options.findIndex(
        (o, i) => i > hitIdx && !o.separator,
      );
      currentPos = nextReal >= 0 ? nextReal + 1 : null;
      // Clear resumeValue so it doesn't override our computed position, and
      // carry the live-refreshed options forward so the next iteration
      // renders what was last on screen instead of reverting to the stale
      // original listing.
      opts = { ...opts, options, resumeValue: undefined };
      continue;
    }

    return parsed;
  }
}

