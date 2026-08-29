/**
 * events:* — the daemon's optional pane-communication bus (RT-44).
 * Thin validation + delegation; the bus owns journal and waiter semantics.
 * Spec: docs/superpowers/specs/2026-08-18-rt-events-bus-design.md
 */

import type { Commands } from "../../../packages/rt-client/src/commands.ts";
import type { CommandResult } from "./types.ts";
import type { EventsBus } from "../events-bus.ts";

const num = (v: unknown): number | undefined => {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

// Every member takes a direct `unknown` payload rather than
// `Pick<TypedHandlers, ...>`'s per-command type: a wider `unknown` param
// still satisfies TypedHandlers' narrower one at the command-router.ts
// assembly site (function parameter contravariance), and stays directly
// assignable to Handler with no HandlerMap-intersection escape hatch needed.
export function createEventsHandlers(
  bus: EventsBus,
  broadcast: (type: string, data: any) => void,
): { "events:emit": (payload: unknown) => Promise<CommandResult<"events:emit">> }
  & { "events:list": (payload: unknown) => Promise<CommandResult<"events:list">> }
  & { "events:head": (payload: unknown) => Promise<CommandResult<"events:head">> }
  & { "events:wait": (payload: unknown, signal?: AbortSignal) => Promise<CommandResult<"events:wait">> } {
  return {
    "events:emit": async (rawPayload: unknown) => {
      const payload = rawPayload as Commands["events:emit"]["payload"] | undefined;
      const topic = typeof payload?.topic === "string" ? payload.topic.trim() : "";
      if (!topic) return { ok: false as const, error: "missing topic" };
      // One timestamp for both the journal row and the broadcast frame, so a
      // consumer comparing the two never sees them disagree.
      const emittedAt = Date.now();
      const id = bus.emitAt(topic, payload?.payload, emittedAt);
      broadcast("event", { id, topic, payload: payload?.payload ?? null, emittedAt });
      return { ok: true as const, data: { id } };
    },

    "events:list": async (rawPayload: unknown) => {
      const payload = rawPayload as Commands["events:list"]["payload"] | undefined;
      const pattern = typeof payload?.pattern === "string" ? payload.pattern.trim() : "";
      if (!pattern) return { ok: false as const, error: "missing pattern" };
      const { events, cursor } = bus.list({ pattern, after: num(payload?.after), limit: num(payload?.limit) });
      return { ok: true as const, data: { events, cursor } };
    },

    "events:head": async () => {
      return { ok: true as const, data: { cursor: bus.head() } };
    },

    // Widened-Handler shape: receives the request AbortSignal from the seam
    // so a dead client's waiter is removed instead of lingering to the cap.
    "events:wait": async (rawPayload: unknown, signal?: AbortSignal) => {
      const payload = rawPayload as Commands["events:wait"]["payload"] | undefined;
      const pattern = typeof payload?.pattern === "string" ? payload.pattern.trim() : "";
      if (!pattern) return { ok: false as const, error: "missing pattern" };
      const { events, cursor } = await bus.wait({
        pattern,
        after: num(payload?.after),
        waitMs: num(payload?.waitMs),
        signal,
      });
      return { ok: true as const, data: { events, cursor } };
    },
  };
}
