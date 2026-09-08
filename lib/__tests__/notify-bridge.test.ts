/**
 * lib/notify-bridge.ts — the settings-driven notifier event bridge (gate
 * events pass, Task 3). Fake deps only: no daemon, no events.db, no herdr
 * socket. Real wiring (EventsBus.onBroadcast, the herdr session.snapshot
 * pane-focus lookup, the notify_queue insert) is exercised where each of
 * those pieces already has its own suite.
 */
import { describe, test, expect } from "bun:test";
import { startNotifyBridge, parseEventBridgeRules, type EventBridgeRule } from "../notify-bridge.ts";
import type { NotificationEvent } from "../state/notifier-store.ts";

/** A fake onBroadcast that captures the subscriber so the test can fire broadcasts by hand. */
function fakeBus(): {
  onBroadcast(fn: (type: string, data: unknown) => void): () => void;
  emit(type: string, data: unknown): Promise<void>;
} {
  const subs = new Set<(type: string, data: unknown) => void>();
  return {
    onBroadcast(fn) {
      subs.add(fn);
      return () => { subs.delete(fn); };
    },
    async emit(type, data) {
      for (const fn of [...subs]) fn(type, data);
      // Let the bridge's internal async handling (paneFocused awaits, etc.) settle.
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

const GATE_RULE: EventBridgeRule = {
  pattern: "board/gate/opened/*",
  category: "gate",
  title: "review gate: !{iid}",
  message: "{mrUrl}",
};

describe("startNotifyBridge", () => {
  test("matching event enqueues an interpolated NotificationEvent carrying paneId", async () => {
    const bus = fakeBus();
    const enqueued: NotificationEvent[] = [];
    const paneFocusedCalls: string[] = [];

    startNotifyBridge({
      onBroadcast: bus.onBroadcast,
      rules: () => [GATE_RULE],
      enqueue: (e) => { enqueued.push(e); },
      paneFocused: async (paneId) => { paneFocusedCalls.push(paneId); return false; },
    });

    await bus.emit("event", {
      id: 1,
      topic: "board/gate/opened/g1",
      payload: { iid: 7, paneId: "w1:p1", mrUrl: "https://gitlab.com/acme/web/-/merge_requests/7" },
      emittedAt: Date.now(),
    });

    expect(enqueued).toHaveLength(1);
    const e = enqueued[0]!;
    expect(e.title).toBe("review gate: !7");
    expect(e.message).toBe("https://gitlab.com/acme/web/-/merge_requests/7");
    expect(e.category).toBe("gate");
    expect(e.paneId).toBe("w1:p1");
    expect(paneFocusedCalls).toEqual(["w1:p1"]);
  });

  test("{question} resolves to the first question's label", async () => {
    const bus = fakeBus();
    const enqueued: NotificationEvent[] = [];

    startNotifyBridge({
      onBroadcast: bus.onBroadcast,
      rules: () => [{ pattern: "board/gate/opened/*", category: "gate", title: "{label}", message: "{question}" }],
      enqueue: (e) => { enqueued.push(e); },
      paneFocused: async () => false,
    });

    await bus.emit("event", {
      id: 9,
      topic: "board/gate/opened/g9",
      payload: { label: "review gate", questions: [{ id: "q1", label: "Approve this MR?" }, { id: "q2", label: "second" }] },
      emittedAt: Date.now(),
    });

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.message).toBe("Approve this MR?");
  });

  test("{question} renders empty when the event payload has no questions", async () => {
    const bus = fakeBus();
    const enqueued: NotificationEvent[] = [];

    startNotifyBridge({
      onBroadcast: bus.onBroadcast,
      rules: () => [{ pattern: "board/gate/opened/*", category: "gate", title: "{label}", message: "{question}" }],
      enqueue: (e) => { enqueued.push(e); },
      paneFocused: async () => false,
    });

    await bus.emit("event", {
      id: 10,
      topic: "board/gate/opened/g10",
      payload: { label: "review gate" },
      emittedAt: Date.now(),
    });

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.message).toBe("");
  });

  test("an unknown template field renders literally, not as undefined", async () => {
    const bus = fakeBus();
    const enqueued: NotificationEvent[] = [];

    startNotifyBridge({
      onBroadcast: bus.onBroadcast,
      rules: () => [{ pattern: "board/gate/opened/*", category: "gate", title: "{missingField}", message: "ok" }],
      enqueue: (e) => { enqueued.push(e); },
      paneFocused: async () => false,
    });

    await bus.emit("event", {
      id: 2,
      topic: "board/gate/opened/g2",
      payload: { iid: 1 },
      emittedAt: Date.now(),
    });

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.title).toBe("{missingField}");
  });

  test("paneFocused resolving true suppresses the notification (no enqueue)", async () => {
    const bus = fakeBus();
    const enqueued: NotificationEvent[] = [];

    startNotifyBridge({
      onBroadcast: bus.onBroadcast,
      rules: () => [GATE_RULE],
      enqueue: (e) => { enqueued.push(e); },
      paneFocused: async () => true,
    });

    await bus.emit("event", {
      id: 3,
      topic: "board/gate/opened/g3",
      payload: { iid: 8, paneId: "w1:p1", mrUrl: "https://gitlab.com/acme/web/-/merge_requests/8" },
      emittedAt: Date.now(),
    });

    expect(enqueued).toHaveLength(0);
  });

  test("a non-matching topic no-ops", async () => {
    const bus = fakeBus();
    const enqueued: NotificationEvent[] = [];

    startNotifyBridge({
      onBroadcast: bus.onBroadcast,
      rules: () => [GATE_RULE],
      enqueue: (e) => { enqueued.push(e); },
      paneFocused: async () => false,
    });

    await bus.emit("event", {
      id: 4,
      topic: "board/gate/closed/g1",
      payload: { iid: 7 },
      emittedAt: Date.now(),
    });

    expect(enqueued).toHaveLength(0);
  });

  test("a non-'event' broadcast type no-ops", async () => {
    const bus = fakeBus();
    const enqueued: NotificationEvent[] = [];
    const paneFocusedCalls: string[] = [];

    startNotifyBridge({
      onBroadcast: bus.onBroadcast,
      rules: () => [GATE_RULE],
      enqueue: (e) => { enqueued.push(e); },
      paneFocused: async (paneId) => { paneFocusedCalls.push(paneId); return false; },
    });

    await bus.emit("notification", {
      id: "x",
      title: "unrelated",
      message: "unrelated",
      category: "general",
      timestamp: Date.now(),
    });

    expect(enqueued).toHaveLength(0);
    expect(paneFocusedCalls).toEqual([]);
  });

  test("a payload without paneId enqueues without calling paneFocused", async () => {
    const bus = fakeBus();
    const enqueued: NotificationEvent[] = [];
    const paneFocusedCalls: string[] = [];

    startNotifyBridge({
      onBroadcast: bus.onBroadcast,
      rules: () => [GATE_RULE],
      enqueue: (e) => { enqueued.push(e); },
      paneFocused: async (paneId) => { paneFocusedCalls.push(paneId); return false; },
    });

    await bus.emit("event", {
      id: 5,
      topic: "board/gate/opened/g5",
      payload: { iid: 9, mrUrl: "https://gitlab.com/acme/web/-/merge_requests/9" },
      emittedAt: Date.now(),
    });

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.paneId).toBeUndefined();
    expect(paneFocusedCalls).toEqual([]);
  });

  test("a throwing enqueue is caught and logged, never crashes the subscriber", async () => {
    const bus = fakeBus();
    const warnings: unknown[] = [];

    startNotifyBridge({
      onBroadcast: bus.onBroadcast,
      rules: () => [GATE_RULE],
      enqueue: () => { throw new Error("db is busy"); },
      paneFocused: async () => false,
      log: { warn: (o) => { warnings.push(o); } },
    });

    await bus.emit("event", {
      id: 6,
      topic: "board/gate/opened/g6",
      payload: { iid: 1, mrUrl: "x" },
      emittedAt: Date.now(),
    });

    expect(warnings.length).toBeGreaterThan(0);
  });

  test("a throwing paneFocused is treated as not-focused (still enqueues) and logged", async () => {
    const bus = fakeBus();
    const enqueued: NotificationEvent[] = [];
    const warnings: unknown[] = [];

    startNotifyBridge({
      onBroadcast: bus.onBroadcast,
      rules: () => [GATE_RULE],
      enqueue: (e) => { enqueued.push(e); },
      paneFocused: async () => { throw new Error("herdr unavailable"); },
      log: { warn: (o) => { warnings.push(o); } },
    });

    await bus.emit("event", {
      id: 7,
      topic: "board/gate/opened/g7",
      payload: { iid: 1, paneId: "w1:p1", mrUrl: "x" },
      emittedAt: Date.now(),
    });

    expect(enqueued).toHaveLength(1);
    expect(warnings.length).toBeGreaterThan(0);
  });

  test("the returned unsubscribe stops the bridge from reacting to further broadcasts", async () => {
    const bus = fakeBus();
    const enqueued: NotificationEvent[] = [];

    const stop = startNotifyBridge({
      onBroadcast: bus.onBroadcast,
      rules: () => [GATE_RULE],
      enqueue: (e) => { enqueued.push(e); },
      paneFocused: async () => false,
    });
    stop();

    await bus.emit("event", {
      id: 8,
      topic: "board/gate/opened/g8",
      payload: { iid: 1, mrUrl: "x" },
      emittedAt: Date.now(),
    });

    expect(enqueued).toHaveLength(0);
  });

  test("payload with only origin.paneId enqueues with the origin pane and calls paneFocused with it", async () => {
    const bus = fakeBus();
    const enqueued: NotificationEvent[] = [];
    const paneFocusedCalls: string[] = [];

    startNotifyBridge({
      onBroadcast: bus.onBroadcast,
      rules: () => [GATE_RULE],
      enqueue: (e) => { enqueued.push(e); },
      paneFocused: async (paneId) => { paneFocusedCalls.push(paneId); return false; },
    });

    await bus.emit("event", {
      id: 11,
      topic: "board/gate/opened/g11",
      payload: { iid: 7, mrUrl: "x", origin: { paneId: "w1:p9" } },
      emittedAt: Date.now(),
    });

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.paneId).toBe("w1:p9");
    expect(paneFocusedCalls).toEqual(["w1:p9"]);
  });

  test("payload.paneId wins over payload.origin.paneId when both are present", async () => {
    const bus = fakeBus();
    const enqueued: NotificationEvent[] = [];
    const paneFocusedCalls: string[] = [];

    startNotifyBridge({
      onBroadcast: bus.onBroadcast,
      rules: () => [GATE_RULE],
      enqueue: (e) => { enqueued.push(e); },
      paneFocused: async (paneId) => { paneFocusedCalls.push(paneId); return false; },
    });

    await bus.emit("event", {
      id: 12,
      topic: "board/gate/opened/g12",
      payload: { iid: 7, mrUrl: "x", paneId: "w1:p1", origin: { paneId: "w1:p9" } },
      emittedAt: Date.now(),
    });

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.paneId).toBe("w1:p1");
    expect(paneFocusedCalls).toEqual(["w1:p1"]);
  });

  test("a rule with url interpolates it and enqueues event.url", async () => {
    const bus = fakeBus();
    const enqueued: NotificationEvent[] = [];

    startNotifyBridge({
      onBroadcast: bus.onBroadcast,
      rules: () => [{ ...GATE_RULE, url: "https://board.local/?gate={id}" }],
      enqueue: (e) => { enqueued.push(e); },
      paneFocused: async () => false,
    });

    await bus.emit("event", {
      id: 13,
      topic: "board/gate/opened/g13",
      payload: { iid: 7, mrUrl: "x", id: "g7" },
      emittedAt: Date.now(),
    });

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.url).toBe("https://board.local/?gate=g7");
  });

  test("a rule without url enqueues an event with no url key", async () => {
    const bus = fakeBus();
    const enqueued: NotificationEvent[] = [];

    startNotifyBridge({
      onBroadcast: bus.onBroadcast,
      rules: () => [GATE_RULE],
      enqueue: (e) => { enqueued.push(e); },
      paneFocused: async () => false,
    });

    await bus.emit("event", {
      id: 14,
      topic: "board/gate/opened/g14",
      payload: { iid: 7, mrUrl: "x" },
      emittedAt: Date.now(),
    });

    expect(enqueued).toHaveLength(1);
    const e = enqueued[0]!;
    expect("url" in e).toBe(false);
  });
});

