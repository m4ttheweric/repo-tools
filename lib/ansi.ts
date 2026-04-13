/**
 * Shared ANSI color codes for rt CLI output.
 *
 * Previously lib/tui.ts — moved to lib/ansi.ts to free `lib/tui/` for
 * the Rezi/Ink component library. All existing imports still work via
 * the re-export shim in lib/tui.ts.
 */

export const esc = (code: number): string => `\x1b[${code}m`;
export const reset = esc(0);
export const bold = esc(1);
export const dim = esc(2);
export const italic = esc(3);
export const cyan = esc(36);
export const green = esc(32);
export const yellow = esc(33);
export const red = esc(31);
export const magenta = esc(35);
export const white = esc(37);
export const blue = esc(34);

// ─── Color palette for concurrent output, etc. ──────────────────────────────

export const COLOR_PALETTE = [
  "blue",
  "magenta",
  "cyan",
  "green",
  "yellow",
  "red",
  "white",
] as const;

export function assignColors(names: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < names.length; i++) {
    result[names[i]!] = COLOR_PALETTE[i % COLOR_PALETTE.length]!;
  }
  return result;
}
