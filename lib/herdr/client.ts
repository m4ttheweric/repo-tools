import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export const HERDR_UNAVAILABLE = "herdr unavailable";

export type HerdrResult<T> = { ok: true; result: T } | { ok: false; code: string; message: string };

const PLAIN_TIMEOUT_MS = 5_000;
const WAIT_MARGIN_MS = 5_000;

/** The daemon runs outside any pane, so the path is configured, never inherited from herdr. */
export function herdrSocketPath(): string {
  return process.env.HERDR_SOCKET_PATH ?? join(homedir(), ".config", "herdr", "herdr.sock");
}

/** herdr answers a waiting call at its budget, not before; the socket must outlive it. */
export function waitTimeout(timeoutMs: number): number {
  return timeoutMs + WAIT_MARGIN_MS;
}

let seq = 0;

/**
 * One request, one connection: herdr reads a single line and closes after
 * replying, so there is nothing to pool. Never throws.
 */
export function herdrRequest<T = unknown>(
  method: string,
  params: Record<string, unknown> = {},
  opts: { timeoutMs?: number; sockPath?: string } = {},
): Promise<HerdrResult<T>> {
  const sockPath = opts.sockPath ?? herdrSocketPath();
  const timeoutMs = opts.timeoutMs ?? PLAIN_TIMEOUT_MS;
  const id = `rt:${process.pid}:${++seq}`;
  const line = JSON.stringify({ id, method, params }) + "\n";

  return new Promise((resolve) => {
    let settled = false;
    let buf = "";
    let conn: { end(): void } | undefined;
    const finish = (r: HerdrResult<T>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { conn?.end(); } catch { /* already closed */ }
      resolve(r);
    };
    const unavailable = (detail: string): HerdrResult<T> => ({ ok: false, code: "unreachable", message: `${HERDR_UNAVAILABLE}: ${detail}` });
    const timer = setTimeout(() => finish({ ok: false, code: "timeout", message: `herdr ${method} timed out after ${timeoutMs}ms` }), timeoutMs);

    if (!existsSync(sockPath)) {
      finish(unavailable(`no socket at ${sockPath}`));
      return;
    }

    const tryParseBuffered = (): HerdrResult<T> | undefined => {
      const nl = buf.indexOf("\n");
      if (nl < 0) return undefined;
      const text = buf.slice(0, nl);
      let parsed: { result?: T; error?: { code?: string; message?: string } };
      try {
        parsed = JSON.parse(text);
      } catch {
        return { ok: false, code: "invalid_response", message: `herdr ${method}: unparseable reply` };
      }
      return parsed.error
        ? { ok: false, code: String(parsed.error.code ?? "error"), message: String(parsed.error.message ?? "") }
        : { ok: true, result: parsed.result as T };
    };

    Bun.connect({
      unix: sockPath,
      socket: {
        open(socket) {
          if (settled) {
            try { socket.end(); } catch { /* already closed */ }
            return;
          }
          conn = socket;
          socket.write(line);
        },
        data(_socket, chunk) {
          buf += chunk.toString();
          const parsed = tryParseBuffered();
          if (parsed) finish(parsed);
        },
        error(_socket, err) {
          finish(unavailable(err.message));
        },
        connectError(_socket, err) {
          finish(unavailable(err.message));
        },
        close() {
          // `close` can fire before the `data` callback carrying a buffered
          // reply has run; check the buffer first, then yield a turn so a
          // pending `data` callback settles before this gives up.
          const parsed = tryParseBuffered();
          if (parsed) {
            finish(parsed);
            return;
          }
          queueMicrotask(() => finish(unavailable("connection closed before a reply")));
        },
      },
    }).catch((err: unknown) => finish(unavailable(err instanceof Error ? err.message : String(err))));
  });
}

/** The gate every pane verb sits behind: a socket that exists and answers. */
export async function herdrAvailable(sockPath: string = herdrSocketPath()): Promise<boolean> {
  if (!existsSync(sockPath)) return false;
  const res = await herdrRequest("session.snapshot", {}, { sockPath });
  return res.ok;
}
