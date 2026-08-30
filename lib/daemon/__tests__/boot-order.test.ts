import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, test, expect } from "bun:test";
import type { Server } from "bun";
import { buildUnits, makeBootContext } from "../../daemon.ts";
import { runUnits, stopUnits } from "../lifecycle.ts";
import { closeStateDb } from "../../state/db.ts";

// The unit list records boot attempts / ready stamps into state.db and writes
// supervision breadcrumbs, so this case runs under its own HOME to keep those
// writes out of the shared per-process test tree (state.db resolves HOME at
// call time). The singleton is closed on both sides so this run owns the open
// and the next test re-derives against the restored HOME.
let priorHome: string | undefined;
let priorPath: string | undefined;
beforeEach(() => {
  priorHome = process.env.HOME;
  priorPath = process.env.PATH;
  process.env.HOME = mkdtempSync(join(tmpdir(), "rt-boot-order-"));
  closeStateDb();
});
afterEach(() => {
  closeStateDb();
  if (priorHome !== undefined) process.env.HOME = priorHome;
  if (priorPath !== undefined) process.env.PATH = priorPath; // unit 3 prepends to PATH
});

// The authoritative boot order (spec §5.1 "Boot order"). The test owns this
// list so a reordering of buildUnits fails here rather than silently shipping.
const EXPECTED_ORDER = [
  "logger",
  "park-gate",
  "path-resolution",
  "events-db",
  "state-db",
  "background-subsystems",
  "handlers",
  "api-server",
  "socket-server",
  "rt-pid",
  "pollers",
  "ready",
] as const;

const fakeServer = (): Server<any> => ({ stop() {} }) as unknown as Server<any>;

test("units start in spec order, pid after both servers, state.db busy_timeout set, reverse stop closes state.db", async () => {
  const spy: string[] = [];
  let stateClosed = 0;

  const ctx = makeBootContext({
    redirectNativeStderr: () => {},
    parkGate: async () => {},
    resolveUserPath: async () => "",
    installCrashHandlers: () => {},
    installSignalHandlers: () => {},
    bindApiServer: async () => { spy.push("api-bound"); return fakeServer(); },
    bindSocketServer: () => { spy.push("socket-bound"); return fakeServer(); },
    writePid: () => { spy.push("pid-written"); },
    closeStateDb: () => { spy.push("closeStateDb"); stateClosed++; closeStateDb(); },
  });
  ctx.spy = spy;

  const units = buildUnits(ctx);
  expect(units.map((u) => u.name)).toEqual([...EXPECTED_ORDER]);

  // Wrap each unit so start/stop order is recorded in the same spy stream the
  // seams write to, giving one ordered sequence to assert pid/close against.
  const spied = units.map((u) => ({
    name: u.name,
    start: async () => { spy.push(`start:${u.name}`); await u.start(); },
    stop: async () => { spy.push(`stop:${u.name}`); await u.stop(); },
  }));

  await runUnits(spied, ctx.log);

  // (a) start order matches the 12-entry list.
  const starts = spy.filter((e) => e.startsWith("start:")).map((e) => e.slice("start:".length));
  expect(starts).toEqual([...EXPECTED_ORDER]);

  // (b) rt.pid is written only after BOTH server units bound.
  expect(spy.indexOf("pid-written")).toBeGreaterThan(spy.indexOf("api-bound"));
  expect(spy.indexOf("pid-written")).toBeGreaterThan(spy.indexOf("socket-bound"));
  expect(spy.indexOf("pid-written")).toBeGreaterThan(spy.indexOf("start:socket-server"));

  // (c) state.db opened at the daemon's contention policy (busy_timeout 250ms).
  const bt = (ctx.stateDb!.query("PRAGMA busy_timeout").get() as { timeout: number }).timeout;
  expect(bt).toBe(250);

  await stopUnits(spied, ctx.log);

  // (d) clean stop runs in reverse and closeStateDb() ran during it.
  const stops = spy.filter((e) => e.startsWith("stop:")).map((e) => e.slice("stop:".length));
  expect(stops).toEqual([...EXPECTED_ORDER].reverse());
  expect(stateClosed).toBeGreaterThan(0);
  expect(spy.indexOf("closeStateDb")).toBeGreaterThan(spy.indexOf("stop:ready"));
});
