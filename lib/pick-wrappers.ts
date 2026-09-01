/**
 * filterableSelect/filterableMultiselect built on the rt-ui `pick` verb.
 * Same names and signatures as the fzf-backed originals in fzf-select.ts,
 * plus one optional trailing `extras` param. Translates a plain SelectOption
 * list into rows and the terminal PickResult back into the shapes callers
 * already depend on.
 */
import { runPick, type PickHandle } from "./ui/pick.ts";
import type { PickAction, PickRow, PickSegment } from "./ui/protocol.ts";
import { BackNavigation } from "./back-navigation.ts";

export { BackNavigation } from "./back-navigation.ts";

export interface SelectOption {
  value: string;
  label: string;
  /** Displayed as dim text after the label. */
  hint?: string;
  /** Unused by this wrapper (no caller sets it); kept for signature parity with fzf-select.ts. */
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
}

const BACK_ACTION_ID = "back";

/** Two-column look: bold label padded to the widest label, then a dim hint. */
function optionsToRows(options: SelectOption[]): PickRow[] {
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
  },
  extras: PickerExtras = {},
): Promise<string | null> {
  const rows = extras.rows ?? optionsToRows(opts.options);
  const actions = withBackAction(extras.actions, opts.backLabel);

  const handle = runPick({
    message: opts.message,
    rows,
    ...(actions ? { actions } : {}),
    ...(opts.exact ? { exact: true } : {}),
    ...(extras.cap !== undefined ? { cap: extras.cap } : {}),
  });
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
  },
  extras: PickerExtras = {},
): Promise<string[] | null> {
  const rows = extras.rows ?? optionsToRows(opts.options);

  const handle = runPick({
    message: opts.message,
    rows,
    multi: true,
    ...(opts.initialValues !== undefined ? { initialValues: opts.initialValues } : {}),
    ...(extras.actions ? { actions: extras.actions } : {}),
    ...(extras.cap !== undefined ? { cap: extras.cap } : {}),
  });
  extras.onOpen?.(handle);

  const result = await handle.result;

  if (result.action === "cancel") return null;
  return result.values ?? [];
}
