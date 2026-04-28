/** @jsxImportSource @rezi-ui/jsx */
/**
 * HintBar — keybinding hint footer, scoped to the current mode.
 *
 * Pure props-only view — the only input is the current mode tag. The mode
 * union used here is the structural subset of commands/runner.tsx's Mode
 * type (`Mode["type"]`) passed as a string. Extracted with no behavior change.
 */

import { C } from "./shared.ts";

/** Structural subset of runner.tsx's `Mode["type"]`. Kept local to avoid a module cycle. */
export type HintBarMode =
  | "normal"
  | "lane-scope"
  | "process-scope"
  | "open-scope"
  | "port-input"
  | "entry-picker"
  | "confirm-reset"
  | "confirm-spread";

export function HintBar({ mode }: { mode: HintBarMode }) {
  const Key = ({ k }: { k: string }) => <text style={{ fg: C.muted }}>{`[${k}]`}</text>;
  const Label = ({ l }: { l: string }) => <text style={{ fg: C.dim }}>{l}</text>;
  const Cmd = ({ k, l }: { k: string; l: string }) => (
    <row gap={1}><Key k={k} /><Label l={l} /></row>
  );
  const ScopeTitle = ({ name }: { name: string }) => (
    <row gap={1}>
      <text style={{ fg: C.lav, bold: true }}>{name}</text>
      <text style={{ fg: C.dim }}>{"›"}</text>
    </row>
  );

  if (mode === "lane-scope") return (
    <column gap={0}>
      <ScopeTitle name="lane" />
      <row gap={1}><Cmd k="a" l="add" /><Cmd k="r" l="remove" /><Cmd k="p" l="port" /><Cmd k="m" l="mode" /></row>
      <row gap={1}><Cmd k="z" l="pause" /><Cmd k="w" l="spread" /><Cmd k="c" l="cmd" /></row>
      <row gap={1}><Cmd k="esc" l="back" /></row>
    </column>
  );
  if (mode === "process-scope") return (
    <column gap={0}>
      <ScopeTitle name="process" />
      <row gap={1}><Cmd k="a" l="add" /><Cmd k="w" l="warm" /><Cmd k="↵" l="activate" /></row>
      <row gap={1}><Cmd k="r" l="remove" /><Cmd k="e" l="cmd" /><Cmd k="t" l="shell" /><Cmd k="f" l="fix rules" /><Cmd k="esc" l="back" /></row>
    </column>
  );
  if (mode === "open-scope") return (
    <column gap={0}>
      <ScopeTitle name="open" />
      <row gap={1}><Cmd k="b" l="branch" /><Cmd k="c" l="code" /><Cmd k="w" l="browser" /></row>
      <row gap={1}><Cmd k="r" l="run" /><Cmd k="i" l="info" /><Cmd k="esc" l="back" /></row>
    </column>
  );
  // Default top-level hints
  return (
    <column gap={0}>
      <row gap={1}><Cmd k="l" l="lane" /><Cmd k="p" l="process" /><Cmd k="o" l="open" /></row>
      <row gap={1}><Cmd k="s" l="start" /><Cmd k="x" l="stop" /><Cmd k="t" l="shell" /><Cmd k="↵" l="activate" /></row>
      <row gap={1}><Cmd k="q" l="quit" /><Cmd k="!" l="reset" /></row>
    </column>
  );
}
