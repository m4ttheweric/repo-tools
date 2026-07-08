import { describe, expect, test, spyOn, afterEach, mock } from "bun:test";
import * as notifier from "../notifier.ts";
import type { SystemProcess } from "../daemon/system-process-scanner.ts";

function makeProcess(overrides: Partial<SystemProcess> = {}): SystemProcess {
  return {
    pid: 1234,
    ppid: 1,
    command: "node",
    fullCommand: "node server.js",
    cpuPercent: 95,
    rssKb: 102400,
    uptime: "10:00",
    cwd: "/Users/test/repos/myrepo",
    repo: "myrepo",
    worktree: null,
    branch: "feature/foo",
    relativeDir: ".",
    port: null,
    linearTicket: null,
    isRunaway: true,
    runawayDurationMs: 6 * 60_000,
    firstSeen: Date.now(),
    packageScript: null,
    ...overrides,
  };
}

describe("checkRunawayProcesses", () => {
  afterEach(() => {
    // Restore any spies installed by a test so they don't leak — the in-test
    // mockRestore() calls are skipped when an assertion fails first.
    mock.restore();
  });

  test("notifies and marks notified for a newly-detected runaway process", () => {
    const prefsSpy = spyOn(notifier, "loadNotificationPrefs").mockReturnValue({ runaway_process: true });
    const notifySpy = spyOn(notifier, "notify").mockImplementation(() => {});

    const marked: number[] = [];
    const proc = makeProcess();

    notifier.checkRunawayProcesses(
      [proc],
      (pid) => marked.push(pid),
      () => false,
    );

    expect(notifySpy).toHaveBeenCalledTimes(1);
    const [title, message, url, category] = notifySpy.mock.calls[0]!;
    expect(title).toBe("Runaway Process");
    expect(message).toContain("node");
    expect(message).toContain("myrepo");
    expect(message).toContain("feature/foo");
    expect(message).toContain("95");
    expect(category).toBe("runaway_process");
    expect(marked).toEqual([1234]);

    prefsSpy.mockRestore();
    notifySpy.mockRestore();
  });

  test("skips non-runaway processes", () => {
    const prefsSpy = spyOn(notifier, "loadNotificationPrefs").mockReturnValue({ runaway_process: true });
    const notifySpy = spyOn(notifier, "notify").mockImplementation(() => {});

    const proc = makeProcess({ isRunaway: false });
    const marked: number[] = [];

    notifier.checkRunawayProcesses([proc], (pid) => marked.push(pid), () => false);

    expect(notifySpy).not.toHaveBeenCalled();
    expect(marked).toEqual([]);

    prefsSpy.mockRestore();
    notifySpy.mockRestore();
  });

  test("does not re-notify a process already marked as notified", () => {
    const prefsSpy = spyOn(notifier, "loadNotificationPrefs").mockReturnValue({ runaway_process: true });
    const notifySpy = spyOn(notifier, "notify").mockImplementation(() => {});

    const proc = makeProcess();
    const marked: number[] = [];

    notifier.checkRunawayProcesses([proc], (pid) => marked.push(pid), () => true);

    expect(notifySpy).not.toHaveBeenCalled();
    expect(marked).toEqual([]);

    prefsSpy.mockRestore();
    notifySpy.mockRestore();
  });

  test("respects the runaway_process notification preference toggle", () => {
    const prefsSpy = spyOn(notifier, "loadNotificationPrefs").mockReturnValue({ runaway_process: false });
    const notifySpy = spyOn(notifier, "notify").mockImplementation(() => {});

    const proc = makeProcess();
    const marked: number[] = [];

    notifier.checkRunawayProcesses([proc], (pid) => marked.push(pid), () => false);

    expect(notifySpy).not.toHaveBeenCalled();
    expect(marked).toEqual([]);

    prefsSpy.mockRestore();
    notifySpy.mockRestore();
  });

  test("prefers packageScript over command in the notification message", () => {
    const prefsSpy = spyOn(notifier, "loadNotificationPrefs").mockReturnValue({ runaway_process: true });
    const notifySpy = spyOn(notifier, "notify").mockImplementation(() => {});

    const proc = makeProcess({ packageScript: "pnpm start:lite:watch" });

    notifier.checkRunawayProcesses([proc], () => {}, () => false);

    const [, message] = notifySpy.mock.calls[0]!;
    expect(message).toContain("pnpm start:lite:watch");

    prefsSpy.mockRestore();
    notifySpy.mockRestore();
  });

  test("collapses multiple new runaways into one summary notification", () => {
    const prefsSpy = spyOn(notifier, "loadNotificationPrefs").mockReturnValue({ runaway_process: true });
    const notifySpy = spyOn(notifier, "notify").mockImplementation(() => {});

    const marked: number[] = [];
    const procs = [
      makeProcess({ pid: 1, cpuPercent: 100, packageScript: "pnpm start:lite:watch" }),
      makeProcess({ pid: 2, cpuPercent: 99, packageScript: "pnpm start:lite:watch" }),
      makeProcess({ pid: 3, cpuPercent: 98 }),
      makeProcess({ pid: 4, cpuPercent: 97 }),
    ];

    notifier.checkRunawayProcesses(procs, (pid) => marked.push(pid), () => false);

    expect(notifySpy).toHaveBeenCalledTimes(1);
    const [title, message] = notifySpy.mock.calls[0]!;
    expect(title).toBe("4 Runaway Processes");
    expect(message).toContain("pnpm start:lite:watch");
    expect(message).toContain("+2 more");
    expect(marked.sort()).toEqual([1, 2, 3, 4]);

    prefsSpy.mockRestore();
    notifySpy.mockRestore();
  });

  test("already-notified runaways do not count toward the summary", () => {
    const prefsSpy = spyOn(notifier, "loadNotificationPrefs").mockReturnValue({ runaway_process: true });
    const notifySpy = spyOn(notifier, "notify").mockImplementation(() => {});

    const marked: number[] = [];
    const procs = [
      makeProcess({ pid: 1 }),
      makeProcess({ pid: 2 }),
    ];

    // pid 1 was notified in an earlier tick; only pid 2 is new
    notifier.checkRunawayProcesses(procs, (pid) => marked.push(pid), (pid) => pid === 1);

    expect(notifySpy).toHaveBeenCalledTimes(1);
    const [title] = notifySpy.mock.calls[0]!;
    expect(title).toBe("Runaway Process");
    expect(marked).toEqual([2]);

    prefsSpy.mockRestore();
    notifySpy.mockRestore();
  });

  test("reports <1 minute for a runaway with no accumulated duration yet", () => {
    const prefsSpy = spyOn(notifier, "loadNotificationPrefs").mockReturnValue({ runaway_process: true });
    const notifySpy = spyOn(notifier, "notify").mockImplementation(() => {});

    const proc = makeProcess({ runawayDurationMs: null });

    notifier.checkRunawayProcesses([proc], () => {}, () => false);

    const [, message] = notifySpy.mock.calls[0]!;
    expect(message).toContain("<1 minutes");

    prefsSpy.mockRestore();
    notifySpy.mockRestore();
  });
});

