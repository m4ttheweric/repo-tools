/**
 * Push events from the rt daemon's WebSocket relay (127.0.0.1:9401),
 * `{ type, data, timestamp }` frames.
 *
 * Ported verbatim from mr-board's src/rt-client.ts.
 */
import type { RtClientOptions } from "./transport.ts";

export type RelayEventType =
  | "project-mrs"
  | "discussions:update"
  | "discussions:new-comments"
  | "mr:status"
  | (string & {});

export const DEFAULT_WS_URL = "ws://127.0.0.1:9401/ws";

/**
 * Subscribe to the daemon's broadcast channel. Reconnects with capped
 * exponential backoff (1s to 30s) until the returned stop function runs;
 * the daemon being down just means silence, never a crash.
 */
export function subscribe(
  onEvent: (type: RelayEventType, data: unknown) => void,
  opts: RtClientOptions = {},
): () => void {
  const url = opts.wsUrl ?? DEFAULT_WS_URL;
  let ws: WebSocket | null = null;
  let stopped = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const connect = () => {
    if (stopped) return;
    ws = new WebSocket(url);
    ws.onopen = () => { attempt = 0; };
    ws.onmessage = (ev) => {
      try {
        const frame = JSON.parse(String(ev.data)) as { type?: unknown; data?: unknown };
        if (typeof frame.type === "string") onEvent(frame.type, frame.data);
      } catch {
        // Non-JSON frame; ignore.
      }
    };
    ws.onclose = () => {
      if (stopped) return;
      const delay = Math.min(30_000, 1_000 * 2 ** attempt++);
      timer = setTimeout(connect, delay);
    };
    ws.onerror = () => {
      try { ws?.close(); } catch { /* already closed */ }
    };
  };

  connect();
  return () => {
    stopped = true;
    clearTimeout(timer);
    try { ws?.close(); } catch { /* already closed */ }
  };
}

/**
 * One daemon subscription for the whole process, republished onto a
 * caller-chosen pub/sub topic. Every subscriber to that topic then shares
 * one relay connection instead of each opening its own — filtering here
 * (rather than at each subscriber) is what keeps an unrelated event from
 * making every subscriber re-render.
 *
 * Ported from console's `startRelay` (src/server/ws.ts) with the match
 * predicate and target topic lifted to arguments.
 */
export function createRelay(
  cfg: { match: (topic: string) => boolean; topic: string; publish: (topic: string, data: string) => void },
  opts: RtClientOptions = {},
): () => void {
  const doSubscribe = opts.subscribeImpl ?? subscribe;
  return doSubscribe((type, data) => {
    if (type !== "event") return;
    const frame = data as { topic?: unknown };
    if (typeof frame?.topic !== "string" || !cfg.match(frame.topic)) return;
    cfg.publish(cfg.topic, JSON.stringify(data));
  }, opts);
}
