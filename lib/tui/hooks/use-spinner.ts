/**
 * HOOK: useSpinnerFrame (Ink / React)
 *
 * Animates a braille spinner character at 80ms intervals.
 * Only ticks (re-renders) when `active` is true — prevents unnecessary renders.
 *
 * One shared 80ms interval drives every active spinner. With N concurrent
 * spinners, a per-hook setInterval produced N×12.5 renders/s for 12+ hours —
 * enough churn to OOM the JS heap. Sharing the ticker (and only running it
 * while at least one subscriber is active) keeps render volume flat as the
 * number of active spinners grows.
 *
 * Use this in Ink (React) dashboards (e.g. rt status).
 * For Rezi dashboards (e.g. rt runner), use setInterval + safeUpdate pattern instead:
 *
 *   const spinnerTimer = setInterval(() => {
 *     safeUpdate((s) => {
 *       const hasTransient = [...s.states.values()].some(st => st === "starting");
 *       if (!hasTransient) return s; // skip render when nothing is animating
 *       return { ...s, spinnerFrame: s.spinnerFrame + 1 };
 *     });
 *   }, 80);
 *
 * Source: commands/status useSpinnerChar (shared-ticker variant)
 */

import { useState, useEffect } from "react";
import { SPINNER_FRAMES } from "../theme.ts";

let spinnerFrame = 0;
let spinnerInterval: ReturnType<typeof setInterval> | null = null;
const spinnerSubs = new Set<(f: number) => void>();

function startSpinnerTicker() {
  if (spinnerInterval) return;
  spinnerInterval = setInterval(() => {
    spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
    for (const cb of spinnerSubs) cb(spinnerFrame);
  }, 80);
}

function stopSpinnerTicker() {
  if (!spinnerInterval) return;
  clearInterval(spinnerInterval);
  spinnerInterval = null;
}

/**
 * Returns the current spinner character, advancing at 80ms when active.
 *
 * @param active - Whether the spinner should animate. Pass false to freeze.
 * @returns A single braille character like "⠋" "⠙" "⠹" etc.
 *
 * @example
 * ```tsx
 * const spin = useSpinnerFrame(isLoading);
 * return <Text color="cyan">{spin}</Text>;
 * ```
 */
export function useSpinnerFrame(active: boolean): string {
  const [frame, setFrame] = useState(spinnerFrame);

  useEffect(() => {
    if (!active) return;
    spinnerSubs.add(setFrame);
    startSpinnerTicker();
    return () => {
      spinnerSubs.delete(setFrame);
      if (spinnerSubs.size === 0) stopSpinnerTicker();
    };
  }, [active]);

  return SPINNER_FRAMES[frame]!;
}
