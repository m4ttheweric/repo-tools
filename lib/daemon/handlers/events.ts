/**
 * events:* — the daemon's optional pane-communication bus (RT-44).
 * Thin validation + delegation; the bus owns journal and waiter semantics.
 * Spec: docs/superpowers/specs/2026-08-18-rt-events-bus-design.md
 */

import type { Commands } from "../../../packages/rt-client/src/commands.ts";
import type { CommandResult, HandlerMap, TypedHandlers } from "./types.ts";
import type { EventsBus } from "../events-bus.ts";

const num = (v: unknown): number | undefined => {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

// events:wait is declared as a named member (not left to the HandlerMap index
// signature — that would fail TypedHandlers' required-key check in
// buildRoutedHandlers) with the widened (payload, signal?) shape, which stays
// assignable to TypedHandlers' payload-only signature.
export function createEventsHandlers(
  bus: EventsBus,
  broadcast: (type: string, data: any) => void,
): Pick<TypedHandlers, "events:emit" | "events:list"> & {
  "events:wait": (
    payload: Commands["events:wait"]["payload"],
    signal?: AbortSignal,
  ) => Promise<CommandResult<"events:wait">>;
} & HandlerMap {
  return {
    "events:emit": async (payload: Commands["events:emit"]["payload"]) => {
      const topic = typeof payload?.topic === "string" ? payload.topic.trim() : "";
      if (!topic) return { ok: false as const, error: "missing topic" };
      // One timestamp for both the journal row and the broadcast frame, so a
      // consumer comparing the two never sees them disagree.
      const emittedAt = Date.now();
      const id = bus.emitAt(topic, payload.payload, emittedAt);
      broadcast("event", { id, topic, payload: payload.payload ?? null, emittedAt });
      return { ok: true as const, data: { id } };
    },

    "events:list": async (payload: Commands["events:list"]["payload"]) => {
      const pattern = typeof payload?.pattern === "string" ? payload.pattern.trim() : "";
      if (!pattern) return { ok: false as const, error: "missing pattern" };
      const { events, cursor } = bus.list({ pattern, after: num(payload.after), limit: num(payload.limit) });
      return { ok: true as const, data: { events, cursor } };
    },

    // Widened-Handler shape: receives the request AbortSignal from the seam
    // so a dead client's waiter is removed instead of lingering to the cap.
    "events:wait": async (payload: Commands["events:wait"]["payload"], signal?: AbortSignal) => {
      const pattern = typeof payload?.pattern === "string" ? payload.pattern.trim() : "";
      if (!pattern) return { ok: false as const, error: "missing pattern" };
      const { events, cursor } = await bus.wait({
        pattern,
        after: num(payload.after),
        waitMs: num(payload.waitMs),
        signal,
      });
      return { ok: true as const, data: { events, cursor } };
    },
  };
}
