/**
 * REST API + WebSocket server on 127.0.0.1:9401 — the daemon's HTTP surface
 * for external clients (GUI dashboard, scripts).
 *
 * Also owns the broadcast channel: `broadcast()` fans an event out to every
 * connected /ws client. It is safe to call before the server starts (the
 * client set is simply empty).
 */

import type { Server, ServerWebSocket } from "bun";
import type { Logger } from "pino";
import { API_PORT } from "../daemon-config.ts";
import { needsToken, tokenOk, loadOrCreateApiToken } from "./api-auth.ts";
import { matchProcessApiRoute } from "./api-routes.ts";
import { openLogStream, handleLogStreamControl, handleAttachMessage } from "./log-stream.ts";
import { getAggregatedConnection } from "./mr-subscriptions.ts";
import { spawnHerdrAttach } from "./herdr/attach-bridge.ts";
import type { PaneMap } from "./herdr/pane-map.ts";
import type { LogBuffer } from "./log-buffer.ts";

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
    { method: "GET",  path: "/api/processes",        description: "Enriched list of all managed processes across repos (state, pid, timing, repo/worktree)" },
    { method: "GET",  path: "/api/processes/system", description: "All repo-associated processes with CPU, memory, ports, runaway status" },
    { method: "POST", path: "/api/processes",         description: "Launch a command in a worktree { cwd, cmd, label? } (requires X-RT-Token)" },
    { method: "POST", path: "/api/terminals",         description: "Open an interactive terminal session (login shell) in a worktree { cwd } (requires X-RT-Token)" },
    { method: "GET",  path: "/api/worktrees/commands", description: "Runnable packages + scripts for a worktree (?path=...), monorepo-aware" },
    { method: "GET",  path: "/api/endpoints",       description: "Declared canonical endpoints + active state for a repo (?repo=)" },
    { method: "POST", path: "/api/endpoints/map",            description: "Map a forward endpoint to a process { repo, port, processId, upstreamPort } (X-RT-Token)" },
    { method: "POST", path: "/api/endpoints/unmap",          description: "Unmap a forward endpoint { repo, port } (X-RT-Token)" },
    { method: "POST", path: "/api/endpoints/bounce-enable",  description: "Enable a bounce relay on a declared bounce port { repo, port } (X-RT-Token)" },
    { method: "POST", path: "/api/endpoints/bounce-disable", description: "Disable a bounce relay { repo, port } (X-RT-Token)" },
    { method: "POST", path: "/api/processes/:id/start",   description: "Start a process via its stored config (requires X-RT-Token)" },
    { method: "POST", path: "/api/processes/:id/stop",    description: "Stop a process (requires X-RT-Token)" },
    { method: "POST", path: "/api/processes/:id/restart", description: "Restart a process (requires X-RT-Token)" },
    { method: "GET",  path: "/api/notifications",   description: "Pending notifications (drains queue)" },
    { method: "POST", path: "/api/refresh",         description: "Trigger a background cache refresh" },
    { method: "POST", path: "/api/hooks/:repo/repair", description: "Repair hooks path for a repo" },
    { method: "POST", path: "/api/shutdown",        description: "Gracefully stop the daemon" },
  ],
  websocket_events: [
    { type: "status",         description: "Full daemon status — after each cache refresh (~5 min)" },
    { type: "ports",          description: "Full port list — after each port scan (~30s)" },
    { type: "notification",   description: "Notification event — when a transition fires" },
    { type: "remedy",         description: "Remedy fire event — when an auto-remedy triggers" },
    { type: "process:changed", description: "Process state transition { id, from, to, pid?, exitCode? }" },
    { type: "system-processes", description: "Repo processes with CPU/memory — after each 10s scan" },
  ],
  log_stream: {
    path: `ws://localhost:${API_PORT}/ws/processes/:id/logs`,
    description: "Read-only per-process log tail: replays recent history, then streams live output",
  },
  auth: {
    header: "X-RT-Token",
    description: "Required on mutating routes (process control, shutdown). Token at ~/.rt/api-token.",
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
};

/**
 * Per-connection data on the :9401 WebSocket. "broadcast" sockets receive the
 * event stream; "logs" sockets are a read-only tail of one process's output;
 * "attach" sockets are bidirectional — output tail + keystroke input + resize
 * (an interactive terminal). "attach" is token-gated on upgrade because input
 * is arbitrary code execution.
 */
interface ApiWSData {
  kind: "broadcast" | "logs" | "attach";
  id?: string;
  unsub?: () => void;
  /** Herdr attach path: the Bun.Terminal bridging `herdr terminal attach`. */
  term?: any;
  /** Herdr attach path: the herdr-attach child process to kill on close. */
  herdrProc?: ReturnType<typeof Bun.spawn>;
}

const wsClients = new Set<ServerWebSocket<ApiWSData>>();

