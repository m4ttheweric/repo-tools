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

describe("checkRunawayProcesses agent exclusion", () => {
  afterEach(() => {
    mock.restore();
  });

  test("stays silent for a runaway AI agent process and its descendants", () => {
    const prefsSpy = spyOn(notifier, "loadNotificationPrefs").mockReturnValue({ runaway_process: true });
    const notifySpy = spyOn(notifier, "notify").mockImplementation(() => {});

    const marked: number[] = [];
    notifier.checkRunawayProcesses(
      [
        makeProcess({ pid: 50, command: "claude", fullCommand: "claude" }),
        // claude's child inherits the exemption through the ppid link
        makeProcess({ pid: 51, ppid: 50, command: "node", fullCommand: "node server.js" }),
        // grandchild too
        makeProcess({ pid: 52, ppid: 51, command: "esbuild", fullCommand: "esbuild --watch" }),
      ],
      (pid) => marked.push(pid),
      () => false,
    );

    expect(notifySpy).not.toHaveBeenCalled();
    // Not marked notified: if the agent exits and the orphan is still
    // runaway, the next sweep should surface it.
    expect(marked).toEqual([]);

    prefsSpy.mockRestore();
    notifySpy.mockRestore();
  });

  test("still notifies for a runaway orphaned by a dead agent session", () => {
    const prefsSpy = spyOn(notifier, "loadNotificationPrefs").mockReturnValue({ runaway_process: true });
    const notifySpy = spyOn(notifier, "notify").mockImplementation(() => {});

    // No claude ancestor in the list — the orphan was reparented to pid 1
    notifier.checkRunawayProcesses(
      [makeProcess({ pid: 51, ppid: 1, command: "node", fullCommand: "node server.js" })],
      () => {},
      () => false,
    );

    expect(notifySpy).toHaveBeenCalledTimes(1);

    prefsSpy.mockRestore();
    notifySpy.mockRestore();
  });
});

describe("NOTIFICATION_TYPES", () => {
  test("registers the runaway_process category", () => {
    const entry = notifier.NOTIFICATION_TYPES.find((t) => t.key === "runaway_process");
    expect(entry).toBeDefined();
    expect(entry?.label).toBe("Runaway processes");
  });
});
