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

  test("head returns the journal max id and does not fetch rows", () => {
    expect(bus.head()).toBe(0);
    const id = bus.emit("chat/wake/a");
    expect(bus.head()).toBe(id);
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

describe("events bus wait", () => {
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

  test("wait resolves immediately when matching events already exist past cursor", async () => {
    const id = bus.emit("job/x/question", { q: 1 });
    const res = await bus.wait({ pattern: "job/x/*", after: 0 });
    expect(res.events.map(e => e.id)).toEqual([id]);
    expect(res.cursor).toBe(id);
  });

  test("wait blocks then wakes on a matching emit", async () => {
    const p = bus.wait({ pattern: "job/x/*" });          // no after → from now on
    expect(bus.waiterCount()).toBe(1);
    const id = bus.emit("job/x/report", { done: true });
    const res = await p;
    expect(res.events.map(e => e.id)).toEqual([id]);
    expect(res.cursor).toBe(id);
    expect(bus.waiterCount()).toBe(0);
  });

  test("non-matching emit does not wake the waiter", async () => {
    const p = bus.wait({ pattern: "job/x/*", waitMs: 150 });
    bus.emit("other/topic");
    const res = await p; // resolves via cap expiry
    expect(res.events).toEqual([]);
  });

  test("cap expiry returns empty events WITH the registration-time cursor", async () => {
    const preId = bus.emit("seed/event");
    const res = await bus.wait({ pattern: "job/**", waitMs: 100 });
    expect(res.events).toEqual([]);
    expect(res.cursor).toBe(preId);
    expect(bus.waiterCount()).toBe(0);
  });

  test("abort removes the waiter and resolves empty", async () => {
    const ac = new AbortController();
    const p = bus.wait({ pattern: "job/**", signal: ac.signal, waitMs: 240_000 });
    expect(bus.waiterCount()).toBe(1);
    ac.abort();
    const res = await p;
    expect(res.events).toEqual([]);
    expect(bus.waiterCount()).toBe(0);
  });

  test("empty expiry advances the cursor to the registration-time head, not the caller's after", async () => {
    const a = bus.emit("job/x/seen");
    bus.emit("noise/1");
    const head = bus.emit("noise/2");
    // Caller is caught up on job/* (cursor a); newer events are all non-matching.
    const res = await bus.wait({ pattern: "job/**", after: a, waitMs: 100 });
    expect(res.events).toEqual([]);
    expect(res.cursor).toBe(head); // NOT a — empty polls must not rescan the non-matching tail forever
  });

  test("ahead cursor (stale db generation) clamps to journal head instead of hanging", async () => {
    bus.emit("job/x/a");
    const p = bus.wait({ pattern: "job/**", after: 99_999, waitMs: 240_000 });
    const id = bus.emit("job/x/b"); // must wake it — clamp made effAfter = head
    const res = await p;
    expect(res.events.map(e => e.id)).toEqual([id]);
  });

  test("no-await atomicity: emit racing registration is not lost", async () => {
    // Deterministic given single-threaded Bun: the emit lands after wait()
    // returns its promise, so it must be delivered via the waiter path.
    const p = bus.wait({ pattern: "job/**", waitMs: 5_000 });
    const id = bus.emit("job/race");
    const res = await p;
    expect(res.events.map(e => e.id)).toEqual([id]);
  });
});

describe("events bus retention", () => {
  let dir: string;
  let bus: EventsBus;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rt-events-"));
    bus = createEventsBus({ dbPath: join(dir, "events.db"), log, retentionFloor: 3 });
  });
  afterEach(() => {
    bus.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("sweep deletes old rows beyond the floor, keeps recent and floor rows", () => {
    // 5 old events (emittedAt 8 days ago) + 1 fresh one
    const oldTs = Date.now() - 8 * 24 * 60 * 60 * 1000;
    for (let i = 0; i < 5; i++) bus.emitAt(`old/${i}`, undefined, oldTs);
    bus.emit("fresh/1");
    const deleted = bus.sweep();
    // 6 total, floor keeps newest 3 (old/3 old/4 fresh/1 by id), age keeps fresh/1;
    // deletable = old/0..old/2 → 3 rows
    expect(deleted).toBe(3);
    const res = bus.list({ pattern: "**", after: 0 });
    expect(res.events.map(e => e.topic)).toEqual(["old/3", "old/4", "fresh/1"]);
  });

  test("ids stay monotonic after a sweep (AUTOINCREMENT)", () => {
    const oldTs = Date.now() - 8 * 24 * 60 * 60 * 1000;
    for (let i = 0; i < 5; i++) bus.emitAt(`old/${i}`, undefined, oldTs);
    const lastBefore = bus.emit("fresh/1");
    bus.sweep();
    expect(bus.emit("fresh/2")).toBe(lastBefore + 1);
  });
});
