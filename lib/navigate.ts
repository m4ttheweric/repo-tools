/**
 * Shared navigation types and the `runNavPicker` re-export.
 *
 * Each command builds its own navigation loop on top of `runNavPicker`,
 * keeping domain-specific state management and key interpretation
 * where they belong.
 */

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
  /** Exit key: "" for Enter/select, key name for a bound expect key, "" for cancel. */
  key: string;
  /** The filter query text (always set, even on cancel — useful for resume). */
  query: string;
}

export interface NavPickerOpts {
  options: NavOption[];
  /** Shown in the border label. */
  message: string;
  /** Header-left breadcrumb Go renders instead of `message`; defaults to `[message]` when unset (runNavPicker, lib/pick-wrappers.ts). */
  breadcrumb?: string[];
  /** Faint run appended after the bold breadcrumb segments; rides with `breadcrumb`, ignored without it. */
  crumbSuffix?: string;
  /** Unused by runNavPicker (lib/pick-wrappers.ts reads only `headerParts`); kept for callers that still set it, but it renders nothing on the rt-ui path. */
  header?: string;
  /** Header segments joined with "  ". Ignored if `header` is set. */
  headerParts?: string[];
  /** Extra --expect keys (ctrl-up is always included). */
  expectKeys?: string[];
  /** Pre-fill the filter query. */
  initialQuery?: string;
  /** Value to pre-position the cursor on. */
  resumeValue?: string;
  /** Explicit 1-based cursor position. Overridden by resumeValue. */
  initialPos?: number | null;
  /** Use exact-match mode instead of fuzzy matching. */
  exact?: boolean;
  /**
   * When true, a no-match accept (the user typed a query that matched
   * nothing and pressed Enter) resolves to a NavResult with `value: null`
   * and the typed `query`, instead of null. Lets callers offer a live-search
   * fallback on the typed text. Esc / Ctrl-C still returns null.
   */
  captureQueryOnNoMatch?: boolean;
}

/** Create a separator NavOption. The value is auto-generated; the cursor auto-skips it. */
let sepCounter = 0;
export function navSeparator(label = "──────────────"): NavOption {
  return { value: `${NAV_SEPARATOR_PREFIX}${sepCounter++}__`, label, hint: "", separator: true };
}

// ─── Main entry point ───────────────────────────────────────────────────────

/**
 * Runs the picker built from these options and returns its NavResult, or
 * null on cancel. Implemented on the rt-ui `pick` verb in
 * lib/pick-wrappers.ts; re-exported here so import sites keyed on
 * lib/navigate.ts don't move.
 */
export { runNavPicker } from "./pick-wrappers.ts";

