/**
 * REST API + WebSocket server on 127.0.0.1:9401 — the daemon's HTTP surface
 * for external clients (tray, editor extensions, scripts).
 *
 * Also owns the broadcast channel: `broadcast()` fans an event out to every
 * connected /ws client. It is safe to call before the server starts (the
 * client set is simply empty).
 */

import type { Server, ServerWebSocket } from "bun";
import type { Logger } from "pino";
import { API_PORT, resolveApiPort } from "../daemon-config.ts";
import { needsToken, tokenOk, getApiToken, resolveOriginTrust } from "./api-auth.ts";
import { getAggregatedConnection } from "./freshness.ts";
import { MAX_REQUEST_BODY_SIZE } from "./request-limits.ts";
import { runCapture } from "../subprocess.ts";

const API_INDEX = {
  name: "rt daemon",
  version: "1.0.0",
  docs: `http://localhost:${API_PORT}/`,
  websocket: `ws://localhost:${API_PORT}/ws`,
  endpoints: [
    { method: "GET",  path: "/api/status",        description: "Daemon health, uptime, memory, cache stats" },
    { method: "GET",  path: "/api/ports",          description: "Listening ports grouped by repo/worktree" },
    { method: "GET",  path: "/api/cache",           description: "All branch cache entries (MR, Linear, pipeline)" },
    { method: "GET",  path: "/api/cache/:branch",   description: "Single branch cache entry" },
    { method: "GET",  path: "/api/repos",           description: "Tracked repos with worktrees and watched status" },
    { method: "GET",  path: "/api/processes/system", description: "All repo-associated processes with CPU, memory, ports, runaway status" },
    { method: "GET",  path: "/api/notifications",   description: "Pending notifications (drains queue)" },
    { method: "POST", path: "/api/refresh",         description: "Trigger a background cache refresh" },
    { method: "POST", path: "/api/hooks/:repo/repair", description: "Repair hooks path for a repo" },
    { method: "POST", path: "/api/shutdown",        description: "Gracefully stop the daemon" },
    { method: "GET",  path: "/api/sdm/recents",     description: "Recent StrongDM connections with live connected state" },
    { method: "POST", path: "/api/sdm/reconnect",   description: "Reconnect a StrongDM recent (promptless; fails if an access request is needed)" },
    { method: "POST", path: "/api/events/emit",     description: "Emit an event onto the pane-communication bus" },
    { method: "GET",  path: "/api/events",          description: "List events matching a topic pattern" },
    { method: "GET",  path: "/api/secrets",          description: "Whitelisted secret values (linearApiKey, gitlabToken) — token-gated" },
    { method: "GET",  path: "/api/runs",            description: "Pipeline runs, newest first (?repo= to scope)" },
    { method: "GET",  path: "/api/runs/:repo/:runId", description: "One run: stages, fields, decisions" },
  ],
  websocket_events: [
    { type: "status",         description: "Full daemon status — after each cache refresh (~5 min)" },
    { type: "ports",          description: "Full port list — after each port scan (~30s)" },
    { type: "notification",   description: "Notification event — when a transition fires" },
    { type: "system-processes", description: "Repo processes with CPU/memory — after each 10s scan" },
    { type: "event",          description: "Events-bus broadcast frame; topic run-updated announces pipeline run writes" },
  ],
  auth: {
    header: "X-RT-Token",
    description: "Required on mutating routes (shutdown, sdm reconnect, events emit) and /api/secrets. Token at ~/.mattstack/rt/api-token.",
  },
};

const REST_ROUTES: Record<string, { cmd: string; method: string }> = {
  "/api/status":        { cmd: "tray:status", method: "GET" },
  "/api/ports":         { cmd: "ports", method: "GET" },
  "/api/cache":         { cmd: "cache:read", method: "GET" },
  "/api/repos":         { cmd: "repos", method: "GET" },
  "/api/notifications": { cmd: "notifications", method: "GET" },
  "/api/refresh":       { cmd: "cache:refresh", method: "POST" },
  "/api/shutdown":      { cmd: "shutdown", method: "POST" },
  "/api/processes/system": { cmd: "system-processes", method: "GET" },
  "/api/sdm/recents":   { cmd: "sdm:recents", method: "GET" },
  "/api/sdm/reconnect": { cmd: "sdm:reconnect", method: "POST" },
  "/api/events/emit":   { cmd: "events:emit", method: "POST" },
  "/api/events":        { cmd: "events:list", method: "GET" },
  "/api/runs":          { cmd: "runs:list", method: "GET" },
  // "/api/secrets" is NOT here — see the dedicated block in fetch() below:
  // it needs its header token forwarded into the command payload (the
  // secrets:read handler checks payload.token itself, not just this layer),
  // which the generic query-params-as-payload path below doesn't do.
};

