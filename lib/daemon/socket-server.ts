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
import { deriveFailure } from "./failure.ts";
import { MAX_REQUEST_BODY_SIZE } from "./request-limits.ts";

export function startSocketServer(opts: {
  handleCommand: (cmd: string, payload: any, signal?: AbortSignal) => Promise<any>;
  log: Logger;
}): Server<any> {
  const { handleCommand, log } = opts;

  // Clean up stale socket
  if (existsSync(DAEMON_SOCK_PATH)) {
    try { unlinkSync(DAEMON_SOCK_PATH); } catch { /* */ }
  }

  // R048: bun-types (1.3.10) doesn't declare `idleTimeout` on the unix-socket
  // Options variant (typed `never` there via the HostnamePortServeOptions/
  // UnixServeOptions XOR) even though Bun accepts it at runtime for unix
  // sockets too — verified empirically. A cast rather than `@ts-expect-error`:
  // the directive form breaks `tsc --noEmit` outright (TS2578, "unused
  // directive") the day bun-types adds the property, since `@types/bun` is
  // pinned to "latest"; this stays correct either way.
  const server = Bun.serve({
    unix: DAEMON_SOCK_PATH,
    // Raise Bun's implicit 10s idle-request timeout so long-poll requests
    // (events:wait, Task 5) aren't reaped mid-wait. This only raises the cap
    // on how long an idle connection may sit before Bun kills it — it never
    // holds connections open on its own.
    idleTimeout: 255,
    maxRequestBodySize: MAX_REQUEST_BODY_SIZE,
    async fetch(req: Request) {
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
  } as unknown as Parameters<typeof Bun.serve>[0]);

  log.info({ path: DAEMON_SOCK_PATH }, "socket server listening");
  return server;
}
