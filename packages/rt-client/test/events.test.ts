import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { eventsEmit, eventsList, eventsWait, COMMAND_NAMES } from "../src/index.ts";
import { fakeDaemon } from "./fake-daemon.ts";

const stops: Array<() => void> = [];
afterEach(() => { for (const stop of stops) stop(); stops.length = 0; });

test("event wrappers are exported functions", () => {
  for (const fn of [eventsEmit, eventsWait, eventsList]) {
    expect(typeof fn).toBe("function");
  }
});

test("event commands are cataloged", () => {
  const names: string[] = [...COMMAND_NAMES];
  for (const name of ["events:emit", "events:wait", "events:list"]) {
    expect(names).toContain(name);
  }
});

describe("eventsEmit", () => {
  test("sends topic and payload to the daemon", async () => {
    const { sock, seen, stop } = fakeDaemon({
      "events:emit": { ok: true, data: { id: 42 } },
    });
    stops.push(stop);
    const res = await eventsEmit("mytopic", { some: "data" }, { sockPath: sock });
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ id: 42 });
    const emitCall = seen.find((s) => s.cmd === "events:emit");
    expect(emitCall?.payload).toEqual({ topic: "mytopic", payload: { some: "data" } });
  });

  test("sends topic without payload when undefined", async () => {
    const { sock, seen, stop } = fakeDaemon({
      "events:emit": { ok: true, data: { id: 43 } },
    });
    stops.push(stop);
    const res = await eventsEmit("anothertopic", undefined, { sockPath: sock });
    expect(res.ok).toBe(true);
    const emitCall = seen.find((s) => s.cmd === "events:emit");
    expect(emitCall?.payload).toEqual({ topic: "anothertopic" });
  });

  test("uses 10s timeout by default, overridable via opts", async () => {
    const { sock, stop } = fakeDaemon({
      "events:emit": { ok: true, data: { id: 44 } },
    });
    stops.push(stop);
    const spy = spyOn(AbortSignal, "timeout");
    await eventsEmit("topic1", { sockPath: sock });
    await eventsEmit("topic2", undefined, { sockPath: sock, timeoutMs: 5_000 });
    expect(spy.mock.calls.map((c) => c[0])).toEqual([10_000, 5_000]);
    spy.mockRestore();
  });
});

describe("eventsWait", () => {
  test("sends pattern and optional parameters to the daemon", async () => {
    const { sock, seen, stop } = fakeDaemon({
      "events:wait": { ok: true, data: { events: [], cursor: 100 } },
    });
    stops.push(stop);
    const res = await eventsWait(
      { pattern: "test:*", after: 50, waitMs: 30000 },
      { sockPath: sock },
    );
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ events: [], cursor: 100 });
    const waitCall = seen.find((s) => s.cmd === "events:wait");
    expect(waitCall?.payload).toEqual({ pattern: "test:*", after: 50, waitMs: 30000 });
  });

  test("sends just pattern when other fields undefined", async () => {
    const { sock, seen, stop } = fakeDaemon({
      "events:wait": { ok: true, data: { events: [], cursor: 200 } },
    });
    stops.push(stop);
    const res = await eventsWait({ pattern: "other:*" }, { sockPath: sock });
    expect(res.ok).toBe(true);
    const waitCall = seen.find((s) => s.cmd === "events:wait");
    expect(waitCall?.payload).toEqual({ pattern: "other:*" });
  });

  test("uses 250s timeout by default, overridable via opts", async () => {
    const { sock, stop } = fakeDaemon({
      "events:wait": { ok: true, data: { events: [], cursor: 300 } },
    });
    stops.push(stop);
    const spy = spyOn(AbortSignal, "timeout");
    await eventsWait({ pattern: "p1:*" }, { sockPath: sock });
    await eventsWait({ pattern: "p2:*" }, { sockPath: sock, timeoutMs: 60_000 });
    expect(spy.mock.calls.map((c) => c[0])).toEqual([250_000, 60_000]);
    spy.mockRestore();
  });
});

describe("eventsList", () => {
  test("sends pattern and optional parameters to the daemon", async () => {
    const { sock, seen, stop } = fakeDaemon({
      "events:list": { ok: true, data: { events: [], cursor: 150 } },
    });
    stops.push(stop);
    const res = await eventsList(
      { pattern: "list:*", after: 25, limit: 10 },
      { sockPath: sock },
    );
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ events: [], cursor: 150 });
    const listCall = seen.find((s) => s.cmd === "events:list");
    expect(listCall?.payload).toEqual({ pattern: "list:*", after: 25, limit: 10 });
  });

  test("sends just pattern when other fields undefined", async () => {
    const { sock, seen, stop } = fakeDaemon({
      "events:list": { ok: true, data: { events: [], cursor: 250 } },
    });
    stops.push(stop);
    const res = await eventsList({ pattern: "simple:*" }, { sockPath: sock });
    expect(res.ok).toBe(true);
    const listCall = seen.find((s) => s.cmd === "events:list");
    expect(listCall?.payload).toEqual({ pattern: "simple:*" });
  });

  test("uses 10s timeout by default, overridable via opts", async () => {
    const { sock, stop } = fakeDaemon({
      "events:list": { ok: true, data: { events: [], cursor: 350 } },
    });
    stops.push(stop);
    const spy = spyOn(AbortSignal, "timeout");
    await eventsList({ pattern: "l1:*" }, { sockPath: sock });
    await eventsList({ pattern: "l2:*" }, { sockPath: sock, timeoutMs: 3_000 });
    expect(spy.mock.calls.map((c) => c[0])).toEqual([10_000, 3_000]);
    spy.mockRestore();
  });
});
