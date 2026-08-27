import { tmpdir } from "os";
import { join } from "path";

/** A reply the fake returns as herdr's `{ error: { code, message } }` envelope. */
export class HerdrFakeError {
  constructor(public code: string, public message: string) {}
}

export type FakeHerdrHandler = (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>;

let counter = 0;

/**
 * herdr's wire contract, for tests: newline-delimited JSON over a unix
 * socket, one request per connection, the server closes after replying.
 * The handler returns the `result` object (with its `type` field) or a
 * HerdrFakeError; a thrown error becomes `internal_error`.
 */
export function fakeHerdr(handler: FakeHerdrHandler) {
  const sock = join(tmpdir(), `fake-herdr-${process.pid}-${counter++}.sock`);
  const seen: Array<{ id: string; method: string; params: Record<string, unknown> }> = [];
  const buffers = new Map<object, string>();
  const server = Bun.listen({
    unix: sock,
    socket: {
      data(socket, chunk) {
        const buf = (buffers.get(socket) ?? "") + chunk.toString();
        const nl = buf.indexOf("\n");
        if (nl < 0) {
          buffers.set(socket, buf);
          return;
        }
        buffers.delete(socket);
        const line = buf.slice(0, nl);
        void (async () => {
          let reply: string;
          let id = "";
          try {
            const req = JSON.parse(line) as { id: string; method: string; params?: Record<string, unknown> };
            id = req.id;
            const params = req.params ?? {};
            seen.push({ id, method: req.method, params });
            const out = await handler(req.method, params);
            reply = out instanceof HerdrFakeError
              ? JSON.stringify({ id, error: { code: out.code, message: out.message } })
              : JSON.stringify({ id, result: out });
          } catch (err) {
            reply = JSON.stringify({ id, error: { code: "internal_error", message: err instanceof Error ? err.message : String(err) } });
          }
          socket.write(reply + "\n");
          socket.end();
        })();
      },
      close(socket) {
        buffers.delete(socket);
      },
      error() {},
    },
  });
  return { sock, seen, stop: () => server.stop(true) };
}
