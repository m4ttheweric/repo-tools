/**
 * Shared theme tokens, status maps, and pure helpers used by the runner's
 * view components (EntryRow, LaneCard, HintBar) and re-imported by
 * commands/runner.tsx for the inline overlays that still live there.
 *
 * ── Theme layering ──
 *   T  — raw color tokens (edit here to retheme everything)
 *   C  — semantic roles referenced in JSX (don't change these names)
 *
 * Extracted from commands/runner.tsx; no behavior change.
 */

import { rgb } from "@rezi-ui/jsx";
import type { LaneEntry } from "../../runner-store.ts";
import type { ProcessState } from "../../daemon/state-store.ts";

/**
 * States a lane entry can be in.
 *
 * "starting" / "stopping" are UI-only optimistic states. Kept here (rather
 * than re-imported from commands/runner.tsx) to avoid a module cycle between
 * the view components and their host command file.
 */
export type EntryState = ProcessState | "starting" | "stopping";

/** Raw palette tokens — one place to edit per color. */
export const T = {
  // ── Backgrounds ────────────────────────────────────────────────────────────
  bgBase:     [22,  18,  36] as const,  // #161224  dark plum-black   (canvas fill)
  bgElevated: [35,  28,  55] as const,  // #231C37  slightly lighter
  bgOverlay:  [50,  40,  75] as const,  // #32284B  overlays / overlaid boxes
  bgSubtle:   [28,  22,  44] as const,  // #1C162C  subtly lighter than base
  bgSelBg:    [55,  40,  75] as const,  // #37284B  selected-row highlight

  // ── Accents ────────────────────────────────────────────────────────────────
  pink:  [255, 107, 157] as const,  // #FF6B9D  rose pink    — primary / borders / active
  lav:   [189, 147, 249] as const,  // #BD93F9  soft lavender — secondary hints
  mint:  [ 98, 230, 168] as const,  // #62E6A8  mint green   — running / healthy
  peach: [255, 183, 122] as const,  // #FFB77A  warm peach   — warnings / toasts
  coral: [255, 121, 121] as const,  // #FF7979  coral rose   — errors / stopped
  warm:  [255, 210, 100] as const,  // #FFD264  warm yellow  — warm/idle state
  cyan:  [ 90, 170, 255] as const,  // #5AAAFF  electric blue — group headers

  // ── Neutrals ───────────────────────────────────────────────────────────────
  dim:   [168, 160, 198] as const,  // #A8A0C6  muted plum   — secondary text / borders
  muted: [210, 205, 235] as const,  // #D2CDEB  lilac-grey   — tertiary text
  white: [230, 224, 255] as const,  // #E6E0FF  lavender white — primary text
};

/** Semantic color roles — reference these in JSX (never raw T values). */
export const C = {
  // accents
  pink:  rgb(...T.pink),
  lav:   rgb(...T.lav),
  mint:  rgb(...T.mint),
  peach: rgb(...T.peach),
  coral: rgb(...T.coral),
  cyan:  rgb(...T.cyan),
  // neutrals
  dim:   rgb(...T.dim),
  muted: rgb(...T.muted),
  white: rgb(...T.white),
  // backgrounds
  selBg: rgb(...T.bgSelBg),
};

/** Status state → display color (references T tokens). */
export const STATUS_COLOR: Record<EntryState, number> = {
  starting: rgb(...T.mint),
  stopping: rgb(...T.coral),
  running:  rgb(...T.mint),
  warm:     rgb(...T.warm),
  crashed:  rgb(...T.coral),
  stopped:  rgb(...T.dim),
};

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠣", "⠏"];

export const STATUS_ICON: Record<EntryState, string> = {
  starting: SPINNER_FRAMES[0]!, // overridden at render time with animated frame
  stopping: SPINNER_FRAMES[0]!, // overridden at render time with animated frame
  running:  "●",
  warm:     "❄",
  crashed:  "✗",
  stopped:  "○",
};

/** Compute the display label for an entry's command (package · script or custom template). */
export function entryCommandLabel(entry: LaneEntry): string {
  const defaultCmd = `${entry.pm} run ${entry.script}`;
  const hasCustomCmd = entry.commandTemplate !== defaultCmd;
  return entry.packageLabel !== "root"
    ? `${entry.packageLabel} · ${hasCustomCmd ? entry.commandTemplate : entry.script}`
    : (hasCustomCmd ? entry.commandTemplate : entry.script);
}
