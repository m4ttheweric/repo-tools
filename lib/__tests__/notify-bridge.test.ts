/**
 * lib/notify-bridge.ts — the settings-driven notifier event bridge (gate
 * events pass, Task 3). Fake deps only: no daemon, no events.db, no herdr
 * socket. Real wiring (EventsBus.onBroadcast, the herdr session.snapshot
 * pane-focus lookup, the notify_queue insert) is exercised where each of
 * those pieces already has its own suite.
 */
import { describe, test, expect } from "bun:test";
import { startNotifyBridge, type EventBridgeRule } from "../notify-bridge.ts";
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
});