describe("subjectPrefix rule filter", () => {
  const RUN_RULE: EventBridgeRule = {
    pattern: "gate/opened/*", category: "gate", title: "gate", message: "{subject}", subjectPrefix: "mr:",
  };

  test("a rule with subjectPrefix fires only for matching subjects", async () => {
    const bus = fakeBus();
    const enqueued: NotificationEvent[] = [];
    startNotifyBridge({ onBroadcast: bus.onBroadcast, rules: () => [RUN_RULE], enqueue: (e) => enqueued.push(e), paneFocused: async () => false });
    await bus.emit("event", { id: 1, topic: "gate/opened/g1", payload: { subject: "run:r1" }, emittedAt: 0 });
    expect(enqueued.length).toBe(0);
    await bus.emit("event", { id: 2, topic: "gate/opened/g2", payload: { subject: "mr:https://gitlab.example.com/x/1" }, emittedAt: 0 });
    expect(enqueued.length).toBe(1);
  });

  test("a subjectPrefix rule skips events with no string subject", async () => {
    const bus = fakeBus();
    const enqueued: NotificationEvent[] = [];
    startNotifyBridge({ onBroadcast: bus.onBroadcast, rules: () => [RUN_RULE], enqueue: (e) => enqueued.push(e), paneFocused: async () => false });
    await bus.emit("event", { id: 3, topic: "gate/opened/g3", payload: {}, emittedAt: 0 });
    expect(enqueued.length).toBe(0);
  });
});