/** Per-connection data on the :9401 WebSocket broadcast channel. */
interface ApiWSData {
  kind: "broadcast";
}

const wsClients = new Set<ServerWebSocket<ApiWSData>>();

let apiServerLog: { warn: (o: unknown, m: string) => void } = { warn: () => {} };

/** Consecutive Bun `ws.send()` backpressure (-1) returns tolerated before a
    client is dropped as chronically stalled. */
const BACKPRESSURE_CLOSE_THRESHOLD = 3;
const backpressureCounts = new WeakMap<object, number>();

export interface BroadcastTarget {
  send(data: string): number;
  close(): void;
}

/**
 * Sends one frame to every client, dropping any that Bun's own send() return
 * value marks as gone. `ws.send()` never throws on a dead socket --
 * it returns 0 (this send silently failed) or -1 (backpressure) -- so a
 * disconnected or stalled console/chat-viewer tab used to keep receiving a
 * SUBSET of frames forever with nothing logged. 0 means Bun already dropped
 * this exact frame for this client: closing immediately (rather than
 * counting) is correct because the client's own reconnect logic is the only
 * way it recovers a consistent stream. -1 means backpressure, which can be
 * transient, so a few in a row are tolerated before giving up on the client.
 */
export function broadcastToClients(
  clients: Iterable<BroadcastTarget>,
  type: string,
  data: any,
  log: { warn: (o: unknown, m: string) => void },
): void {
  const msg = JSON.stringify({ type, data, timestamp: Date.now() });
  for (const client of clients) {
    let result: number;
    try {
      result = client.send(msg);
    } catch (err) {
      log.warn({ err }, "ws client send threw; dropping");
      try { client.close(); } catch { /* already gone */ }
      continue;
    }
    if (result === 0) {
      log.warn({ type }, "ws client dropped a frame (send()=0); closing so its reconnect resyncs");
      backpressureCounts.delete(client);
      try { client.close(); } catch { /* already gone */ }
    } else if (result === -1) {
      const count = (backpressureCounts.get(client) ?? 0) + 1;
      if (count >= BACKPRESSURE_CLOSE_THRESHOLD) {
        log.warn({ type, count }, "ws client chronically backpressured; closing");
        backpressureCounts.delete(client);
        try { client.close(); } catch { /* already gone */ }
      } else {
        backpressureCounts.set(client, count);
      }
    } else {
      backpressureCounts.delete(client);
    }
  }
}

/** Broadcast an event to all connected WebSocket clients. */
export function broadcast(type: string, data: any): void {
  if (wsClients.size === 0) return;
  broadcastToClients(wsClients, type, data, apiServerLog);
}

/** Drop all broadcast clients (shutdown). */
export function clearWsClients(): void {
  wsClients.clear();
}

/**
 * CORS default-deny: a browser page on an untrusted Origin still gets
 * its request served (127.0.0.1 loopback + the per-route token gate are the
 * real defenses), but the response carries no Access-Control-Allow-Origin,
 * so the page's own JavaScript cannot read the body. A request with no
 * Origin at all (every non-browser consumer today) needs no CORS headers.
 */
export function buildCorsHeaders(origin: string | null, trusted: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-RT-Token",
  };
  if (origin && trusted) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin";
  }
  return headers;
}

/**
 * Decodes one path segment between a fixed prefix (and optional suffix),
 * returning `undefined` (never throwing) on any shape mismatch or malformed
 * %-encoding. Before this, each parameterized route hand-rolled its
 * own decodeURIComponent inside the route's try block, so a malformed
 * segment fell through to the OUTER catch and came back as a logged 500;
 * every route using this helper instead gets a clean 400.
 */
