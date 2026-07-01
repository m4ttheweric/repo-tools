// lib/daemon/__tests__/system-processes-handlers.test.ts
import { describe, test, expect } from "bun:test";
import { createSystemProcessHandlers } from "../handlers/system-processes.ts";
import type { SystemProcess } from "../system-process-scanner.ts";

function makeProcess(overrides: Partial<SystemProcess> = {}): SystemProcess {
  return {
    pid: 1234,
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
    isRunaway: false,
    runawayDurationMs: null,
    firstSeen: Date.now(),
    ...overrides,
  };
}

function setup(processes: SystemProcess[], cacheEntries: Record<string, any> = {}) {
  const scanner = { getProcesses: () => processes } as any;
  const ctx = { cache: { entries: cacheEntries } } as any;
  return createSystemProcessHandlers(scanner, ctx);
}

describe("system-processes handler", () => {
  test("returns scanner processes with updatedAt", async () => {
    const proc = makeProcess();
    const handlers = setup([proc]);

    const res = await handlers["system-processes"]!({});

    expect(res.ok).toBe(true);
    expect(res.data.processes).toHaveLength(1);
    expect(res.data.processes[0].pid).toBe(1234);
    expect(typeof res.data.updatedAt).toBe("number");
  });

  test("enriches processes with Linear ticket from branch cache", async () => {
    const proc = makeProcess({ branch: "feature/foo" });
    const handlers = setup([proc], {
      "feature/foo": {
        ticket: { identifier: "ENG-123", title: "Do the thing" },
      },
    });

    const res = await handlers["system-processes"]!({});

    expect(res.data.processes[0].linearTicket).toBe("ENG-123: Do the thing");
  });

  test("leaves linearTicket null when branch has no cache entry", async () => {
    const proc = makeProcess({ branch: "feature/untracked" });
    const handlers = setup([proc], {});

    const res = await handlers["system-processes"]!({});

    expect(res.data.processes[0].linearTicket).toBeNull();
  });

  test("leaves linearTicket null when cache entry has no ticket", async () => {
    const proc = makeProcess({ branch: "feature/foo" });
    const handlers = setup([proc], { "feature/foo": { ticket: null } });

    const res = await handlers["system-processes"]!({});

    expect(res.data.processes[0].linearTicket).toBeNull();
  });

  test("leaves linearTicket null when process has no branch", async () => {
    const proc = makeProcess({ branch: null });
    const handlers = setup([proc], {});

    const res = await handlers["system-processes"]!({});

    expect(res.data.processes[0].linearTicket).toBeNull();
  });

  test("returns empty list when scanner has no processes", async () => {
    const handlers = setup([]);

    const res = await handlers["system-processes"]!({});

    expect(res.ok).toBe(true);
    expect(res.data.processes).toEqual([]);
  });
});
