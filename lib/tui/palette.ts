/**
 * Raw brand palette — RGB tuples only. No runtime deps.
 *
 * theme.ts composes these with @rezi-ui's rgb() helper to build the
 * runner's semantic color roles. CLI pickers (lib/rt-render.tsx, etc.)
 * import them directly to stay free of the Rezi UI runtime.
 *
 * To re-theme rt: edit this file. theme.ts derives from it.
 */

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

export type Rgb = readonly [number, number, number];

/** Format an RGB tuple as a 6-digit hex string (e.g. "#FF6B9D"). */
export function toHex(rgb: Rgb): string {
  const [r, g, b] = rgb;
  const hex = (n: number) => n.toString(16).padStart(2, "0").toUpperCase();
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/** Format an RGB tuple as an ANSI truecolor foreground escape. */
export function toAnsiFg(rgb: Rgb): string {
  return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
}

/** Format an RGB tuple as an ANSI truecolor background escape. */
export function toAnsiBg(rgb: Rgb): string {
  return `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
}