describe("checkRunawayProcesses kill payload", () => {
  afterEach(() => {
    mock.restore();
  });

  test("notification carries the pids so the tray can offer Kill", () => {
    const prefsSpy = spyOn(notifier, "loadNotificationPrefs").mockReturnValue({ runaway_process: true });
    const notifySpy = spyOn(notifier, "notify").mockImplementation(() => {});

    notifier.checkRunawayProcesses(
      [makeProcess({ pid: 7 }), makeProcess({ pid: 8 })],
      () => {},
      () => false,
    );

    const [, , , , pids] = notifySpy.mock.calls[0]!;
    expect(pids?.sort()).toEqual([7, 8]);

    prefsSpy.mockRestore();
    notifySpy.mockRestore();
  });
});

describe("checkParkedWorkloads", () => {
  afterEach(() => {
    mock.restore();
  });

  function memStore(seed: string[] = []): notifier.ParkedNotifiedStore & { keys: Set<string> } {
    const keys = new Set(seed);
    return {
      keys,
      has: (k: string) => keys.has(k),
      add: (k: string) => { keys.add(k); },
      prune: (live: Set<string>) => {
        for (const k of keys) if (!live.has(k)) keys.delete(k);
      },
    };
  }

  function parkedProcess(overrides: Partial<SystemProcess> = {}): SystemProcess {
    return makeProcess({
      isRunaway: false,
      branch: "parking-lot/2",
      worktree: "/Users/test/gh/assured/ron",
      packageScript: "pnpm start:lite:watch",
      ...overrides,
    });
  }

  test("notifies once, with pids, for a workload in a parked worktree", () => {
    const prefsSpy = spyOn(notifier, "loadNotificationPrefs").mockReturnValue({ parked_workload: true });
    const notifySpy = spyOn(notifier, "notify").mockImplementation(() => {});

    const store = memStore();
    notifier.checkParkedWorkloads([parkedProcess({ pid: 42 })], store);

    expect(notifySpy).toHaveBeenCalledTimes(1);
    const [title, message, , category, pids] = notifySpy.mock.calls[0]!;
    expect(title).toBe("Parked Worktree Still Busy");
    expect(message).toContain("pnpm start:lite:watch");
    expect(message).toContain("ron");
    expect(category).toBe("parked_workload");
    expect(pids).toEqual([42]);
    expect(store.keys.size).toBe(1);

    // Second sweep with the same store stays silent
    notifier.checkParkedWorkloads([parkedProcess({ pid: 42 })], store);
    expect(notifySpy).toHaveBeenCalledTimes(1);

    prefsSpy.mockRestore();
    notifySpy.mockRestore();
  });

  test("ignores processes on non-parking branches", () => {
    const prefsSpy = spyOn(notifier, "loadNotificationPrefs").mockReturnValue({ parked_workload: true });
    const notifySpy = spyOn(notifier, "notify").mockImplementation(() => {});

    notifier.checkParkedWorkloads(
      [parkedProcess({ branch: "feature/foo" }), parkedProcess({ branch: null })],
      memStore(),
    );

    expect(notifySpy).not.toHaveBeenCalled();

    prefsSpy.mockRestore();
    notifySpy.mockRestore();
  });

  test("stays silent for AI agent sessions in parked worktrees", () => {
    const prefsSpy = spyOn(notifier, "loadNotificationPrefs").mockReturnValue({ parked_workload: true });
    const notifySpy = spyOn(notifier, "notify").mockImplementation(() => {});

    notifier.checkParkedWorkloads(
      [
        parkedProcess({ pid: 50, command: "claude", fullCommand: "claude", packageScript: null }),
        // claude's child inherits protection through the ppid link
        parkedProcess({ pid: 51, ppid: 50, command: "bun", fullCommand: "bun test", packageScript: null }),
      ],
      memStore(),
    );

    expect(notifySpy).not.toHaveBeenCalled();

    prefsSpy.mockRestore();
    notifySpy.mockRestore();
  });

  test("summarizes across worktrees with accurate counts", () => {
    const prefsSpy = spyOn(notifier, "loadNotificationPrefs").mockReturnValue({ parked_workload: true });
    const notifySpy = spyOn(notifier, "notify").mockImplementation(() => {});

    notifier.checkParkedWorkloads(
      [
        parkedProcess({ pid: 1 }),
        parkedProcess({ pid: 2, worktree: "/Users/test/gh/assured/dobby", branch: "parking-lot/13" }),
        parkedProcess({ pid: 3, worktree: "/Users/test/gh/assured/dumbledore", branch: "parking-lot/4" }),
      ],
      memStore(),
    );

    expect(notifySpy).toHaveBeenCalledTimes(1);
    const [title, message, , , pids] = notifySpy.mock.calls[0]!;
    expect(title).toBe("3 Parked Worktrees Still Busy");
    expect(message).toContain("3 processes");
    expect(pids?.sort()).toEqual([1, 2, 3]);

    prefsSpy.mockRestore();
    notifySpy.mockRestore();
  });

  test("counts worktrees, not processes, in the title", () => {
    const prefsSpy = spyOn(notifier, "loadNotificationPrefs").mockReturnValue({ parked_workload: true });
    const notifySpy = spyOn(notifier, "notify").mockImplementation(() => {});

    // Two chain members in the SAME worktree — one worktree, two processes
    notifier.checkParkedWorkloads(
      [parkedProcess({ pid: 1 }), parkedProcess({ pid: 2, command: "doppler", packageScript: null })],
      memStore(),
    );

    const [title, message] = notifySpy.mock.calls[0]!;
    expect(title).toBe("Parked Worktree Still Busy");
    expect(message).toContain("2 processes");

    prefsSpy.mockRestore();
    notifySpy.mockRestore();
  });

  test("prunes dead pids from the store so a restarted process re-notifies", () => {
    const prefsSpy = spyOn(notifier, "loadNotificationPrefs").mockReturnValue({ parked_workload: true });
    const notifySpy = spyOn(notifier, "notify").mockImplementation(() => {});

    const store = memStore(["999:node", "42:node"]);
    notifier.checkParkedWorkloads([parkedProcess({ pid: 42, command: "node" })], store);

    // 42 was already notified (silent); 999 is gone and gets pruned
    expect(notifySpy).not.toHaveBeenCalled();
    expect(store.keys.has("999:node")).toBe(false);
    expect(store.keys.has("42:node")).toBe(true);

    prefsSpy.mockRestore();
    notifySpy.mockRestore();
  });

  test("respects the pref toggle", () => {
    const notifySpy = spyOn(notifier, "notify").mockImplementation(() => {});
    const prefsOff = spyOn(notifier, "loadNotificationPrefs").mockReturnValue({ parked_workload: false });

    notifier.checkParkedWorkloads([parkedProcess({ pid: 10 })], memStore());
    expect(notifySpy).not.toHaveBeenCalled();

    prefsOff.mockRestore();
    notifySpy.mockRestore();
  });
});

describe("NOTIFICATION_TYPES", () => {
  test("registers the runaway_process category", () => {
    const entry = notifier.NOTIFICATION_TYPES.find((t) => t.key === "runaway_process");
    expect(entry).toBeDefined();
    expect(entry?.label).toBe("Runaway processes");
  });

  test("registers the parked_workload category", () => {
    const entry = notifier.NOTIFICATION_TYPES.find((t) => t.key === "parked_workload");
    expect(entry).toBeDefined();
  });
});
