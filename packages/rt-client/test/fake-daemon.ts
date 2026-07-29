import { tmpdir } from "os";
import { join } from "path";

let sockCounter = 0;

/** Fake daemon over a unix socket: records requests, replies from a map. */
export function fakeDaemon(replies: Record<string, unknown>) {
  const sock = join(tmpdir(), `rt-client-test-${process.pid}-${sockCounter++}.sock`);
  const seen: Array<{ cmd: string; payload: unknown }> = [];
  const server = Bun.serve({
    unix: sock,
    async fetch(req) {
      const cmd = new URL(req.url).pathname.slice(1);
      const payload = req.method === "POST" ? await req.json() : undefined;
      seen.push({ cmd, payload });
      const reply = replies[cmd] ?? { ok: false, error: `unknown command: ${cmd}` };
      return Response.json(reply);
    },
  });
  return { sock, seen, stop: () => server.stop() };
}
