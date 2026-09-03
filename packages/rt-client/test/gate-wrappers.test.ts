import { describe, expect, test, afterEach } from "bun:test";
import {
  gateOpen, gateAnswer, gateWait, gateList, gatePark, gateClose, gateSubscribe, gateUnsubscribe,
  gateSubscriptions,
} from "../src/client.ts";
import type { GateRow, GateSubscription } from "../src/commands.ts";
import { fakeDaemon } from "./fake-daemon.ts";

const stops: Array<() => void> = [];
afterEach(() => { for (const stop of stops) stop(); stops.length = 0; });

const row: GateRow = {
  id: "gt-1", subject: "run:1", kind: "approve",
  questions: [{ id: "q1", label: "ok?", multi: false, options: ["yes", "no"] }],
  meta: null, status: "open", answer: null,
  openedAt: 1, parkedAt: null, closedAt: null, closedReason: null,
  agent: null, pane: null, nudge: null, delivery: null, released: false,
};

describe("gateOpen", () => {
  test("passes the command name and payload through verbatim, types the reply", async () => {
    const { sock, seen, stop } = fakeDaemon({
      "gate:open": { ok: true, data: { id: "gt-1", supersededId: null } },
    });
    stops.push(stop);
    const payload = { subject: "run:1", kind: "approve", questions: row.questions };
    const res = await gateOpen(payload, { sockPath: sock });
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ id: "gt-1", supersededId: null });
    expect(seen).toEqual([{ cmd: "gate:open", payload }]);
  });
});

describe("gateAnswer", () => {
  test("passes the command name and payload through verbatim, types the reply", async () => {
    const { sock, seen, stop } = fakeDaemon({
      "gate:answer": { ok: true, data: { row } },
    });
    stops.push(stop);
    const payload = { id: "gt-1", answers: { q1: "yes" }, by: "matt" };
    const res = await gateAnswer(payload, { sockPath: sock });
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ row });
    expect(seen).toEqual([{ cmd: "gate:answer", payload }]);
  });
});

describe("gateWait", () => {
  test("passes the command name and payload through verbatim, types the reply", async () => {
    const { sock, seen, stop } = fakeDaemon({
      "gate:wait": { ok: true, data: { status: "answered", row } },
    });
    stops.push(stop);
    const payload = { id: "gt-1", waitMs: 5_000 };
    const res = await gateWait(payload, { sockPath: sock });
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ status: "answered", row });
    expect(seen).toEqual([{ cmd: "gate:wait", payload }]);
  });
});

describe("gateList", () => {
  test("passes the command name and payload through verbatim, types the reply", async () => {
    const { sock, seen, stop } = fakeDaemon({
      "gate:list": { ok: true, data: { gates: [row], cursor: 1 } },
    });
    stops.push(stop);
    const payload = { open: true, subjectPrefix: "run:" };
    const res = await gateList(payload, { sockPath: sock });
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ gates: [row], cursor: 1 });
    expect(seen).toEqual([{ cmd: "gate:list", payload }]);
  });

  test("forwards limit and cursor when present", async () => {
    const { sock, seen, stop } = fakeDaemon({
      "gate:list": { ok: true, data: { gates: [], cursor: 5 } },
    });
    stops.push(stop);
    const payload = { limit: 10, cursor: 5 };
    const res = await gateList(payload, { sockPath: sock });
    expect(res.ok).toBe(true);
    expect(seen).toEqual([{ cmd: "gate:list", payload }]);
  });
});

describe("gatePark", () => {
  test("passes the command name and payload through verbatim, types the reply", async () => {
    const { sock, seen, stop } = fakeDaemon({
      "gate:park": { ok: true, data: { ok: true } },
    });
    stops.push(stop);
    const payload = { id: "gt-1" };
    const res = await gatePark(payload, { sockPath: sock });
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ ok: true });
    expect(seen).toEqual([{ cmd: "gate:park", payload }]);
  });
});

describe("gateClose", () => {
  test("passes the command name and payload through verbatim, types the reply", async () => {
    const { sock, seen, stop } = fakeDaemon({
      "gate:close": { ok: true, data: { ok: true } },
    });
    stops.push(stop);
    const payload = { id: "gt-1", reason: "abandoned" as const };
    const res = await gateClose(payload, { sockPath: sock });
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ ok: true });
    expect(seen).toEqual([{ cmd: "gate:close", payload }]);
  });
});

describe("gateSubscribe", () => {
  test("passes the command name and payload through verbatim, types the reply", async () => {
    const { sock, seen, stop } = fakeDaemon({
      "gate:subscribe": { ok: true, data: { id: "sub-1" } },
    });
    stops.push(stop);
    const payload = { subjectPrefix: "run:", session: "sess-1" };
    const res = await gateSubscribe(payload, { sockPath: sock });
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ id: "sub-1" });
    expect(seen).toEqual([{ cmd: "gate:subscribe", payload }]);
  });
});

describe("gateUnsubscribe", () => {
  test("passes the command name and payload through verbatim, types the reply", async () => {
    const { sock, seen, stop } = fakeDaemon({
      "gate:unsubscribe": { ok: true, data: { removed: true } },
    });
    stops.push(stop);
    const payload = { id: "sub-1" };
    const res = await gateUnsubscribe(payload, { sockPath: sock });
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ removed: true });
    expect(seen).toEqual([{ cmd: "gate:unsubscribe", payload }]);
  });
});

describe("gateSubscriptions", () => {
  test("passes the command name and payload through verbatim, types the reply", async () => {
    const sub: GateSubscription = {
      id: "sub-1", subjectPrefix: "run:", session: "sess-1",
      createdAt: 1, lastDelivery: null, dead: false,
    };
    const { sock, seen, stop } = fakeDaemon({
      "gate:subscriptions": { ok: true, data: { subscriptions: [sub] } },
    });
    stops.push(stop);
    const payload = { session: "sess-1", live: true };
    const res = await gateSubscriptions(payload, { sockPath: sock });
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ subscriptions: [sub] });
    expect(seen).toEqual([{ cmd: "gate:subscriptions", payload }]);
  });

  test("omits unset fields from the payload", async () => {
    const { sock, seen, stop } = fakeDaemon({
      "gate:subscriptions": { ok: true, data: { subscriptions: [] } },
    });
    stops.push(stop);
    const res = await gateSubscriptions({}, { sockPath: sock });
    expect(res.ok).toBe(true);
    expect(seen).toEqual([{ cmd: "gate:subscriptions", payload: {} }]);
  });
});
