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
import { API_PORT } from "../daemon-config.ts";
import { needsToken, tokenOk, loadOrCreateApiToken } from "./api-auth.ts";
import { getAggregatedConnection } from "./freshness.ts";

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
  handleCommand: (cmd: string, payload: any, signal?: AbortSignal) => Promise<any>;
  log: Logger;
}

export function startApiServer(deps: ApiServerDeps): Server<any> {
  const { handleCommand, log } = deps;
  const apiToken = loadOrCreateApiToken();

  const server = Bun.serve<ApiWSData, never>({
    port: API_PORT,
    // Bind to loopback only — never expose the control surface on the LAN.
    hostname: "127.0.0.1",
    // Raise the request idle timeout off Bun's 10s default so long-lived
    // clients aren't reaped every 10s ("[Bun.serve]: request timed out").
    // 255 is the server max; the websocket block below sets its own larger one.
    idleTimeout: 255,
    async fetch(req, server) {
      const url = new URL(req.url);

      // WebSocket upgrade — broadcast channel
      if (url.pathname === "/ws") {
        if (server.upgrade(req, { data: { kind: "broadcast" } })) return undefined as any;
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
          const result = await handleCommand("cache:read", { branches: [branch] }, req.signal);
          return Response.json(result, { headers: corsHeaders });
        }

        // Hooks repair: /api/hooks/:repo/repair
        if (url.pathname.startsWith("/api/hooks/") && url.pathname.endsWith("/repair") && req.method === "POST") {
          const repo = decodeURIComponent(url.pathname.slice("/api/hooks/".length, -"/repair".length));
          const result = await handleCommand("hooks:repair", { repo }, req.signal);
          return Response.json(result, { headers: corsHeaders });
        }

        // Runs detail: /api/runs/:repo/:runId
        if (url.pathname.startsWith("/api/runs/") && req.method === "GET") {
          let rest: string | undefined;
          try {
            rest = decodeURIComponent(url.pathname.slice("/api/runs/".length));
          } catch {
            rest = undefined; // malformed %-encoding -> fall through to the 404 path below
          }
          if (rest !== undefined) {
            const slash = rest.indexOf("/");
            if (slash > 0 && slash < rest.length - 1) {
              const result = await handleCommand("runs:get", { repo: rest.slice(0, slash), runId: rest.slice(slash + 1) }, req.signal);
              return Response.json(result, { headers: corsHeaders });
            }
          }
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
          payload = Object.fromEntries(url.searchParams);
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
  });

  log.info({ port: API_PORT }, "api server listening");
  return server;
}