describe("parseEventBridgeRules", () => {
  function noopWarn(): void {}

  test("keeps a rule with a string url", () => {
    const warnings: unknown[] = [];
    const raw = [{ pattern: "gate/opened/*", category: "gate", title: "t", message: "m", url: "https://board.local/?gate={id}" }];
    const rules = parseEventBridgeRules(raw, (o) => { warnings.push(o); });
    expect(rules).toHaveLength(1);
    expect(rules[0]!.url).toBe("https://board.local/?gate={id}");
    expect(warnings).toHaveLength(0);
  });

  test("drops a rule with a numeric url and warns", () => {
    const warnings: unknown[] = [];
    const raw = [{ pattern: "gate/opened/*", category: "gate", title: "t", message: "m", url: 42 }];
    const rules = parseEventBridgeRules(raw, (o) => { warnings.push(o); });
    expect(rules).toHaveLength(0);
    expect(warnings.length).toBeGreaterThan(0);
  });

  test("keeps subjectPrefix behavior: drops a rule with numeric subjectPrefix and warns", () => {
    const warnings: unknown[] = [];
    const raw = [{ pattern: "gate/opened/*", category: "gate", title: "t", message: "m", subjectPrefix: 7 }];
    const rules = parseEventBridgeRules(raw, (o) => { warnings.push(o); });
    expect(rules).toHaveLength(0);
    expect(warnings.length).toBeGreaterThan(0);
  });

  test("keeps a rule with a valid string subjectPrefix", () => {
    const rules = parseEventBridgeRules(
      [{ pattern: "gate/opened/*", category: "gate", title: "t", message: "m", subjectPrefix: "mr:" }],
      noopWarn,
    );
    expect(rules).toHaveLength(1);
    expect(rules[0]!.subjectPrefix).toBe("mr:");
  });

  test("skips an entry missing a required field and warns", () => {
    const warnings: unknown[] = [];
    const raw = [{ pattern: "gate/opened/*", category: "gate", title: "t" }];
    const rules = parseEventBridgeRules(raw, (o) => { warnings.push(o); });
    expect(rules).toHaveLength(0);
    expect(warnings.length).toBeGreaterThan(0);
  });

  test("returns [] with a warn for a non-array input", () => {
    const warnings: unknown[] = [];
    const rules = parseEventBridgeRules("not-an-array", (o) => { warnings.push(o); });
    expect(rules).toEqual([]);
    expect(warnings.length).toBeGreaterThan(0);
  });

  test("returns [] without a warn for undefined input", () => {
    const warnings: unknown[] = [];
    const rules = parseEventBridgeRules(undefined, (o) => { warnings.push(o); });
    expect(rules).toEqual([]);
  });
});
