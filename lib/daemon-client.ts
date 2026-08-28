/**
 * Daemon client — thin IPC layer for CLI → daemon communication.
 *
 * Uses HTTP over Unix socket (Bun.serve on the daemon side).
 * Gracefully degrades when daemon is not installed or not running:
 *  - Not installed → returns null silently
 *  - Installed but down → attempts launchctl restart, warns if that fails
 */

import { existsSync } from "fs";
import { join } from "path";
import {
  isDaemonInstalled,
  getDaemonConfig,
  DAEMON_SOCK_PATH,
  TRAY_SOCK_PATH,
  API_PORT,
} from "./daemon-config.ts";
import { rtDir } from "./rt-paths.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DaemonResponse {
  ok: boolean;
  data?: any;
  error?: string;
}

// ─── HTTP over Unix socket ───────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 2000;

// Deprecated shim state (see lastQueryTimedOut's doc): kept in sync so an
// external caller still reading it via the module-level accessor keeps
// working, but nothing in this file reads these two vars anymore — every
// internal caller carries its own attribution on its own return value
// instead, which a concurrent query can never clobber.
let _lastQueryWasRefused = false;
let _lastQueryTimedOut   = false;

interface SocketQueryAttempt {
  response: DaemonResponse | null;
  /** True on ECONNREFUSED — the socket is stale, not merely slow. */
  refused: boolean;
  /** True when the request itself exceeded timeoutMs. */
  timedOut: boolean;
}

