/**
 * Daemon client — thin IPC layer for CLI → daemon communication.
 *
 * Uses HTTP over Unix socket (Bun.serve on the daemon side).
 * Gracefully degrades when daemon is not installed or not running:
 *  - Not installed → returns null silently
 *  - Installed but down → attempts launchctl restart, warns if that fails
 */

import { existsSync } from "fs";
import {
  isDaemonInstalled,
  getDaemonConfig,
  DAEMON_SOCK_PATH,
  TRAY_SOCK_PATH,
  API_PORT,
} from "./daemon-config.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DaemonResponse {
  ok: boolean;
  data?: any;
  error?: string;
}

// ─── HTTP over Unix socket ───────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 2000;

let _lastQueryWasRefused = false;
let _lastQueryTimedOut   = false;

async function trySocketQuery(
  cmd: string,
  payload?: Record<string, any>,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<DaemonResponse | null> {
  if (!existsSync(DAEMON_SOCK_PATH)) return null;

  try {
    const hasBody = payload && Object.keys(payload).length > 0;

    const response = await fetch(`http://localhost/${cmd}`, {
      unix: DAEMON_SOCK_PATH,
      method: hasBody ? "POST" : "GET",
      headers: hasBody ? { "Content-Type": "application/json" } : undefined,
      body: hasBody ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    } as any);

    _lastQueryWasRefused = false;
    _lastQueryTimedOut   = false;
    return (await response.json()) as DaemonResponse;
  } catch (err) {
    const code = (err as any)?.code ?? "";
    const name = (err as any)?.name ?? "";
    const msg  = err instanceof Error ? err.message : "";
    _lastQueryWasRefused = code === "ECONNREFUSED" || msg.includes("ECONNREFUSED") || msg.includes("Connection refused");
    _lastQueryTimedOut   = name === "TimeoutError" || name === "AbortError" || msg.includes("timed out");
    return null;
  }
}

// ─── Tray socket query ──────────────────────────────────────────────────────

export async function trayQuery(
  endpoint: string,
  method: "GET" | "POST" = "POST",
): Promise<DaemonResponse | null> {
  if (!existsSync(TRAY_SOCK_PATH)) return null;

  try {
    const response = await fetch(`http://localhost${endpoint}`, {
      unix: TRAY_SOCK_PATH,
      method,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    } as any);

    return (await response.json()) as DaemonResponse;
  } catch {
    return null;
  }
}

// ─── Auto-recovery ───────────────────────────────────────────────────────────

let hasWarnedThisSession = false;
let _warningSuppressed = false;

function attemptRestart(): boolean {
  try {
    const config = getDaemonConfig();
    if (!config) return false;

    // Ask the tray app to start the daemon (fire-and-forget)
    trayQuery("/daemon/start", "POST");
    return true;
  } catch {
    return false;
  }
}

function warnDaemonDown(): void {
  if (hasWarnedThisSession || _warningSuppressed) return;
  hasWarnedThisSession = true;
  console.error(
    "  \x1b[33m⚠\x1b[0m rt daemon is installed but not running. Run: \x1b[1mrt daemon start\x1b[0m",
  );
}

/**
 * Disable the stderr "daemon down" warning emitted by `daemonQuery` when it
 * gives up after a failed restart attempt. TUI callers (e.g. the runner) must
 * call this at startup — otherwise the warning bleeds into the rendered
 * canvas as a stuck line because Ink/Rezi never redraw over stderr writes.
 */
export function suppressDaemonDownWarning(): void {
  _warningSuppressed = true;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Send a command to the daemon and return the response.
 *
 * Returns null if daemon is not available (either not installed or not running
 * and can't be auto-restarted). Callers should fall back to direct execution.
 */
export async function daemonQuery(
  cmd: string,
  payload?: Record<string, any>,
  timeoutMs?: number,
): Promise<DaemonResponse | null> {
  // 1. Try HTTP request over Unix socket
  const result = await trySocketQuery(cmd, payload, timeoutMs);
  if (result !== null) return result;

  // 2. Check if user opted in
  if (!isDaemonInstalled()) return null; // not installed → silent fallback

  // 3. If the socket file still exists AND the connection wasn't refused,
  //    the daemon IS running — this query timed out or hit a transient error.
  //    Return null silently. But if the connection was refused, the socket is
  //    stale (daemon died without cleaning up) — fall through to attempt restart.
  if (existsSync(DAEMON_SOCK_PATH) && !_lastQueryWasRefused) return null;

  // 4. Socket is gone → daemon is genuinely not running. Attempt restart.
  const restarted = attemptRestart();
  if (restarted) {
    // Retry once after short delay
    await Bun.sleep(300);
    const retryResult = await trySocketQuery(cmd, payload, timeoutMs);
    if (retryResult !== null) return retryResult;
  }

  // 5. Restart failed → warn (once per session)
  warnDaemonDown();
  return null;
}

/**
 * True if the last `daemonQuery` returned null because the request timed out
 * (as opposed to the daemon being genuinely down). Used by action callers so
 * they can surface "timed out — verify on GitLab" instead of the misleading
 * "daemon unavailable".
 */
export function lastQueryTimedOut(): boolean {
  return _lastQueryTimedOut;
}

/**
 * Quick check: is the daemon reachable right now?
 */
export async function isDaemonRunning(): Promise<boolean> {
  const response = await trySocketQuery("ping");
  return response?.ok === true;
}

// ─── MR action facade ────────────────────────────────────────────────────────

/**
 * JSON-over-IPC mirror of glance-sdk's `MRDashboardActions` bound to a
 * `{repoName, iid}` pair. Each method round-trips through the daemon, which
 * holds the single authoritative GitLabProvider + DashboardGroup and runs the
 * real action against the live group.
 *
 * Errors returned by the daemon (`{ok: false, error}`) and transport-level
 * failures (daemon down) both surface as thrown Errors so callers can handle
 * them uniformly in action-state machinery.
 */
export interface DaemonMRActions {
  merge:            (opts?: any) => Promise<void>;
  rebase:           () => Promise<void>;
  approve:          () => Promise<void>;
  unapprove:        () => Promise<void>;
  setAutoMerge:     () => Promise<void>;
  cancelAutoMerge:  () => Promise<void>;
  retryPipeline:    (pipelineId?: number) => Promise<void>;
  retryJob:         (jobId: number) => Promise<void>;
  toggleDraft:      (isDraft: boolean) => Promise<void>;
  requestReReview:  (userId: number) => Promise<void>;
  fetchJobDetail:   (jobId: number, pipelineId?: number) => Promise<any>;
  fetchJobTrace:    (jobId: number) => Promise<string>;
}

// MR actions hit GitLab through the daemon, so the IPC call must wait out the
// underlying API round-trip. 2s (the default IPC timeout) is too short — a
// real-world merge regularly takes 3–10s and the client would throw
// "daemon unavailable" even though the merge succeeded on the server.
const MR_ACTION_TIMEOUT_MS = 30_000;

export function mrActions(repoName: string, iid: number): DaemonMRActions {
  const fire = async (action: string, args: any[] = []): Promise<void> => {
    const res = await daemonQuery("mr:action", { repoName, iid, action, args }, MR_ACTION_TIMEOUT_MS);
    if (!res) throw new Error(lastQueryTimedOut() ? `${action} timed out — verify on GitLab` : "daemon unavailable");
    if (!res.ok) throw new Error(res.error || `${action} failed`);
  };

  return {
    merge:            (opts) => fire("merge", [opts]),
    rebase:           ()     => fire("rebase"),
    approve:          ()     => fire("approve"),
    unapprove:        ()     => fire("unapprove"),
    setAutoMerge:     ()     => fire("setAutoMerge"),
    cancelAutoMerge:  ()     => fire("cancelAutoMerge"),
    retryPipeline:    (id)   => fire("retryPipeline", [id]),
    retryJob:         (id)   => fire("retryJob", [id]),
    toggleDraft:      (d)    => fire("toggleDraft", [d]),
    requestReReview:  (uid)  => fire("requestReReview", [uid]),

    fetchJobDetail: async (jobId, pipelineId) => {
      const res = await daemonQuery("mr:fetch-job-detail", { repoName, iid, jobId, pipelineId }, MR_ACTION_TIMEOUT_MS);
      if (!res) throw new Error(lastQueryTimedOut() ? "fetchJobDetail timed out" : "daemon unavailable");
      if (!res.ok) throw new Error(res.error || "fetchJobDetail failed");
      return res.data;
    },
    fetchJobTrace: async (jobId) => {
      const res = await daemonQuery("mr:fetch-job-trace", { repoName, iid, jobId }, MR_ACTION_TIMEOUT_MS);
      if (!res) throw new Error(lastQueryTimedOut() ? "fetchJobTrace timed out" : "daemon unavailable");
      if (!res.ok) throw new Error(res.error || "fetchJobTrace failed");
      return res.data as string;
    },
  };
}

// ─── Discussions facade ──────────────────────────────────────────────────────

import type { Discussion } from "@workforge/glance-sdk";

export interface DiscussionsSnapshot {
  discussions: Discussion[];
  /** Unix-ms timestamp of the fetch that produced this snapshot. */
  fetchedAt:   number;
}

// Discussion fetches hit GitLab REST; allow the same 30s window as mr:action
// so slow/busy instances don't surface spurious timeouts.
const DISCUSSIONS_TIMEOUT_MS = 30_000;

/**
 * Read the discussions (comment threads) for an MR. The daemon serves from its
 * cache when fresh; otherwise it fetches from GitLab and broadcasts
 * `discussions:update` so other subscribers see the new data.
 *
 * Pass `force: true` to bypass the daemon's TTL and always re-fetch.
 */
export async function fetchDiscussions(
  repoName: string,
  iid: number,
  opts?: { force?: boolean },
): Promise<DiscussionsSnapshot> {
  const res = await daemonQuery(
    "discussions:read",
    { repoName, iid, force: opts?.force === true },
    DISCUSSIONS_TIMEOUT_MS,
  );
  if (!res) throw new Error(lastQueryTimedOut() ? "discussions timed out" : "daemon unavailable");
  if (!res.ok) throw new Error(res.error || "discussions:read failed");
  return res.data as DiscussionsSnapshot;
}

/** Toggle the resolved state of a discussion thread. Returns the refreshed snapshot. */
export async function setDiscussionResolved(
  repoName: string,
  iid: number,
  discussionId: string,
  resolved: boolean,
): Promise<DiscussionsSnapshot> {
  const res = await daemonQuery(
    "discussions:resolve",
    { repoName, iid, discussionId, resolved },
    DISCUSSIONS_TIMEOUT_MS,
  );
  if (!res) throw new Error(lastQueryTimedOut() ? "resolve timed out" : "daemon unavailable");
  if (!res.ok) throw new Error(res.error || "discussions:resolve failed");
  return res.data as DiscussionsSnapshot;
}

/** Fetch all file diffs for an MR. Returns `{ newPath, diff }[]` — one entry per changed file. */
export async function fetchMRDiffs(
  repoName: string,
  iid: number,
): Promise<Array<{ newPath: string; diff: string }>> {
  const res = await daemonQuery(
    "discussions:diffs",
    { repoName, iid },
    DISCUSSIONS_TIMEOUT_MS,
  );
  if (!res) throw new Error(lastQueryTimedOut() ? "diffs timed out" : "daemon unavailable");
  if (!res.ok) throw new Error(res.error || "discussions:diffs failed");
  return (res.data as { diffs: Array<{ newPath: string; diff: string }> }).diffs;
}

/** Post a reply note into an existing discussion thread. Returns the refreshed snapshot. */
export async function replyToDiscussion(
  repoName: string,
  iid: number,
  discussionId: string,
  body: string,
): Promise<DiscussionsSnapshot> {
  const res = await daemonQuery(
    "discussions:reply",
    { repoName, iid, discussionId, body },
    DISCUSSIONS_TIMEOUT_MS,
  );
  if (!res) throw new Error(lastQueryTimedOut() ? "reply timed out" : "daemon unavailable");
  if (!res.ok) throw new Error(res.error || "discussions:reply failed");
  return res.data as DiscussionsSnapshot;
}

// ─── Daemon event subscription (WebSocket) ───────────────────────────────────

/**
 * Shape of events pushed by the daemon over its WS endpoint.
 * The daemon wraps every broadcast as `{ type, data }`.
 */
export interface DaemonEvent {
  type: string;
  data: any;
}

export interface DaemonSubscription {
  /** Close the socket and stop auto-reconnecting. */
  close: () => void;
}

/**
 * Open a persistent WS connection to the daemon and forward every event to
 * `onEvent`. Auto-reconnects with a capped exponential backoff until `close()`
 * is called.
 *
 * The daemon's WS endpoint is a plain broadcast fan-out: every message
 * received here is a `{ type, data }` object the daemon pushed via its
 * `broadcast()` helper. Callers filter by `type` (`mr:update`, `mr:status`,
 * `status`, `ports`, `remedy`, `notification`, …).
 *
 * Errors are silent by design — the daemon may be down at any moment, and
 * the caller just keeps reading from its disk cache until the socket comes
 * back up.
 */
export function subscribeToDaemon(
  onEvent: (ev: DaemonEvent) => void,
  opts?: {
    /** Fired whenever the socket transitions open/closed. */
    onStatusChange?: (status: "connecting" | "connected" | "disconnected") => void;
  },
): DaemonSubscription {
  let ws: WebSocket | null = null;
  let closed = false;
  let retryMs = 500;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const setStatus = (s: "connecting" | "connected" | "disconnected") => {
    opts?.onStatusChange?.(s);
  };

  const connect = () => {
    if (closed) return;
    setStatus("connecting");
    try {
      ws = new WebSocket(`ws://localhost:${API_PORT}/ws`);
    } catch {
      scheduleReconnect();
      return;
    }

    ws.addEventListener("open", () => {
      retryMs = 500;
      setStatus("connected");
    });

    ws.addEventListener("message", (ev: MessageEvent) => {
      try {
        const raw = typeof ev.data === "string" ? ev.data : String(ev.data);
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.type === "string") {
          onEvent(parsed as DaemonEvent);
        }
      } catch { /* ignore malformed frame */ }
    });

    const onDown = () => {
      setStatus("disconnected");
      scheduleReconnect();
    };
    ws.addEventListener("close", onDown);
    ws.addEventListener("error", onDown);
  };

  const scheduleReconnect = () => {
    if (closed || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, retryMs);
    retryMs = Math.min(retryMs * 2, 10_000);
  };

  connect();

  return {
    close: () => {
      closed = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      try { ws?.close(); } catch { /* best-effort */ }
      ws = null;
    },
  };
}
