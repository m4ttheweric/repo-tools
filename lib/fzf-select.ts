/**
 * Filterable pickers backed by the native `fzf` binary.
 *
 * fzf does all the rendering, so the `rt cd`/`rt run` hot path pays for no
 * renderer of its own. rt-render.tsx re-exports these functions for
 * back-compat; the latency-sensitive callers import them from here directly.
 */

import { CARD_WIDTH, T, toHex } from "./tui/palette.ts";
import { BackNavigation } from "./back-navigation.ts";

export { BackNavigation } from "./back-navigation.ts";

/**
 * Caps the picker at the card width rt-ui's prompts share. fzf has no width
 * option, so the cap is a right margin. A box narrower than the terminal is
 * what keeps a reflowing terminal from rewrapping the border mid-resize.
 */
export function fzfWidthArgs(columns: number | undefined = process.stderr.columns ?? process.stdout.columns): string[] {
  if (!columns || columns <= CARD_WIDTH) return [];
  return [`--margin=0,${columns - CARD_WIDTH},0,0`];
}

// ─── Option type ─────────────────────────────────────────────────────────────

export interface SelectOption {
  value: string;
  label: string;
  /** Displayed as dim text after the label (not a native ink-ui prop — rendered manually) */
  hint?: string;
  /** Optional ANSI SGR color escape (e.g. "\x1b[36m"). Tints the label + hint
   *  in the fzf renderer; a closing default-fg reset is appended automatically. */
  color?: string;
}

/**
 * Show a filterable multi-select using fzf.
 * Selected items are shown in a preview pane at the top so you can always
 * see what you've picked, even when filtering.
 * fzf is a hard dependency — exits with an install hint if it's missing.
 */
export async function filterableMultiselect(opts: {
  message: string;
  options: SelectOption[];
  initialValues?: string[];
  stderr?: boolean;
}): Promise<string[] | null> {
  const { spawnSync } = await import("child_process");
  const { ensureFzf } = await import("./fzf.ts");
  ensureFzf();

  const labelWidth = Math.max(...opts.options.map((o) => o.label.length));
  const input = opts.options
    .map((o) => {
      const pad = " ".repeat(labelWidth - o.label.length);
      return `${o.value}\t\x1b[1m${o.label}\x1b[22m${pad}${o.hint ? `  \x1b[2m${o.hint}\x1b[22m` : ""}`;
    })
    .join("\n");

  // Build start binding to pre-select initialValues
  // Strategy: select-all, then deselect items NOT in initialValues
  const initialSet = new Set(opts.initialValues ?? []);
  const bindings: string[] = [];

  if (opts.initialValues !== undefined) {
    const actions: string[] = ["toggle-all"];
    // Deselect items that should NOT be selected
    for (let i = 0; i < opts.options.length; i++) {
      if (!initialSet.has(opts.options[i]!.value)) {
        actions.push(`pos(${i + 1})+toggle`);
      }
    }
    // Reset cursor to top
    actions.push("pos(1)");
    bindings.push(`--bind=start:${actions.join("+")}`);
  }

  const result = spawnSync("fzf", [
    "--multi",
    "--ansi",
    "--with-nth=2..",
    "--delimiter=\t",
    process.env.RT_FZF_ALT_SCREEN ? "--height=100%" : "--height=~100%",
    ...fzfWidthArgs(),
    "--layout=reverse",
    "--border=rounded",
    `--border-label= ${opts.message} `,
    "--prompt=filter: ",
    "--header=space: toggle  tab: toggle & next  enter: confirm",
    "--no-mouse",
    "--bind=space:toggle,tab:toggle+down",
    "--preview=printf '%s\\n' {+2..}",
    "--preview-window=up,4,wrap,border-bottom",
    "--preview-label= selected ",
    ...bindings,
  ], {
    input,
    stdio: ["pipe", "pipe", "inherit"],
    encoding: "utf8",
  });

  if (result.status !== 0) {
    return null;
  }

  if (!result.stdout?.trim()) {
    return [];
  }

  return result.stdout
    .trim()
    .split("\n")
    .map((line) => line.split("\t")[0]!)
    .filter(Boolean);
}

/**
 * Show a filterable single-select using fzf.
 * fzf is a hard dependency — exits with an install hint if it's missing.
 */
export async function filterableSelect(opts: {
  message: string;
  options: SelectOption[];
  stderr?: boolean;
  /** When set, shows `ctrl-up: back` in the header and throws BackNavigation on ctrl-up. */
  backLabel?: string;
  /** Use fzf's exact-match mode instead of fuzzy matching. */
  exact?: boolean;
}): Promise<string | null> {
  const { spawnSync } = await import("child_process");
  const { ensureFzf } = await import("./fzf.ts");
  ensureFzf();

  const options = opts.options;

  const labelWidth = Math.max(...options.map((o) => o.label.length));
  const input = options
    .map((o) => {
      const pad = " ".repeat(labelWidth - o.label.length);
      const open = o.color ?? "";
      const close = o.color ? "\x1b[0m" : "";
      const hint = o.hint
        ? (o.color ? o.hint : `\x1b[2m${o.hint}\x1b[22m`)
        : "";
      // \x1b[22m cancels bold AND dim (both are "intensity" in SGR), so a
      // dim `open` color would otherwise vanish right after the label —
      // reapply it before the hint so the whole row stays dimmed.
      return `${o.value}\t${open}\x1b[1m${o.label}\x1b[22m${open}${pad}\t  ${hint}${close}`;
    })
    .join("\n");

  const header = opts.backLabel
    ? "enter: select  |: OR  !: exclude  ctrl-up: back"
    : "enter: select  |: OR  !: exclude";

  const result = spawnSync("fzf", [
    "--ansi",
    "--with-nth=2..",
    "--nth=1",
    "--delimiter=\t",
    "--tabstop=1",
    process.env.RT_FZF_ALT_SCREEN ? "--height=100%" : "--height=~100%",
    ...fzfWidthArgs(),
    "--layout=reverse",
    "--border=rounded",
    `--border-label= ${opts.message} `,
    "--prompt=filter: ",
    `--header=${header}`,
    "--no-mouse",
    "--print-query",
    "--expect=ctrl-up",
    `--color=border:${toHex(T.pink)},label:${toHex(T.pink)}`,
    ...(opts.exact ? ["--exact"] : []),
  ], {
    input,
    stdio: ["pipe", "pipe", "inherit"],
    encoding: "utf8",
  });

  if (result.status !== 0) return null;

  // --print-query + --expect always produce 3 lines:
  //   line 0: query text
  //   line 1: key pressed ("" for Enter, "ctrl-up" if that key)
  //   line 2: selected row (tab-delimited)
  const lines = (result.stdout ?? "").split("\n");
  const key = lines[1]?.trim() || null;
  const raw = lines[2]?.trim() ?? "";

  if (key === "ctrl-up") {
    if (opts.backLabel) throw new BackNavigation();
    return null;
  }

  if (!raw) return null;
  return raw.split("\t")[0]!;
}
