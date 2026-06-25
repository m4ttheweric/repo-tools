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
import { ensureFzf } from "./fzf.ts";
import { T, toHex } from "./tui/palette.ts";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface NavOption {
  value: string;
  label: string;
  hint?: string;
  /** Optional ANSI SGR color escape (e.g. "\x1b[36m") applied to label + hint. */
  color?: string;
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
export function buildNavArgs(opts: NavPickerOpts): string[] {
  const header =
    opts.header ??
    (opts.headerParts ? opts.headerParts.join("  ") : DEFAULT_HEADER);

  const expectKeys = ["ctrl-up", ...(opts.expectKeys ?? [])];
  const expectStr = expectKeys.join(",");

  return [
    "--ansi",
    "--with-nth=2..",
    "--nth=1",
    "--delimiter=\t",
    "--tabstop=1",
    "--height=~100%",
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
 * Run an fzf picker and return the parsed result.
 *
 * Returns null when fzf is cancelled (Esc / Ctrl-C / non-zero exit).
 * Otherwise returns a NavResult with the selected value, exit key, and query.
 */
export async function runNavPicker(
  opts: NavPickerOpts,
): Promise<NavResult | null> {
  ensureFzf();

  const input = formatNavInput(opts.options);
  const args = buildNavArgs(opts);

  // Resolve cursor position: resumeValue wins over initialPos
  const cursorPos =
    (opts.resumeValue
      ? findResumePosition(opts.options, opts.initialQuery ?? "", opts.resumeValue)
      : null) ?? opts.initialPos ?? null;

  if (cursorPos !== null) {
    args.push(`--bind=load:pos(${cursorPos})`);
  }

  const result = spawnSync("fzf", args, {
    input,
    stdio: ["pipe", "pipe", "inherit"],
    encoding: "utf8",
  });

  if (result.status !== 0) return null;

  return parseNavOutput(result.stdout ?? "");
}
