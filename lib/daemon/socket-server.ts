/**
 * Unix-socket IPC server at ~/.mattstack/rt/rt.sock — the CLI/tray control channel.
 *
 * Commands are HTTP-shaped over the socket: the pathname is the command name
 * ("/cache:read" → "cache:read") and POST bodies carry the payload.
 */

import { existsSync, unlinkSync } from "fs";
import type { Server } from "bun";
import type { Logger } from "pino";
import { DAEMON_SOCK_PATH } from "../daemon-config.ts";
import { MAX_REQUEST_BODY_SIZE } from "./request-limits.ts";

/**
 * Same code/message derivation as api-server.ts's outer-catch failure and
 * createHandleCommand's throw-to-envelope path (lib/daemon.ts, R035).
 * Duplicated rather than imported: this guards fetch()'s own routing/dispatch
 * bugs, a different failure class than a handleCommand throw (createHandleCommand
 * already catches those and never lets them reach this far).
 */
function deriveFailure(err: unknown): { code: string; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  const code =
    err && typeof err === "object" && typeof (err as { code?: unknown }).code === "string"
      ? (err as { code: string }).code
      : "handler-threw";
  return { code, message };
}

export function startSocketServer(opts: {
  handleCommand: (cmd: string, payload: any, signal?: AbortSignal) => Promise<any>;
  log: Logger;
}): Server<any> {
  const { handleCommand, log } = opts;

  // Clean up stale socket
  if (existsSync(DAEMON_SOCK_PATH)) {
    try { unlinkSync(DAEMON_SOCK_PATH); } catch { /* */ }
  }

  // @ts-expect-error bun-types (1.3.10) doesn't declare `idleTimeout` on the
  // unix-socket Options variant (typed `never` there via the
  // HostnamePortServeOptions/UnixServeOptions XOR) even though Bun accepts it
  // at runtime for unix sockets too — verified empirically. Remove this
  // suppression once bun-types catches up.
  const server = Bun.serve({
    unix: DAEMON_SOCK_PATH,
    // Raise Bun's implicit 10s idle-request timeout so long-poll requests
    // (events:wait, Task 5) aren't reaped mid-wait. This only raises the cap
    // on how long an idle connection may sit before Bun kills it — it never
    // holds connections open on its own.
    idleTimeout: 255,
    maxRequestBodySize: MAX_REQUEST_BODY_SIZE,
    async fetch(req) {
      try {
        const url = new URL(req.url);
        const cmd = url.pathname.slice(1); // "/cache:read" → "cache:read"

        let payload: any = {};
        if (req.method === "POST") {
          try { payload = await req.json(); } catch { /* empty body is fine */ }
        }

        const client = req.headers.get("x-rt-client");
        if (client) (payload as any)._client = client;
        const result = await handleCommand(cmd, payload, req.signal);
        return Response.json(result);
      } catch (err) {
        log.error({ err, url: req.url }, "socket request failed");
        return Response.json(
          { ok: false, error: String(err), failure: deriveFailure(err) },
          { status: 500 },
        );
      }
    },
  });

  log.info({ path: DAEMON_SOCK_PATH }, "socket server listening");
  return server;
}
