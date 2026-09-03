/**
 * gate:* — typed verbs over the gates store (BOARD-20/21 gate facility).
 * Thin validation + delegation; the store owns CAS/wake/persistence
 * semantics. Mirrors handlers/events.ts's shape and dual-path emit idiom.
 */

import type { Logger } from "pino";
import type { Commands } from "../../../packages/rt-client/src/commands.ts";
import type { CommandResult } from "./types.ts";
import type { EventsBus } from "../events-bus.ts";
import type { GatesStore, GateQuestion, GateAnswer, GateRow } from "../gates-store.ts";
import type { GatePush } from "../gate-push.ts";

/** Callers that omit `push` (e.g. handler-only tests) get a no-op: gate:*
    must work identically with or without the delivery layer wired in. */
const noopPush: GatePush = {
  onAnswered: async () => {},
  onOpened: async () => {},
};

// gates.db is a shared registry (mirrors events.ts's DEFAULT_LIST_LIMIT
// reasoning exactly): a client that omits `limit` must not be able to force
// a full-table read.
const DEFAULT_LIST_LIMIT = 500;
const clampListLimit = (n: number | undefined): number => Math.max(1, Math.floor(n ?? DEFAULT_LIST_LIMIT));

const num = (v: unknown): number | undefined => {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

function isValidQuestion(q: unknown): q is GateQuestion {
  const cand = q as Partial<GateQuestion> | null;
  return (
    typeof cand === "object" && cand !== null &&
    typeof cand.id === "string" && cand.id.length > 0 &&
    typeof cand.label === "string" &&
    typeof cand.multi === "boolean" &&
    Array.isArray(cand.options) && cand.options.every((o) => typeof o === "string")
  );
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Both wire shapes carry the same value underneath: bare, or `{value, note?}`
    when the panel attaches free text. Validation reads only the value. */
function unwrapAnswerValue(raw: unknown): unknown {
  if (raw && typeof raw === "object" && !Array.isArray(raw) && "value" in (raw as Record<string, unknown>)) {
    return (raw as { value: unknown }).value;
  }
  return raw;
}

/**
 * Option membership is required whenever a question declares options,
 * checked against the unwrapped value (every element, for multi); an
 * empty options array stays free-form. Every question id must also appear
 * as an answers key -- an omitted question is not a legitimate decision
 * (an intentional empty multi-select `{tiers: []}` already satisfies this).
 * The sole validation point before an answer reaches storage.
 */
function validateAnswers(questions: GateQuestion[], answers: Record<string, unknown>): string | null {
  const byId = new Map(questions.map((q) => [q.id, q]));
  for (const [qid, raw] of Object.entries(answers)) {
    const question = byId.get(qid);
    if (!question) return `unknown question id: ${qid}`;
    const value = unwrapAnswerValue(raw);
    const isArray = Array.isArray(value);
    if (question.multi && !isArray) return `question ${qid} expects an array (multi)`;
    if (!question.multi && isArray) return `question ${qid} expects a single value`;
    const values = isArray ? (value as unknown[]) : [value];
    if (!values.every((v) => typeof v === "string")) return `question ${qid} value must be a string`;
    if (question.options.length > 0) {
      for (const v of values as string[]) {
        if (!question.options.includes(v)) return `answer for "${qid}" is not one of its options: "${v}"`;
      }
    }
  }
  const missing = questions.map((q) => q.id).filter((id) => !(id in answers));
  if (missing.length > 0) return `missing answer(s) for: ${missing.join(", ")}`;
  return null;
}

export function createGateHandlers(
  store: GatesStore,
  bus: EventsBus,
  broadcast: (type: string, data: any) => void,
  deps: { push?: GatePush; log?: Logger } = {},
): { "gate:open": (payload: unknown) => Promise<CommandResult<"gate:open">> }
  & { "gate:answer": (payload: unknown) => Promise<CommandResult<"gate:answer">> }
  & { "gate:wait": (payload: unknown, signal?: AbortSignal) => Promise<CommandResult<"gate:wait">> }
  & { "gate:list": (payload: unknown) => Promise<CommandResult<"gate:list">> }
  & { "gate:park": (payload: unknown) => Promise<CommandResult<"gate:park">> }
  & { "gate:close": (payload: unknown) => Promise<CommandResult<"gate:close">> }
  & { "gate:subscribe": (payload: unknown) => Promise<CommandResult<"gate:subscribe">> }
  & { "gate:unsubscribe": (payload: unknown) => Promise<CommandResult<"gate:unsubscribe">> }
  & { "gate:subscriptions": (payload: unknown) => Promise<CommandResult<"gate:subscriptions">> } {
  const push = deps.push ?? noopPush;
  const log = deps.log;
  // Fire-and-forget: a push/fan-out failure must never fail the verb that
  // triggered it. The promise itself is not expected to reject (gate-push
  // catches and records delivery outcomes internally), but a logged catch
  // guards against anything unexpected escaping that contract.
  const firePush = (promise: Promise<void>, context: Record<string, unknown>): void => {
    promise.catch((err) => log?.warn({ err, ...context }, "gate-push: fire-and-forget push failed"));
  };

  // Shared dual-path emit (journal emitAt + broadcast, one timestamp) for
  // every lifecycle topic below -- mirrors the events:emit handler's path,
  // the only one live subscribers (board relay, notify bridge) ever see.
  const emitGateEvent = (topic: string, payload: Record<string, unknown>, emittedAt: number): void => {
    const eventId = bus.emitAt(topic, payload, emittedAt);
    broadcast("event", { id: eventId, topic, payload, emittedAt });
  };

  const emitReleased = (row: GateRow, emittedAt: number): void => {
    emitGateEvent(`gate/released/${row.id}`, {
      id: row.id, subject: row.subject, kind: row.kind, paneId: row.pane, delivery: row.delivery,
    }, emittedAt);
  };

  return {
    "gate:open": async (rawPayload: unknown) => {
      const payload = rawPayload as Commands["gate:open"]["payload"] | undefined;
      const subject = typeof payload?.subject === "string" ? payload.subject.trim() : "";
      const kind = typeof payload?.kind === "string" ? payload.kind.trim() : "";
      if (!subject || !subject.includes(":")) return { ok: false as const, error: "invalid subject" };
      if (!kind) return { ok: false as const, error: "missing kind" };
      const questions = payload?.questions;
      if (!Array.isArray(questions) || questions.length === 0 || !questions.every(isValidQuestion)) {
        return { ok: false as const, error: "invalid questions" };
      }
      const ids = questions.map((q) => q.id);
      if (new Set(ids).size !== ids.length) return { ok: false as const, error: "duplicate question id" };
      if (payload?.meta !== undefined && !isPlainObject(payload.meta)) {
        return { ok: false as const, error: "meta must be a plain object" };
      }

      const { row, supersededId } = store.open({
        subject, kind, questions,
        meta: payload?.meta, agent: payload?.agent, pane: payload?.pane, nudge: payload?.nudge,
      });

      // One timestamp for both the journal row and the broadcast frame (events:emit idiom).
      const emittedAt = Date.now();
      const label = typeof row.meta?.label === "string" ? row.meta.label : row.kind;
      const eventPayload = {
        id: row.id, subject: row.subject, kind: row.kind, questions: row.questions,
        meta: row.meta, agent: row.agent, paneId: row.pane, label,
      };
      emitGateEvent(`gate/opened/${row.id}`, eventPayload, emittedAt);

      // The supersede rule closes the old gate in the SAME store transaction;
      // its closed event fires here, alongside the opener's, sharing the
      // timestamp -- same subject/kind as the new gate (supersede only ever
      // matches on both), so no extra row fetch is needed.
      if (supersededId) {
        emitGateEvent(`gate/closed/${supersededId}`, {
          id: supersededId, subject: row.subject, kind: row.kind,
          reason: "superseded", supersededBy: row.id,
        }, emittedAt);
      }

      firePush(push.onOpened(row), { verb: "gate:open", gateId: row.id });

      return { ok: true as const, data: { id: row.id, supersededId } };
    },

    "gate:answer": async (rawPayload: unknown) => {
      const payload = rawPayload as Commands["gate:answer"]["payload"] | undefined;
      const id = typeof payload?.id === "string" ? payload.id.trim() : "";
      const by = typeof payload?.by === "string" ? payload.by.trim() : "";
      if (!id) return { ok: false as const, error: "missing id" };
      if (!by) return { ok: false as const, error: "missing by" };
      const answers = payload?.answers;
      if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
        return { ok: false as const, error: "missing answers" };
      }

      const gate = store.get(id);
      if (!gate) return { ok: false as const, error: "not-found" };
      const validationError = validateAnswers(gate.questions, answers as Record<string, unknown>);
      if (validationError) return { ok: false as const, error: validationError };

      const result = store.answer(id, answers as GateAnswer["answers"], by);
      const emittedAt = Date.now();

      if (result.ok) {
        const row = result.row;
        const eventPayload = {
          id: row.id, subject: row.subject, kind: row.kind,
          answers: row.answer?.answers, by, paneId: row.pane,
        };
        emitGateEvent(`gate/answered/${row.id}`, eventPayload, emittedAt);
        firePush(push.onAnswered(row), { verb: "gate:answer", gateId: row.id });
        // Winner-path release (by === "pane") shares the answer's timestamp:
        // one transaction, one moment, two events.
        if (result.released) emitReleased(row, emittedAt);
        return { ok: true as const, data: { row } };
      }

      // Loser-path release: a CAS-losing pane still proves it reconciled.
      if (result.released) emitReleased(result.row!, emittedAt);

      // A CAS loss is a defined outcome, not an error: the loser gets the
      // winning row typed, not an envelope hack.
      if (result.reason === "already-answered") {
        return { ok: true as const, data: { row: result.row!, conflict: true } };
      }
      return { ok: false as const, error: result.reason };
    },

    // Widened-Handler shape: receives the request AbortSignal from the seam,
    // same as events:wait, so a dead client's waiter is removed rather than
    // lingering to the cap. Clamping to 240s lives in gates-store.wait.
    "gate:wait": async (rawPayload: unknown, signal?: AbortSignal) => {
      const payload = rawPayload as Commands["gate:wait"]["payload"] | undefined;
      const id = typeof payload?.id === "string" ? payload.id.trim() : "";
      if (!id) return { ok: false as const, error: "missing id" };
      const result = await store.wait(id, { waitMs: num(payload?.waitMs), signal });
      if (result.status === "not-found") return { ok: false as const, error: "not-found" };
      if (result.status === "timeout") return { ok: true as const, data: { status: "timeout" as const } };
      return { ok: true as const, data: { status: result.status, row: result.row } };
    },

    "gate:list": async (rawPayload: unknown) => {
      const payload = rawPayload as Commands["gate:list"]["payload"] | undefined;
      const { gates, cursor } = store.list({
        open: payload?.open,
        subjectPrefix: payload?.subjectPrefix,
        kind: payload?.kind,
        cursor: num(payload?.cursor),
        limit: clampListLimit(num(payload?.limit)),
      });
      return { ok: true as const, data: { gates, cursor } };
    },

    "gate:park": async (rawPayload: unknown) => {
      const payload = rawPayload as Commands["gate:park"]["payload"] | undefined;
      const id = typeof payload?.id === "string" ? payload.id.trim() : "";
      if (!id) return { ok: false as const, error: "missing id" };
      const result = store.park(id);
      if (result.ok) {
        const row = store.get(id)!;
        emitGateEvent(`gate/parked/${row.id}`, { id: row.id, subject: row.subject, kind: row.kind }, Date.now());
        return { ok: true as const, data: { ok: true as const } };
      }
      return { ok: false as const, error: result.reason };
    },

    "gate:close": async (rawPayload: unknown) => {
      const payload = rawPayload as Commands["gate:close"]["payload"] | undefined;
      const id = typeof payload?.id === "string" ? payload.id.trim() : "";
      const reason = payload?.reason;
      if (!id) return { ok: false as const, error: "missing id" };
      if (reason !== "abandoned" && reason !== "superseded" && reason !== "pruned") {
        return { ok: false as const, error: "invalid reason" };
      }
      const result = store.close(id, reason);
      if (result.ok) {
        const row = store.get(id)!;
        emitGateEvent(`gate/closed/${row.id}`, { id: row.id, subject: row.subject, kind: row.kind, reason: row.closedReason }, Date.now());
        return { ok: true as const, data: { ok: true as const } };
      }
      return { ok: false as const, error: result.reason };
    },

    "gate:subscribe": async (rawPayload: unknown) => {
      const payload = rawPayload as Commands["gate:subscribe"]["payload"] | undefined;
      const subjectPrefix = typeof payload?.subjectPrefix === "string" ? payload.subjectPrefix.trim() : "";
      const session = typeof payload?.session === "string" ? payload.session.trim() : "";
      if (!subjectPrefix) return { ok: false as const, error: "missing subjectPrefix" };
      if (!session) return { ok: false as const, error: "missing session" };
      const sub = store.subscribe({ subjectPrefix, session });
      return { ok: true as const, data: { id: sub.id } };
    },

    "gate:unsubscribe": async (rawPayload: unknown) => {
      const payload = rawPayload as Commands["gate:unsubscribe"]["payload"] | undefined;
      const id = typeof payload?.id === "string" ? payload.id.trim() : "";
      if (!id) return { ok: false as const, error: "missing id" };
      const removed = store.unsubscribe(id);
      return { ok: true as const, data: { removed } };
    },

    "gate:subscriptions": async (rawPayload: unknown) => {
      const payload = rawPayload as Commands["gate:subscriptions"]["payload"] | undefined;
      const session = typeof payload?.session === "string" ? payload.session.trim() : "";
      const subscriptions = store.subscriptions({ live: payload?.live, session: session || undefined });
      return { ok: true as const, data: { subscriptions } };
    },
  };
}
