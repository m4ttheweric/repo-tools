/**
 * HOOK: useSpinnerFrame (Ink / React)
 *
 * Animates a braille spinner character at 80ms intervals.
 * Only ticks (re-renders) when `active` is true — prevents unnecessary renders.
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
 * Source: commands/status.tsx useSpinnerChar (line 106)
 */

import { useState, useEffect } from "react";
import { SPINNER_FRAMES } from "../theme.ts";

/**
 * Returns the current spinner character, advancing at 80ms when active.
 *
 * @param active - Whether the spinner should animate. Pass false to freeze at frame 0.
 * @returns A single braille character like "⠋" "⠙" "⠹" etc.
 *
 * @example
 * ```tsx
 * const spin = useSpinnerFrame(isLoading);
 * return <Text color="cyan">{spin}</Text>;
 * ```
 */
export function useSpinnerFrame(active: boolean): string {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(t);
  }, [active]);

  return SPINNER_FRAMES[frame]!;
}