/** Broadcast an event to all connected WebSocket clients. */
export function broadcast(type: string, data: any): void {
  if (wsClients.size === 0) return;
  const msg = JSON.stringify({ type, data, timestamp: Date.now() });
  for (const ws of wsClients) {
    try { ws.send(msg); } catch { /* client disconnected */ }
  }
}

/** Drop all broadcast clients (shutdown). */
export function clearWsClients(): void {
  wsClients.clear();
}

export interface ApiServerDeps {
  handleCommand: (cmd: string, payload: any) => Promise<any>;
  log: Logger;
  /** True when processes are backed by herdr panes instead of local PTYs. */
  useHerdr: boolean;
  herdrPaneMap: PaneMap | null;
  /** ProcessManager or HerdrProcessManager (structural: userPath/getTerminal/subscribeToOutput). */
  processManager: any;
  logBuffer: LogBuffer;
}

export function startApiServer(deps: ApiServerDeps): Server<any> {
  const { handleCommand, log, useHerdr, herdrPaneMap, processManager, logBuffer } = deps;
  const apiToken = loadOrCreateApiToken();

  const server = Bun.serve<ApiWSData, never>({
    port: API_PORT,
    // Bind to loopback only — never expose the control surface on the LAN.
    hostname: "127.0.0.1",
    // Raise the request idle timeout off Bun's 10s default. Long-lived clients
    // (the terminal attach WS, the log-stream WS) are idle between keystrokes /
    // output and were being reaped every 10s ("[Bun.serve]: request timed out").
    // 255 is the server max; the websocket block below sets its own larger one.
    idleTimeout: 255,
    async fetch(req, server) {
      const url = new URL(req.url);

      // WebSocket upgrade — broadcast channel
      if (url.pathname === "/ws") {
        if (server.upgrade(req, { data: { kind: "broadcast" } })) return undefined as any;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      // WebSocket upgrade — read-only per-process log tail
      const logMatch = url.pathname.match(/^\/ws\/processes\/([^/]+)\/logs$/);
      if (logMatch) {
        const id = decodeURIComponent(logMatch[1]!);
        if (server.upgrade(req, { data: { kind: "logs", id } })) return undefined as any;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      // WebSocket upgrade — bidirectional interactive attach (terminal).
      // Token-gated: writing to a PTY is arbitrary code execution, so unlike the
      // read-only log tail this requires the local token (injected by the dev
      // proxy on the upgrade request; browsers can't set WS headers themselves).
      const attachMatch = url.pathname.match(/^\/ws\/processes\/([^/]+)\/attach$/);
      if (attachMatch) {
        if (!tokenOk(req.headers.get("x-rt-token"), apiToken)) {
          return new Response("unauthorized", { status: 401 });
        }
        const id = decodeURIComponent(attachMatch[1]!);
        if (server.upgrade(req, { data: { kind: "attach", id } })) return undefined as any;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      // CORS headers for local dev
      const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      };

      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      // Gate mutating routes behind the local token (CORS is *, so this is the
      // CSRF defense against a malicious page driving control endpoints).
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
          const branch = decodeURIComponent(url.pathname.slice("/api/cache/".length));
          const result = await handleCommand("cache:read", { branches: [branch] });
          return Response.json(result, { headers: corsHeaders });
        }

        // Hooks repair: /api/hooks/:repo/repair
        if (url.pathname.startsWith("/api/hooks/") && url.pathname.endsWith("/repair") && req.method === "POST") {
          const repo = decodeURIComponent(url.pathname.slice("/api/hooks/".length, -"/repair".length));
          const result = await handleCommand("hooks:repair", { repo });
          return Response.json(result, { headers: corsHeaders });
        }

        // Launch a command in a worktree/package
        if (url.pathname === "/api/processes" && req.method === "POST") {
          const body = await req.json().catch(() => ({}));
          return Response.json(await handleCommand("process:create", body), { headers: corsHeaders });
        }

        // Discover a worktree's runnable packages + scripts
        if (url.pathname === "/api/worktrees/commands" && req.method === "GET") {
          const result = await handleCommand("worktree:commands", { path: url.searchParams.get("path") });
          return Response.json(result, { headers: corsHeaders });
        }

        // Canonical endpoints
        if (url.pathname === "/api/endpoints" && req.method === "GET") {
          const repo = url.searchParams.get("repo") ?? "";
          return Response.json(await handleCommand("endpoints:list", { repo }), { headers: corsHeaders });
        }
        if (url.pathname === "/api/endpoints/map" && req.method === "POST") {
          return Response.json(await handleCommand("endpoints:map", await req.json()), { headers: corsHeaders });
        }
        if (url.pathname === "/api/endpoints/unmap" && req.method === "POST") {
          return Response.json(await handleCommand("endpoints:unmap", await req.json()), { headers: corsHeaders });
        }
        if (url.pathname === "/api/endpoints/bounce-enable" && req.method === "POST") {
          return Response.json(await handleCommand("endpoints:bounce-enable", await req.json()), { headers: corsHeaders });
        }
        if (url.pathname === "/api/endpoints/bounce-disable" && req.method === "POST") {
          return Response.json(await handleCommand("endpoints:bounce-disable", await req.json()), { headers: corsHeaders });
        }

        // Open an interactive terminal session (login shell) in a worktree
        if (url.pathname === "/api/terminals" && req.method === "POST") {
          const body = await req.json().catch(() => ({}));
          return Response.json(await handleCommand("terminal:create", body), { headers: corsHeaders });
        }

        // Process control + introspection surface (/api/processes...)
        const procRoute = matchProcessApiRoute(req.method, url.pathname);
        if (procRoute) {
          const result = await handleCommand(procRoute.cmd, procRoute.payload);
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
          payload = Object.fromEntries(url.searchParams);
        }

        const result = await handleCommand(route.cmd, payload);
        return Response.json(result, { headers: corsHeaders });
      } catch (err) {
        return Response.json({ ok: false, error: String(err) }, { status: 500, headers: corsHeaders });
      }
    },
    websocket: {
      // Keep terminal/log sockets alive: an idle terminal sends nothing for long
      // stretches. 960 is Bun's per-socket max; combined with the default pings
      // this stops idle WS connections from being closed out from under the GUI.
      idleTimeout: 960,
      open(ws) {
        const data = ws.data as ApiWSData;
        // Log tail (read-only) and attach (bidirectional) share the same output
        // path: replay history, then forward live PTY output. Attach adds an
        // input path in message() below.
        if ((data?.kind === "logs" || data?.kind === "attach") && data.id) {
          if (useHerdr) {
            // Herdr path: bridge `herdr terminal attach` I/O to this WS connection.
            const bridge = spawnHerdrAttach({
              id: data.id,
              paneMap: herdrPaneMap!,
              userPath: processManager.userPath as string | undefined,
              send: (chunk) => { try { ws.send(chunk); } catch { /* client gone */ } },
            });
            data.term = bridge.term;
            data.herdrProc = bridge.proc;
            return;
          }
          data.unsub = openLogStream(data.id, {
            getReplay: (id) => logBuffer.getLastLines(id),
            subscribe: (id, cb) => processManager.subscribeToOutput(id, cb),
            send: (d) => { try { ws.send(d); } catch { /* client gone */ } },
          });
          return;
        }
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
        const data = ws.data as ApiWSData;
        if (data?.kind === "logs" || data?.kind === "attach") {
          if (useHerdr) {
            // Dispose the herdr attach bridge — the herdr pane keeps running.
            try { data.term?.kill(); } catch { /* */ }
            try { data.herdrProc?.kill(); } catch { /* */ }
          } else {
            // Detach only — the process (e.g. a shell session) keeps running so
            // the user can reconnect later and replay its history.
            try { data.unsub?.(); } catch { /* */ }
          }
          return;
        }
        wsClients.delete(ws);
        log.debug({ total: wsClients.size }, "ws client disconnected");
      },
      message(ws, msg) {
        const data = ws.data as ApiWSData;
        if (!data?.id) return;
        const id = data.id;
        // Log clients may send one control message — a resize — so the PTY
        // matches the viewer's terminal grid and TUIs (turbo, start:lite) stop
        // wrapping their in-place redraws.
        if (data.kind === "logs") {
          if (useHerdr) {
            handleLogStreamControl(msg as string | Uint8Array, {
              resize: (cols, rows) => { try { data.term?.resize(cols, rows); } catch { /* gone */ } },
            });
          } else {
            handleLogStreamControl(msg as string | Uint8Array, {
              resize: (cols, rows) => {
                try { processManager.getTerminal(id)?.resize(cols, rows); } catch { /* gone */ }
              },
            });
          }
          return;
        }
        // Attach clients are bidirectional: binary frames are keystrokes written
        // to the PTY, string frames are control (resize).
        if (data.kind === "attach") {
          if (useHerdr) {
            handleAttachMessage(msg as string | Uint8Array, {
              resize: (cols, rows) => { try { data.term?.resize(cols, rows); } catch { /* gone */ } },
              input: (bytes) => { try { data.term?.write(bytes); } catch { /* gone */ } },
            });
            return;
          }
          handleAttachMessage(msg as string | Uint8Array, {
            resize: (cols, rows) => {
              try { processManager.getTerminal(id)?.resize(cols, rows); } catch { /* gone */ }
            },
            input: (bytes) => {
              try { processManager.getTerminal(id)?.write(bytes); } catch { /* gone */ }
            },
          });
        }
      },
    },
  });

  log.info({ port: API_PORT }, "api server listening");
  return server;
}
