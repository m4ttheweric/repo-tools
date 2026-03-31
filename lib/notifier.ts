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
const STALE_PORT_THRESHOLD_MS = 6 * 60 * 60 * 1000; // 6 hours

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
    ticketState: entry.ticket?.stateName ?? null,
  };
}

function detectBranchTransitions(
  prev: Record<string, BranchSnapshot>,
  current: Record<string, CacheEntry>,
  fired: Set<string>,
  log: (msg: string) => void,
): void {
  for (const [branch, entry] of Object.entries(current)) {
    const now = snapshotBranch(entry);
    const was = prev[branch];
    if (!was) continue; // First time seeing this branch — no transition

    const branchShort = branch.length > 40 ? branch.slice(0, 39) + "…" : branch;
    const mrUrl = entry.mr?.webUrl ?? undefined;

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
        notify("Pipeline Failed", branchShort, mrUrl);
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
        notify("Pipeline Passed ✓", branchShort, mrUrl);
      }
    }

    // MR approved (was not approved → now approved)
    if (!was.approved && now.approved) {
      const key = `mr:approved:${branch}`;
      if (!fired.has(key)) {
        fired.add(key);
        log(`notify: MR approved on ${branch}`);
        notify("MR Approved 👍", branchShort, mrUrl);
      }
    }

    // MR merged
    if (was.mrState === "opened" && now.mrState === "merged") {
      const key = `mr:merged:${branch}`;
      if (!fired.has(key)) {
        fired.add(key);
        log(`notify: MR merged on ${branch}`);
        notify("MR Merged 🎉", branchShort, mrUrl);
      }
    }

    // Merge conflicts appeared
    if (!was.conflicts && now.conflicts) {
      const key = `mr:conflicts:${branch}`;
      if (!fired.has(key)) {
        fired.add(key);
        log(`notify: merge conflicts on ${branch}`);
        notify("Merge Conflicts", branchShort, mrUrl);
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
  }
}

// ─── Port staleness detection ────────────────────────────────────────────────

function detectStalePortTransitions(
  portState: Record<string, PortSnapshot>,
  currentPorts: PortEntry[],
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
      notify(
        "Stale Process",
        `${entry.command} on :${entry.port} has been running ${hours}h (${snapshot.relativeDir})`,
      );
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
  const fired = new Set(state.fired);

  // Branch transitions
  detectBranchTransitions(state.branches, cacheEntries, fired, log);

  // Port staleness
  detectStalePortTransitions(state.ports, ports, log);

  // Update state with current snapshots
  const newBranches: Record<string, BranchSnapshot> = {};
  for (const [branch, entry] of Object.entries(cacheEntries)) {
    newBranches[branch] = snapshotBranch(entry);
  }

  state.branches = newBranches;
  state.fired = [...fired];
  saveState(state);
}
