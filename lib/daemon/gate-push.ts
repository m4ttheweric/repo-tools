/**
 * gate-push — envelope-wrapped pane push on gate answered, plus subscription
 * fan-out on both opened and answered. Delivery is always fire-and-forget
 * from the caller's side (handlers/gate.ts): every outcome here is recorded
 * on the store, never thrown, so a delivery failure can never fail a gate:*
 * verb.
 *
 * Binding rule: the pane push targets `row.nudge.session` ONLY. The opener records its own session id at `gate open`; `row.pane` is
 * a focus/resume ref, never a delivery target. No nudge means no push --
 * the unattended-gate case blocks in `gate wait` with nothing to wake.
 *
 * Answers never travel in the push body: it is always the fixed
 * envelope-wrapped phrase, so a stale or racing pane is told to re-read the
 * registry rather than trust a value that may already be stale by delivery
 * time.
 */

import type { Logger } from "pino";
import { deliverToInbox, wrapCrossSession } from "./inbox.ts";
import type { GateRow, GateSubscription, GatesStore } from "./gates-store.ts";

export const GATE_ANSWERED_PHRASE = (id: string) =>
  `[gate] ${id} answered elsewhere; re-read the registry and proceed on the recorded answer.`;

/** Fan-out notification: a subscriber is never told the answer, only that
    the gate moved, and where to look. */
const GATE_SUBSCRIPTION_PHRASE = (row: GateRow) =>
  `[gate] ${row.subject} (${row.id}) is now ${row.status}; check the gate registry for the current state.`;

const DEFAULT_DEAD_AFTER_FAILURES = 3;

export interface GatePush {
  /** Pane push (attended gates with a nudge) + subscription fan-out. */
  onAnswered(row: GateRow): Promise<void>;
  /** Subscription fan-out only -- there is no pane to wake on open. */
  onOpened(row: GateRow): Promise<void>;
}

export function createGatePush(opts: {
  store: GatesStore;
  deliver: typeof deliverToInbox;
  resolveSession: (sessionId: string) => { socketPath: string } | null;
  log: Logger;
  deadAfterFailures?: number;
}): GatePush {
  const { store, deliver, resolveSession, log } = opts;
  const deadAfterFailures = opts.deadAfterFailures ?? DEFAULT_DEAD_AFTER_FAILURES;

  // Consecutive-failure counts live only in daemon memory, not the store:
  // the store's `lastDelivery` is a single observable outcome, not a running
  // tally. A daemon restart resets the count, which just means a
  // borderline-dead subscription gets a fresh run of chances -- acceptable,
  // since the alternative (persisting a counter) buys nothing `dead` doesn't
  // already give a reader.
  const consecutiveFailures = new Map<string, number>();

  async function safeDeliver(socketPath: string, body: string, context: Record<string, unknown>): Promise<boolean> {
    try {
      const result = await deliver(socketPath, body);
      return result.ok;
    } catch (err) {
      log.warn({ err, ...context }, "gate-push: delivery threw");
      return false;
    }
  }

  async function pushToPane(row: GateRow): Promise<void> {
    const sessionId = row.nudge?.session;
    if (!sessionId) return;
    const binding = resolveSession(sessionId);
    if (!binding) {
      store.markDelivery(row.id, "dead-pane");
      return;
    }
    const body = wrapCrossSession("gate-facility", GATE_ANSWERED_PHRASE(row.id));
    const ok = await safeDeliver(binding.socketPath, body, { gateId: row.id, sessionId });
    store.markDelivery(row.id, ok ? "delivered" : "dead-pane");
  }

  function recordSubscriptionOutcome(sub: GateSubscription, ok: boolean): void {
    store.markSubscriptionDelivery(sub.id, ok ? "delivered" : "failed");
    if (ok) {
      consecutiveFailures.delete(sub.id);
      return;
    }
    const count = (consecutiveFailures.get(sub.id) ?? 0) + 1;
    if (count >= deadAfterFailures) {
      store.markSubscriptionDead(sub.id);
      consecutiveFailures.delete(sub.id);
    } else {
      consecutiveFailures.set(sub.id, count);
    }
  }

  async function pushToSubscription(row: GateRow, sub: GateSubscription): Promise<void> {
    const binding = resolveSession(sub.session);
    if (!binding) {
      recordSubscriptionOutcome(sub, false);
      return;
    }
    const body = wrapCrossSession("gate-facility", GATE_SUBSCRIPTION_PHRASE(row));
    const ok = await safeDeliver(binding.socketPath, body, { gateId: row.id, subId: sub.id });
    recordSubscriptionOutcome(sub, ok);
  }

  async function fanOut(row: GateRow): Promise<void> {
    const subs = store.subscriptions({ live: true }).filter((sub) => row.subject.startsWith(sub.subjectPrefix));
    await Promise.all(subs.map((sub) => pushToSubscription(row, sub)));
  }

  return {
    async onAnswered(row) {
      await Promise.all([pushToPane(row), fanOut(row)]);
    },
    async onOpened(row) {
      await fanOut(row);
    },
  };
}
