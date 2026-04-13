/**
 * Smart notification engine for the rt daemon.
 *
 * Compares current cache state against the previous snapshot to detect
 * transitions (pipeline failures, MR approvals, etc.) and dispatches
 * notifications via a durable queue.
 *
 * Notification flow:
 *  1. Transition detected → event queued in memory + persisted to disk
 *  2. Push attempt to rt-tray.app via ~/.rt/tray.sock (instant delivery)
 *  3. If tray is unavailable → event stays in queue for later drain
 *  4. Fallback: if no tray.sock exists, shell out to terminal-notifier/osascript
 *  5. Tray app can drain pending queue via drainNotifications() on startup
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

export interface NotificationEvent {
  id: string;
  title: string;
  message: string;
  url?: string;
  category: string;
  timestamp: number;
}

// ─── Config ──────────────────────────────────────────────────────────────────

const STATE_PATH = join(RT_DIR, "notifier-state.json");
const PREFS_PATH = join(RT_DIR, "notifications.json");
const QUEUE_PATH = join(RT_DIR, "notify-queue.json");
const TRAY_SOCK_PATH = join(RT_DIR, "tray.sock");

// ─── Broadcast hook (set by daemon.ts to push to WebSocket clients) ──────────

let _broadcastHook: ((type: string, data: any) => void) | null = null;

/** Register a callback to broadcast notification events (e.g. to WebSocket clients) */
export function onNotification(hook: (type: string, data: any) => void): void {
  _broadcastHook = hook;
}
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

// ─── Notification queue (durable) ────────────────────────────────────────────

/** In-memory queue — also persisted to disk for durability */
let notificationQueue: NotificationEvent[] = [];

/** Load any persisted notifications from a previous daemon session */
function loadQueue(): void {
  try {
    const raw = JSON.parse(readFileSync(QUEUE_PATH, "utf8"));
    if (Array.isArray(raw)) notificationQueue = raw;
  } catch { /* no queue file or corrupt — start fresh */ }
}

/** Persist the current queue to disk */
function flushQueue(): void {
  try {
    mkdirSync(RT_DIR, { recursive: true });
    if (notificationQueue.length === 0) {
      // Clean up empty queue file
      try { if (existsSync(QUEUE_PATH)) writeFileSync(QUEUE_PATH, "[]"); } catch { /* */ }
    } else {
      writeFileSync(QUEUE_PATH, JSON.stringify(notificationQueue, null, 2));
    }
  } catch { /* best-effort */ }
}

// Load persisted queue on module init (daemon startup)
loadQueue();

/**
 * Drain all pending notifications. Called by the tray app on startup
 * and by the daemon's /notifications endpoint.
 * Returns the events and clears the queue.
 */
export function drainNotifications(): NotificationEvent[] {
  const events = notificationQueue.splice(0);
  flushQueue();
  return events;
}

/**
 * Peek at pending notifications without draining.
 */
export function peekNotifications(): NotificationEvent[] {
  return [...notificationQueue];
}

// ─── Push to tray app ────────────────────────────────────────────────────────

/**
 * Attempt to push a notification event to the tray app via its Unix socket.
 * Returns true if the push succeeded, false if tray is unavailable.
 */
