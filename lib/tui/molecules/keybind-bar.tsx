/** @jsxImportSource @rezi-ui/jsx */
/**
 * MOLECULE: KeybindBar
 *
 * Renders a multi-row grid of sectioned keybinding hints at the bottom of a dashboard.
 *
 * Each section occupies one row: a padded section label on the left,
 * then a series of [key] label command pairs separated by spaces.
 *
 * Composed from: SectionLabel + Sep + Cmd (KeyBadge + CmdLabel) atoms.
 *
 * Usage:
 *   <KeybindBar sections={[
 *     {
 *       name: "lane",
 *       cmds: [{ k: "A", l: "add" }, { k: "p", l: "port" }, { k: "R", l: "remove" }],
 *     },
 *     {
 *       name: "process",
 *       cmds: [{ k: "a", l: "add" }, { k: "s", l: "start/restart" }, { k: "x/X", l: "stop" }],
 *     },
 *   ]} />
 *
 * Source: commands/runner.tsx HintBar (lines 1177-1234)
 */

import { SectionLabel, Sep } from "../atoms/section-label.tsx";
import { Cmd } from "../atoms/key-badge.tsx";

export interface KeybindSection {
  /** Short category name, right-padded to align columns. E.g. "lane", "process", "global". */
  name: string;
  /** The commands in this section, each an object with `k` (key) and `l` (label). */
  cmds: { k: string; l: string }[];
  /** If true, this section is hidden (useful for conditional commands like "spread"). */
  hidden?: boolean;
}

export interface KeybindBarProps {
  sections: KeybindSection[];
}

export function KeybindBar({ sections }: KeybindBarProps) {
  const visible = sections.filter((s) => !s.hidden);

  return (
    <column gap={0}>
      {visible.map((section) => (
        <row key={section.name} gap={1}>
          <SectionLabel name={section.name} />
          <Sep />
          {section.cmds.map((cmd) => (
            <Cmd key={cmd.k} k={cmd.k} l={cmd.l} />
          ))}
        </row>
      ))}
    </column>
  );
}
