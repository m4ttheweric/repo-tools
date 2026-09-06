/**
 * gate:* — typed verbs over the gates store (BOARD-20/21 gate facility).
 * Thin validation + delegation; the store owns CAS/wake/persistence
 * semantics. Mirrors handlers/events.ts's shape and dual-path emit idiom.
 */

import type { Logger } from "pino";
import type { Commands } from "../../../packages/rt-client/src/commands.ts";
import { gateOptionValue } from "../../../packages/rt-client/src/commands.ts";
import type { CommandResult } from "./types.ts";
import type { EventsBus } from "../events-bus.ts";
import type { GatesStore, GateQuestion, GateAnswer, GateRow } from "../gates-store.ts";
import type { GatePush } from "../gate-push.ts";

/** Callers that omit `push` (e.g. handler-only tests) get a no-op: gate:*
    must work identically with or without the delivery layer wired in. */
const noopPush: GatePush = {
  onAnswered: async () => {},
  onOpened: async () => {},
  onClosed: async () => {},
};

// gates.db is a shared registry (mirrors events.ts's DEFAULT_LIST_LIMIT
// reasoning exactly): a client that omits `limit` must not be able to force
// a full-table read.
const DEFAULT_LIST_LIMIT = 500;
// Unlike events.ts's bare pass-through, a gate row carries its full
// questions+answers JSON, not a thin envelope -- a client-supplied limit
// still needs a ceiling, or a large explicit value is an oversized socket read.
const MAX_LIST_LIMIT = 1000;
const clampListLimit = (n: number | undefined): number =>
  Math.min(MAX_LIST_LIMIT, Math.max(1, Math.floor(n ?? DEFAULT_LIST_LIMIT)));

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
    Array.isArray(cand.options) && cand.options.every(isValidOption)
  );
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const LABEL_CAP_BYTES = 200;
const CONTEXT_CAP_BYTES = 8192;

function isValidOption(o: unknown): boolean {
  if (typeof o === "string") return true;
  if (!isPlainObject(o)) return false;
  return typeof o.value === "string" && o.value.length > 0 && typeof o.label === "string";
}

function oversizedLabel(questions: GateQuestion[]): string | null {
  for (const q of questions) {
    for (const o of q.options) {
      if (typeof o !== "string" && Buffer.byteLength(o.label, "utf8") > LABEL_CAP_BYTES) {
        return `option label exceeds ${LABEL_CAP_BYTES} bytes (question "${q.id}")`;
      }
    }
  }
  return null;
}

const ORIGIN_STRING_KEYS: ReadonlySet<string> = new Set(["paneId", "tabId", "runId", "worktree"]);
const ORIGIN_FIELD_CAP_BYTES = 1024;

/** Returns an error message on an invalid origin, null when it validates.
    Each string field is capped like label/context: the row and the
    gate/opened payload carry origin verbatim to every surface, so an
    unbounded field defeats the "at-most-8KB payload growth" budget. */
function invalidOrigin(v: unknown): string | null {
  if (!isPlainObject(v)) return "origin must be an object of string fields with presentation form|wait";
  for (const [key, val] of Object.entries(v)) {
    if (key === "presentation") {
      if (val !== "form" && val !== "wait") {
        return "origin must be an object of string fields with presentation form|wait";
      }
      continue;
    }
    if (!ORIGIN_STRING_KEYS.has(key) || typeof val !== "string") {
      return "origin must be an object of string fields with presentation form|wait";
    }
    if (Buffer.byteLength(val, "utf8") > ORIGIN_FIELD_CAP_BYTES) {
      return `origin.${key} exceeds ${ORIGIN_FIELD_CAP_BYTES} bytes`;
    }
  }
  return null;
}

/** gate-push resolves delivery off `nudge.session`; a malformed nudge would
    silently become "no delivery target" instead of a loud open-time reject. */
function isValidNudge(v: unknown): v is { session: string } {
  return isPlainObject(v) && typeof v.session === "string" && v.session.length > 0;
}

/** A wrapper relaunch opens a fresh gate that supersedes its own prior one
    from the SAME pane; delivering the closed-doorbell there would Escape
    the pane's brand-new form, an avoidable self-interrupt (recoverable via
    the queued doorbell, but not worth causing). Compares origin.paneId
    first, falling back to nudge.session when either paneId is absent; with
    nothing comparable on either axis, the two gates are treated as
    different panes and the push proceeds. */
function sameOpenerPane(a: GateRow, b: GateRow): boolean {
  const paneA = a.origin?.paneId;
  const paneB = b.origin?.paneId;
  if (paneA && paneB) return paneA === paneB;
  const sessionA = a.nudge?.session;
  const sessionB = b.nudge?.session;
  if (sessionA && sessionB) return sessionA === sessionB;
  return false;
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
      const members = question.options.map(gateOptionValue);
      for (const v of values as string[]) {
        if (!members.includes(v)) return `answer for "${qid}" is not one of its options: "${v}"`;
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
      const colonAt = subject.indexOf(":");
      if (!subject || colonAt === -1 || colonAt === subject.length - 1) return { ok: false as const, error: "invalid subject" };
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
      if (payload?.agent !== undefined && typeof payload.agent !== "string") {
        return { ok: false as const, error: "agent must be a string" };
      }
      if (payload?.pane !== undefined && typeof payload.pane !== "string") {
        return { ok: false as const, error: "pane must be a string" };
      }
      if (payload?.nudge !== undefined && !isValidNudge(payload.nudge)) {
        return { ok: false as const, error: "nudge must be an object with a string session" };
      }
      const labelError = oversizedLabel(questions);
      if (labelError) return { ok: false as const, error: labelError };
      if (payload?.context !== undefined) {
        if (typeof payload.context !== "string") return { ok: false as const, error: "context must be a string" };
        if (Buffer.byteLength(payload.context, "utf8") > CONTEXT_CAP_BYTES) {
          return { ok: false as const, error: `context exceeds ${CONTEXT_CAP_BYTES} bytes` };
        }
      }
      if (payload?.origin !== undefined) {
        const originError = invalidOrigin(payload.origin);
        if (originError) return { ok: false as const, error: originError };
      }

      const { row, supersededId } = store.open({
        subject, kind, questions,
        meta: payload?.meta, agent: payload?.agent, pane: payload?.pane, nudge: payload?.nudge,
        context: payload?.context, origin: payload?.origin,
      });

      // One timestamp for both the journal row and the broadcast frame (events:emit idiom).
      const emittedAt = Date.now();
      const label = typeof row.meta?.label === "string" ? row.meta.label : row.kind;
      const eventPayload = {
        id: row.id, subject: row.subject, kind: row.kind, questions: row.questions,
        meta: row.meta, agent: row.agent, paneId: row.pane, label,
        context: row.context, origin: row.origin,
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
        // Fetched fresh (unlike the event payload above): a form-blocked pane
        // on the superseded gate never gets an answer, so it needs the same
        // doorbell-then-Escape delivery onAnswered gives a real answer.
        const supersededRow = store.get(supersededId);
        if (supersededRow && !sameOpenerPane(row, supersededRow)) {
          firePush(push.onClosed(supersededRow), { verb: "gate:open", gateId: supersededRow.id });
        }
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
        firePush(push.onClosed(row), { verb: "gate:close", gateId: row.id });
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
