/**
 * Smart notification engine for the rt daemon.
 *
 * Compares current cache state against the previous snapshot to detect
 * transitions (pipeline failures, MR approvals, etc.) and fires macOS
 * notifications via terminal-notifier (preferred) or osascript (fallback).
 *
 * Called at the end of each daemon cache refresh cycle.
 */

import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { RT_DIR } from "./daemon-config.ts";
import type { PortEntry } from "./port-scanner.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

interface BranchSnapshot {
  pipelineStatus: string | null;
  mrState: string | null;
  approved: boolean;
  conflicts: boolean;
  needsRebase: boolean;
  isReady: boolean;
  mergeError: string | null;
  ticketState: string | null;
}

interface PortSnapshot {
  pid: number;
  port: number;
  command: string;
  repo: string;
  branch: string | null;
  relativeDir: string;
  /** Timestamp when we first saw this PID:port combo */
  firstSeen: number;
  /** Whether we already notified about staleness */
  staleNotified: boolean;
}

interface NotifierState {
  branches: Record<string, BranchSnapshot>;
  ports: Record<string, PortSnapshot>; // keyed by "pid:port"
  /** Transition keys we've already notified about */
  fired: string[];
}

// ─── Config ──────────────────────────────────────────────────────────────────

const STATE_PATH = join(RT_DIR, "notifier-state.json");
const PREFS_PATH = join(RT_DIR, "notifications.json");
const STALE_PORT_THRESHOLD_MS = 6 * 60 * 60 * 1000; // 6 hours

// ─── Notification type registry ──────────────────────────────────────────────

export const NOTIFICATION_TYPES = [
  { key: "pipeline_failed",   label: "Pipeline failed",     description: "When a running pipeline fails" },
  { key: "pipeline_passed",   label: "Pipeline passed",     description: "When a running pipeline succeeds" },
  { key: "mr_approved",       label: "MR approved",         description: "When your MR gets fully approved" },
  { key: "mr_merged",         label: "MR merged",           description: "When your MR is merged" },
  { key: "mr_ready",          label: "MR ready to merge",   description: "When all blockers are cleared" },
  { key: "merge_conflicts",   label: "Merge conflicts",     description: "When merge conflicts appear on your MR" },
  { key: "needs_rebase",      label: "Needs rebase",        description: "When your branch falls behind target" },
  { key: "merge_error",       label: "Merge error",         description: "When auto-merge or merge train fails" },
  { key: "stale_port",        label: "Stale processes",     description: "When a dev server has been running 6h+" },
] as const;

export type NotificationPrefs = Record<string, boolean>;

export function loadNotificationPrefs(): NotificationPrefs {
  try {
    return JSON.parse(readFileSync(PREFS_PATH, "utf8"));
  } catch {
    // Default: everything enabled
    const defaults: NotificationPrefs = {};
    for (const t of NOTIFICATION_TYPES) defaults[t.key] = true;
    return defaults;
  }
}

export function saveNotificationPrefs(prefs: NotificationPrefs): void {
  try {
    mkdirSync(RT_DIR, { recursive: true });
    writeFileSync(PREFS_PATH, JSON.stringify(prefs, null, 2));
  } catch { /* best-effort */ }
}

function isEnabled(prefs: NotificationPrefs, key: string): boolean {
  return prefs[key] !== false; // default to enabled if not set
}

// ─── State persistence ───────────────────────────────────────────────────────

function loadState(): NotifierState {
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    return { branches: {}, ports: {}, fired: [] };
  }
}

