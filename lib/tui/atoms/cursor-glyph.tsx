/** @jsxImportSource @rezi-ui/jsx */
/**
 * ATOM: CursorGlyph
 *
 * Renders the navigation cursor indicator:
 *   selected=true  → "❯" in pink
 *   selected=false → " " in dim
 *
 * Usage:
 *   <CursorGlyph selected={isSelected} />
 *
 * Always paired with a `bg` prop matching the row's rowBg() so the
 * cursor character has the correct background on selected rows:
 *   <CursorGlyph selected={isSelected} bg={rowBg(isSelected)} />
 */

import { C } from "../theme.ts";

export function CursorGlyph({
  selected,
  bg,
}: {
  selected: boolean;
  bg?: number;
}) {
  return (
    <text style={{ fg: selected ? C.pink : C.dim, bg }}>
      {selected ? "❯" : " "}
    </text>
  );
}
