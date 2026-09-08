/**
 * Long-lived herdr `events.subscribe` stream. herdr keeps the connection
 * open after the ack and pushes one JSON object per line; a dropped
 * connection is reconnected with capped backoff, and events retained
 * before a (re)subscribe are never replayed by herdr, so callers reconcile
 * from their own state on `onState(true)`.
 *
 * herdr rejects the whole request when any subscription entry omits a field
 * that entry's type requires: `pane.agent_status_changed` needs a `pane_id`,
 * while `pane.closed`, `pane.exited` and `pane.agent_detected` accept the
 * wildcard form.
 */
import { existsSync } from "fs";

export interface HerdrEvent { type: string; pane_id?: string; agent_status?: string; [k: string]: unknown }
export interface HerdrSubscription { stop(): void; connected(): boolean }

let seq = 0;

/**
 * herdr names a pushed frame's `event` inconsistently: `pane_closed`,
 * `pane_exited` and `pane_agent_detected` arrive underscored while
 * `pane.agent_status_changed` arrives dotted. Subscription entries are always
 * dotted, so the first underscore becomes the namespace separator and callers
 * match one vocabulary.
 */
function eventType(name: string): string {
  return name.includes(".") ? name : name.replace("_", ".");
}

export function subscribeHerdrEvents(opts: {
  sockPath: string;
  subscriptions: Array<Record<string, unknown>>;
  onEvent: (ev: HerdrEvent) => void;
  onState?: (connected: boolean) => void;
  log: { warn(o: unknown, m?: string): void; debug(o: unknown, m?: string): void };
  backoffMs?: { initial: number; max: number };
}): HerdrSubscription {
  const initial = opts.backoffMs?.initial ?? 1_000;
  const max = opts.backoffMs?.max ?? 30_000;
  let stopped = false;
  let connected = false;
  let delay = initial;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let current: { end(): void } | undefined;

  const setConnected = (c: boolean) => {
    if (connected === c) return;
    connected = c;
    opts.onState?.(c);
  };

  const scheduleReconnect = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (stopped) return;
    timer = setTimeout(connect, delay);
    delay = Math.min(max, delay * 2);
  };

  function connect(): void {
    if (stopped) return;
    if (!existsSync(opts.sockPath)) { scheduleReconnect(); return; }
    const id = `rt:sub:${process.pid}:${++seq}`;
    // A multibyte UTF-8 character can straddle a socket chunk boundary;
    // decoding each chunk on its own turns each half into its own U+FFFD, and
    // JSON.parse still succeeds on the corrupted text. One streaming decoder
    // per connection holds the trailing bytes until the rest arrives.
    const decoder = new TextDecoder();
    let buf = "";
    let acked = false;
    // A failed attempt can surface as a rejected connect, an error then a
    // close, or a bare close; only the first of those schedules the retry.
    let settled = false;
    const retry = () => {
      setConnected(false);
      if (settled) return;
      settled = true;
      scheduleReconnect();
    };
    Bun.connect({
      unix: opts.sockPath,
      socket: {
        open(socket) {
          if (stopped) {
            try { socket.end(); } catch { /* already closed */ }
            return;
          }
          current = socket;
          socket.write(JSON.stringify({ id, method: "events.subscribe", params: { subscriptions: opts.subscriptions } }) + "\n");
        },
        data(_socket, chunk) {
          if (stopped) return;
          buf += decoder.decode(chunk, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            let parsed: unknown;
            try { parsed = JSON.parse(line); } catch { opts.log.warn({ line: line.slice(0, 200) }, "herdr subscribe: unparseable line"); continue; }
            if (typeof parsed !== "object" || parsed === null) continue;
            const frame = parsed as { id?: unknown; event?: unknown; data?: unknown; error?: unknown };
            if (typeof frame.event === "string") {
              const data = typeof frame.data === "object" && frame.data !== null ? frame.data as Record<string, unknown> : {};
              opts.onEvent({ ...data, event: frame.event, type: eventType(frame.event) });
              continue;
            }
            if (frame.error) {
              opts.log.warn({ error: frame.error, sockPath: opts.sockPath }, "herdr subscribe: request rejected");
              continue;
            }
            if (!acked && frame.id === id) {
              acked = true;
              delay = initial;
              setConnected(true);
            }
          }
        },
        close() {
          current = undefined;
          retry();
        },
        error(_socket, err) {
          opts.log.debug({ err: err.message, sockPath: opts.sockPath }, "herdr subscribe: socket error");
        },
      },
    }).catch((err: unknown) => {
      opts.log.debug({ err: err instanceof Error ? err.message : String(err) }, "herdr subscribe: connect failed");
      retry();
    });
  }

  connect();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      try { current?.end(); } catch { /* already closed */ }
      setConnected(false);
    },
    connected: () => connected,
  };
}
