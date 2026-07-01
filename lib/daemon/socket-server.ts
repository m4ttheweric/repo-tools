/**
 * Unix-socket IPC server at ~/.rt/rt.sock — the CLI/tray control channel.
 *
 * Commands are HTTP-shaped over the socket: the pathname is the command name
 * ("/cache:read" → "cache:read") and POST bodies carry the payload.
 */

import { existsSync, unlinkSync } from "fs";
import type { Server } from "bun";
import type { Logger } from "pino";
import { DAEMON_SOCK_PATH } from "../daemon-config.ts";

export function startSocketServer(opts: {
  handleCommand: (cmd: string, payload: any) => Promise<any>;
  log: Logger;
}): Server<any> {
  const { handleCommand, log } = opts;

  // Clean up stale socket
  if (existsSync(DAEMON_SOCK_PATH)) {
    try { unlinkSync(DAEMON_SOCK_PATH); } catch { /* */ }
  }

  const server = Bun.serve({
    unix: DAEMON_SOCK_PATH,
    async fetch(req) {
      try {
        const url = new URL(req.url);
        const cmd = url.pathname.slice(1); // "/cache:read" → "cache:read"

        let payload: any = {};
        if (req.method === "POST") {
          try { payload = await req.json(); } catch { /* empty body is fine */ }
        }

        const result = await handleCommand(cmd, payload);
        return Response.json(result);
      } catch (err) {
        return Response.json({ ok: false, error: String(err) }, { status: 500 });
      }
    },
  });

  log.info({ path: DAEMON_SOCK_PATH }, "socket server listening");
  return server;
}