export function pathParam(pathname: string, prefix: string, suffix = ""): string | undefined {
  if (!pathname.startsWith(prefix)) return undefined;
  if (suffix && !pathname.endsWith(suffix)) return undefined;
  const end = suffix ? pathname.length - suffix.length : pathname.length;
  if (end <= prefix.length) return undefined;
  const raw = pathname.slice(prefix.length, end);
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
}

const PLAIN_NUMBER_RE = /^-?\d+(\.\d+)?$/;

/**
 * REST query strings arrive as strings no matter what the client meant:
 * "?maxAgeMs=60000" and "?refresh=true" reached handlers that do a
 * strict `typeof x === "number"` or `x === true` check, so the documented
 * flag silently no-op'd over HTTP while working over the socket (where
 * payloads are real JSON). One coercion at the REST seam fixes every such
 * flag at once instead of a per-handler private parser.
 */
export function coerceQueryParams(params: URLSearchParams): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of params) {
    if (value === "true") out[key] = true;
    else if (value === "false") out[key] = false;
    else if (value !== "" && PLAIN_NUMBER_RE.test(value)) out[key] = Number(value);
    else out[key] = value;
  }
  return out;
}

export interface ApiServerDeps {
  handleCommand: (cmd: string, payload: any, signal?: AbortSignal) => Promise<any>;
  log: Logger;
}

/**
 * Thrown when every bind retry is exhausted with EADDRINUSE still held. A
 * named error type rather than the raw EADDRINUSE Error, so lib/daemon.ts's
 * caller can distinguish "the port is genuinely squatted" from any other
 * startup failure and park-and-retry with backoff instead of crash-looping
 * (that caller-side change belongs to a sibling job; this class is the
 * contract it wires into).
 */
export class ApiPortInUseError extends Error {
  readonly code = "EADDRINUSE" as const;
  readonly port: number;
  constructor(port: number) {
    super(`EADDRINUSE: api server port ${port} is still in use after ${BIND_RETRY_ATTEMPTS} bind attempts`);
    this.name = "ApiPortInUseError";
    this.port = port;
  }
}

export interface BindRetryDeps {
  sleep: (ms: number) => Promise<void>;
  log: { warn: (o: unknown, m: string) => void };
  /** Defaults to a real `lsof -i :<port>` via runCapture; overridable so tests never shell out. */
  probePortHolder?: (port: number) => Promise<string>;
}

async function defaultProbePortHolder(port: number): Promise<string> {
  const result = await runCapture(["lsof", "-i", `:${port}`], { timeoutMs: 5_000, stderr: "pipe" });
  return result.stdout.trim();
}

// evictStaleDaemon (lib/daemon/boot-reconcile.ts) already assumes a prior
// holder is gone after a 300ms Bun.sleepSync — 6 attempts at 500ms (~3s
// worst case, exported so tests assert against these, not hardcoded copies)
// gives that same assumption room to be wrong once before this gives up too.
export const BIND_RETRY_ATTEMPTS = 6;
export const BIND_RETRY_DELAY_MS = 500;

/**
 * evictStaleDaemon() SIGTERMs the previous holder of this port before a new
 * daemon binds, but the kill isn't synchronous with the exit — a fresh
 * daemon can reach this bind before the old one has actually released
 * 9401. Only EADDRINUSE is retried (bounded, ~3s total); anything else is a
 * real misconfiguration and fails on the first attempt, same as before.
 *
 * Once retries are exhausted, this logs who holds the port and throws
 * ApiPortInUseError instead of the bare EADDRINUSE Error, so a caller can
 * tell "give up cleanly" apart from "the bind function itself is broken".
 */
export async function bindApiServerWithRetry<T>(bind: () => T, deps: BindRetryDeps, port: number = API_PORT): Promise<T> {
  const probe = deps.probePortHolder ?? defaultProbePortHolder;
  for (let attempt = 1; ; attempt++) {
    try {
      return bind();
    } catch (err) {
      const isAddrInUse = err instanceof Error && (err as NodeJS.ErrnoException).code === "EADDRINUSE";
      if (!isAddrInUse) throw err;
      if (attempt >= BIND_RETRY_ATTEMPTS) {
        const holder = await probe(port).catch((probeErr) => `lsof failed: ${String(probeErr)}`);
        deps.log.warn({ port, holder }, "api port still in use after retries; giving up bind (the daemon should park and retry with backoff rather than crash-loop)");
        throw new ApiPortInUseError(port);
      }
      deps.log.warn({ attempt, port }, "api port in use, retrying — another daemon is likely still shutting down");
      await deps.sleep(BIND_RETRY_DELAY_MS);
    }
  }
}

