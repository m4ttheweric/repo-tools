import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import pino from "pino";
import { createEventsBus, type EventsBus } from "../events-bus.ts";
import { createEventsHandlers } from "../handlers/events.ts";

const log = pino({ level: "silent" });

describe("events handlers", () => {
  let dir: string;
  let bus: EventsBus;
  let frames: Array<{ type: string; data: any }>;
  let handlers: ReturnType<typeof createEventsHandlers>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rt-events-"));
    bus = createEventsBus({ dbPath: join(dir, "events.db"), log });
    frames = [];
    handlers = createEventsHandlers(bus, (type, data) => frames.push({ type, data }));
  });
  afterEach(() => {
    bus.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("events:emit validates topic, returns id, broadcasts an event frame", async () => {
    const bad = await handlers["events:emit"]({ topic: "" } as any);
    expect(bad.ok).toBe(false);
    const res = await handlers["events:emit"]({ topic: "job/x/q", payload: { a: 1 } });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.id).toBeGreaterThan(0);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.type).toBe("event");
    expect(frames[0]!.data.topic).toBe("job/x/q");
  });

  test("events:list coerces string after/limit (REST query params)", async () => {
    await handlers["events:emit"]({ topic: "job/x/a" });
    await handlers["events:emit"]({ topic: "job/x/b" });
    const res = await handlers["events:list"]({ pattern: "job/**", after: "0", limit: "1" } as any);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.events).toHaveLength(1);
  });

  test("events:wait passes the abort signal through to the bus", async () => {
    const ac = new AbortController();
    const p = handlers["events:wait"]({ pattern: "job/**", waitMs: 240_000 }, ac.signal);
    ac.abort();
    const res = await p;
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.events).toEqual([]);
    expect(bus.waiterCount()).toBe(0);
  });

  test("events:wait rejects missing pattern", async () => {
    const res = await handlers["events:wait"]({} as any);
    expect(res.ok).toBe(false);
  });
});
