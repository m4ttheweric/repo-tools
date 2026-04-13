/** @jsxImportSource @rezi-ui/jsx */
/**
 * ATOM: PortLabel + StateLabel
 *
 * Small inline metadata atoms for process entries:
 *
 *   PortLabel   — ":4001" in dim color
 *   StateLabel  — "running" / "starting…" / "❄ warm" in state-specific color
 *
 * Source: commands/runner.tsx EntryRow (lines 1050-1066)
 */

import { C, STATUS_COLOR } from "../theme.ts";
import type { EntryState } from "./status-icon.ts";

/**
 * Renders the ephemeral port number in dim color: ":4001"
 *
 * Usage: <PortLabel port={entry.ephemeralPort} />
 */
export function PortLabel({ port, bg }: { port: number; bg?: number }) {
  return <text style={{ fg: C.dim, bg }}>{`:${port}`}</text>;
}

/**
 * Renders a human-readable state label in the appropriate state color.
 * Maps raw state strings to display text:
 *   starting → "starting…"
 *   stopping → "stopping…"
 *   warm     → "❄ warm"
 *   others   → the state string as-is ("running", "stopped", "crashed")
 *
 * Usage: <StateLabel state={entry.state} />
 */
export function StateLabel({ state, bg }: { state: EntryState; bg?: number }) {
  const label =
    state === "starting" ? "starting…" :
    state === "stopping" ? "stopping…" :
    state === "warm"     ? "❄ warm"    : state;

  return <text style={{ fg: STATUS_COLOR[state], bg }}>{label}</text>;
}