async function trySocketQuery(
  cmd: string,
  payload?: Record<string, any>,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<SocketQueryAttempt> {
  if (!existsSync(DAEMON_SOCK_PATH)) {
    _lastQueryWasRefused = false;
    _lastQueryTimedOut   = false;
    return { response: null, refused: false, timedOut: false };
  }

  try {
    const hasBody = payload && Object.keys(payload).length > 0;

    const headers: Record<string, string> = { "X-RT-Client": `rt-cli/${process.pid}` };
    if (hasBody) headers["Content-Type"] = "application/json";
    const response = await fetch(`http://localhost/${cmd}`, {
      unix: DAEMON_SOCK_PATH,
      method: hasBody ? "POST" : "GET",
      headers,
      body: hasBody ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    } as any);

    _lastQueryWasRefused = false;
    _lastQueryTimedOut   = false;
    return { response: (await response.json()) as DaemonResponse, refused: false, timedOut: false };
  } catch (err) {
    const code = (err as any)?.code ?? "";
    const name = (err as any)?.name ?? "";
    const msg  = err instanceof Error ? err.message : "";
    const refused  = code === "ECONNREFUSED" || msg.includes("ECONNREFUSED") || msg.includes("Connection refused");
    const timedOut = name === "TimeoutError" || name === "AbortError" || msg.includes("timed out");
    _lastQueryWasRefused = refused;
    _lastQueryTimedOut   = timedOut;
    return { response: null, refused, timedOut };
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

// ─── Read-only daemon socket query ────────────────────────────────────────────

/**
 * Read-only daemon query for the setup probes seam: unlike `daemonQuery`,
 * a missing/down daemon never triggers the tray `/daemon/start` POST or the
 * stderr "daemon down" warning — a `rt setup check` must never mutate
 * machine state or write outside its NDJSON stream just by probing.
 */
export async function daemonSocketQuery(
  cmd: string,
  payload?: Record<string, any>,
  timeoutMs?: number,
): Promise<DaemonResponse | null> {
  return (await trySocketQuery(cmd, payload, timeoutMs)).response;
}

// ─── Tray request client (MAT-383 setup verbs) ───────────────────────────────

/**
 * RT_APP_SOCKET (set by the app when it spawns rt) wins over the default
 * tray.sock path. Resolves `rtDir()` at CALL time, not `TRAY_SOCK_PATH`
 * (a module-load const) — a caller that repoints HOME after this module
 * has loaded (every test in this repo) must see the new path.
 */
export function traySocketPath(): string {
  return process.env.RT_APP_SOCKET || join(rtDir(), "tray.sock");
}

export interface TrayReply<T = unknown> {
  status: number;
  json: T | null;
}

/**
 * General-purpose tray.sock request client for setup probes — unlike
 * `trayQuery`, callers choose the method and may send a JSON body.
 * Never throws: socket absent, connection failure, and timeout all resolve
 * `{status: 0, json: null}` so probe code can treat every tray outage
 * uniformly instead of catching transport errors itself.
 */
export async function trayRequest<T = unknown>(
  path: string,
  init: { method: "GET" | "POST"; body?: unknown; timeoutMs?: number } = { method: "GET" },
): Promise<TrayReply<T>> {
  const sockPath = traySocketPath();
  if (!existsSync(sockPath)) return { status: 0, json: null };

  try {
    const hasBody = init.body !== undefined;
    const headers: Record<string, string> = { "X-RT-Client": `rt-cli/${process.pid}` };
    if (hasBody) headers["Content-Type"] = "application/json";
    const response = await fetch(`http://localhost${path}`, {
      unix: sockPath,
      method: init.method,
      headers,
      body: hasBody ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(init.timeoutMs ?? REQUEST_TIMEOUT_MS),
    } as any);

    const text = await response.text();
    let json: T | null = null;
    if (text.length > 0) {
      try {
        json = JSON.parse(text) as T;
      } catch {
        json = null; // tolerate a non-JSON body rather than surfacing a parse error
      }
    }
    return { status: response.status, json };
  } catch {
    return { status: 0, json: null };
  }
}

export type TrayClient = typeof trayRequest;

// ─── Auto-recovery ───────────────────────────────────────────────────────────

let hasWarnedThisSession = false;
let _warningSuppressed = false;

async function attemptRestart(): Promise<boolean> {
  try {
    const config = getDaemonConfig();
    if (!config) return false;

    // Ask the tray app to start the daemon. Await it — an unawaited POST may
    // never leave the socket before a short-lived CLI process exits, and a
    // null response (tray socket absent / request failed) means no restart
    // actually happened.
    const res = await trayQuery("/daemon/start", "POST");
    if (res === null) return false;

    // The tray ack only proves the request was received, not that the
    // daemon actually came up, so re-probe rt.sock before reporting success,
    // so daemonQuery's caller isn't told "restarted" while the daemon is
    // still mid-boot and then misdirected into warnDaemonDown() on the very
    // next query instead of actually waiting for it.
    for (let i = 0; i < 12; i++) {
      await Bun.sleep(250);
      if (await isDaemonRunning()) return true;
    }
    return false;
  } catch {
    return false;
  }
}

const SOCKET_POLL_TOTAL_MS = 3_000;
const SOCKET_POLL_INTERVAL_MS = 150;

/**
 * Polls for rt.sock to exist and answer for up to ~3s after a restart
 * request. parkUntilIntended's own socket probe, state.db open, and the
 * identity migration routinely take longer than a single fixed delay, so a
 * start that genuinely succeeds must not be reported as "installed but not
 * running" just because the retry landed too early.
 */
async function waitForSocket(
  totalMs: number = SOCKET_POLL_TOTAL_MS,
  intervalMs: number = SOCKET_POLL_INTERVAL_MS,
): Promise<boolean> {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    if (existsSync(DAEMON_SOCK_PATH)) {
      const ping = await trySocketQuery("ping", {}, Math.min(intervalMs * 2, 1000));
      if (ping.response !== null) return true;
    }
    await Bun.sleep(intervalMs);
  }
  return existsSync(DAEMON_SOCK_PATH);
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
 * Same contract as `daemonQuery`, but the failure kind travels on the
 * return value instead of the module-level `_lastQuery*` flags — so a
 * concurrent query (a 30s mr:action merge racing a 2s status poll, say)
 * can never clobber this call's own attribution between its trySocketQuery
 * resolving and its caller reading it. Prefer this over
 * `daemonQuery` + `lastQueryTimedOut()` for any new caller.
 */
export async function daemonQueryAttributed(
  cmd: string,
  payload?: Record<string, any>,
  timeoutMs?: number,
): Promise<SocketQueryAttempt> {
  // 1. Try HTTP request over Unix socket
  const first = await trySocketQuery(cmd, payload, timeoutMs);
  if (first.response !== null) return first;

  // 2. Check if user opted in
  if (!isDaemonInstalled()) return { response: null, refused: false, timedOut: false }; // not installed → silent fallback

  // 3. If the socket file still exists AND the connection wasn't refused,
  //    the daemon IS running — this query timed out or hit a transient error.
  //    Return null silently. But if the connection was refused, the socket is
  //    stale (daemon died without cleaning up) — fall through to attempt restart.
  if (existsSync(DAEMON_SOCK_PATH) && !first.refused) return first;

  // 4. Socket is gone → daemon is genuinely not running. Attempt restart.
  const restarted = await attemptRestart();
  let last = first;
  if (restarted) {
    // Bounded poll, not one fixed-delay retry: parkUntilIntended's own
    // socket probe, state.db open, and the identity migration routinely
    // take longer than 300ms, and a successful start must not be reported
    // as "installed but not running" just because the retry landed early.
    await waitForSocket();
    const retry = await trySocketQuery(cmd, payload, timeoutMs);
    if (retry.response !== null) return retry;
    last = retry;
  }

  // 5. Restart failed → warn (once per session)
  warnDaemonDown();
  return last;
}

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
  return (await daemonQueryAttributed(cmd, payload, timeoutMs)).response;
}

/**
 * True if the last `daemonQuery` returned null because the request timed out
 * (as opposed to the daemon being genuinely down). Deprecated: still backed
 * by shared module state, so it remains vulnerable to the exact
 * cross-query attribution race `daemonQueryAttributed` closes — kept only
 * for callers that predate that function. New callers should use
 * `daemonQueryAttributed` and read `.timedOut` off their own result.
 */
export function lastQueryTimedOut(): boolean {
  return _lastQueryTimedOut;
}

/**
 * Quick check: is the daemon reachable right now?
 */
export async function isDaemonRunning(): Promise<boolean> {
  const { response } = await trySocketQuery("ping");
  return response?.ok === true;
}

/** Single-attempt ping that never triggers the restart machinery, so
 *  `rt daemon status` can probe liveness and read the daemon's eventLoop
 *  summary without spawning a daemon as a side effect. */
export async function pingDaemon(timeoutMs?: number): Promise<DaemonResponse | null> {
  return (await trySocketQuery("ping", undefined, timeoutMs)).response;
}

// ─── MR action facade ────────────────────────────────────────────────────────

/**
 * JSON-over-IPC facade for MR actions, bound to a `{repoName, iid}` pair.
 * Each method round-trips through the daemon, which holds the single
 * authoritative per-repo GitLabProvider and runs the real action against it.
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
    const { response: res, timedOut } = await daemonQueryAttributed("mr:action", { repoName, iid, action, args }, MR_ACTION_TIMEOUT_MS);
    if (!res) throw new Error(timedOut ? `${action} timed out — verify on GitLab` : "daemon unavailable");
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
      const { response: res, timedOut } = await daemonQueryAttributed("mr:fetch-job-detail", { repoName, iid, jobId, pipelineId }, MR_ACTION_TIMEOUT_MS);
      if (!res) throw new Error(timedOut ? "fetchJobDetail timed out" : "daemon unavailable");
      if (!res.ok) throw new Error(res.error || "fetchJobDetail failed");
      return res.data;
    },
    fetchJobTrace: async (jobId) => {
      const { response: res, timedOut } = await daemonQueryAttributed("mr:fetch-job-trace", { repoName, iid, jobId }, MR_ACTION_TIMEOUT_MS);
      if (!res) throw new Error(timedOut ? "fetchJobTrace timed out" : "daemon unavailable");
      if (!res.ok) throw new Error(res.error || "fetchJobTrace failed");
      return res.data as string;
    },
  };
}

// ─── Discussions facade ──────────────────────────────────────────────────────

import type { Discussion } from "@mattstack/glance";

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
  const { response: res, timedOut } = await daemonQueryAttributed(
    "discussions:read",
    { repoName, iid, force: opts?.force === true },
    DISCUSSIONS_TIMEOUT_MS,
  );
  if (!res) throw new Error(timedOut ? "discussions timed out" : "daemon unavailable");
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
  const { response: res, timedOut } = await daemonQueryAttributed(
    "discussions:resolve",
    { repoName, iid, discussionId, resolved },
    DISCUSSIONS_TIMEOUT_MS,
  );
  if (!res) throw new Error(timedOut ? "resolve timed out" : "daemon unavailable");
  if (!res.ok) throw new Error(res.error || "discussions:resolve failed");
  return res.data as DiscussionsSnapshot;
}

/** Fetch all file diffs for an MR. Returns `{ newPath, diff }[]` — one entry per changed file. */
export async function fetchMRDiffs(
  repoName: string,
  iid: number,
): Promise<Array<{ newPath: string; diff: string }>> {
  const { response: res, timedOut } = await daemonQueryAttributed(
    "discussions:diffs",
    { repoName, iid },
    DISCUSSIONS_TIMEOUT_MS,
  );
  if (!res) throw new Error(timedOut ? "diffs timed out" : "daemon unavailable");
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
  const { response: res, timedOut } = await daemonQueryAttributed(
    "discussions:reply",
    { repoName, iid, discussionId, body },
    DISCUSSIONS_TIMEOUT_MS,
  );
  if (!res) throw new Error(timedOut ? "reply timed out" : "daemon unavailable");
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
 * `status`, `ports`, `notification`, …).
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
