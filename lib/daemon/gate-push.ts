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
import { GATE_BY_PANE } from "./gates-store.ts";
import type { EscapeInjector } from "./gate-escape.ts";

export const GATE_ANSWERED_PHRASE = (id: string) =>
  `[gate] ${id} answered elsewhere; re-read the registry and proceed on the recorded answer.`;

/** Sibling of GATE_ANSWERED_PHRASE for the supersede/close paths, which end
    a gate with no answer ever coming -- a form pane waiting on it needs the
    same doorbell-then-Escape nudge, worded so it never reads as "answered". */
export const GATE_CLOSED_PHRASE = (id: string, reason: GateRow["closedReason"]) =>
  reason === "superseded"
    ? `[gate] ${id} superseded by a newer gate; re-read the registry and proceed.`
    : `[gate] ${id} closed; re-read the registry and proceed.`;

/** Fan-out notification: push text is data, never instructions, and carries
    no opener-controlled content -- `subject` is opener-set and must never
    ride a cross-session message body. id + status only; the W2 protocol
    part imports this for priming. */
export const GATE_SUBSCRIPTION_PHRASE = (row: Pick<GateRow, "id" | "status">) =>
  `[gate] ${row.id} is now ${row.status}; re-read the gate registry.`;

const DEFAULT_DEAD_AFTER_FAILURES = 3;

export interface GatePush {
  /** Pane push (attended gates with a nudge) + subscription fan-out. */
  onAnswered(row: GateRow): Promise<void>;
  /** Subscription fan-out only -- there is no pane to wake on open. */
  onOpened(row: GateRow): Promise<void>;
  /** Pane push only, on a gate that ends WITHOUT an answer (supersede or
      gate:close). Same doorbell-then-Escape delivery as onAnswered -- a
      form-blocked pane otherwise never learns its gate ended. */
  onClosed(row: GateRow): Promise<void>;
  /** Retry dead-pane nudges up to maxPaneRetries per gate. */
  retryDeadPanes(): Promise<{ retried: number; delivered: number; gaveUp: number }>;
}

