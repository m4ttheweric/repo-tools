/**
 * Smart notification engine for the rt daemon.
 *
 * Compares current cache state against the previous snapshot to detect
 * transitions (pipeline failures, MR approvals, etc.) and dispatches
 * notifications via a durable queue.
 *
 * Notification flow:
 *  1. Transition detected → event queued in memory + persisted to disk
 *  2. Push attempt to mattstack.app via ~/.mattstack/rt/tray.sock (instant delivery)
 *  3. If tray is unavailable → event stays in queue for later drain
 *  4. Fallback: if no tray.sock exists, shell out to osascript
 *  5. Tray app can drain pending queue via drainNotifications() on startup
 *
 * Called at the end of each daemon cache refresh cycle.
 *
 * R031: the only real module-scope singleton state here is the broadcast
 * hook and the (test-only) fallback-notifier path: everything else
 * (branch/port snapshots, the fired-key ledger, the notification queue)
 * already lives in state.db, not in this module. Both are held by
 * `createNotifier(deps)`; the free functions below delegate to one
 * lazily-created default instance, so every existing caller keeps sharing
 * the state it always has.
 */

import { existsSync } from "fs";
import { join } from "path";
import { isTransitionalMergeStatus } from "@mattstack/glance";
import { RT_DIR } from "./daemon-config.ts";
import { getSetting } from "./settings/resolve.ts";
import { setSetting } from "./settings/write.ts";
import { parseEtimeMs, type PortEntry } from "./port-scanner.ts";
import type { SystemProcess } from "./daemon/system-process-scanner.ts";
import { agentSessionPids } from "./daemon/worktree-process-kill.ts";
import { lazyChildLogger } from "./daemon-logger.ts";
import { repoLabel } from "./repo-label.ts";
import { branchOf } from "./state/branch-cache.ts";
import { numericUserId } from "./enrich.ts";
import {
  getNotifierStateBlob,
  setNotifierStateBlob,
  enqueueNotification,
  drainNotificationQueue,
  peekNotificationQueue,
  isNotificationQueued,
  removeQueuedNotification,
  type NotificationEvent,
} from "./state/index.ts";
const log = lazyChildLogger("notifier");

// ─── Types ───────────────────────────────────────────────────────────────────

