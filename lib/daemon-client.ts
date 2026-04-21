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

async function trySocketQuery(
  cmd: string,
  payload?: Record<string, any>,
): Promise<DaemonResponse | null> {
  if (!existsSync(DAEMON_SOCK_PATH)) return null;

  try {
    const hasBody = payload && Object.keys(payload).length > 0;

    const response = await fetch(`http://localhost/${cmd}`, {
      unix: DAEMON_SOCK_PATH,
      method: hasBody ? "POST" : "GET",
      headers: hasBody ? { "Content-Type": "application/json" } : undefined,
      body: hasBody ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    } as any);

    _lastQueryWasRefused = false;
    return (await response.json()) as DaemonResponse;
  } catch (err) {
    const code = (err as any)?.code ?? "";
    const msg  = err instanceof Error ? err.message : "";
    _lastQueryWasRefused = code === "ECONNREFUSED" || msg.includes("ECONNREFUSED") || msg.includes("Connection refused");
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
  if (hasWarnedThisSession) return;
  hasWarnedThisSession = true;
  console.error(
    "  \x1b[33m⚠\x1b[0m rt daemon is installed but not running. Run: \x1b[1mrt daemon start\x1b[0m",
  );
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
): Promise<DaemonResponse | null> {
  // 1. Try HTTP request over Unix socket
  const result = await trySocketQuery(cmd, payload);
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
    const retryResult = await trySocketQuery(cmd, payload);
    if (retryResult !== null) return retryResult;
  }

  // 5. Restart failed → warn (once per session)
  warnDaemonDown();
  return null;
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

export function mrActions(repoName: string, iid: number): DaemonMRActions {
  const fire = async (action: string, args: any[] = []): Promise<void> => {
    const res = await daemonQuery("mr:action", { repoName, iid, action, args });
    if (!res) throw new Error("daemon unavailable");
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
      const res = await daemonQuery("mr:fetch-job-detail", { repoName, iid, jobId, pipelineId });
      if (!res) throw new Error("daemon unavailable");
      if (!res.ok) throw new Error(res.error || "fetchJobDetail failed");
      return res.data;
    },
    fetchJobTrace: async (jobId) => {
      const res = await daemonQuery("mr:fetch-job-trace", { repoName, iid, jobId });
      if (!res) throw new Error("daemon unavailable");
      if (!res.ok) throw new Error(res.error || "fetchJobTrace failed");
      return res.data as string;
    },
  };
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