function saveState(state: NotifierState): void {
  try {
    mkdirSync(RT_DIR, { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch { /* best-effort */ }
}

// ─── Notification dispatch ───────────────────────────────────────────────────

let _hasTerminalNotifier: boolean | null = null;

function hasTerminalNotifier(): boolean {
  if (_hasTerminalNotifier === null) {
    try {
      execSync("which terminal-notifier", { stdio: "pipe" });
      _hasTerminalNotifier = true;
    } catch {
      _hasTerminalNotifier = false;
    }
  }
  return _hasTerminalNotifier;
}

export function notify(title: string, message: string, url?: string): void {
  try {
    if (hasTerminalNotifier()) {
      const args = [
        `-title "rt"`,
        `-subtitle ${escapeShell(title)}`,
        `-message ${escapeShell(message)}`,
        `-group "rt"`,
      ];
      if (url) args.push(`-open ${escapeShell(url)}`);
      execSync(`terminal-notifier ${args.join(" ")}`, { stdio: "pipe", timeout: 5000 });
    } else {
      // osascript fallback
      const body = `${title}: ${message}`;
      execSync(
        `osascript -e 'display notification ${escapeShell(body)} with title "rt"'`,
        { stdio: "pipe", timeout: 5000 },
      );
    }
  } catch { /* notification is best-effort */ }
}

function escapeShell(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// ─── Branch transition detection ─────────────────────────────────────────────

interface CacheEntry {
  ticket: any;
  linearId: string;
  mr: any;
  fetchedAt: number;
}

function snapshotBranch(entry: CacheEntry): BranchSnapshot {
  return {
    pipelineStatus: entry.mr?.pipeline?.status ?? null,
    mrState: entry.mr?.state ?? null,
    approved: entry.mr?.reviews?.isApproved ?? false,
    conflicts: entry.mr?.blockers?.hasConflicts ?? false,
    needsRebase: entry.mr?.blockers?.needsRebase ?? false,
    isReady: entry.mr?.isReady ?? false,
    mergeError: entry.mr?.blockers?.mergeError ?? null,
    ticketState: entry.ticket?.stateName ?? null,
  };
}

function detectBranchTransitions(
  prev: Record<string, BranchSnapshot>,
  current: Record<string, CacheEntry>,
  fired: Set<string>,
  prefs: NotificationPrefs,
  log: (msg: string) => void,
): void {
  for (const [branch, entry] of Object.entries(current)) {
    const now = snapshotBranch(entry);
    const was = prev[branch];
    if (!was) continue; // First time seeing this branch — no transition

    const branchShort = branch.length > 40 ? branch.slice(0, 39) + "…" : branch;
    const mrUrl = entry.mr?.webUrl ?? undefined;

    // MR merged (open → merged) — check BEFORE skipping merged MRs
    if (was.mrState === "opened" && now.mrState === "merged") {
      const key = `mr:merged:${branch}`;
      if (!fired.has(key)) {
        fired.add(key);
        log(`notify: MR merged on ${branch}`);
        if (isEnabled(prefs, "mr_merged")) notify("MR Merged 🎉", branchShort, mrUrl);
      }
    }

    // Skip all other notifications for merged/closed MRs
    if (entry.mr?.status === "merged" || entry.mr?.status === "closed") continue;

    // Pipeline: running/pending → failed
    if (
      was.pipelineStatus &&
      ["running", "pending", "created"].includes(was.pipelineStatus) &&
      now.pipelineStatus === "failed"
    ) {
      const key = `pipeline:failed:${branch}`;
      if (!fired.has(key)) {
        fired.add(key);
        log(`notify: pipeline failed on ${branch}`);
        if (isEnabled(prefs, "pipeline_failed")) notify("Pipeline Failed", branchShort, mrUrl);
      }
    }

    // Pipeline: running/pending → success
    if (
      was.pipelineStatus &&
      ["running", "pending", "created"].includes(was.pipelineStatus) &&
      now.pipelineStatus === "success"
    ) {
      const key = `pipeline:success:${branch}`;
      if (!fired.has(key)) {
        fired.add(key);
        log(`notify: pipeline passed on ${branch}`);
        if (isEnabled(prefs, "pipeline_passed")) notify("Pipeline Passed ✓", branchShort, mrUrl);
      }
    }

    // MR approved (was not approved → now approved)
    if (!was.approved && now.approved) {
      const key = `mr:approved:${branch}`;
      if (!fired.has(key)) {
        fired.add(key);
        log(`notify: MR approved on ${branch}`);
        if (isEnabled(prefs, "mr_approved")) notify("MR Approved 👍", branchShort, mrUrl);
      }
    }

    // Merge conflicts appeared
    if (!was.conflicts && now.conflicts) {
      const key = `mr:conflicts:${branch}`;
      if (!fired.has(key)) {
        fired.add(key);
        log(`notify: merge conflicts on ${branch}`);
        if (isEnabled(prefs, "merge_conflicts")) notify("Merge Conflicts", branchShort, mrUrl);
      }
    }

    // MR ready to merge (all blockers cleared)
    if (!was.isReady && now.isReady) {
      const key = `mr:ready:${branch}`;
      if (!fired.has(key)) {
        fired.add(key);
        log(`notify: MR ready to merge on ${branch}`);
        if (isEnabled(prefs, "mr_ready")) notify("Ready to Merge ✓", branchShort, mrUrl);
      }
    }

    // Needs rebase (branch fell behind target)
    if (!was.needsRebase && now.needsRebase) {
      const key = `mr:rebase:${branch}`;
      if (!fired.has(key)) {
        fired.add(key);
        log(`notify: needs rebase on ${branch}`);
        if (isEnabled(prefs, "needs_rebase")) notify("Needs Rebase", branchShort, mrUrl);
      }
    }

    // Merge error (auto-merge or merge train failed)
    if (!was.mergeError && now.mergeError) {
      const key = `mr:merge_error:${branch}`;
      if (!fired.has(key)) {
        fired.add(key);
        log(`notify: merge error on ${branch}: ${now.mergeError}`);
        if (isEnabled(prefs, "merge_error")) notify("Merge Error", `${branchShort}: ${now.mergeError}`, mrUrl);
      }
    }

    // Clear fired keys when state changes back (so we can re-notify on next transition)
    if (was.pipelineStatus === "failed" && now.pipelineStatus !== "failed") {
      fired.delete(`pipeline:failed:${branch}`);
    }
    if (was.pipelineStatus === "success" && now.pipelineStatus !== "success") {
      fired.delete(`pipeline:success:${branch}`);
    }
    if (was.approved && !now.approved) {
      fired.delete(`mr:approved:${branch}`);
    }
    if (was.conflicts && !now.conflicts) {
      fired.delete(`mr:conflicts:${branch}`);
    }
    if (was.isReady && !now.isReady) {
      fired.delete(`mr:ready:${branch}`);
    }
    if (was.needsRebase && !now.needsRebase) {
      fired.delete(`mr:rebase:${branch}`);
    }
    if (was.mergeError && !now.mergeError) {
      fired.delete(`mr:merge_error:${branch}`);
    }
  }
}

// ─── Port staleness detection ────────────────────────────────────────────────

function detectStalePortTransitions(
  portState: Record<string, PortSnapshot>,
  currentPorts: PortEntry[],
  prefs: NotificationPrefs,
  log: (msg: string) => void,
): void {
  const now = Date.now();
  const currentKeys = new Set<string>();

  for (const entry of currentPorts) {
    const key = `${entry.pid}:${entry.port}`;
    currentKeys.add(key);

    if (!portState[key]) {
      // First time seeing this port — track it
      portState[key] = {
        pid: entry.pid,
        port: entry.port,
        command: entry.command,
        repo: entry.repo || "unknown",
        branch: entry.branch,
        relativeDir: entry.relativeDir,
        firstSeen: now,
        staleNotified: false,
      };
    }

    const snapshot = portState[key]!;
    const age = now - snapshot.firstSeen;

    if (age > STALE_PORT_THRESHOLD_MS && !snapshot.staleNotified) {
      snapshot.staleNotified = true;
      const hours = Math.round(age / (60 * 60 * 1000));
      log(`notify: stale port ${entry.command} on :${entry.port} (${hours}h)`);
      if (isEnabled(prefs, "stale_port")) {
        notify(
          "Stale Process",
          `${entry.command} on :${entry.port} has been running ${hours}h (${snapshot.relativeDir})`,
        );
      }
    }
  }

  // Prune ports that are no longer running
  for (const key of Object.keys(portState)) {
    if (!currentKeys.has(key)) {
      delete portState[key];
    }
  }
}

// ─── Public API (called by daemon after each refresh) ────────────────────────

export function checkAndNotify(
  cacheEntries: Record<string, CacheEntry>,
  ports: PortEntry[],
  log: (msg: string) => void,
): void {
  const state = loadState();
  const prefs = loadNotificationPrefs();
  const fired = new Set(state.fired);

  // Branch transitions
  detectBranchTransitions(state.branches, cacheEntries, fired, prefs, log);

  // Port staleness
  detectStalePortTransitions(state.ports, ports, prefs, log);

  // Update state with current snapshots
  const newBranches: Record<string, BranchSnapshot> = {};
  for (const [branch, entry] of Object.entries(cacheEntries)) {
    newBranches[branch] = snapshotBranch(entry);
  }

  state.branches = newBranches;
  state.fired = [...fired];
  saveState(state);
}
