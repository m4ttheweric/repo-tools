/** @jsxImportSource @rezi-ui/jsx */
/**
 * ATOM: StatusIcon + EntryState
 *
 * Renders the process status icon colored by state.
 * When state is "starting" or "stopping", renders an animated braille spinner
 * (the spinnerFrame prop advances at 80ms intervals in the parent dashboard).
 *
 * Usage:
 *   <StatusIcon state={entry.state} spinnerFrame={s.spinnerFrame} />
 *
 * Also exports:
 *   - EntryState         — the union type for all process states
 *   - STATUS_ICON        — state → static icon character
 *   - getStatusColor()   — state → display color (use theme.ts STATUS_COLOR instead)
 *
 * Source: commands/runner.tsx STATUS_ICON / STATUS_COLOR / SPINNER_FRAMES
 */

import { C, STATUS_COLOR, SPINNER_FRAMES } from "../theme.ts";

/** All states a process / lane entry can be in. */
export type EntryState =
  | "running"   // process is alive and serving
  | "stopped"   // process is not running
  | "crashed"   // process exited with non-zero code
  | "warm"      // process is running but not active (suspended / background)
  | "starting"  // UI-only optimistic state while spawn is in flight
  | "stopping"; // UI-only optimistic state while kill is in flight

/** Static icon characters per state (starting/stopping overridden with spinner at render time). */
export const STATUS_ICON: Record<EntryState, string> = {
  starting: SPINNER_FRAMES[0]!, // replaced with animated frame at render time
  stopping: SPINNER_FRAMES[0]!, // replaced with animated frame at render time
  running:  "●",
  warm:     "❄",
  crashed:  "✗",
  stopped:  "○",
};

/**
 * Renders one colored status icon.
 *
 * @param state        - Current process state
 * @param spinnerFrame - Current animation frame index (from app state, 80ms timer)
 * @param bg           - Optional background color for selected-row highlight
 */
export function StatusIcon({
  state,
  spinnerFrame = 0,
  bg,
}: {
  state: EntryState;
  spinnerFrame?: number;
  bg?: number;
}) {
  const isAnimated = state === "starting" || state === "stopping";
  const icon = isAnimated
    ? SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]!
    : STATUS_ICON[state];
  const color = STATUS_COLOR[state];

  return <text style={{ fg: color, bg }}>{icon}</text>;
}