interface BranchSnapshot {
  pipelineStatus: string | null;
  mrState: string | null;
  approved: boolean;
  approvedByUserIds: number[];
  conflicts: boolean;
  /**
   * Consecutive observations that reported no conflict, carried forward from
   * the previous snapshot. Zero whenever conflicts are present.
   * See shouldRearmConflicts.
   */
  conflictFreeStreak: number;
  needsRebase: boolean;
  isReady: boolean;
  mergeError: string | null;
  /** GitLab detailed_merge_status (e.g. "mergeable", "unchecked", "not_approved"). */
  statusDetail: string | null;
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

export type { NotificationEvent };

// ─── Config ──────────────────────────────────────────────────────────────────

const TRAY_SOCK_PATH = join(RT_DIR, "tray.sock");

const STALE_PORT_THRESHOLD_MS = 6 * 60 * 60 * 1000; // 6 hours

// ─── Notification type registry ──────────────────────────────────────────────

/**
 * Persisted preference key (see NOTIFICATION_TYPES) and event.category for
 * chat mentions. The string value, not this identifier, is the contract:
 * users who disabled chat notifications have it stored on disk as
 * `{"chat_mention": false}` — changing the value here silently re-enables
 * their preference.
 */
export const CHAT_NOTIFICATION_CATEGORY = "chat_mention";

export const NOTIFICATION_TYPES = [
  { key: "pipeline_failed",   label: "Pipeline failed",     description: "When a running pipeline fails" },
  { key: "pipeline_passed",   label: "Pipeline passed",     description: "When a running pipeline succeeds" },
  { key: "mr_approved",       label: "MR approved",         description: "When your MR gets fully approved" },
  { key: "mr_merged",         label: "MR merged",           description: "When your MR is merged" },
  { key: "mr_closed",         label: "MR closed",           description: "When your MR is closed without merging" },
  { key: "mr_ready",          label: "MR ready to merge",   description: "When all blockers are cleared" },
  { key: "merge_conflicts",   label: "Merge conflicts",     description: "When merge conflicts appear on your MR" },
  { key: "needs_rebase",      label: "Needs rebase",        description: "When GitLab requires a rebase before your MR can merge" },
  { key: "merge_error",       label: "Merge error",         description: "When auto-merge or merge train fails" },
  { key: "new_comment",       label: "New comment",         description: "When someone comments on an MR you're tracking" },
  { key: "stale_port",        label: "Stale processes",     description: "When a dev server has been running 6h+" },
  { key: "runaway_process",   label: "Runaway processes",   description: "When a process is pegged at high CPU for 5+ minutes" },
  { key: "evidence_batch_ready", label: "Evidence batch ready", description: "All evidence requests for a branch settled; captures await review" },
  { key: "evidence_failed",      label: "Evidence capture failed", description: "A queued evidence capture failed in the sandbox" },
  { key: CHAT_NOTIFICATION_CATEGORY, label: "Chat mention", description: "When an agent mentions you in a chat room" },
] as const;

export type NotificationPrefs = Record<string, boolean>;

export function loadNotificationPrefs(): NotificationPrefs {
  const defaults: NotificationPrefs = {};
  for (const t of NOTIFICATION_TYPES) defaults[t.key] = true;

  // A resolver throw (e.g. an unexpandable ${...} variable authored into the
  // store by hand) must degrade to the same all-enabled default a missing or
  // corrupt file gave today — this fires on every notify() call, so it can
  // never be allowed to crash the daemon's transition loop.
  try {
    const stored = getSetting<NotificationPrefs | undefined>("rt.notifications").value;
    return stored ? { ...defaults, ...stored } : defaults;
  } catch {
    return defaults;
  }
}

export function saveNotificationPrefs(prefs: NotificationPrefs): void {
  setSetting("rt.notifications", prefs, "user");
}

function isEnabled(prefs: NotificationPrefs, key: string): boolean {
  return prefs[key] !== false; // default to enabled if not set
}

// ─── State persistence ───────────────────────────────────────────────────────
//
// The kv blob (ns='notifier', k='state') — one read + one write per
// checkAndNotify() cycle, exactly as the old notifier-state.json rhythm
// (RT-48 "Store-by-store" item 4). Cache write: shared warn-and-defer, not
// the queue's bounded retry.

function loadState(): NotifierState {
  return getNotifierStateBlob<NotifierState>({ branches: {}, ports: {}, fired: [] });
}

function saveState(state: NotifierState): void {
  setNotifierStateBlob(state);
}

// ─── Notification queue (durable) ────────────────────────────────────────────
//
// The notify_queue TABLE IS the queue (RT-48 "Store-by-store" item 4) — no
// in-memory array, nothing loaded at module scope. Every mutation goes
// through lib/state/notifier-store.ts, which retries bounded-and-logs
// instead of warn-and-defer: a dropped queue write here loses a
// notification permanently (see that module's doc).

/**
 * Drain all pending notifications. Called by the tray app on startup
 * and by the daemon's /notifications endpoint.
 * Returns the events and clears the queue.
 */
export function drainNotifications(): NotificationEvent[] {
  return drainNotificationQueue();
}

/**
 * Peek at pending notifications without draining.
 */
export function peekNotifications(): NotificationEvent[] {
  return peekNotificationQueue();
}

// ─── Push to tray app ────────────────────────────────────────────────────────

/**
 * removeQueuedNotification's own write already retries on SQLITE_BUSY (3 x
 * 20ms, lib/state/notifier-store.ts) and gives up silently. When that
 * happens after a successful tray push, the row stays queued and the next
 * drainNotifications()/peekNotifications() redelivers it as a duplicate.
 * Retry the removal at this layer, bounded, before reporting success.
 */
async function removeFromQueueWithRetry(
  eventId: string,
  attempts = 3,
  delayMs = 50,
  removeFn: (id: string) => void = removeQueuedNotification,
  isQueuedFn: (id: string) => boolean = isNotificationQueued,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    removeFn(eventId);
    if (!isQueuedFn(eventId)) return true;
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  log.warn({ eventId }, "notification queue removal kept failing after a successful push; it may redeliver on the next drain");
  return false;
}

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
      await removeFromQueueWithRetry(event.id);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ─── Fallback dispatch (osascript) ────────────────────────────────────────

/** Escape for embedding inside an AppleScript double-quoted string literal. */
function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** How long a fallback notifier child may run before SIGTERM, then SIGKILL. */
const FALLBACK_TERM_MS = 5000;
const FALLBACK_KILL_MS = 7000;

// ─── Branch transition detection (pure helpers) ──────────────────────────────

interface CacheEntry {
  ticket: any;
  linearId: string;
  mr: any;
  fetchedAt: number;
}

function approvedByUserIds(entry: CacheEntry): number[] {
  const approvers = entry.mr?.reviews?.approvedBy;
  if (!Array.isArray(approvers)) return [];
  return approvers
    .map((u) => numericUserId(u?.id))
    .filter((id): id is number => id !== null);
}

/**
 * Whether the current user authored this MR. Branches enter the cache because
 * they're checked out locally — which includes teammates' branches pulled down
 * for review. Their pipeline/MR-state transitions must never notify. Strict: if
 * the current user id can't be resolved, treat the MR as not-ours (suppress)
 * rather than risk resurfacing other people's alerts.
 */
function isSelfAuthored(entry: CacheEntry, currentUserId: number | null): boolean {
  if (currentUserId === null) return false;
  const authorId = numericUserId(entry.mr?.author?.id);
  return authorId !== null && authorId === currentUserId;
}

/**
 * How many consecutive observations must report "no conflict" before we
 * believe the conflict is gone and re-arm the alert. GitLab's conflict answer
 * is an OR of three async signals that drop together for a single poll cycle
 * while it re-runs its merge checks; taking that at face value re-armed the
 * alert and re-fired it on the next cycle, 91 times on one MR. One stable
 * repeat is enough to tell a blink from a resolution, and the cost of being
 * wrong is only that a genuine re-conflict notifies one cycle late.
 */
const CONFLICT_FREE_OBSERVATIONS_TO_REARM = 2;

/**
 * Strict readiness for notification purposes: the MR is open, GitLab has
 * *settled* on "mergeable", and approvals are satisfied. This deliberately
 * ignores the SDK's optimistic `entry.mr.isReady`, which reports true during
 * transitional merge-status windows even for unreviewed MRs — the source of
 * repeated false "Ready to Merge" alerts.
 */
function isReadyForNotification(entry: CacheEntry): boolean {
  return entry.mr?.state === "opened"
    && entry.mr?.statusDetail === "mergeable"
    && !(entry.mr?.blockers?.awaitingApprovals ?? true)
    && entry.mr?.isStacked !== true;
}

function snapshotBranch(entry: CacheEntry, prev?: BranchSnapshot): BranchSnapshot {
  const conflicts = entry.mr?.blockers?.hasConflicts ?? false;
  return {
    pipelineStatus: entry.mr?.pipeline?.status ?? null,
    mrState: entry.mr?.state ?? null,
    approved: entry.mr?.reviews?.isApproved ?? false,
    approvedByUserIds: approvedByUserIds(entry),
    conflicts,
    conflictFreeStreak: conflicts ? 0 : (prev?.conflictFreeStreak ?? 0) + 1,
    needsRebase: entry.mr?.blockers?.needsRebase ?? false,
    isReady: isReadyForNotification(entry),
    mergeError: entry.mr?.blockers?.mergeError ?? null,
    statusDetail: entry.mr?.statusDetail ?? null,
  };
}

/**
 * Whether to re-arm the "ready to merge" alert (clear its fired key) after
 * readiness was lost. Only re-arm on a *genuine* regression — not while GitLab
 * is transiently re-checking. Re-arming on transient flaps is what caused the
 * same MR to re-notify every few minutes.
 */
function shouldRearmReady(was: BranchSnapshot, now: BranchSnapshot): boolean {
  if (!was.isReady || now.isReady) return false;
  return !isTransitionalMergeStatus(now.statusDetail);
}

/**
 * Whether to re-arm the "merge conflicts" alert. Same shape as
 * shouldRearmReady, with one addition: a settled non-conflict status is not
 * enough on its own. The MRs that flapped worst sat at a settled
 * `not_approved` the whole time, and their conflict came from the CONFLICT
 * mergeability check rather than from `detailedMergeStatus`, so a
 * transitional-status test alone would not have caught the blink. Require the
 * negative to hold across observations before believing it.
 */
function shouldRearmConflicts(was: BranchSnapshot, now: BranchSnapshot): boolean {
  if (!was.conflicts || now.conflicts) return false;
  if (isTransitionalMergeStatus(now.statusDetail)) return false;
  return now.conflictFreeStreak >= CONFLICT_FREE_OBSERVATIONS_TO_REARM;
}

type ApprovalTransitionVerdict = "notify" | "not-transition" | "no-new-approver" | "self-approved";

function shouldNotifyApprovalTransition(
  was: BranchSnapshot,
  now: BranchSnapshot,
  currentUserId: number | null,
): ApprovalTransitionVerdict {
  if (was.approved || !now.approved) return "not-transition";

  // Require a human approval to have actually landed: some approver present
  // now that wasn't before. A bare flag flip (approval-rule change, GitLab
  // flap, vacuously-approved stack MR) with no new approver is not news.
  const previousApprovers = new Set(was.approvedByUserIds ?? []);
  const grew = (now.approvedByUserIds ?? []).some((id) => !previousApprovers.has(id));
  if (!grew) return "no-new-approver";

  if (currentUserId === null) return "notify";

  const selfNewlyApproved = (now.approvedByUserIds ?? []).includes(currentUserId)
    && !previousApprovers.has(currentUserId);

  return selfNewlyApproved ? "self-approved" : "notify";
}

/**
 * Every transition kind that produces a `fired` key. Shared by
 * `firedKey` (creation, throughout detectBranchTransitions) and
 * `pruneFiredForEvictedBranches` (hygiene, at the checkAndNotify cycle
 * tail) so the two never drift apart into two different key formats.
 */
const TRANSITION_KINDS = [
  "mr:merged",
  "mr:closed",
  "pipeline:failed",
  "pipeline:success",
  "mr:approved",
  "mr:conflicts",
  "mr:ready",
  "mr:rebase",
  "mr:merge_error",
] as const;
type TransitionKind = (typeof TRANSITION_KINDS)[number];

/** The one place a fired key is built (spec "Store-by-store" item 4: "the same key-construction helper the notifier uses to CREATE fired keys"). */
function firedKey(kind: TransitionKind, branch: string): string {
  return `${kind}:${branch}`;
}

/**
 * Drops `fired` keys belonging to branches with no branch-cache entry this
 * cycle (review r1 finding 11): a branch-cache GC eviction must not leak a
 * stale fired key that would suppress a real notification if the branch
 * ever returns. Membership is computed by FORWARD construction — building
 * every possible key for every still-live branch with the same `firedKey`
 * helper used to create them — never by parsing a stored key string apart
 * to recover its branch (spec: "no string parsing of key formats").
 */
function pruneFiredForEvictedBranches(fired: Set<string>, liveBranches: Iterable<string>): void {
  const live = new Set<string>();
  for (const branch of liveBranches) {
    for (const kind of TRANSITION_KINDS) live.add(firedKey(kind, branch));
  }
  for (const key of fired) {
    if (!live.has(key)) fired.delete(key);
  }
}

// ─── Notifier factory (R031: the module-scope singleton, isolated) ──────────

export interface NotifierDeps {
  /** Registered up front instead of via a later onNotification() call, if known at construction time. */
  broadcast?: (type: string, data: any) => void;
}

export interface Notifier {
  /** Register a callback to broadcast notification events (e.g. to WebSocket clients) */
  onNotification(hook: (type: string, data: any) => void): void;
  /** Queue a notification, persist it, and attempt to push to the tray app. Falls back to osascript if no tray app is available. */
  notify(title: string, message: string, url?: string, category?: string, pids?: number[], id?: string): void;
  /**
   * notify() gated on the user's preference for `category`, loading prefs per
   * call. For emitters outside the transition loop (which loads prefs once per
   * cycle). Every notification rt delivers goes through notify(), so it lands in
   * the durable queue, reaches the tray socket, and falls back to the CLI
   * notifier — a bare broadcast reaches WebSocket clients only.
   */
  notifyEnabled(category: string, title: string, message: string, url?: string, pids?: number[], id?: string): void;
  checkAndNotify(cacheEntries: Record<string, CacheEntry>, ports?: PortEntry[], currentUserId?: number | null): void;
  checkRunawayProcesses(
    processes: SystemProcess[],
    markNotified: (pid: number) => void,
    isNotified: (pid: number) => boolean,
  ): void;
  drainNotifications(): NotificationEvent[];
  peekNotifications(): NotificationEvent[];
}

/** Shape `notify` and every function that calls it (through `api.notify`) share. */
type NotifyFn = (
  title: string,
  message: string,
  url?: string,
  category?: string,
  pids?: number[],
  id?: string,
) => void;

/**
 * R031: `checkAndNotify`/`checkRunawayProcesses`/`notifyEnabled` call
 * `api.notify(...)`, a property lookup on this instance's own `api` object
 * at call time, and `detectBranchTransitions`/`detectStalePortTransitions`
 * take that same `api.notify` in as an explicit `notifyFn` parameter rather
 * than reaching for a shared identifier. So every method on one
 * `createNotifier(deps)` instance is bound to that instance's own
 * `broadcastHook`/`fallbackNotifierPath`: see the isolation test in
 * `lib/__tests__/notifier.test.ts` ("two instances route ... through their
 * own broadcast hook").
 *
 * The only state isolated per instance is the broadcast hook and the
 * (test-only) fallback-notifier executable path: every other *input*
 * (prefs, branch/port snapshots, the durable queue) already lives in
 * state.db, shared across the whole process regardless of which instance
 * reads it; but which hook a given instance's own notify() call fires is
 * fully isolated.
 */
export function createNotifier(deps: NotifierDeps = {}): Notifier {
  let broadcastHook: ((type: string, data: any) => void) | null = deps.broadcast ?? null;
  /** Fallback notifier executable; replaceable in tests with a fake that hangs. */
  let fallbackNotifierPath = "osascript";

  function onNotification(hook: (type: string, data: any) => void): void {
    broadcastHook = hook;
  }

  /** Direct notification via osascript (no queue).
   *  argv-array spawning — message content includes branch names and error
   *  text, which must never pass through a shell ($, backticks, quotes).
   *
   *  Fire-and-forget async spawn, never a sync exec: this runs on the daemon's
   *  main thread, and a hung notifier child (osascript blocked on Notification
   *  Center/TCC from the launchd context) must not block the event loop.
   *  Bun's sync-exec `timeout` only SIGTERMs and then waits the child out, so
   *  a SIGTERM-immune child wedged every API/socket surface for the child's
   *  lifetime (MAT-222). The kill escalation here is the bound the sync
   *  timeout could not provide. */
  function notifyFallback(title: string, message: string, _url?: string): void {
    const body = `${title}: ${message}`;
    const argv = [fallbackNotifierPath, "-e", `display notification "${escapeAppleScript(body)}" with title "rt"`];
    try {
      const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      const term = setTimeout(() => { try { proc.kill("SIGTERM"); } catch { /* already exited */ } }, FALLBACK_TERM_MS);
      const kill = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* already exited */ } }, FALLBACK_KILL_MS);
      void proc.exited.finally(() => { clearTimeout(term); clearTimeout(kill); });
    } catch { /* notification is best-effort */ }
  }

  function notify(
    title: string,
    message: string,
    url?: string,
    category: string = "general",
    pids?: number[],
    id?: string,
  ): void {
    const event: NotificationEvent = {
      id: id ?? crypto.randomUUID(),
      title,
      message,
      url,
      category,
      timestamp: Date.now(),
      pids,
    };

    // 1. Queue + persist
    enqueueNotification(event);

    // 1b. Broadcast to WebSocket clients
    if (broadcastHook) broadcastHook("notification", event);

    // 2. Try to push to tray app (async, fire-and-forget)
    pushToTray(event).then(pushed => {
      if (!pushed) {
        // Tray unavailable — if no tray.sock exists at all, this is likely
        // a setup without the tray app. Use the CLI fallback after a short delay
        // to give the tray a chance to come online.
        setTimeout(() => {
          if (isNotificationQueued(event.id)) {
            // Still not drained — remove from queue and use fallback
            removeQueuedNotification(event.id);
            notifyFallback(title, message, url);
          }
        }, 10_000);
      }
    });
    // (No .catch needed: pushToTray's body is fully wrapped in try/catch and
    // resolves false on failure — it can never reject.)

    // 3. Optional push to a phone for chat mentions (off by default; v1 is
    // ntfy-only — Pushover needs token/user credentials chat.push.target has
    // nowhere to hold). Fire-and-forget: the desk notification above already
    // queued successfully, so a rejected fetch here must not undo that.
    if (category === CHAT_NOTIFICATION_CATEGORY) {
      // Optional push is best-effort: nothing under here may sink the desk
      // notification already queued above. The try spans the getSetting() reads
      // (which can throw on an unexpandable stored value) and the synchronous
      // fetch() throw a malformed target URL raises before the promise exists.
      try {
        const provider = getSetting<string>("chat.push.provider").value;
        if (provider === "ntfy") {
          const target = getSetting<string>("chat.push.target").value;
          if (target) {
            // Bound the request so an unresponsive ntfy can't leak a pending
            // fetch forever (the Fetch API has no default timeout).
            const headers: Record<string, string> = { Title: title };
            if (url) headers.Click = url;
            fetch(target, { method: "POST", headers, body: message, signal: AbortSignal.timeout(10_000) })
              .catch(err => log.warn({ err }, "chat push failed"));
          }
        } else if (provider) {
          log.warn(`chat.push.provider "${provider}" is not supported (only "ntfy" is)`);
        }
      } catch (err) {
        log.warn({ err }, "chat push failed");
      }
    }
  }

  /**
   * notify() gated on the user's preference for `category`, loading prefs per
   * call. For emitters outside the transition loop (which loads prefs once per
   * cycle). Every notification rt delivers goes through notify(), so it lands in
   * the durable queue, reaches the tray socket, and falls back to the CLI
   * notifier — a bare broadcast reaches WebSocket clients only.
   */
  function notifyEnabled(
    category: string,
    title: string,
    message: string,
    url?: string,
    pids?: number[],
    id?: string,
  ): void {
    if (!isEnabled(loadNotificationPrefs(), category)) return;
    api.notify(title, message, url, category, pids, id);
  }

  function checkAndNotify(
    cacheEntries: Record<string, CacheEntry>,
    ports?: PortEntry[],
    currentUserId: number | null = null,
  ): void {
    const state = loadState();
    const prefs = loadNotificationPrefs();
    const fired = new Set(state.fired);

    // Branch transitions
    detectBranchTransitions(state.branches, cacheEntries, fired, prefs, currentUserId, api.notify);

    // Port staleness (skipped when called from real-time MR update path)
    if (ports) {
      detectStalePortTransitions(state.ports, ports, prefs, api.notify);
    }

    // Update state with current snapshots.
    // When entry.mr is null (API failure or branch has no MR), keep the
    // previous snapshot so we don't wipe conflict/approval state that the
    // dedup logic depends on.
    const newBranches: Record<string, BranchSnapshot> = {};
    for (const [branch, entry] of Object.entries(cacheEntries)) {
      if (!entry.mr && state.branches[branch]) {
        newBranches[branch] = state.branches[branch]!;
      } else {
        newBranches[branch] = snapshotBranch(entry, state.branches[branch]);
      }
    }

    // fired-ledger hygiene: drop keys for branches the branch-cache no longer
    // carries an entry for (evicted by GC, or never present this cycle) — see
    // pruneFiredForEvictedBranches.
    pruneFiredForEvictedBranches(fired, Object.keys(cacheEntries));

    state.branches = newBranches;
    state.fired = [...fired];
    saveState(state);
  }

  function checkRunawayProcesses(
    processes: SystemProcess[],
    markNotified: (pid: number) => void,
    isNotified: (pid: number) => boolean,
  ): void {
    const prefs = loadNotificationPrefs();
    if (!isEnabled(prefs, "runaway_process")) return;

    // AI agent sessions and their live subprocesses burn CPU as part of normal
    // work — never worth an alert. Deliberately not marked notified: if the
    // agent exits and the orphan is still runaway, it surfaces then.
    const agentPids = agentSessionPids(processes.map(p => ({
      pid: p.pid, ppid: p.ppid, command: p.command, fullCommand: p.fullCommand,
    })));

    const fresh = processes.filter(p =>
      p.isRunaway && !isNotified(p.pid) && !agentPids.has(p.pid),
    );
    if (fresh.length === 0) return;

    if (fresh.length === 1) {
      const proc = fresh[0]!;
      const durationMin = proc.runawayDurationMs
        ? Math.round(proc.runawayDurationMs / 60_000)
        : 0;
      const branchInfo = proc.branch ? ` (branch: ${proc.branch})` : "";

      api.notify(
        "Runaway Process",
        `${proc.packageScript ?? proc.command} in ${repoLabel(proc.repo)}${branchInfo} at ${Math.round(proc.cpuPercent)}% CPU for ${durationMin || "<1"} minutes`,
        undefined,
        "runaway_process",
        [proc.pid],
      );
    } else {
      // A burst of runaways in one tick collapses into a single summary so the
      // user gets one actionable notification instead of a pile.
      const shown = fresh.slice(0, 2).map(p =>
        `${p.packageScript ?? p.command} (${repoLabel(p.repo)} ${Math.round(p.cpuPercent)}%)`,
      );
      const rest = fresh.length - shown.length;
      const summary = rest > 0 ? `${shown.join(", ")}, +${rest} more` : shown.join(", ");

      api.notify(
        `${fresh.length} Runaway Processes`,
        summary,
        undefined,
        "runaway_process",
        fresh.map(p => p.pid),
      );
    }

    for (const proc of fresh) {
      markNotified(proc.pid);
    }
  }

  const api: Notifier & { __setFallbackNotifier(path: string | null): void; __notifyFallback: typeof notifyFallback } = {
    onNotification,
    notify,
    notifyEnabled,
    checkAndNotify,
    checkRunawayProcesses,
    drainNotifications,
    peekNotifications,
    /** Test-only seam; see __test__ below. */
    __setFallbackNotifier(path: string | null): void {
      fallbackNotifierPath = path ?? "osascript";
    },
    /** Test-only seam; see __test__ below. */
    __notifyFallback: notifyFallback,
  };

  return api;
}

