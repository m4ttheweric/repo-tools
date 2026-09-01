/**
 * Shared fzf navigation primitives.
 *
 * Used by nav.ts, run.ts, and rt-render.ts to avoid duplicating the
 * tab-delimited input builder, fzf argument builder, and output parser.
 *
 * Each command builds its own navigation loop on top of `runNavPicker`,
 * keeping domain-specific state management and key interpretation
 * where they belong.
 */

import { spawnSync } from "child_process";
import { resolveFzf } from "./fzf.ts";
import { toAnsiFg, T, toHex } from "./tui/palette.ts";

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
  /** Header-left breadcrumb Go renders instead of `message`; defaults to `[message]` when unset (runNavPicker, lib/pick-wrappers.ts). */
  breadcrumb?: string[];
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

/** Single-quote a path for safe interpolation into an fzf shell binding. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Build the fzf CLI argument array.
 *
 * ctrl-up is always added to --expect so callers can detect back-navigation
 * via `result.key === "ctrl-up"`.
 */
export function buildNavArgs(opts: NavPickerOpts, socketPath?: string, helpStateFile?: string): string[] {
  const helpMode = !!opts.helpHeader && !opts.header && !opts.headerParts;
  const legend =
    opts.header ??
    (opts.headerParts ? opts.headerParts.join("  ") : helpMode ? null : DEFAULT_HEADER);

  const expectKeys = ["ctrl-up", ...(opts.expectKeys ?? [])];
  const expectStr = expectKeys.join(",");

  return [
    "--ansi",
    "--with-nth=2..",
    "--nth=1",
    "--delimiter=\t",
    "--tabstop=1",
    "--layout=reverse",
    // Up at the top wraps to the bottom and down at the bottom wraps to the
    // top, so a long list has no dead ends at either edge.
    "--cycle",
    // The same left edge every rt picker draws; the path rides above the
    // filter as the pink title and the key legend lives in the sticky footer.
    "--border=left",
    "--no-separator",
    `--header=${toAnsiFg(T.cyan)}${opts.message}\x1b[0m`,
    "--header-first",
    "--info=inline-right",
    "--prompt=  filter: ",
    "--no-mouse",
    "--print-query",
    `--expect=${expectStr}`,
    "--scrollbar=▐",
    `--color=border:${toHex(T.pink)},scrollbar:${toHex(T.dim)},footer-border:${toHex(T.faint)},pointer:${toHex(T.cyan)},marker:${toHex(T.cyan)}${opts.colorOverrides ?? ""}`,
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
          // One vertical separator instead of a second box inside the first.
          `--preview-window=right,50%,border-line${opts.previewHidden ? ",hidden" : ""}`,
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
    ...(legend !== null ? [`--footer=${legend}`] : []),
    // The expanded hints live in the footer. fzf exposes no current-footer
    // state to transform commands, so a marker file carries the toggle: the
    // ctrl-/ bind flips it, the resize bind re-lays the hints out only while
    // it exists.
    ...(helpMode
      ? opts.resizeHeaderCommand && helpStateFile
        ? (() => {
            const q = shellQuote(helpStateFile);
            return [
              "--footer=ctrl-/: commands",
              `--bind=ctrl-/:transform-footer([ -e ${q} ] && { rm -f ${q}; echo "ctrl-/: commands"; } || { touch ${q}; ${opts.resizeHeaderCommand}; })`,
              `--bind=resize:transform-footer([ -e ${q} ] && { ${opts.resizeHeaderCommand}; } || echo "ctrl-/: commands")`,
            ];
          })()
        : [`--footer=${opts.helpHeader}`]
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
  const result = spawnSync(resolveFzf() ?? "fzf", ["--filter", query], {
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
 * Runs the picker built from these options and returns its NavResult, or
 * null on cancel. Implemented on the rt-ui `pick` verb in
 * lib/pick-wrappers.ts; re-exported here so import sites keyed on
 * lib/navigate.ts don't move.
 */
export { runNavPicker } from "./pick-wrappers.ts";

