/**
 * lib/notify-bridge.ts — settings-driven notifier event bridge (gate events
 * pass, Task 3). A daemon-internal EventsBus.onBroadcast subscriber that
 * turns a matching `("event", frame)` broadcast into a queued desktop
 * notification, suppressed when the event's paneId is the currently
 * focused pane (the user is already looking at it).
 *
 * Rules are re-read per event (deps.rules()), not cached at subscribe time,
 * so a settings edit to rt.notify.eventBridges takes effect on the next
 * broadcast without a daemon restart. Every dependency call is wrapped: a
 * throwing rules()/paneFocused()/enqueue() only logs and moves on — this
 * subscriber must never crash the events bus's broadcast loop.
 */
import { matchTopic } from "./daemon/events-bus.ts";
import type { NotificationEvent } from "./state/notifier-store.ts";

export interface EventBridgeRule {
  pattern: string;
  category: string;
  title: string;
  message: string;
}

interface BroadcastEventFrame {
  id: number | string;
  topic: string;
  payload: unknown;
  emittedAt: number;
}

const TEMPLATE_FIELD_RE = /\{([^{}]+)\}/g;

/** `{field}` -> String(payload[field]); an unknown field renders as the literal `{field}`. */
function interpolate(template: string, payload: Record<string, unknown>): string {
  return template.replace(TEMPLATE_FIELD_RE, (literal, field: string) =>
    Object.prototype.hasOwnProperty.call(payload, field) ? String(payload[field]) : literal);
}

function isEventFrame(data: unknown): data is BroadcastEventFrame {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return typeof d.topic === "string";
}

export function startNotifyBridge(deps: {
  onBroadcast(fn: (type: string, data: unknown) => void): () => void;
  rules(): EventBridgeRule[];
  enqueue(e: NotificationEvent): void;
  paneFocused(paneId: string): Promise<boolean>;
  log?: { warn(o: unknown, msg: string): void };
}): () => void {
  const warn = (o: unknown, msg: string): void => { deps.log?.warn(o, msg); };

  const handleMatch = async (frame: BroadcastEventFrame, rule: EventBridgeRule): Promise<void> => {
    const payload = (frame.payload && typeof frame.payload === "object" ? frame.payload : {}) as Record<string, unknown>;
    const paneId = typeof payload.paneId === "string" ? payload.paneId : undefined;

    if (paneId !== undefined) {
      let focused = false;
      try {
        focused = await deps.paneFocused(paneId);
      } catch (err) {
        warn({ err, paneId }, "notify-bridge: paneFocused threw, treating as not-focused");
      }
      if (focused) return;
    }

    const event: NotificationEvent = {
      id: String(frame.id),
      title: interpolate(rule.title, payload),
      message: interpolate(rule.message, payload),
      category: rule.category,
      timestamp: Date.now(),
      paneId,
    };

    try {
      deps.enqueue(event);
    } catch (err) {
      warn({ err, eventId: event.id, topic: frame.topic }, "notify-bridge: enqueue threw");
    }
  };

  const onEvent = async (type: string, data: unknown): Promise<void> => {
    if (type !== "event") return;
    if (!isEventFrame(data)) return;

    let rules: EventBridgeRule[];
    try {
      rules = deps.rules();
    } catch (err) {
      warn({ err }, "notify-bridge: rules() threw");
      return;
    }

    for (const rule of rules) {
      let matched = false;
      try {
        matched = matchTopic(rule.pattern, data.topic);
      } catch (err) {
        warn({ err, pattern: rule.pattern }, "notify-bridge: matchTopic threw on rule pattern");
        continue;
      }
      if (!matched) continue;
      await handleMatch(data, rule);
    }
  };

  return deps.onBroadcast((type, data) => {
    void onEvent(type, data).catch((err) => {
      warn({ err }, "notify-bridge: unexpected error handling broadcast");
    });
  });
}
