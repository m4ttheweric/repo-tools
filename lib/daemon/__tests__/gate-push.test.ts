import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import pino from "pino";
import { createGatesStore, type GatesStore, type GateQuestion } from "../gates-store.ts";
import { createGatePush, GATE_ANSWERED_PHRASE, GATE_SUBSCRIPTION_PHRASE } from "../gate-push.ts";
import { wrapCrossSession } from "../inbox.ts";

const log = pino({ level: "silent" });

let dirs: string[] = [];
beforeEach(() => { dirs = []; });
afterEach(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

function qs(): GateQuestion[] {
  return [{ id: "q", label: "Pick", multi: false, options: ["a", "b"] }];
}

function freshStore(): GatesStore {
  const dir = mkdtempSync(join(tmpdir(), "rt-gate-push-"));
  dirs.push(dir);
  return createGatesStore({ dbPath: join(dir, "gates.db"), log });
}

/** Every session id resolves to a binding keyed by the id itself (so the
    fake deliver can report back which session a push targeted), unless
    `deliverOk` is false, in which case delivery itself reports failure --
    resolution still succeeds so the "failed" and "unresolvable" halves of
    the outcome mapping stay independently testable. */
function harness(opts: { deliverOk?: boolean; deadAfterFailures?: number } = {}) {
  const store = freshStore();
  const delivered: Array<{ sessionId: string; body: string }> = [];
  const deliver = async (socketPath: string, body: string) => {
    delivered.push({ sessionId: socketPath, body });
    return opts.deliverOk === false ? { ok: false as const, error: "boom" } : { ok: true as const };
  };
  const resolveSession = (sessionId: string) => ({ socketPath: sessionId });
  const push = createGatePush({
    store,
    deliver,
    resolveSession,
    log,
    deadAfterFailures: opts.deadAfterFailures,
  });
  return { push, store, delivered };
}

describe("gate-push", () => {
  test("onAnswered pushes the ENVELOPE-WRAPPED fixed phrase to nudge.session; records delivered, NOT released", async () => {
    const { push, store, delivered } = harness();
    const row = store.open({ subject: "mr:https://x/1", kind: "review-post", questions: qs(), nudge: { session: "sess-1" } }).row;
    store.answer(row.id, { q: "a" }, "console");
    await push.onAnswered(store.get(row.id)!);
    expect(delivered[0]!.body).toBe(wrapCrossSession("gate-facility", GATE_ANSWERED_PHRASE(row.id)));
    expect(delivered[0]!.sessionId).toBe("sess-1");
    expect(store.get(row.id)!.delivery!.outcome).toBe("delivered");
    expect(store.get(row.id)!.released).toBe(false); // only pane reconciliation releases
  });

  test("a failed or unresolvable delivery records dead-pane and does NOT mark released", async () => {
    const { push, store } = harness({ deliverOk: false });
    const row = store.open({ subject: "mr:https://x/1", kind: "review-post", questions: qs(), nudge: { session: "sess-gone" } }).row;
    store.answer(row.id, { q: "a" }, "console");
    await push.onAnswered(store.get(row.id)!);
    expect(store.get(row.id)!.delivery!.outcome).toBe("dead-pane");
    expect(store.get(row.id)!.released).toBe(false);
  });

  test("no nudge means no pane push (unattended gates block in wait; there is nothing to wake)", async () => {
    const { push, store, delivered } = harness();
    const row = store.open({ subject: "run:r1", kind: "clarify", questions: qs() }).row;
    store.answer(row.id, { q: "a" }, "board");
    await push.onAnswered(store.get(row.id)!);
    expect(delivered.length).toBe(0);
  });

  test("subscription fan-out fires on opened AND answered, matched by subject prefix", async () => {
    const { push, store, delivered } = harness();
    store.subscribe({ subjectPrefix: "run:", session: "shep-1" });
    const row = store.open({ subject: "run:r1", kind: "clarify", questions: qs() }).row;
    await push.onOpened(row);
    store.answer(row.id, { q: "a" }, "console");
    await push.onAnswered(store.get(row.id)!);
    expect(delivered.filter((d) => d.sessionId === "shep-1").length).toBe(2);
  });

  test("repeated failures mark a subscription dead OBSERVABLY: pruned from live, readable unfiltered with its outcome", async () => {
    const { push, store } = harness({ deliverOk: false, deadAfterFailures: 2 });
    const sub = store.subscribe({ subjectPrefix: "run:", session: "shep-1" });
    const row = store.open({ subject: "run:r1", kind: "clarify", questions: qs() }).row;
    await push.onOpened(row); await push.onOpened(row);
    expect(store.subscriptions({ live: true }).length).toBe(0);
    const dead = store.subscriptions().find((x) => x.id === sub.id)!;
    expect(dead.dead).toBe(true);
    expect(dead.lastDelivery!.outcome).toBe("failed");
  });

  test("duplicate subscribe (idempotent) never doubles the fan-out (F3)", async () => {
    const { push, store, delivered } = harness();
    store.subscribe({ subjectPrefix: "run:", session: "shep-1" });
    store.subscribe({ subjectPrefix: "run:", session: "shep-1" }); // returns the SAME row, no second insert
    const row = store.open({ subject: "run:r1", kind: "clarify", questions: qs() }).row;
    await push.onOpened(row);
    expect(delivered.filter((d) => d.sessionId === "shep-1").length).toBe(1);
  });

  test("subscription push carries ONLY the fixed id+status phrase, never the opener-controlled subject (F6)", async () => {
    const { push, store, delivered } = harness();
    store.subscribe({ subjectPrefix: "mr:", session: "shep-1" });
    const row = store.open({ subject: "mr:https://x/1?evil=<script>", kind: "review-post", questions: qs() }).row;
    await push.onOpened(row);
    expect(delivered[0]!.body).toBe(wrapCrossSession("gate-facility", GATE_SUBSCRIPTION_PHRASE(row)));
    expect(delivered[0]!.body).not.toContain(row.subject);
    expect(delivered[0]!.body).toContain(row.id);
    expect(delivered[0]!.body).toContain(row.status);
  });

  test("fan-out resolves the subscriber registry ONCE per event when resolveAll is wired (F8)", async () => {
    const store = freshStore();
    const delivered: Array<{ sessionId: string; body: string }> = [];
    const deliver = async (socketPath: string, body: string) => {
      delivered.push({ sessionId: socketPath, body });
      return { ok: true as const };
    };
    let resolveAllCalls = 0;
    const resolveAll = () => {
      resolveAllCalls++;
      return new Map([
        ["shep-1", { socketPath: "shep-1" }],
        ["shep-2", { socketPath: "shep-2" }],
      ]);
    };
    const push = createGatePush({
      store,
      deliver,
      resolveSession: () => { throw new Error("resolveSession must not be called when resolveAll is wired"); },
      resolveAll,
      log,
    });
    store.subscribe({ subjectPrefix: "run:", session: "shep-1" });
    store.subscribe({ subjectPrefix: "run:", session: "shep-2" });
    const row = store.open({ subject: "run:r1", kind: "clarify", questions: qs() }).row;
    await push.onOpened(row);
    expect(resolveAllCalls).toBe(1); // one directory scan for both subscribers
    expect(delivered.map((d) => d.sessionId).sort()).toEqual(["shep-1", "shep-2"]);
  });
});
