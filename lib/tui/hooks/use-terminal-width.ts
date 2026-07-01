/**
 * HOOK: useTerminalWidth (Ink / React)
 *
 * Reactive terminal width. Subscribes to stdout resize events and triggers
 * a re-render whenever the terminal is resized.
 *
 * Source: commands/status useTerminalWidth
 */

import { useState, useEffect } from "react";

/**
 * Returns the current terminal column count, re-rendering on resize.
 *
 * @returns `process.stdout.columns`, falling back to 80 when unavailable.
 *
 * @example
 * ```tsx
 * const cols = useTerminalWidth();
 * const titleMax = Math.max(20, cols - 30);
 * ```
 */
export function useTerminalWidth(): number {
  const [width, setWidth] = useState(process.stdout.columns || 80);
  useEffect(() => {
    const onResize = () => setWidth(process.stdout.columns || 80);
    process.stdout.on("resize", onResize);
    return () => { process.stdout.off("resize", onResize); };
  }, []);
  return width;
}
