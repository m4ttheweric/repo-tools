/**
 * filterableSelect/filterableMultiselect built on the rt-ui `pick` verb.
 * Same names and signatures as the original fzf-backed pickers, plus one
 * optional trailing `extras` param. Translates a plain SelectOption list into
 * rows and the terminal PickResult back into the shapes callers already
 * depend on.
 */
import { runPick, type PickHandle } from "./ui/pick.ts";
import type { PickAction, PickEvent, PickRow, PickSegment } from "./ui/protocol.ts";
import { BackNavigation } from "./back-navigation.ts";
import type { NavOption, NavPickerOpts, NavResult } from "./navigate.ts";

export { BackNavigation } from "./back-navigation.ts";

export interface SelectOption {
  value: string;
  label: string;
  /** Displayed as dim text after the label. */
  hint?: string;
  /** Unused by this wrapper (no caller sets it); kept for signature parity with the original fzf-backed picker. */
  color?: string;
}

export interface PickerExtras {
  /** Segment-form rows override options rendering. */
  rows?: PickRow[];
  /** Extra registry entries, merged after any injected back action. */
  actions?: PickAction[];
  /** Live handle for update() pushes, called once the picker has opened. */
  onOpen?: (h: PickHandle) => void;
  cap?: number;
  /** Event door for `event: true` actions (e.g. a ctrl-r reload) -- without this, such an action fires Go-side but is dropped TS-side. */
  onEvent?: (e: PickEvent) => void | Promise<void>;
}

const BACK_ACTION_ID = "back";

/** Two-column look: bold label padded to the widest label, then a dim hint. */
export function optionsToRows(options: SelectOption[]): PickRow[] {
  const labelWidth = options.reduce((w, o) => Math.max(w, o.label.length), 0);
  return options.map((o) => {
    const left: PickSegment[] = [{ text: o.label.padEnd(labelWidth), bold: true }];
    if (o.hint) left.push({ text: `  ${o.hint}`, tone: "dim" });
    return { value: o.value, left };
  });
}

function withBackAction(actions: PickAction[] | undefined, backLabel: string | undefined): PickAction[] | undefined {
  if (!backLabel) return actions;
  const back: PickAction = { id: BACK_ACTION_ID, label: backLabel, key: "ctrl-up", scope: "global" };
  return actions ? [...actions, back] : [back];
}

/**
 * Show a filterable single-select. `stderr` is accepted for signature parity
 * with the fzf-backed original but has no effect there either: this wrapper
 * preserves that (a no-op), same as today.
 */
export async function filterableSelect(
  opts: {
    message: string;
    options: SelectOption[];
    stderr?: boolean;
    /** When set, adds a back action bound to ctrl-up and throws BackNavigation on it. */
    backLabel?: string;
    exact?: boolean;
    /** Header-left breadcrumb (e.g. ["rt", "commit"]); Go renders this, not `message`. */
    breadcrumb?: string[];
    /** Faint run appended after the bold breadcrumb segments (e.g. " · <repo> worktrees"); rides with `breadcrumb`, ignored without it. */
    crumbSuffix?: string;
  },
  extras: PickerExtras = {},
): Promise<string | null> {
  const rows = extras.rows ?? optionsToRows(opts.options);
  const actions = withBackAction(extras.actions, opts.backLabel);

  const handle = runPick(
    {
      message: opts.message,
      rows,
      ...(actions ? { actions } : {}),
      ...(opts.exact ? { exact: true } : {}),
      ...(extras.cap !== undefined ? { cap: extras.cap } : {}),
      ...(opts.breadcrumb ? { breadcrumb: opts.breadcrumb, ...(opts.crumbSuffix ? { crumbSuffix: opts.crumbSuffix } : {}) } : {}),
    },
    extras.onEvent ? { onEvent: extras.onEvent } : undefined,
  );
  extras.onOpen?.(handle);

  const result = await handle.result;

  if (opts.backLabel && result.action === BACK_ACTION_ID) {
    throw new BackNavigation();
  }
  if (result.action === "cancel") return null;
  return result.value ?? null;
}

/** Show a filterable multi-select. `stderr` is a no-op, same as today. */
export async function filterableMultiselect(
  opts: {
    message: string;
    options: SelectOption[];
    initialValues?: string[];
    stderr?: boolean;
    /** Header-left breadcrumb (e.g. ["rt", "commit"]); Go renders this, not `message`. */
    breadcrumb?: string[];
  },
  extras: PickerExtras = {},
): Promise<string[] | null> {
  const rows = extras.rows ?? optionsToRows(opts.options);

  const handle = runPick(
    {
      message: opts.message,
      rows,
      multi: true,
      ...(opts.initialValues !== undefined ? { initialValues: opts.initialValues } : {}),
      ...(extras.actions ? { actions: extras.actions } : {}),
      ...(extras.cap !== undefined ? { cap: extras.cap } : {}),
      ...(opts.breadcrumb ? { breadcrumb: opts.breadcrumb } : {}),
    },
    extras.onEvent ? { onEvent: extras.onEvent } : undefined,
  );
  extras.onOpen?.(handle);

  const result = await handle.result;

  if (result.action === "cancel") return null;
  return result.values ?? [];
}

