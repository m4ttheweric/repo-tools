/**
 * UTILS: Text formatting helpers
 *
 * Pure string utilities shared across all dashboard views.
 *
 * Source:
 *   - commands/runner.tsx entryCommandLabel, rowBg (lines 1027-1032, 1055)
 *   - commands/status.tsx truncate, rpad, lpad, timeAgo (lines 90-104, 384-390)
 */

import { C } from "../theme.ts";

// ─── String formatting ────────────────────────────────────────────────────────

/**
 * Truncates a string to `max` characters, adding "…" if truncated.
 * Safe to call on empty strings.
 */
export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/**
 * Right-pads a string to a fixed width by appending spaces.
 * If the string is longer than `w`, it is truncated to `w`.
 */
export function rpad(s: string, w: number): string {
  return s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length);
}

/**
 * Left-pads a string to a fixed width by prepending spaces.
 * If the string is longer than `w`, it is returned as-is.
 */
export function lpad(s: string, w: number): string {
  return s.length >= w ? s : " ".repeat(w - s.length) + s;
}

/**
 * Returns a human-readable relative time string from a timestamp.
 *
 * @param ms - Unix timestamp in milliseconds, or ISO date string.
 * @returns  Strings like "just now", "5m ago", "3h ago", "2d ago".
 */
export function timeAgo(ms: number | string): string {
  const ts = typeof ms === "string" ? new Date(ms).getTime() : ms;
  const mins = Math.floor((Date.now() - ts) / 60_000);
  if (mins < 1)  return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// ─── Row background ───────────────────────────────────────────────────────────

/**
 * Returns the correct background color for a row based on its selection state.
 * In Rezi, background color must be applied to EVERY `<text>` element in the row —
 * not just the container. Pass the result to each `<text style={{ ..., bg }}>`.
 *
 * @param selected - Whether the row is currently selected.
 * @returns `C.selBg` (the selection highlight color) or `undefined` (transparent).
 *
 * @example
 * ```tsx
 * const bg = rowBg(isSelected);
 * return (
 *   <row gap={1}>
 *     <text style={{ fg: C.pink, bg }}>❯</text>
 *     <text style={{ fg: C.white, bg }}>label</text>
 *     <spacer flex={1} />
 *     <text style={{ fg: C.dim, bg }}>:4001</text>
 *   </row>
 * );
 * ```
 */
export function rowBg(selected: boolean): number | undefined {
  return selected ? C.selBg : undefined;
}

// ─── Command label formatting ─────────────────────────────────────────────────

/**
 * Formats a lane entry's display label from its commandTemplate.
 *
 * Rules:
 *   - If alias is set: shows the alias (scoped with packageLabel if not "root")
 *   - Else: extracts a short script name from `<pm> run <script>` in commandTemplate
 *   - If packageLabel !== "root": prefixes with "packageLabel · "
 *   - If extraction fails: shows the raw commandTemplate
 */
export function entryCommandLabel(entry: {
  packageLabel: string;
  commandTemplate: string;
  alias?: string;
}): string {
  const m = entry.commandTemplate.match(/(?:pnpm|npm|bun|yarn|deno)\s+run\s+(\S+)/);
  const summary = m ? m[1]! : entry.commandTemplate;
  const cmdLabel = entry.alias ?? summary;
  return entry.packageLabel !== "root"
    ? `${entry.packageLabel} · ${cmdLabel}`
    : cmdLabel;
}
