/**
 * rt-tui Theme — two-layer color system.
 *
 * LAYER 1: T (raw palette tokens) — one place to retheme everything.
 * LAYER 2: C (semantic roles)     — what JSX code references; never raw T values.
 *
 * To switch color themes: only modify the T block. C derives from it.
 */

import { rgb } from "@rezi-ui/jsx";
import { extendTheme, darkTheme } from "@rezi-ui/core";
import type { EntryState } from "./atoms/status-icon.ts";

// ─── Layer 1: Raw palette tokens ────────────────────────────────────────────

/** Raw RGB tuples — one place to edit per color. */
export const T = {
  // Backgrounds
  bgBase:     [22,  18,  36] as const,  // #161224 dark plum-black (canvas fill)
  bgElevated: [35,  28,  55] as const,  // #231C37 slightly lighter
  bgOverlay:  [50,  40,  75] as const,  // #32284B overlays / overlaid boxes
  bgSubtle:   [28,  22,  44] as const,  // #1C162C subtly lighter than base
  bgSelBg:    [55,  40,  75] as const,  // #37284B selected-row highlight

  // Accent colors
  pink:  [255, 107, 157] as const,  // #FF6B9D rose pink    — primary / borders / active
  lav:   [189, 147, 249] as const,  // #BD93F9 soft lavender — section labels in hint bar
  mint:  [ 98, 230, 168] as const,  // #62E6A8 mint green   — running / healthy / proxy up
  peach: [255, 183, 122] as const,  // #FFB77A warm peach   — warnings / toasts
  coral: [255, 121, 121] as const,  // #FF7979 coral rose   — errors / stopped
  warm:  [255, 210, 100] as const,  // #FFD264 warm yellow  — warm/idle (process suspended)
  cyan:  [ 90, 170, 255] as const,  // #5AAAFF electric blue — group headers / info

  // Neutrals
  dim:   [168, 160, 198] as const,  // #A8A0C6 muted plum   — secondary text / borders
  muted: [210, 205, 235] as const,  // #D2CDEB lilac-grey   — tertiary text
  white: [230, 224, 255] as const,  // #E6E0FF lavender white — primary text
} as const;

// ─── Layer 2: Semantic color roles ──────────────────────────────────────────

/**
 * Semantic roles — reference these in JSX. Never reference raw T values directly.
 * These are Rezi rgb() numbers (packed 24-bit integers).
 */
export const C = {
  // Primary accents
  pink:  rgb(...T.pink),   // primary accent / active selection / focused borders
  lav:   rgb(...T.lav),    // hint bar section labels
  mint:  rgb(...T.mint),   // running / healthy / success
  peach: rgb(...T.peach),  // toast messages / warnings
  coral: rgb(...T.coral),  // errors / stopped / proxy down
  warm:  rgb(...T.warm),   // warm/suspended process state
  cyan:  rgb(...T.cyan),   // group headers / informational text

  // Neutrals
  dim:   rgb(...T.dim),    // secondary text, muted borders
  muted: rgb(...T.muted),  // tertiary text (e.g. key badges in hint bar)
  white: rgb(...T.white),  // primary text

  // Backgrounds
  selBg: rgb(...T.bgSelBg), // background color for the selected row
} as const;

// ─── Process state → color ───────────────────────────────────────────────────

/**
 * Maps every EntryState to its display color (Rezi rgb number).
 * Source: commands/runner.tsx STATUS_COLOR.
 */
export const STATUS_COLOR: Record<EntryState, number> = {
  starting: rgb(...T.mint),
  stopping: rgb(...T.coral),
  running:  rgb(...T.mint),
  warm:     rgb(...T.warm),
  crashed:  rgb(...T.coral),
  stopped:  rgb(...T.dim),
};

// ─── Spinner frames ──────────────────────────────────────────────────────────

/** Braille spinner animation frames. Advance at 80ms for smooth animation. */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠣", "⠏"] as const;

// ─── Rezi canvas theme ───────────────────────────────────────────────────────

/**
 * Rezi theme extending the base darkTheme.
 * Pass to createNodeApp({ theme: runnerTheme }).
 */
export const runnerTheme = extendTheme(darkTheme, {
  colors: {
    bg: {
      base:     rgb(...T.bgBase),
      elevated: rgb(...T.bgElevated),
      overlay:  rgb(...T.bgOverlay),
      subtle:   rgb(...T.bgSubtle),
    },
  } as any,
});
