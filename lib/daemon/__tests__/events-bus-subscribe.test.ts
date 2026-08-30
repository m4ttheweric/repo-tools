import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import pino from "pino";
import { createEventsBus, type EventsBus } from "../events-bus.ts";

const log = pino({ level: "silent" });

describe("EventsBus.onBroadcast + fanOut + emitEvent (R020)", () => {
  let dir: string;
  let bus: EventsBus;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rt-events-subscribe-"));
    bus = createEventsBus({ dbPath: join(dir, "events.db"), log });
  });

  afterEach(() => {
    bus.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("one fanOut call reaches every onBroadcast subscriber with (type, data)", () => {
    const seenA: Array<[string, unknown]> = [];
    const seenB: Array<[string, unknown]> = [];
    bus.onBroadcast((type, data) => seenA.push([type, data]));
    bus.onBroadcast((type, data) => seenB.push([type, data]));

    bus.fanOut("chat/build/msg", { id: 1 });

    expect(seenA).toEqual([["chat/build/msg", { id: 1 }]]);
    expect(seenB).toEqual([["chat/build/msg", { id: 1 }]]);
  });

  test("fanOut does NOT persist -- events.db row count is unchanged", () => {
    bus.onBroadcast(() => {});
    expect(bus.list({ pattern: "**" }).events).toHaveLength(0);

    bus.fanOut("system-processes", { anything: true });
    bus.fanOut("worktree:disposed", { repo: "r", path: "/p" });

    expect(bus.list({ pattern: "**" }).events).toHaveLength(0);
  });

  test("emitEvent persists via emitAt and returns the frame, but does NOT fan out to onBroadcast subscribers", () => {
    const seen: Array<[string, unknown]> = [];
    bus.onBroadcast((type, data) => seen.push([type, data]));

    const frame = bus.emitEvent("run-updated", { repo: "r", runId: 1 });

    expect(frame.topic).toBe("run-updated");
    expect(frame.payload).toEqual({ repo: "r", runId: 1 });
    expect(typeof frame.id).toBe("number");
    expect(typeof frame.emittedAt).toBe("number");

    const { events } = bus.list({ pattern: "run-updated" });
    expect(events).toEqual([frame]);

    // The persisted-event path never reached onBroadcast subscribers before
    // this refactor (command-router's chat/agent/run/repo events never
    // triggered cron or the worktree:disposed reaction), and still doesn't.
    expect(seen).toEqual([]);
  });

  test("unsubscribe removes only that subscriber", () => {
    const seenA: Array<[string, unknown]> = [];
    const seenB: Array<[string, unknown]> = [];
    const unsubA = bus.onBroadcast((type, data) => seenA.push([type, data]));
    bus.onBroadcast((type, data) => seenB.push([type, data]));

    bus.fanOut("topic1", { n: 1 });
    unsubA();
    bus.fanOut("topic2", { n: 2 });

    expect(seenA).toEqual([["topic1", { n: 1 }]]);
    expect(seenB).toEqual([["topic1", { n: 1 }], ["topic2", { n: 2 }]]);
  });

  test("the endpoint-release reaction fires only through a registered subscriber, via fanOut, with no persistence", () => {
    // Mirrors daemon.ts's former inline `if (type === "worktree:disposed")`
    // reaction, now expressed as an onBroadcast subscriber fed by fanOut --
    // the same non-persisting path emit() uses for every broadcast.
    const released: Array<{ repo: string; path: string }> = [];
    const unsub = bus.onBroadcast((type, data) => {
      if (type !== "worktree:disposed") return;
      const d = data as { repo?: string; path?: string };
      if (d?.repo && d?.path) released.push({ repo: d.repo, path: d.path });
    });

    bus.fanOut("worktree:disposed", { repo: "acme", path: "/tmp/wt" });
    expect(released).toEqual([{ repo: "acme", path: "/tmp/wt" }]);
    expect(bus.list({ pattern: "**" }).events).toHaveLength(0);

    // Unsubscribed: the same fanOut call no longer reaches the reaction.
    unsub();
    bus.fanOut("worktree:disposed", { repo: "acme", path: "/tmp/wt2" });
    expect(released).toEqual([{ repo: "acme", path: "/tmp/wt" }]);
  });

  test("a non-matching type never triggers a type-filtering subscriber", () => {
    const released: unknown[] = [];
    bus.onBroadcast((type, data) => {
      if (type === "worktree:disposed") released.push(data);
    });

    bus.fanOut("cache:updated", { anything: true });
    expect(released).toEqual([]);
  });
});
