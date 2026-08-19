import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import pino from "pino";
import { createEventsBus, matchTopic, type EventsBus } from "../events-bus.ts";

const log = pino({ level: "silent" });

describe("matchTopic", () => {
  test("bare topic matches itself only", () => {
    expect(matchTopic("job/x/question", "job/x/question")).toBe(true);
    expect(matchTopic("job/x/question", "job/x/report")).toBe(false);
  });
  test("* matches one segment, not across slashes", () => {
    expect(matchTopic("job/x/*", "job/x/question")).toBe(true);
    expect(matchTopic("job/*", "job/x/question")).toBe(false);
  });
  test("** matches across segments", () => {
    expect(matchTopic("job/**", "job/x/question")).toBe(true);
  });
});

describe("events bus journal", () => {
  let dir: string;
  let bus: EventsBus;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rt-events-"));
    bus = createEventsBus({ dbPath: join(dir, "events.db"), log });
  });
  afterEach(() => {
    bus.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("emit returns monotonically increasing ids", () => {
    const a = bus.emit("job/x/question", { q: "hi" });
    const b = bus.emit("job/x/report");
    expect(b).toBe(a + 1);
  });

  test("list returns matching events after cursor, with cursor = max id in journal", () => {
    bus.emit("job/x/question", { q: 1 });
    const id2 = bus.emit("job/y/question", { q: 2 });
    const id3 = bus.emit("job/x/report");
    const res = bus.list({ pattern: "job/x/*", after: 0 });
    expect(res.events.map(e => e.topic)).toEqual(["job/x/question", "job/x/report"]);
    expect(res.events[0]!.payload).toEqual({ q: 1 });
    expect(res.cursor).toBe(id3);
    // `after` excludes everything at or before it
    const res2 = bus.list({ pattern: "job/**", after: id2 });
    expect(res2.events.map(e => e.id)).toEqual([id3]);
  });

  test("list with no matches still returns the current cursor", () => {
    const id = bus.emit("other/topic");
    const res = bus.list({ pattern: "job/**" });
    expect(res.events).toEqual([]);
    expect(res.cursor).toBe(id);
  });

  test("limit applies after the glob filter", () => {
    bus.emit("noise/1");
    bus.emit("job/x/a");
    bus.emit("noise/2");
    bus.emit("job/x/b");
    bus.emit("job/x/c");
    const res = bus.list({ pattern: "job/x/*", after: 0, limit: 2 });
    expect(res.events.map(e => e.topic)).toEqual(["job/x/a", "job/x/b"]);
    expect(res.cursor).toBe(res.events[1]!.id); // truncated list: cursor = last delivered
  });

  test("journal survives close/reopen (WAL file db)", () => {
    bus.emit("job/x/a", { keep: true });
    bus.close();
    bus = createEventsBus({ dbPath: join(dir, "events.db"), log });
    const res = bus.list({ pattern: "job/x/*", after: 0 });
    expect(res.events).toHaveLength(1);
    expect(res.events[0]!.payload).toEqual({ keep: true });
  });
});
