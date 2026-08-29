import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import pino from "pino";
import { Database } from "bun:sqlite";
import { createEventsBus, type EventsBus } from "../events-bus.ts";

const log = pino({ level: "silent" });

// `Statement.all` is an own instance property (not on Statement.prototype),
// so spying has to go through Database.prototype.prepare and wrap whatever
// statement comes back. Only afterStmt in events-bus.ts calls `.all()`
// (insertStmt and maxIdStmt only call `.get()`), so this records exactly
// the SQL reads this task bounds.
function spyOnStatementAll(): { rowCounts: number[]; restore: () => void } {
  const rowCounts: number[] = [];
  const origPrepare = Database.prototype.prepare;
  Database.prototype.prepare = function (this: Database, ...args: unknown[]) {
    const stmt = (origPrepare as (...a: unknown[]) => any).apply(this, args);
    if (typeof stmt.all === "function") {
      const origAll = stmt.all.bind(stmt);
      stmt.all = (...callArgs: unknown[]) => {
        const rows = origAll(...callArgs);
        rowCounts.push(rows.length);
        return rows;
      };
    }
    return stmt;
  } as typeof Database.prototype.prepare;
  return { rowCounts, restore: () => { Database.prototype.prepare = origPrepare; } };
}

describe("events bus bounded reads (S047, R030)", () => {
  let dir: string;
  let bus: EventsBus;
  let spy: { rowCounts: number[]; restore: () => void };

  beforeEach(() => {
    spy = spyOnStatementAll();
    dir = mkdtempSync(join(tmpdir(), "rt-events-bounds-"));
    bus = createEventsBus({ dbPath: join(dir, "events.db"), log });
  });
  afterEach(() => {
    bus.close();
    rmSync(dir, { recursive: true, force: true });
    spy.restore();
  });

  test("list({ pattern, limit: N }) never reads more than N + 1 rows in one SQL call", () => {
    for (let i = 0; i < 40; i++) bus.emit("job/x/" + i);
    spy.rowCounts.length = 0; // ignore rows read during setup emits (none: emit only inserts)

    const res = bus.list({ pattern: "**", after: 0, limit: 5 });

    expect(res.events).toHaveLength(5);
    expect(spy.rowCounts.length).toBeGreaterThan(0);
    for (const count of spy.rowCounts) expect(count).toBeLessThanOrEqual(6); // limit + 1
    // The whole point: it must not have materialized all 40 rows to answer a 5-row page.
    expect(Math.max(...spy.rowCounts)).toBeLessThan(40);
  });

  for (const limit of [0, -1, -5]) {
    test(`list({ limit: ${limit} }) clamps instead of forcing an unbounded read or throwing`, () => {
      for (let i = 0; i < 40; i++) bus.emit("job/x/" + i);
      spy.rowCounts.length = 0;

      let threw = false;
      try {
        bus.list({ pattern: "**", after: 0, limit });
      } catch {
        threw = true;
      }

      expect(threw).toBe(false);
      // Clamped to the minimum positive limit (1), so pages are tiny, not
      // SQLite's unbounded-LIMIT reading of a non-positive value.
      for (const count of spy.rowCounts) expect(count).toBeLessThanOrEqual(2); // clamped limit (1) + 1
      expect(Math.max(...spy.rowCounts)).toBeLessThan(40);
    });
  }

  test("a narrow pattern still pages forward instead of reading the whole journal in one call", () => {
    // 30 rows that never match, one match near the end.
    for (let i = 0; i < 30; i++) bus.emit("noise/" + i);
    const wantedId = bus.emit("job/x/only-match");
    spy.rowCounts.length = 0;

    const res = bus.list({ pattern: "job/**", after: 0, limit: 5 });

    expect(res.events.map(e => e.id)).toEqual([wantedId]);
    for (const count of spy.rowCounts) expect(count).toBeLessThanOrEqual(6); // limit + 1
  });

  test("a waiter registered with a stale `after` does not rescan the pre-registration backlog on the next matching emit", async () => {
    // 30 events that do not match the waiter's pattern, registered while the
    // caller's cursor is still 0 (far behind head).
    for (let i = 0; i < 30; i++) bus.emit("noise/" + i);
    const waitPromise = bus.wait({ pattern: "job/**", after: 0, waitMs: 5_000 });
    expect(bus.waiterCount()).toBe(1);

    spy.rowCounts.length = 0; // only the emit below is under test
    const id = bus.emit("job/x/a"); // first event matching the waiter's pattern
    const res = await waitPromise;

    expect(res.events.map(e => e.id)).toEqual([id]);
    // If the waiter had kept the caller's stale after=0, this emit's wake-up
    // scan would re-read all 30 backlog rows plus the new one. Registering
    // at head means the scan only ever sees rows inserted since registration.
    expect(Math.max(...spy.rowCounts)).toBeLessThan(31);
    expect(Math.max(...spy.rowCounts)).toBeLessThanOrEqual(2);
  });
});
