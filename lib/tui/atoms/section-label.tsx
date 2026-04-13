/** @jsxImportSource @rezi-ui/jsx */
/**
 * ATOM: SectionLabel + Pipe + Divider + GroupHeader
 *
 * Layout/structural atoms used in KeybindBar and GroupedList:
 *
 *   SectionLabel  — padded cyan-bold section name (e.g. "lane   " "process")
 *   Pipe          — "  ·  " separator between inline items
 *   Divider       — "  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌" horizontal separator between groups
 *   GroupHeader   — "  label" group header in cyan (above entries in a group)
 *
 * Source: commands/runner.tsx HintBar Section/Sep/Pipe + LaneCard GroupHeader (lines 1137-1188)
 */

import { C } from "../theme.ts";

/**
 * Section label for the left column of the KeybindBar.
 * The name is right-padded to 7 chars so all section labels align.
 *
 * Usage: <SectionLabel name="lane" /> → "lane   " in lavender bold
 */
export function SectionLabel({ name, width = 7 }: { name: string; width?: number }) {
  return (
    <text style={{ fg: C.lav, bold: true }}>
      {name.padEnd(width)}
    </text>
  );
}

/**
 * Thin space separator used between the SectionLabel and its first Cmd.
 * Provides visual breathing room inside a KeybindBar row.
 */
export function Sep() {
  return <text style={{ fg: C.lav }}>{"  "}</text>;
}

/**
 * "  ·  " separator used between unrelated groups of commands on the same row,
 * or between inline items in a status row.
 */
export function Pipe() {
  return <text style={{ fg: C.dim }}>{"  ·  "}</text>;
}

/**
 * Horizontal dashed line separator between entry groups inside a LaneCard.
 * Rendered above all groups except the first.
 *
 * Usage: <Divider /> → "  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌" in dim
 */
export function Divider() {
  return (
    <text style={{ fg: C.dim }}>{"  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌"}</text>
  );
}

/**
 * Group sub-header rendered above each group's entries inside a grouped list.
 * Shows the group's commandTemplate / category label in cyan.
 *
 * Usage: <GroupHeader label="npm run dev" />
 */
export function GroupHeader({ label }: { label: string }) {
  return <text style={{ fg: C.cyan }}>{`  ${label}`}</text>;
}
