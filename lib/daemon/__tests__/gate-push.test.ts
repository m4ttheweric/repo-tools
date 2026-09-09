import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import pino from "pino";
import { createGatesStore, type GatesStore, type GateQuestion } from "../gates-store.ts";
import { createGatePush, GATE_ANSWERED_PHRASE, GATE_CLOSED_PHRASE, GATE_SUBSCRIPTION_PHRASE } from "../gate-push.ts";
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

  test("a chronically-failing subscriber on ONE prefix still reaches deadAfterFailures despite unrelated events on other prefixes (F12c regression)", async () => {
    const store = freshStore();
    const delivered: Array<{ sessionId: string }> = [];
    // Only the mr: subscriber's session fails; the run: subscriber always
    // succeeds -- so an unrelated run: event's fan-out must not reset (or
    // wipe) the mr: subscriber's failure count via the liveIds prune.
    const deliver = async (socketPath: string) => {
      delivered.push({ sessionId: socketPath });
      return socketPath === "shep-mr" ? { ok: false as const, error: "boom" } : { ok: true as const };
    };
    const push = createGatePush({
      store, deliver, resolveSession: (id) => ({ socketPath: id }), log, deadAfterFailures: 3,
    });
    store.subscribe({ subjectPrefix: "mr:", session: "shep-mr" });
    store.subscribe({ subjectPrefix: "run:", session: "shep-run" });
    const mrRow = store.open({ subject: "mr:https://x/1", kind: "review-post", questions: qs() }).row;
    const runRow = store.open({ subject: "run:r1", kind: "clarify", questions: qs() }).row;

    // Interleave: mr: failure, unrelated run: event, mr: failure, unrelated
    // run: event, mr: failure -- the third mr: failure crosses deadAfterFailures.
    await push.onOpened(mrRow);
    await push.onOpened(runRow);
    await push.onOpened(mrRow);
    await push.onOpened(runRow);
    await push.onOpened(mrRow);

    const mrSub = store.subscriptions().find((s) => s.session === "shep-mr")!;
    expect(mrSub.dead).toBe(true);
    const runSub = store.subscriptions().find((s) => s.session === "shep-run")!;
    expect(runSub.dead).toBe(false);
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

function w4Harness(opts: { deliverOk?: boolean; injectOk?: boolean; withInjector?: boolean } = {}) {
  const store = freshStore();
  const events: string[] = [];
  const deliver = async (_socketPath: string, _body: string) => {
    events.push("deliver");
    return opts.deliverOk === false ? { ok: false as const, error: "boom" } : { ok: true as const };
  };
  const injectEscape = async (paneId: string) => {
    events.push(`inject:${paneId}`);
    return opts.injectOk === false
      ? { ok: false as const, error: "pane_not_found: gone" }
      : { ok: true as const };
  };
  const push = createGatePush({
    store,
    deliver,
    resolveSession: (sessionId) => ({ socketPath: sessionId }),
    log,
    ...(opts.withInjector === false ? {} : { injectEscape }),
  });
  return { push, store, events };
}

function answeredFormGate(store: GatesStore, by: string, origin?: Record<string, unknown>) {
  // arguments.length, not `origin ?? default`: the W4 loop passes an
  // explicit `undefined` third argument to mean "no origin at all", which
  // is distinct from the two-arg callers below that want the form default.
  // `??` cannot tell those apart since both see `origin === undefined`.
  const passedOrigin = arguments.length >= 3 ? origin : { presentation: "form", paneId: "pane-7" };
  const row = store.open({
    subject: "mr:https://gitlab.example.com/x/1", kind: "review-post", questions: qs(),
    nudge: { session: "sess-1" }, pane: "pane-7",
    origin: passedOrigin as never,
  }).row;
  store.answer(row.id, { q: "a" }, by);
  return store.get(row.id)!;
}

describe("gate-push escape injection (W4)", () => {
  test("injects Escape to origin.paneId strictly AFTER the doorbell accept, remote answer", async () => {
    const { push, store, events } = w4Harness();
    const row = answeredFormGate(store, "console");
    await push.onAnswered(row);
    expect(events).toEqual(["deliver", "inject:pane-7"]);
    expect(store.get(row.id)!.delivery!.outcome).toBe("delivered");
  });

  test("no injection when the pane answered its own gate", async () => {
    const { push, store, events } = w4Harness();
    await push.onAnswered(answeredFormGate(store, "pane"));
    expect(events).toEqual(["deliver"]);
  });

  test("no injection for wait presentation, missing paneId, or missing origin", async () => {
    for (const origin of [{ presentation: "wait", paneId: "pane-7" }, { presentation: "form" }, undefined]) {
      const { push, store, events } = w4Harness();
      await push.onAnswered(answeredFormGate(store, "console", origin as never));
      expect(events).toEqual(["deliver"]);
    }
  });

  test("no injection when the doorbell failed (dead-pane degrades to reconcile-at-next-touch)", async () => {
    const { push, store, events } = w4Harness({ deliverOk: false });
    const row = answeredFormGate(store, "console");
    await push.onAnswered(row);
    expect(events).toEqual(["deliver"]);
    expect(store.get(row.id)!.delivery!.outcome).toBe("dead-pane");
  });

  test("injection failure is non-fatal and leaves the delivery outcome delivered", async () => {
    const { push, store, events } = w4Harness({ injectOk: false });
    const row = answeredFormGate(store, "console");
    await push.onAnswered(row);
    expect(events).toEqual(["deliver", "inject:pane-7"]);
    expect(store.get(row.id)!.delivery!.outcome).toBe("delivered");
  });

  test("no injector wired means today's doorbell-only behavior", async () => {
    const { push, store, events } = w4Harness({ withInjector: false });
    await push.onAnswered(answeredFormGate(store, "console"));
    expect(events).toEqual(["deliver"]);
  });
});

/** Unanswered form gate: open() only, no answer -- exercises the
    supersede/close paths, which never carry an answer. */
function openFormGate(store: GatesStore, origin?: Record<string, unknown>) {
  const passedOrigin = arguments.length >= 2 ? origin : { presentation: "form", paneId: "pane-7" };
  return store.open({
    subject: "mr:https://gitlab.example.com/x/1", kind: "review-post", questions: qs(),
    nudge: { session: "sess-1" }, pane: "pane-7",
    origin: passedOrigin as never,
  }).row;
}

describe("gate-push onClosed (supersede/close, W4 final-review M4)", () => {
  test("supersede: closing the stale gate fires the same doorbell-then-Escape delivery", async () => {
    const { push, store, events } = w4Harness();
    const stale = openFormGate(store);
    // A second open on the same subject+kind supersedes the first (relaunch case).
    store.open({ subject: stale.subject, kind: stale.kind, questions: qs() });
    await push.onClosed(store.get(stale.id)!);
    expect(events).toEqual(["deliver", "inject:pane-7"]);
    expect(store.get(stale.id)!.delivery!.outcome).toBe("delivered");
  });

  test("close: gate:close (abandoned) fires the same doorbell-then-Escape delivery", async () => {
    const { push, store, events } = w4Harness();
    const row = openFormGate(store);
    store.close(row.id, "abandoned");
    await push.onClosed(store.get(row.id)!);
    expect(events).toEqual(["deliver", "inject:pane-7"]);
    expect(store.get(row.id)!.delivery!.outcome).toBe("delivered");
  });

  test("the closed doorbell phrase names the gate as abandoned/closed, never as answered", async () => {
    const { push, store, delivered } = harness();
    const row = store.open({
      subject: "mr:https://x/1", kind: "review-post", questions: qs(), nudge: { session: "sess-1" },
    }).row;
    store.close(row.id, "abandoned");
    await push.onClosed(store.get(row.id)!);
    expect(delivered[0]!.body).toBe(wrapCrossSession("gate-facility", GATE_CLOSED_PHRASE(row.id, "abandoned")));
    expect(delivered[0]!.body).not.toContain("answered");
  });

  test("no injection for wait presentation, missing paneId, or missing origin, on close", async () => {
    for (const origin of [{ presentation: "wait", paneId: "pane-7" }, { presentation: "form" }, undefined]) {
      const { push, store, events } = w4Harness();
      const row = openFormGate(store, origin as never);
      store.close(row.id, "abandoned");
      await push.onClosed(store.get(row.id)!);
      expect(events).toEqual(["deliver"]);
    }
  });

  test("no injection when the close doorbell failed (dead-pane degrades to reconcile-at-next-touch)", async () => {
    const { push, store, events } = w4Harness({ deliverOk: false });
    const row = openFormGate(store);
    store.close(row.id, "abandoned");
    await push.onClosed(store.get(row.id)!);
    expect(events).toEqual(["deliver"]);
    expect(store.get(row.id)!.delivery!.outcome).toBe("dead-pane");
  });

  test("close injection failure is non-fatal and leaves the delivery outcome delivered", async () => {
    const { push, store, events } = w4Harness({ injectOk: false });
    const row = openFormGate(store);
    store.close(row.id, "abandoned");
    await push.onClosed(store.get(row.id)!);
    expect(events).toEqual(["deliver", "inject:pane-7"]);
    expect(store.get(row.id)!.delivery!.outcome).toBe("delivered");
  });

  test("no nudge means no pane push on close either", async () => {
    const { push, store, events } = w4Harness();
    const row = store.open({ subject: "run:r1", kind: "clarify", questions: qs() }).row;
    store.close(row.id, "abandoned");
    await push.onClosed(store.get(row.id)!);
    expect(events.length).toBe(0);
  });
});

describe("retryDeadPanes", () => {
  test("re-pushes dead-pane rows, marks delivered on success, gives up after the cap", async () => {
    const store = freshStore();
    let ok = false;
    const delivered: string[] = [];
    const push = createGatePush({
      store,
      deliver: async (_s, body) => { delivered.push(body); return ok ? { ok: true } : { ok: false, error: "dead" }; },
      resolveSession: (id) => ({ socketPath: id }),
      log,
      maxPaneRetries: 2,
    });
    const row = store.open({ subject: "herd:h/j", kind: "question", questions: qs(), nudge: { session: "w" } }).row;
    store.answer(row.id, { q: "a" }, "shepherd");
    await push.onAnswered(store.get(row.id)!);
    expect(store.get(row.id)!.delivery!.outcome).toBe("dead-pane");
    expect(await push.retryDeadPanes()).toEqual({ retried: 1, delivered: 0, gaveUp: 0 });
    ok = true;
    expect(await push.retryDeadPanes()).toEqual({ retried: 1, delivered: 1, gaveUp: 0 });
    expect(store.get(row.id)!.delivery!.outcome).toBe("delivered");
    expect(delivered.at(-1)).toBe(wrapCrossSession("gate-facility", GATE_ANSWERED_PHRASE(row.id)));
  });

  test("gives up after maxPaneRetries and stops retrying that gate", async () => {
    const store = freshStore();
    const push = createGatePush({ store, deliver: async () => ({ ok: false, error: "dead" }), resolveSession: (id) => ({ socketPath: id }), log, maxPaneRetries: 2 });
    const row = store.open({ subject: "herd:h/j", kind: "question", questions: qs(), nudge: { session: "w" } }).row;
    store.answer(row.id, { q: "a" }, "shepherd");
    await push.onAnswered(store.get(row.id)!);
    expect(await push.retryDeadPanes()).toEqual({ retried: 1, delivered: 0, gaveUp: 0 });
    expect(await push.retryDeadPanes()).toEqual({ retried: 1, delivered: 0, gaveUp: 1 });
    expect(await push.retryDeadPanes()).toEqual({ retried: 0, delivered: 0, gaveUp: 0 });
  });

  test("reentrancy guard returns zeros while a run is in flight", async () => {
    const store = freshStore();
    let deliverStarted = false;
    let deliverResolve: (() => void) = () => {};
    const deliverPromise = new Promise<void>((resolve) => { deliverResolve = resolve; });
    const push = createGatePush({
      store,
      deliver: async () => { deliverStarted = true; await deliverPromise; return { ok: false, error: "blocked" }; },
      resolveSession: (id) => ({ socketPath: id }),
      log,
      maxPaneRetries: 2,
    });
    const row = store.open({ subject: "herd:h/j", kind: "question", questions: qs(), nudge: { session: "w" } }).row;
    store.answer(row.id, { q: "a" }, "shepherd");
    store.markDelivery(row.id, "dead-pane");
    const first = push.retryDeadPanes();
    for (let i = 0; i < 100 && !deliverStarted; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    const second = push.retryDeadPanes();
    expect(await second).toEqual({ retried: 0, delivered: 0, gaveUp: 0 });
    deliverResolve();
    expect(await first).toEqual({ retried: 1, delivered: 0, gaveUp: 0 });
  });
});
