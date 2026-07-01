import { describe, expect, test, spyOn, afterEach } from "bun:test";
import * as notifier from "../notifier.ts";
import type { SystemProcess } from "../daemon/system-process-scanner.ts";

function makeProcess(overrides: Partial<SystemProcess> = {}): SystemProcess {
  return {
    pid: 1234,
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
    ...overrides,
  };
}

describe("checkRunawayProcesses", () => {
  afterEach(() => {
    // Restore any spies installed by a test so they don't leak.
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

describe("NOTIFICATION_TYPES", () => {
  test("registers the runaway_process category", () => {
    const entry = notifier.NOTIFICATION_TYPES.find((t) => t.key === "runaway_process");
    expect(entry).toBeDefined();
    expect(entry?.label).toBe("Runaway processes");
  });
});
