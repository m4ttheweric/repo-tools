// lib/daemon/__tests__/system-processes-handlers.test.ts
import { describe, test, expect } from "bun:test";
import { createSystemProcessHandlers } from "../handlers/system-processes.ts";
import type { SystemProcess } from "../system-process-scanner.ts";
import { composeKey } from "../../state/branch-cache.ts";

function makeProcess(overrides: Partial<SystemProcess> = {}): SystemProcess {
  return {
    pid: 1234,
    ppid: 1,
    command: "node",
    fullCommand: "node server.js",
    cpuPercent: 12.5,
    rssKb: 102400,
    uptime: "1:00:00",
    cwd: "/Users/test/repos/myrepo",
    repo: "myrepo",
    worktree: null,
    branch: "feature/foo",
    relativeDir: ".",
    port: null,
    linearTicket: null,
    packageScript: null,
    isRunaway: false,
    runawayDurationMs: null,
    firstSeen: Date.now(),
    ...overrides,
  };
}

function setup(processes: SystemProcess[], cacheEntries: Record<string, any> = {}) {
  // msSinceLastScan returns 0 (fresh) so the handler serves the supplied
  // cache without a scan-on-read; refresh is a no-op guard for completeness.
  const scanner = {
    getProcesses: () => processes,
    msSinceLastScan: () => 0,
    refresh: () => processes,
  } as any;
  const ctx = { cache: { entries: cacheEntries }, portCacheRef: { ports: [] } } as any;
  return createSystemProcessHandlers(scanner, ctx);
}

describe("system-processes handler", () => {
  test("returns scanner processes with updatedAt", async () => {
    const proc = makeProcess();
    const handlers = setup([proc]);

    const res = await handlers["system-processes"]!({}) as any;

    expect(res.ok).toBe(true);
    expect(res.data.processes).toHaveLength(1);
    expect(res.data.processes[0].pid).toBe(1234);
    expect(typeof res.data.updatedAt).toBe("number");
  });

  test("enriches processes with Linear ticket from branch cache", async () => {
    const proc = makeProcess({ branch: "feature/foo", repo: "myrepo" });
    const handlers = setup([proc], {
      [composeKey("myrepo", "feature/foo")]: {
        ticket: { identifier: "ENG-123", title: "Do the thing" },
      },
    });

    const res = await handlers["system-processes"]!({}) as any;

    expect(res.data.processes[0].linearTicket).toBe("ENG-123: Do the thing");
  });

  test("leaves linearTicket null when branch has no cache entry", async () => {
    const proc = makeProcess({ branch: "feature/untracked" });
    const handlers = setup([proc], {});

    const res = await handlers["system-processes"]!({}) as any;

    expect(res.data.processes[0].linearTicket).toBeNull();
  });

  test("leaves linearTicket null when cache entry has no ticket", async () => {
    const proc = makeProcess({ branch: "feature/foo", repo: "myrepo" });
    const handlers = setup([proc], { [composeKey("myrepo", "feature/foo")]: { ticket: null } });

    const res = await handlers["system-processes"]!({}) as any;

    expect(res.data.processes[0].linearTicket).toBeNull();
  });

  test("leaves linearTicket null when process has no branch", async () => {
    const proc = makeProcess({ branch: null });
    const handlers = setup([proc], {});

    const res = await handlers["system-processes"]!({}) as any;

    expect(res.data.processes[0].linearTicket).toBeNull();
  });

  test("returns empty list when scanner has no processes", async () => {
    const handlers = setup([]);

    const res = await handlers["system-processes"]!({}) as any;

    expect(res.ok).toBe(true);
    expect(res.data.processes).toEqual([]);
  });

  test("flattened single-child chain keeps every pid in chainPids", async () => {
    const doppler = makeProcess({ pid: 345, ppid: 1, fullCommand: "/opt/homebrew/bin/doppler run" });
    const node = makeProcess({ pid: 406, ppid: 345, fullCommand: "node server.js" });
    const handlers = setup([doppler, node]);

    const res = await handlers["system-processes"]!({}) as any;

    expect(res.data.processes).toHaveLength(1);
    const row = res.data.processes[0];
    expect(row.command).toBe("doppler › node");
    expect(row.pid).toBe(345);
    expect(row.chainPids).toEqual([345, 406]);
  });

  test("three-deep chain collects all pids in order", async () => {
    const bun = makeProcess({ pid: 10, ppid: 1, fullCommand: "bun run dev" });
    const sh = makeProcess({ pid: 20, ppid: 10, fullCommand: "/bin/sh -c foo" });
    const node = makeProcess({ pid: 30, ppid: 20, fullCommand: "node index.js" });
    const handlers = setup([bun, sh, node]);

    const res = await handlers["system-processes"]!({}) as any;

    expect(res.data.processes).toHaveLength(1);
    expect(res.data.processes[0].chainPids).toEqual([10, 20, 30]);
  });

  test("unflattened processes have no chainPids", async () => {
    const parent = makeProcess({ pid: 100, ppid: 1, fullCommand: "node parent.js" });
    const childA = makeProcess({ pid: 101, ppid: 100, fullCommand: "node a.js" });
    const childB = makeProcess({ pid: 102, ppid: 100, fullCommand: "node b.js" });
    const handlers = setup([parent, childA, childB]);

    const res = await handlers["system-processes"]!({}) as any;

    expect(res.data.processes).toHaveLength(1);
    expect(res.data.processes[0].chainPids).toBeUndefined();
    expect(res.data.processes[0].children).toHaveLength(2);
  });
});