// ─── Branch/port transition detection (pure; take the caller's own notify) ──
//
// Neither function holds state of its own (branch/port snapshots and the
// fired-key ledger are threaded through as parameters or read from
// state.db), so they stay top-level and shared across every createNotifier()
// instance. Each takes the CALLING instance's own `notify` (its `api.notify`,
// looked up at call time) as an explicit parameter instead of reaching for a
// shared identifier: that parameterization is what keeps checkAndNotify's
// per-instance routing (see the isolation comment above createNotifier)
// actually isolated.

function detectBranchTransitions(
  prev: Record<string, BranchSnapshot>,
  current: Record<string, CacheEntry>,
  fired: Set<string>,
  prefs: NotificationPrefs,
  currentUserId: number | null,
  notify: NotifyFn,
): void {
  // `branch` is the branch-cache map key (composite `${identity}:${branch}`
  // when attributed, bare otherwise), kept as-is here rather than unwrapped
  // to the bare branch, so `firedKey` and the snapshot map come out
  // repo-scoped for free. `branchOf(branch)` is used only for the
  // human-readable notification text.
  for (const [branch, entry] of Object.entries(current)) {
    // If the MR slot is null we have no fresh data — skipping prevents
    // false "transition" detection that would clear the fired key set.
    if (!entry.mr) continue;

    // Author gate: only the current user's own MRs generate notifications.
    // A teammate's branch checked out for review lands in this cache too; its
    // pipeline failures and state changes must stay silent.
    if (!isSelfAuthored(entry, currentUserId)) continue;

    const was = prev[branch];
    if (!was) continue; // First time seeing this branch — no transition
    const now = snapshotBranch(entry, was);

    const displayBranch = branchOf(branch);
    const branchShort = displayBranch.length > 40 ? displayBranch.slice(0, 39) + "…" : displayBranch;
    const mrUrl = entry.mr?.webUrl ?? undefined;

    // MR merged (opened → merged) — check BEFORE skipping merged MRs
    if (was.mrState === "opened" && now.mrState === "merged") {
      const key = firedKey("mr:merged", branch);
      if (!fired.has(key)) {
        fired.add(key);
        log.info(`MR merged on ${branch} [was=${was.mrState} now=${now.mrState}]`);
        if (isEnabled(prefs, "mr_merged")) notify("MR Merged 🎉", branchShort, mrUrl, "mr_merged");
      } else {
        log.debug(`suppressed duplicate MR merged on ${branch}`);
      }
    }

    // MR closed without merge (opened → closed)
    if (was.mrState === "opened" && now.mrState === "closed") {
      const key = firedKey("mr:closed", branch);
      if (!fired.has(key)) {
        fired.add(key);
        log.info(`MR closed on ${branch} [was=${was.mrState} now=${now.mrState}]`);
        if (isEnabled(prefs, "mr_closed")) notify("MR Closed", branchShort, mrUrl, "mr_closed");
      } else {
        log.debug(`suppressed duplicate MR closed on ${branch}`);
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
      const key = firedKey("pipeline:failed", branch);
      if (!fired.has(key)) {
        fired.add(key);
        log.info(`pipeline failed on ${branch} [was=${was.pipelineStatus} now=${now.pipelineStatus}]`);
        if (isEnabled(prefs, "pipeline_failed")) notify("Pipeline Failed", branchShort, mrUrl, "pipeline_failed");

      } else {
        log.debug(`suppressed duplicate pipeline_failed on ${branch}`);
      }
    }

    // Pipeline: running/pending → success
    if (
      was.pipelineStatus &&
      ["running", "pending", "created"].includes(was.pipelineStatus) &&
      now.pipelineStatus === "success"
    ) {
      const key = firedKey("pipeline:success", branch);
      if (!fired.has(key)) {
        fired.add(key);
        log.info(`pipeline passed on ${branch} [was=${was.pipelineStatus} now=${now.pipelineStatus}]`);
        if (isEnabled(prefs, "pipeline_passed")) notify("Pipeline Passed ✓", branchShort, mrUrl, "pipeline_passed");
      } else {
        log.debug(`suppressed duplicate pipeline_passed on ${branch}`);
      }
    }

    // MR approved (was not approved -> now approved)
    if (!was.approved && now.approved) {
      const key = firedKey("mr:approved", branch);
      if (fired.has(key)) {
        log.debug(`suppressed duplicate mr_approved on ${branch}`);
      } else {
        const verdict = shouldNotifyApprovalTransition(was, now, currentUserId);
        if (verdict === "notify") {
          fired.add(key);
          log.info(`MR approved on ${branch} [was=${was.approved} now=${now.approved}]`);
          if (isEnabled(prefs, "mr_approved")) notify("MR Approved 👍", branchShort, mrUrl, "mr_approved");
        } else {
          log.debug(`suppressed mr_approved on ${branch} (${verdict})`);
        }
      }
    }

    // Merge conflicts appeared
    if (!was.conflicts && now.conflicts) {
      const key = firedKey("mr:conflicts", branch);
      if (!fired.has(key)) {
        fired.add(key);
        log.info(`merge conflicts on ${branch} [was=${was.conflicts} now=${now.conflicts}]`);
        if (isEnabled(prefs, "merge_conflicts")) notify("Merge Conflicts", branchShort, mrUrl, "merge_conflicts");
      } else {
        log.debug(`suppressed duplicate merge_conflicts on ${branch}`);
      }
    }

    // MR ready to merge (all blockers cleared)
    if (!was.isReady && now.isReady) {
      const key = firedKey("mr:ready", branch);
      if (!fired.has(key)) {
        fired.add(key);
        log.info(`MR ready to merge on ${branch} [was=${was.isReady} now=${now.isReady}]`);
        if (isEnabled(prefs, "mr_ready")) notify("Ready to Merge ✓", branchShort, mrUrl, "mr_ready");
      } else {
        log.debug(`suppressed duplicate mr_ready on ${branch}`);
      }
    }

    // Needs rebase: GitLab requires a rebase before this MR can merge.
    // Not "the target branch moved" — glance 0.18 stopped folding behind-ness
    // into this blocker (MAT-164). It now tracks `shouldBeRebased`, which rides
    // the GraphQL payload every fetch path shares, so it no longer flips false
    // on a bulk poll and re-arm the alert for an MR whose state never changed.
    if (!was.needsRebase && now.needsRebase) {
      const key = firedKey("mr:rebase", branch);
      if (!fired.has(key)) {
        fired.add(key);
        log.info(`needs rebase on ${branch} [was=${was.needsRebase} now=${now.needsRebase}]`);
        if (isEnabled(prefs, "needs_rebase")) notify("Needs Rebase", branchShort, mrUrl, "needs_rebase");
      } else {
        log.debug(`suppressed duplicate needs_rebase on ${branch}`);
      }
    }

    // Merge error (auto-merge or merge train failed)
    if (!was.mergeError && now.mergeError) {
      const key = firedKey("mr:merge_error", branch);
      if (!fired.has(key)) {
        fired.add(key);
        log.info(`merge error on ${branch}: ${now.mergeError} [was=${was.mergeError}]`);
        if (isEnabled(prefs, "merge_error")) notify("Merge Error", `${branchShort}: ${now.mergeError}`, mrUrl, "merge_error");
      } else {
        log.debug(`suppressed duplicate merge_error on ${branch}`);
      }
    }

    // Clear fired keys when state changes back (so we can re-notify on next transition).
    // Log every clear so over-notification can be traced.
    if (was.pipelineStatus === "failed" && now.pipelineStatus !== "failed") {
      if (fired.delete(firedKey("pipeline:failed", branch)))
        log.debug(`cleared pipeline:failed key for ${branch} (pipeline now ${now.pipelineStatus})`);
    }
    if (was.pipelineStatus === "success" && now.pipelineStatus !== "success") {
      if (fired.delete(firedKey("pipeline:success", branch)))
        log.debug(`cleared pipeline:success key for ${branch} (pipeline now ${now.pipelineStatus})`);
    }
    if (was.approved && !now.approved) {
      if (fired.delete(firedKey("mr:approved", branch)))
        log.debug(`cleared mr:approved key for ${branch}`);
    }
    if (shouldRearmConflicts(was, now)) {
      if (fired.delete(firedKey("mr:conflicts", branch)))
        log.debug(`cleared mr:conflicts key for ${branch} (statusDetail=${now.statusDetail}, conflict-free x${now.conflictFreeStreak})`);
    } else if (was.conflicts && !now.conflicts) {
      log.debug(`held mr:conflicts key for ${branch} (statusDetail=${now.statusDetail}, conflict-free x${now.conflictFreeStreak})`);
    }
    if (shouldRearmReady(was, now)) {
      if (fired.delete(firedKey("mr:ready", branch)))
        log.debug(`cleared mr:ready key for ${branch} (statusDetail=${now.statusDetail})`);
    }
    if (was.needsRebase && !now.needsRebase) {
      if (fired.delete(firedKey("mr:rebase", branch)))
        log.debug(`cleared mr:rebase key for ${branch}`);
    }
    if (was.mergeError && !now.mergeError) {
      if (fired.delete(firedKey("mr:merge_error", branch)))
        log.debug(`cleared mr:merge_error key for ${branch}`);
    }
  }
}

function detectStalePortTransitions(
  portState: Record<string, PortSnapshot>,
  currentPorts: PortEntry[],
  prefs: NotificationPrefs,
  notify: NotifyFn,
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
    // The process's own clock, not ours. `firstSeen` only says when the daemon
    // noticed it, which understates anything that predates the notifier state
    // and makes the "has been running Nh" figure in the message untrue.
    const age = parseEtimeMs(entry.uptime) ?? now - snapshot.firstSeen;

    if (age > STALE_PORT_THRESHOLD_MS && !snapshot.staleNotified) {
      snapshot.staleNotified = true;
      const hours = Math.round(age / (60 * 60 * 1000));
      log.info(`stale port ${entry.command} on :${entry.port} (${hours}h)`);
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

// ─── Default instance + free-function wrappers (unchanged call surface) ────

let defaultNotifier: ReturnType<typeof createNotifier> | null = null;

function getDefaultNotifier() {
  return defaultNotifier ??= createNotifier();
}

export function checkRunawayProcesses(
  processes: SystemProcess[],
  markNotified: (pid: number) => void,
  isNotified: (pid: number) => boolean,
): void {
  getDefaultNotifier().checkRunawayProcesses(processes, markNotified, isNotified);
}

export function checkAndNotify(
  cacheEntries: Record<string, CacheEntry>,
  ports?: PortEntry[],
  currentUserId: number | null = null,
): void {
  getDefaultNotifier().checkAndNotify(cacheEntries, ports, currentUserId);
}

/** Register a callback to broadcast notification events (e.g. to WebSocket clients) */
export function onNotification(hook: (type: string, data: any) => void): void {
  getDefaultNotifier().onNotification(hook);
}

/**
 * Queue a notification, persist it, and attempt to push to the tray app.
 * Falls back to osascript if no tray app is available.
 */
export function notify(
  title: string,
  message: string,
  url?: string,
  category: string = "general",
  pids?: number[],
  id?: string,
): void {
  getDefaultNotifier().notify(title, message, url, category, pids, id);
}

/**
 * notify() gated on the user's preference for `category`, loading prefs per
 * call. For emitters outside the transition loop (which loads prefs once per
 * cycle). Every notification rt delivers goes through notify(), so it lands in
 * the durable queue, reaches the tray socket, and falls back to the CLI
 * notifier — a bare broadcast reaches WebSocket clients only.
 */
export function notifyEnabled(
  category: string,
  title: string,
  message: string,
  url?: string,
  pids?: number[],
  id?: string,
): void {
  getDefaultNotifier().notifyEnabled(category, title, message, url, pids, id);
}

export const __test__ = {
  shouldNotifyApprovalTransition,
  snapshotBranch,
  shouldRearmReady,
  shouldRearmConflicts,
  isSelfAuthored,
  notifyFallback(title: string, message: string, url?: string): void {
    (getDefaultNotifier() as any).__notifyFallback(title, message, url);
  },
  firedKey,
  pruneFiredForEvictedBranches,
  removeFromQueueWithRetry,
  setFallbackNotifier(path: string | null): void {
    (getDefaultNotifier() as any).__setFallbackNotifier(path);
  },
  /**
   * The lazily-created default Notifier instance, for tests that need to
   * spy on its `notify` (or another method) directly. Spying on the
   * top-level `export function notify` would only replace that export's
   * own binding: checkAndNotify/checkRunawayProcesses call `api.notify`
   * on THIS object, so this is the thing to spy on to intercept them.
   */
  getDefaultNotifier,
};