export function createGatePush(opts: {
  store: GatesStore;
  deliver: typeof deliverToInbox;
  resolveSession: (sessionId: string) => { socketPath: string } | null;
  /** Batch form for fan-out: one directory scan per event instead of one
      per subscriber. Optional so existing callers (and tests) that only
      wire `resolveSession` keep working unchanged, falling back to a
      per-subscriber resolveSession call. */
  resolveAll?: () => Map<string, { socketPath: string }>;
  log: Logger;
  deadAfterFailures?: number;
  injectEscape?: EscapeInjector;
  maxPaneRetries?: number;
}): GatePush {
  const { store, deliver, resolveSession, resolveAll, log } = opts;
  const deadAfterFailures = opts.deadAfterFailures ?? DEFAULT_DEAD_AFTER_FAILURES;
  const maxPaneRetries = opts.maxPaneRetries ?? 20;

  // Consecutive-failure counts live only in daemon memory, not the store:
  // the store's `lastDelivery` is a single observable outcome, not a running
  // tally. A daemon restart resets the count, which just means a
  // borderline-dead subscription gets a fresh run of chances -- acceptable,
  // since the alternative (persisting a counter) buys nothing `dead` doesn't
  // already give a reader.
  const consecutiveFailures = new Map<string, number>();
  const paneAttempts = new Map<string, number>();

  async function safeDeliver(socketPath: string, body: string, context: Record<string, unknown>): Promise<boolean> {
    try {
      const result = await deliver(socketPath, body);
      return result.ok;
    } catch (err) {
      log.warn({ err, ...context }, "gate-push: delivery threw");
      return false;
    }
  }

  async function pushToPane(row: GateRow, phrase: string): Promise<void> {
    const sessionId = row.nudge?.session;
    if (!sessionId) return;
    const binding = resolveSession(sessionId);
    if (!binding) {
      store.markDelivery(row.id, "dead-pane");
      return;
    }
    const body = wrapCrossSession("gate-facility", phrase);
    const ok = await safeDeliver(binding.socketPath, body, { gateId: row.id, sessionId });
    store.markDelivery(row.id, ok ? "delivered" : "dead-pane");
    // Escape only ever follows an ACCEPTED doorbell: the dismissed form's
    // next input must be the queued frame, and a dead pane has nothing
    // queued to find.
    if (!ok || !opts.injectEscape) return;
    if (row.origin?.presentation !== "form" || !row.origin.paneId) return;
    if (row.answer?.by === GATE_BY_PANE) return;
    const injected = await opts.injectEscape(row.origin.paneId);
    if (!injected.ok) {
      log.warn({ gateId: row.id, paneId: row.origin.paneId, error: injected.error }, "gate-push: escape injection failed; doorbell-only");
    }
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

  async function pushToSubscription(
    row: GateRow,
    sub: GateSubscription,
    registry: Map<string, { socketPath: string }> | null,
  ): Promise<void> {
    const binding = registry ? (registry.get(sub.session) ?? null) : resolveSession(sub.session);
    if (!binding) {
      recordSubscriptionOutcome(sub, false);
      return;
    }
    const body = wrapCrossSession("gate-facility", GATE_SUBSCRIPTION_PHRASE(row));
    const ok = await safeDeliver(binding.socketPath, body, { gateId: row.id, subId: sub.id });
    recordSubscriptionOutcome(sub, ok);
  }

  async function fanOut(row: GateRow): Promise<void> {
    // liveIds must span EVERY live subscription, not just this event's
    // prefix-filtered subset: pruning against `subs` would wipe the failure
    // counter of a live subscriber watching a different prefix on every
    // fan-out that doesn't match it, so a chronically-failing subscriber on
    // an untouched prefix could never reach deadAfterFailures.
    const allLive = store.subscriptions({ live: true });
    const subs = allLive.filter((sub) => row.subject.startsWith(sub.subjectPrefix));
    // Batch registry resolution: one scan for the whole fan-out (resolveAll,
    // when wired) rather than resolveSession re-scanning per subscriber.
    const registry = resolveAll ? resolveAll() : null;
    // Lazy prune: a subscription no longer in the live set (unsubscribed, or
    // pruned dead by a prior failure run) has nothing more to fail, so its
    // failure count would otherwise leak forever.
    const liveIds = new Set(allLive.map((s) => s.id));
    for (const key of [...consecutiveFailures.keys()]) {
      if (!liveIds.has(key)) consecutiveFailures.delete(key);
    }
    await Promise.all(subs.map((sub) => pushToSubscription(row, sub, registry)));
  }

  return {
    async onAnswered(row) {
      await Promise.all([pushToPane(row, GATE_ANSWERED_PHRASE(row.id)), fanOut(row)]);
    },
    async onOpened(row) {
      await fanOut(row);
    },
    async onClosed(row) {
      await pushToPane(row, GATE_CLOSED_PHRASE(row.id, row.closedReason));
    },
    async retryDeadPanes() {
      let retried = 0, delivered = 0, gaveUp = 0;
      const live = new Set<string>();
      for (const row of store.deadPanePushes()) {
        live.add(row.id);
        const attempts = paneAttempts.get(row.id) ?? 0;
        if (attempts >= maxPaneRetries) continue;
        retried++;
        paneAttempts.set(row.id, attempts + 1);
        await pushToPane(row, GATE_ANSWERED_PHRASE(row.id));
        const after = store.get(row.id);
        if (after?.delivery?.outcome === "delivered") { delivered++; paneAttempts.delete(row.id); }
        else if (attempts + 1 >= maxPaneRetries) { gaveUp++; log.warn({ gateId: row.id, session: row.nudge?.session }, "gate-push: pane nudge gave up; worker was never woken"); }
      }
      for (const id of [...paneAttempts.keys()]) if (!live.has(id)) paneAttempts.delete(id);
      return { retried, delivered, gaveUp };
    },
  };
}
