/**
 * Procedural single-line spinner for CLI commands.
 *
 * Animates a braille spinner on stderr while an async task runs, then clears
 * the line so the caller can render its real output cleanly.
 *
 * Use this when:
 *   - You're in a one-shot CLI command (not Ink/Rezi)
 *   - You want the spinner to vanish silently on completion (no "✓ done" line)
 *
 * For workflows that should print a completion line, use `withSpinner` from
 * `lib/rt-render.tsx`. For React/Ink rendering, use `useSpinnerFrame` from
 * `lib/tui/hooks/use-spinner.ts`.
 */

import { cyan, dim, reset } from "../ansi.ts";
import { SPINNER_FRAMES } from "./theme.ts";

export async function withInlineSpinner<T>(
  label: string,
  task: () => Promise<T>,
): Promise<T> {
  if (!process.stderr.isTTY) return task();

  let frame = 0;
  const draw = () => {
    const f = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
    process.stderr.write(`\r  ${cyan}${f}${reset} ${dim}${label}${reset}`);
    frame++;
  };
  draw();
  const interval = setInterval(draw, 80);

  try {
    return await task();
  } finally {
    clearInterval(interval);
    process.stderr.write(`\r\x1b[2K`);
  }
}
