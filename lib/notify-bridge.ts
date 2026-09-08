/**
 * lib/notify-bridge.ts — settings-driven notifier event bridge (gate events
 * pass, Task 3). A daemon-internal EventsBus.onBroadcast subscriber that
 * turns a matching `("event", frame)` broadcast into a queued desktop
 * notification, suppressed when the event's paneId is the currently
 * focused pane (the user is already looking at it). A rule's optional `url`
 * is interpolated the same way as title/message and carried onto the event
 * for the tray's click routing. The paneId used for both focus lookup and
 * the event falls back to `payload.origin.paneId` when the payload has no
 * top-level `paneId`, since engine-opened gates only carry the pane id
 * inside `origin`.
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
  subjectPrefix?: string;
  url?: string;
}

/** Parses the rt.notify.eventBridges setting value into rules, shared by the
    daemon's live setting read and by tests. Non-array input yields `[]`
    (warns unless `raw` is `undefined`, the unset-setting case). An entry
    missing pattern/category/title/message, or with a non-string
    subjectPrefix/url, is skipped with a warn. */
export function parseEventBridgeRules(raw: unknown, warn: (o: unknown, msg: string) => void): EventBridgeRule[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    warn({ raw }, "rt.notify.eventBridges must be an array; ignoring");
    return [];
  }
  const rules: EventBridgeRule[] = [];
  for (const entry of raw) {
    const e = entry as Partial<EventBridgeRule> | null;
    if (
      !e || typeof e !== "object" ||
      typeof e.pattern !== "string" || typeof e.category !== "string" ||
      typeof e.title !== "string" || typeof e.message !== "string"
    ) {
      warn({ entry }, "rt.notify.eventBridges: skipping invalid rule entry");
      continue;
    }
    const rawSubjectPrefix = (e as { subjectPrefix?: unknown }).subjectPrefix;
    if (rawSubjectPrefix !== undefined && typeof rawSubjectPrefix !== "string") {
      warn({ entry }, "rt.notify.eventBridges: skipping rule with non-string subjectPrefix");
      continue;
    }
    const rawUrl = (e as { url?: unknown }).url;
    if (rawUrl !== undefined && typeof rawUrl !== "string") {
      warn({ entry }, "rt.notify.eventBridges: skipping rule with non-string url");
      continue;
    }
    rules.push({
      pattern: e.pattern, category: e.category, title: e.title, message: e.message,
      ...(rawSubjectPrefix !== undefined ? { subjectPrefix: rawSubjectPrefix } : {}),
      ...(rawUrl !== undefined ? { url: rawUrl } : {}),
    });
  }
  return rules;
}

interface BroadcastEventFrame {
  id: number | string;
  topic: string;
  payload: unknown;
  emittedAt: number;
}

const TEMPLATE_FIELD_RE = /\{([^{}]+)\}/g;

/** The first question's label, or "" when the payload carries no questions
    array or that entry has no string label -- a rule referencing `{question}`
    must never surface `undefined` in a human-facing notification. */
function firstQuestionLabel(payload: Record<string, unknown>): string {
  const questions = payload.questions;
  if (!Array.isArray(questions) || questions.length === 0) return "";
  const first = questions[0];
  if (!first || typeof first !== "object") return "";
  const label = (first as Record<string, unknown>).label;
  return typeof label === "string" ? label : "";
}

/** `{field}` -> String(payload[field]); an unknown field renders as the literal
    `{field}`. `{question}` is the one computed field: it does not read
    payload.question but resolves to payload.questions[0].label. */
function interpolate(template: string, payload: Record<string, unknown>): string {
  return template.replace(TEMPLATE_FIELD_RE, (literal, field: string) => {
    if (field === "question") return firstQuestionLabel(payload);
    return Object.prototype.hasOwnProperty.call(payload, field) ? String(payload[field]) : literal;
  });
}

function isEventFrame(data: unknown): data is BroadcastEventFrame {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return typeof d.topic === "string";
}

/** `payload.paneId` wins when it is a non-empty string; otherwise falls
    back to `payload.origin.paneId`, since an engine-opened gate carries the
    pane id only inside `origin`. */
function resolvePaneId(payload: Record<string, unknown>): string | undefined {
  if (typeof payload.paneId === "string" && payload.paneId !== "") return payload.paneId;
  const origin = payload.origin;
  if (origin && typeof origin === "object") {
    const originPaneId = (origin as Record<string, unknown>).paneId;
    if (typeof originPaneId === "string" && originPaneId !== "") return originPaneId;
  }
  return undefined;
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
    const paneId = resolvePaneId(payload);

    if (paneId !== undefined) {
      let focused = false;
      try {
        focused = await deps.paneFocused(paneId);
      } catch (err) {
        warn({ err, paneId }, "notify-bridge: paneFocused threw, treating as not-focused");
      }
      if (focused) return;
    }

    const url = typeof rule.url === "string" ? interpolate(rule.url, payload) : "";

    const event: NotificationEvent = {
      id: String(frame.id),
      title: interpolate(rule.title, payload),
      message: interpolate(rule.message, payload),
      category: rule.category,
      timestamp: Date.now(),
      paneId,
      ...(url !== "" ? { url } : {}),
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
      if (rule.subjectPrefix !== undefined) {
        const payload = (data.payload && typeof data.payload === "object" ? data.payload : {}) as Record<string, unknown>;
        const subject = payload.subject;
        if (typeof subject !== "string" || !subject.startsWith(rule.subjectPrefix)) continue;
      }
      await handleMatch(data, rule);
    }
  };

  return deps.onBroadcast((type, data) => {
    void onEvent(type, data).catch((err) => {
      warn({ err }, "notify-bridge: unexpected error handling broadcast");
    });
  });
}