// ─── runNavPicker ───────────────────────────────────────────────────────────
//
// Translates NavPickerOpts (lib/navigate.ts, which keeps the type homes and
// re-exports this function) onto runPick.

/** Bold label, padded to the widest label across the whole option list, plus a dim hint -- same look as the fzf-backed picker. */
function navOptionsToRows(options: NavOption[]): PickRow[] {
  const real = options.filter((o) => !o.separator);
  const labelWidth = real.reduce((w, o) => Math.max(w, o.label.length), 0);

  const rows: PickRow[] = [];
  let group: string | undefined;
  for (const o of options) {
    // A separator carries no row of its own -- its label names the group for
    // every real option that follows, until the next separator.
    if (o.separator) {
      group = o.label;
      continue;
    }
    const left: PickSegment[] = [{ text: o.label.padEnd(labelWidth), bold: true }];
    if (o.hint) left.push({ text: `  ${o.hint}`, tone: "dim" });
    // Filtering sees the label only; the hint is display (the old fzf nav
    // primitive matched a single column with --nth=1).
    rows.push({ value: o.value, match: o.label, left, ...(group ? { group } : {}) });
  }
  return rows;
}

function parseHeaderPart(part: string): { key: string; label: string } {
  const sep = part.indexOf(": ");
  return sep < 0 ? { key: part, label: part } : { key: part.slice(0, sep), label: part.slice(sep + 2) };
}

// Result actions this wrapper treats as the built-in select/cancel outcomes,
// whether Go's own defaults produced them or a headerPart claimed the same
// key under its own id -- see navActions.
const CANCEL_ACTION_IDS = new Set(["cancel", "esc"]);
const SELECT_ACTION_IDS = new Set(["select", "enter"]);

/**
 * ctrl-up (always) plus every caller expectKey become exit actions --
 * event:false, id equal to the key itself, so a press ends the picker with
 * that key as the result action (mirrors fzf's --expect contract). Every
 * headerPart names a key too: one that an exit action already claims just
 * relabels it (the caller's own footer wording wins over the raw key name);
 * any other headerPart becomes its own label-only global action.
 */
function navActions(opts: NavPickerOpts): PickAction[] | undefined {
  const headerLabels = new Map((opts.headerParts ?? []).map(parseHeaderPart).map((h) => [h.key, h.label] as const));
  const exitKeys = new Set<string>(["ctrl-up", ...(opts.expectKeys ?? [])]);

  const actions: PickAction[] = [];
  for (const key of exitKeys) {
    // An exit key no headerPart names stays bound but off the legend: fzf
    // never advertised an unlabeled expect key, and printing the key as its
    // own label reads as "ctrl-up ctrl-up".
    const label = headerLabels.get(key);
    actions.push({ id: key, label: label ?? key, key, scope: "global", event: false, ...(label === undefined ? { footerHidden: true } : {}) });
  }
  for (const [key, label] of headerLabels) {
    if (exitKeys.has(key)) continue;
    actions.push({ id: key, label, key, scope: "global" });
  }
  return actions.length > 0 ? actions : undefined;
}

/** initialPos is a 1-based index into the full option list; resumeValue (a value to search for) always wins when both are set. */
function resolveResumeValue(opts: NavPickerOpts): string | undefined {
  if (opts.resumeValue) return opts.resumeValue;
  if (opts.initialPos != null) return opts.options[opts.initialPos - 1]?.value;
  return undefined;
}

function toNavResult(result: { action: string; value: string | null; query: string }): NavResult | null {
  if (CANCEL_ACTION_IDS.has(result.action)) return null;
  const key = SELECT_ACTION_IDS.has(result.action) ? "" : result.action;
  return { value: result.value ?? null, key, query: result.query };
}

/**
 * Run a picker built from NavPickerOpts and return its NavResult, or null on
 * cancel -- same signature and return shape as the fzf-backed original, so
 * every existing call site keeps working unchanged.
 */
export async function runNavPicker(opts: NavPickerOpts): Promise<NavResult | null> {
  const rows = navOptionsToRows(opts.options);
  const actions = navActions(opts);
  const resumeValue = resolveResumeValue(opts);

  const handle = runPick({
    message: opts.message,
    rows,
    // Nav-grammar default: a single bold segment naming the picker, same as
    // every other caller that builds its own breadcrumb by hand -- without
    // this the header goes blank (Go renders Breadcrumb, never Message).
    breadcrumb: opts.breadcrumb ?? [opts.message],
    ...(opts.crumbSuffix ? { crumbSuffix: opts.crumbSuffix } : {}),
    ...(actions ? { actions } : {}),
    ...(opts.initialQuery ? { initialQuery: opts.initialQuery } : {}),
    ...(resumeValue ? { resumeValue } : {}),
    ...(opts.exact ? { exact: true } : {}),
    ...(opts.captureQueryOnNoMatch ? { acceptNoMatch: true } : {}),
  });

  const result = await handle.result;
  return toNavResult(result);
}