async function pushToTray(event: NotificationEvent): Promise<boolean> {
  if (!existsSync(TRAY_SOCK_PATH)) return false;

  try {
    const response = await fetch("http://localhost/notify", {
      unix: TRAY_SOCK_PATH,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(2000),
    } as any);

    if (response.ok) {
      // Push succeeded — remove from queue
      const idx = notificationQueue.findIndex(n => n.id === event.id);
      if (idx !== -1) notificationQueue.splice(idx, 1);
      flushQueue();
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ─── Fallback dispatch (terminal-notifier / osascript) ───────────────────────

/**
 * Resolve the absolute path to terminal-notifier.
 *
 * We can't rely on `which` because when the daemon is launched by launchd,
 * PATH is minimal (/usr/bin:/bin:/usr/sbin:/sbin) and won't include
 * Homebrew's bin dirs. Instead, probe well-known Homebrew install locations
 * directly, then fall back to `which` for non-standard installs.
 */
let _terminalNotifierPath: string | false | null = null;

function resolveTerminalNotifier(): string | false {
  if (_terminalNotifierPath === null) {
    // Check well-known Homebrew locations first (ARM + Intel)
    const candidates = [
      "/opt/homebrew/bin/terminal-notifier",    // Apple Silicon Homebrew
      "/usr/local/bin/terminal-notifier",        // Intel Homebrew
    ];

    for (const p of candidates) {
      if (existsSync(p)) {
        _terminalNotifierPath = p;
        return _terminalNotifierPath;
      }
    }

    // Fall back to `which` for custom installs (nix, macports, etc.)
    try {
      _terminalNotifierPath = execSync("which terminal-notifier", {
        stdio: "pipe", timeout: 3000,
      }).toString().trim();
    } catch {
      _terminalNotifierPath = false;
    }
  }
  return _terminalNotifierPath;
}

function escapeShell(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Direct notification via terminal-notifier or osascript (no queue) */
function notifyFallback(title: string, message: string, url?: string): void {
  try {
    const tnPath = resolveTerminalNotifier();
    if (tnPath) {
      const args = [
        `-title "rt"`,
        `-subtitle ${escapeShell(title)}`,
        `-message ${escapeShell(message)}`,
        `-group "rt"`,
      ];
      if (url) args.push(`-open ${escapeShell(url)}`);
      execSync(`${escapeShell(tnPath)} ${args.join(" ")}`, { stdio: "pipe", timeout: 5000 });
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

// ─── Main notification dispatch ──────────────────────────────────────────────

/**
 * Queue a notification, persist it, and attempt to push to the tray app.
 * Falls back to terminal-notifier/osascript if no tray app is available.
 */
export function notify(
  title: string,
  message: string,
  url?: string,
  category: string = "general",
): void {
  const event: NotificationEvent = {
    id: crypto.randomUUID(),
    title,
    message,
    url,
    category,
    timestamp: Date.now(),
  };

  // 1. Queue + persist
  notificationQueue.push(event);
  flushQueue();

  // 1b. Broadcast to WebSocket clients
  if (_broadcastHook) _broadcastHook("notification", event);

  // 2. Try to push to tray app (async, fire-and-forget)
  pushToTray(event).then(pushed => {
    if (!pushed) {
      // Tray unavailable — if no tray.sock exists at all, this is likely
      // a setup without the tray app. Use the CLI fallback after a short delay
      // to give the tray a chance to come online.
      setTimeout(() => {
        const stillQueued = notificationQueue.find(n => n.id === event.id);
        if (stillQueued) {
          // Still not drained — remove from queue and use fallback
          const idx = notificationQueue.findIndex(n => n.id === event.id);
          if (idx !== -1) notificationQueue.splice(idx, 1);
          flushQueue();
          notifyFallback(title, message, url);
        }
      }, 10_000);
    }
  }).catch(() => {
    // Push errored — fallback immediately
    const idx = notificationQueue.findIndex(n => n.id === event.id);
    if (idx !== -1) notificationQueue.splice(idx, 1);
    flushQueue();
    notifyFallback(title, message, url);
  });
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
    // If the MR slot is null we have no fresh data — skipping prevents
    // false "transition" detection that would clear the fired key set.
    if (!entry.mr) continue;

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
        log(`notify: MR merged on ${branch} [was=${was.mrState} now=${now.mrState}]`);
        if (isEnabled(prefs, "mr_merged")) notify("MR Merged 🎉", branchShort, mrUrl, "mr_merged");
      } else {
        log(`notify: suppressed duplicate MR merged on ${branch}`);
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
        log(`notify: pipeline failed on ${branch} [was=${was.pipelineStatus} now=${now.pipelineStatus}]`);
        if (isEnabled(prefs, "pipeline_failed")) notify("Pipeline Failed", branchShort, mrUrl, "pipeline_failed");
      } else {
        log(`notify: suppressed duplicate pipeline_failed on ${branch}`);
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
        log(`notify: pipeline passed on ${branch} [was=${was.pipelineStatus} now=${now.pipelineStatus}]`);
        if (isEnabled(prefs, "pipeline_passed")) notify("Pipeline Passed ✓", branchShort, mrUrl, "pipeline_passed");
      } else {
        log(`notify: suppressed duplicate pipeline_passed on ${branch}`);
      }
    }

    // MR approved (was not approved → now approved)
    if (!was.approved && now.approved) {
      const key = `mr:approved:${branch}`;
      if (!fired.has(key)) {
        fired.add(key);
        log(`notify: MR approved on ${branch} [was=${was.approved} now=${now.approved}]`);
        if (isEnabled(prefs, "mr_approved")) notify("MR Approved 👍", branchShort, mrUrl, "mr_approved");
      } else {
        log(`notify: suppressed duplicate mr_approved on ${branch}`);
      }
    }

    // Merge conflicts appeared
    if (!was.conflicts && now.conflicts) {
      const key = `mr:conflicts:${branch}`;
      if (!fired.has(key)) {
        fired.add(key);
        log(`notify: merge conflicts on ${branch} [was=${was.conflicts} now=${now.conflicts}]`);
        if (isEnabled(prefs, "merge_conflicts")) notify("Merge Conflicts", branchShort, mrUrl, "merge_conflicts");
      } else {
        log(`notify: suppressed duplicate merge_conflicts on ${branch}`);
      }
    }

    // MR ready to merge (all blockers cleared)
    if (!was.isReady && now.isReady) {
      const key = `mr:ready:${branch}`;
      if (!fired.has(key)) {
        fired.add(key);
        log(`notify: MR ready to merge on ${branch} [was=${was.isReady} now=${now.isReady}]`);
        if (isEnabled(prefs, "mr_ready")) notify("Ready to Merge ✓", branchShort, mrUrl, "mr_ready");
      } else {
        log(`notify: suppressed duplicate mr_ready on ${branch}`);
      }
    }

    // Needs rebase (branch fell behind target)
    if (!was.needsRebase && now.needsRebase) {
      const key = `mr:rebase:${branch}`;
      if (!fired.has(key)) {
        fired.add(key);
        log(`notify: needs rebase on ${branch} [was=${was.needsRebase} now=${now.needsRebase}]`);
        if (isEnabled(prefs, "needs_rebase")) notify("Needs Rebase", branchShort, mrUrl, "needs_rebase");
      } else {
        log(`notify: suppressed duplicate needs_rebase on ${branch}`);
      }
    }

    // Merge error (auto-merge or merge train failed)
    if (!was.mergeError && now.mergeError) {
      const key = `mr:merge_error:${branch}`;
      if (!fired.has(key)) {
        fired.add(key);
        log(`notify: merge error on ${branch}: ${now.mergeError} [was=${was.mergeError}]`);
        if (isEnabled(prefs, "merge_error")) notify("Merge Error", `${branchShort}: ${now.mergeError}`, mrUrl, "merge_error");
      } else {
        log(`notify: suppressed duplicate merge_error on ${branch}`);
      }
    }

    // Clear fired keys when state changes back (so we can re-notify on next transition).
    // Log every clear so over-notification can be traced.
    if (was.pipelineStatus === "failed" && now.pipelineStatus !== "failed") {
      if (fired.delete(`pipeline:failed:${branch}`))
        log(`notify: cleared pipeline:failed key for ${branch} (pipeline now ${now.pipelineStatus})`);
    }
    if (was.pipelineStatus === "success" && now.pipelineStatus !== "success") {
      if (fired.delete(`pipeline:success:${branch}`))
        log(`notify: cleared pipeline:success key for ${branch} (pipeline now ${now.pipelineStatus})`);
    }
    if (was.approved && !now.approved) {
      if (fired.delete(`mr:approved:${branch}`))
        log(`notify: cleared mr:approved key for ${branch}`);
    }
    if (was.conflicts && !now.conflicts) {
      if (fired.delete(`mr:conflicts:${branch}`))
        log(`notify: cleared mr:conflicts key for ${branch}`);
    }
    if (was.isReady && !now.isReady) {
      if (fired.delete(`mr:ready:${branch}`))
        log(`notify: cleared mr:ready key for ${branch}`);
    }
    if (was.needsRebase && !now.needsRebase) {
      if (fired.delete(`mr:rebase:${branch}`))
        log(`notify: cleared mr:rebase key for ${branch}`);
    }
    if (was.mergeError && !now.mergeError) {
      if (fired.delete(`mr:merge_error:${branch}`))
        log(`notify: cleared mr:merge_error key for ${branch}`);
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
          undefined,
          "stale_port",
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

  // Update state with current snapshots.
  // When entry.mr is null (API failure or branch has no MR), keep the
  // previous snapshot so we don't wipe conflict/approval state that the
  // dedup logic depends on.
  const newBranches: Record<string, BranchSnapshot> = {};
  for (const [branch, entry] of Object.entries(cacheEntries)) {
    if (!entry.mr && state.branches[branch]) {
      newBranches[branch] = state.branches[branch]!;
    } else {
      newBranches[branch] = snapshotBranch(entry);
    }
  }

  state.branches = newBranches;
  state.fired = [...fired];
  saveState(state);
}