/**
 * Backoff base/cap for {@link withApiPortParkRetry}'s outer loop. Distinct
 * from BIND_RETRY_* (bindApiServerWithRetry's own ~3s inner retry, already
 * exhausted before an ApiPortInUseError ever reaches here): this loop
 * assumes the holder is a whole other process that may take much longer
 * than 3s to exit, so it backs off further between each full re-attempt.
 */
const PARK_RETRY_BASE_MS = 3_000;
const PARK_RETRY_MAX_MS = 60_000;

export interface ParkRetryDeps {
  sleep: (ms: number) => Promise<void>;
  log: { warn: (o: unknown, m: string) => void };
}

/**
 * Wraps a `startApiServer`-shaped call: on `ApiPortInUseError` (bind retries
 * already exhausted), logs and waits with exponential backoff, then calls
 * `start` again — indefinitely, never giving up — instead of letting the
 * error reach the daemon's top-level crash path (S043 caller-side contract,
 * docs/daemon-api-auth.md). Any other error propagates immediately: that is
 * a genuine misconfiguration, not a transient port squat.
 */
export async function withApiPortParkRetry<T>(start: () => Promise<T>, deps: ParkRetryDeps): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await start();
    } catch (err) {
      if (!(err instanceof ApiPortInUseError)) throw err;
      const delayMs = Math.min(PARK_RETRY_BASE_MS * 2 ** (attempt - 1), PARK_RETRY_MAX_MS);
      deps.log.warn({ attempt, port: err.port, delayMs }, "api server port still in use; parked, retrying with backoff");
      await deps.sleep(delayMs);
    }
  }
}

