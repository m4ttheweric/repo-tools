/**
 * Pure formatting helpers and status/color maps for the rt status dashboard.
 * No React — string and icon lookups only. Generic text helpers (truncate,
 * rpad, lpad, timeAgo) live in lib/tui/utils/label.ts.
 */

import type { MRDashboardProps } from "@workforge/glance-sdk";

// ─── Status config ──────────────────────────────────────────────────────────

export type MRStatus = MRDashboardProps["status"];

export const STATUS_COLOR: Record<MRStatus, string> = {
  mergeable: "green",     // positive  → green-40
  merged: "magenta",      // action    → purple-40
  blocked: "yellow",      // caution   → yellow-40
  draft: "gray",          // muted     → border
  closed: "red",          // negative  → red-40
};

export const STATUS_LABEL: Record<MRStatus, string> = {
  mergeable: "Ready to merge",
  merged: "Merged",
  blocked: "Blocked",
  draft: "Draft",
  closed: "Closed",
};

/**
 * 2-line box-art status icons, colored by STATUS_COLOR.
 */
export const STATUS_ART: Record<MRStatus, [string, string]> = {
  mergeable: ["╭ ✓ ╮", "╰───╯"],
  merged:    ["╭ ⏣ ╮", "╰───╯"],
  blocked:   ["╭ ━ ╮", "╰───╯"],
  draft:     ["┌ · ┐", "└───┘"],
  closed:    ["╭ ✗ ╮", "╰───╯"],
};

// ─── Review display state ───────────────────────────────────────────────────

export const REVIEW_ICON: Record<string, string> = {
  approved: "✓",
  commented: "💬",
  changes_requested: "✗",
  reviewing: "…",
  awaiting_review: "○",
};

export const REVIEW_COLOR: Record<string, string> = {
  approved: "green",
  commented: "cyan",
  changes_requested: "yellow",
  reviewing: "gray",
  awaiting_review: "gray",
};

// ─── Pipeline icons ─────────────────────────────────────────────────────────

/** Pipeline status → TUI icon */
export function pipelineIcon(pipeline: { status: string; failing?: number; running?: number } | null): { icon: string; color: string } {
  if (!pipeline) return { icon: " ", color: "gray" };
  const { status, failing, running } = pipeline;
  if (status === "failed" || (failing && failing > 0)) return { icon: "✗", color: "red" };
  if (status === "running" || (running && running > 0)) return { icon: "~", color: "blue" };
  return { icon: "●", color: "green" };
}

export function jobStatusIcon(status: string, allowFailure = false): { icon: string; color: string; isSpinner?: boolean } {
  switch (status) {
    case "success": return { icon: "✓", color: "green" };
    case "failed": return allowFailure
      ? { icon: "⚠", color: "yellow" }   // allowed failure — warning, not error
      : { icon: "✗", color: "red" };
    case "running": return { icon: "", color: "blue", isSpinner: true };
    case "pending":
    case "waiting_for_resource":
    case "preparing":
    case "created": return { icon: "○", color: "yellow" };
    case "canceled": return { icon: "⊘", color: "gray" };
    case "skipped": return { icon: "⊘", color: "gray" };
    case "manual": return { icon: "▸", color: "cyan" };
    case "scheduled": return { icon: "◷", color: "cyan" };
    default: return { icon: "?", color: "gray" };
  }
}

export function formatDuration(seconds: number | null): string {
  if (seconds == null) return "";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

// ─── Trace log formatting ───────────────────────────────────────────────────

/** Strip GitLab CI section markers and clean up trace lines, preserving ANSI color codes */
export function cleanTraceLine(line: string): string {
  // Strip GitLab section markers: \x1b[0Ksection_start:...\r\x1b[0K / section_end:...
  let cleaned = line
    .replace(/\x1b\[0Ksection_(start|end):[^\r\n]*/g, "")
    .replace(/\r/g, "")
    // Strip leading/trailing reset sequences that add no value
    .replace(/^\x1b\[0;m/, "")
    .replace(/\x1b\[0;m$/, "");

  // If line already has ANSI color codes, leave it as-is (GitLab colored it)
  if (/\x1b\[\d+/.test(cleaned)) return cleaned;

  // Pattern-based colorization for plain lines
  const lower = cleaned.toLowerCase();

  // Error patterns → red
  if (/\b(error|ERR!|FAIL|fatal|panic|exception)\b/i.test(cleaned)) {
    return `\x1b[31m${cleaned}\x1b[0m`;
  }
  // Warning patterns → yellow
  if (/\b(warn(ing)?|WARN|deprecated)\b/i.test(cleaned)) {
    return `\x1b[33m${cleaned}\x1b[0m`;
  }
  // Command prefix ($ ...) → cyan
  if (/^\$\s/.test(cleaned)) {
    return `\x1b[36m${cleaned}\x1b[0m`;
  }
  // Pass/success patterns → green
  if (/\b(pass(ed)?|success(ful)?|✓|ok)\b/i.test(cleaned) && !lower.includes("fail")) {
    return `\x1b[32m${cleaned}\x1b[0m`;
  }

  return cleaned;
}

// ─── Diff hunk helpers ───────────────────────────────────────────────────────

/**
 * Parse unified diff text and return the hunk that contains `newLine`.
 * Returns null when the line can't be located (e.g. context-only note).
 */
export function extractHunk(diffText: string, newLine: number | null): string | null {
  if (!diffText || newLine === null) return null;
  const hunks = diffText.split(/(?=^@@)/m);
  for (const hunk of hunks) {
    if (!hunk.startsWith("@@")) continue;
    const m = hunk.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!m) continue;
    const start = parseInt(m[1]!, 10);
    const count = parseInt(m[2] ?? "1", 10);
    if (newLine >= start && newLine < start + count) return hunk.trimEnd();
  }
  return null;
}
