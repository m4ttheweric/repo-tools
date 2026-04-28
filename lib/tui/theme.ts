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
import { T } from "./palette.ts";

// ─── Layer 1: Raw palette tokens ────────────────────────────────────────────

// T is defined in ./palette.ts so CLI code (lib/rt-render.tsx, commands/*)
// can import the brand palette without pulling @rezi-ui/* into their dep
// graph. Re-exported here for back-compat with existing `lib/tui/index.ts`
// consumers.
export { T };

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