export async function startApiServer(deps: ApiServerDeps): Promise<Server<any>> {
  const { handleCommand, log } = deps;
  apiServerLog = log;
  const apiToken = getApiToken();
  const port = resolveApiPort();

  const server = await bindApiServerWithRetry(() => Bun.serve<ApiWSData, never>({
    port,
    // Bind to loopback only — never expose the control surface on the LAN.
    hostname: "127.0.0.1",
    // Raise the request idle timeout off Bun's 10s default so long-lived
    // clients aren't reaped every 10s ("[Bun.serve]: request timed out").
    // 255 is the server max; the websocket block below sets its own larger one.
    idleTimeout: 255,
    maxRequestBodySize: MAX_REQUEST_BODY_SIZE,
    async fetch(req, server) {
      const url = new URL(req.url);
      const origin = req.headers.get("origin");

      // WebSocket upgrade (broadcast channel). Browsers cannot set custom
      // headers on a WS handshake, so the token (when a browser page wants
      // to identify itself) travels as a ?token= query param instead of
      // X-RT-Token.
      if (url.pathname === "/ws") {
        const wsToken = url.searchParams.get("token");
        if (!resolveOriginTrust(origin, wsToken, apiToken)) {
          return new Response("origin not allowed", { status: 403 });
        }
        if (server.upgrade(req, { data: { kind: "broadcast" } })) return undefined as any;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      // CORS: default-deny. A trusted Origin (token or allowlist) gets its
      // Origin echoed back; anything else gets no Access-Control-Allow-Origin
      // at all, so a malicious page's own JS cannot read the response.
      // resolveOriginTrust only resolves the allowlist when origin is set,
      // since the settings read behind it is synchronous disk I/O.
      const trusted = resolveOriginTrust(origin, req.headers.get("x-rt-token"), apiToken);
      const corsHeaders = buildCorsHeaders(origin, trusted);

      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      // Gate mutating routes behind the local token. CORS default-deny only
      // stops a malicious page from reading the response; it can still fire
      // the request itself (a classic CSRF), so the token is the actual
      // defense against a malicious page driving control endpoints.
      if (needsToken(req.method, url.pathname) && !tokenOk(req.headers.get("x-rt-token"), apiToken)) {
        return Response.json({ ok: false, error: "unauthorized" }, { status: 401, headers: corsHeaders });
      }

      try {
        // Self-describing root
        if (url.pathname === "/" || url.pathname === "") {
          return Response.json(API_INDEX, { headers: corsHeaders });
        }

        // Single branch lookup: /api/cache/:branch
        if (url.pathname.startsWith("/api/cache/") && req.method === "GET") {
          const branch = pathParam(url.pathname, "/api/cache/");
          if (branch === undefined) {
            return Response.json({ ok: false, error: "malformed path parameter" }, { status: 400, headers: corsHeaders });
          }
          const result = await handleCommand("cache:read", { branches: [branch] }, req.signal);
          return Response.json(result, { headers: corsHeaders });
        }

        // Hooks repair: /api/hooks/:repo/repair
        if (url.pathname.startsWith("/api/hooks/") && url.pathname.endsWith("/repair") && req.method === "POST") {
          const repo = pathParam(url.pathname, "/api/hooks/", "/repair");
          if (repo === undefined) {
            return Response.json({ ok: false, error: "malformed path parameter" }, { status: 400, headers: corsHeaders });
          }
          const result = await handleCommand("hooks:repair", { repo }, req.signal);
          return Response.json(result, { headers: corsHeaders });
        }

        // Runs detail: /api/runs/:repo/:runId
        if (url.pathname.startsWith("/api/runs/") && req.method === "GET") {
          const rest = pathParam(url.pathname, "/api/runs/");
          if (rest === undefined) {
            return Response.json({ ok: false, error: "malformed path parameter" }, { status: 400, headers: corsHeaders });
          }
          const slash = rest.indexOf("/");
          if (slash > 0 && slash < rest.length - 1) {
            const result = await handleCommand("runs:get", { repo: rest.slice(0, slash), runId: rest.slice(slash + 1) }, req.signal);
            return Response.json(result, { headers: corsHeaders });
          }
          // falls through to the 404 path below for a shape mismatch, e.g. "/api/runs/onlyonesegment"
        }

        // Secrets: forward the X-RT-Token header (already verified above by
        // needsToken/tokenOk) into the command payload — secrets:read's own
        // handler-level check (the enforcement point that also covers the
        // unix socket transport) needs it there, not just on this request.
        if (url.pathname === "/api/secrets" && req.method === "GET") {
          const result = await handleCommand("secrets:read", { token: req.headers.get("x-rt-token") ?? undefined }, req.signal);
          return Response.json(result, { headers: corsHeaders });
        }

        // Static routes
        const route = REST_ROUTES[url.pathname];
        if (!route) {
          return Response.json({ ok: false, error: "not found", docs: `http://localhost:${API_PORT}/` }, { status: 404, headers: corsHeaders });
        }

        if (req.method !== route.method && req.method !== "OPTIONS") {
          return Response.json({ ok: false, error: `use ${route.method}` }, { status: 405, headers: corsHeaders });
        }

        // Build payload from query params (GET) or body (POST)
        let payload: any = {};
        if (req.method === "POST") {
          try { payload = await req.json(); } catch { /* empty body */ }
        } else {
          payload = coerceQueryParams(url.searchParams);
        }

        const result = await handleCommand(route.cmd, payload, req.signal);
        return Response.json(result, { headers: corsHeaders });
      } catch (err) {
        log.error({ err, url: req.url }, "api request failed");
        return Response.json({ ok: false, error: String(err) }, { status: 500, headers: corsHeaders });
      }
    },
    websocket: {
      // 960 is Bun's per-socket max; combined with the default pings this
      // stops idle WS connections from being closed out from under clients.
      idleTimeout: 960,
      open(ws) {
        wsClients.add(ws);
        log.debug({ total: wsClients.size }, "ws client connected");
        try {
          ws.send(JSON.stringify({
            type: "mr:status",
            data: { connection: getAggregatedConnection() },
            timestamp: Date.now(),
          }));
        } catch { /* client gone */ }
      },
      close(ws) {
        wsClients.delete(ws);
        log.debug({ total: wsClients.size }, "ws client disconnected");
      },
      message() {
        // Broadcast clients are read-only; inbound frames are ignored.
      },
    },
  }), { sleep: (ms) => Bun.sleep(ms), log }, port);

  log.info({ port }, "api server listening");
  return server;
}
