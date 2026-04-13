/** @jsxImportSource @rezi-ui/jsx */
/**
 * ATOM: KeyBadge + CmdLabel
 *
 * The two lowest-level building blocks of the KeybindBar molecule:
 *
 *   KeyBadge  — renders "[k]" in muted color
 *   CmdLabel  — renders a label in dim color
 *
 * These combine into the Cmd molecule:
 *   <Cmd k="s" l="start/restart" />
 *   → <row gap={1}><KeyBadge k="s" /><CmdLabel l="start/restart" /></row>
 *
 * Source: commands/runner.tsx HintBar Key/Label/Cmd components (lines 1183-1187)
 */

import { C } from "../theme.ts";

/** "[k]" in muted color — the key part of a keybinding hint. */
export function KeyBadge({ k }: { k: string }) {
  return <text style={{ fg: C.muted }}>{`[${k}]`}</text>;
}

/** Dim label text — the description part of a keybinding hint. */
export function CmdLabel({ l }: { l: string }) {
  return <text style={{ fg: C.dim }}>{l}</text>;
}

/**
 * A single keybinding hint: "[key] label" in a row.
 * The primary building block of KeybindBar sections.
 */
export function Cmd({ k, l }: { k: string; l: string }) {
  return (
    <row gap={1}>
      <KeyBadge k={k} />
      <CmdLabel l={l} />
    </row>
  );
}
