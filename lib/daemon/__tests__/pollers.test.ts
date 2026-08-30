import { afterEach, expect, test } from "bun:test";
import type { PortEntry } from "../../port-scanner.ts";
import type { SystemProcessScanner } from "../system-process-scanner.ts";
import type { PortCacheRef, RepoIndex } from "../handlers/types.ts";
import { startPollers, type PollerDeps, type PollersHandle } from "../pollers.ts";

const quietLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as unknown as PollerDeps["log"];

/** Bare-minimum SystemProcessScanner stand-in: only `scan` is exercised by
 *  the tests below, the other two members are called unconditionally after
 *  a successful scan so they must exist. */
function fakeScanner(scan: () => Promise<any[]>): SystemProcessScanner {
  return {
    scan,
    markRunawayNotified: () => {},
    isRunawayNotified: () => false,
  } as unknown as SystemProcessScanner;
}

let handle: PollersHandle | null = null;
afterEach(() => {
  handle?.stop();
  handle = null;
});

function poller(overrides: Partial<PollerDeps> = {}): PollersHandle {
  const portCacheRef: PortCacheRef = { ports: [], updatedAt: 0 };
  const repoIndex: () => RepoIndex = () => ({});
  handle = startPollers({
    log: quietLog,
    refreshCache: async () => {},
    portCacheRef,
    broadcast: () => {},
    systemProcessScanner: fakeScanner(async () => []),
    repoIndex,
    checkAndRepairHooksPath: async () => true,
    demanded: () => true,
    scanPorts: async () => [],
    ...overrides,
  });
  return handle;
}

test("a second port-scan tick during an in-flight scan does not double-run it", async () => {
  let calls = 0;
  let resolveScan!: (v: PortEntry[]) => void;
  const scanPorts = () => {
    calls++;
    return new Promise<PortEntry[]>((r) => { resolveScan = r; });
  };
  const h = poller({ scanPorts });

  const first = h.tickPorts();
  const second = h.tickPorts(); // fires while the first scan is still in flight
  expect(calls).toBe(1); // the second tick did not start a new scan

  resolveScan([]);
  await Promise.all([first, second]);
});

test("demand gating skips the port scan when nothing is demanded, then runs once demand resumes", async () => {
  let calls = 0;
  let demand = false;
  const h = poller({
    scanPorts: async () => { calls++; return []; },
    demanded: () => demand,
  });

  await h.tickPorts();
  expect(calls).toBe(0); // no consumer asked recently -> the scanner is not invoked

  demand = true;
  await h.tickPorts();
  expect(calls).toBe(1);
});

test("a never-settling port scan is abandoned via the deadline so a later tick can run", async () => {
  let calls = 0;
  const scanPorts = () => {
    calls++;
    return calls === 1
      ? new Promise<PortEntry[]>(() => {}) // never settles
      : Promise.resolve([]);
  };
  const h = poller({ scanPorts, scanDeadlineMs: 20 });

  const t0 = Date.now();
  await h.tickPorts(); // the hung scan never resolves; the deadline race does
  expect(Date.now() - t0).toBeLessThan(1000);
  expect(calls).toBe(1);

  await h.tickPorts(); // latch cleared by the deadline -> a later tick runs
  expect(calls).toBe(2);
});

test("a second process-scan tick during an in-flight scan does not double-run it", async () => {
  let calls = 0;
  let resolveScan!: (v: any[]) => void;
  const systemProcessScanner = fakeScanner(() => {
    calls++;
    return new Promise<any[]>((r) => { resolveScan = r; });
  });
  const h = poller({ systemProcessScanner });

  const first = h.tickProcesses();
  const second = h.tickProcesses(); // fires while the first scan is still in flight
  expect(calls).toBe(1);

  resolveScan([]);
  await Promise.all([first, second]);
});

test("demand gating skips the process scan when nothing is demanded", async () => {
  let calls = 0;
  const systemProcessScanner = fakeScanner(async () => { calls++; return []; });
  const h = poller({ systemProcessScanner, demanded: () => false });

  await h.tickProcesses();
  expect(calls).toBe(0);
});

test("a never-settling process scan is abandoned via the deadline so a later tick can run", async () => {
  let calls = 0;
  const systemProcessScanner = fakeScanner(() => {
    calls++;
    return calls === 1
      ? new Promise<any[]>(() => {}) // never settles
      : Promise.resolve([]);
  });
  const h = poller({ systemProcessScanner, scanDeadlineMs: 20 });

  const t0 = Date.now();
  await h.tickProcesses();
  expect(Date.now() - t0).toBeLessThan(1000);
  expect(calls).toBe(1);

  await h.tickProcesses(); // latch cleared -> a later tick runs
  expect(calls).toBe(2);
});
