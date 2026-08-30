import { describe, expect, test } from "bun:test";
import { rmSync } from "fs";
import { join } from "path";
import {
  recordBootAttempt,
  recordDaemonReady,
  recordBootFailure,
  recordCleanExit,
  readSupervisionState,
  isCrashLooping,
  writeBreadcrumb,
  readBreadcrumb,
} from "../supervision-state.ts";
import { RT_DIR } from "../../daemon-config.ts";

/** Test-only cleanup mirroring the breadcrumb file's path (production has
 * no clear API; the daemon only ever writes or reads it). */
function removeBreadcrumbFile(): void {
  rmSync(join(RT_DIR, "daemon-boot.json"), { force: true });
}

describe("supervision-state kv round-trip", () => {
  test("boot attempts, ready stamp, failures and last-exit round-trip through kv", () => {
    recordBootAttempt();
    recordBootAttempt();
    recordDaemonReady();
    recordBootFailure("api", "EADDRINUSE");
    const s = readSupervisionState();
    expect(s.bootAttempts).toBe(2);
    expect(s.lastReadyAt).toBeGreaterThan(0);
    expect(s.recentFailures.at(-1)).toMatchObject({ phase: "api", reason: "EADDRINUSE" });
    expect(s.lastExit).toMatchObject({ kind: "boot-failed", code: 1 });
  });

  test("recordCleanExit sets last-exit with the given kind and code", () => {
    recordCleanExit("shutdown", 0);
    const s = readSupervisionState();
    expect(s.lastExit).toMatchObject({ kind: "shutdown", code: 0 });
  });

  test("recent-failures is capped at 10 entries", () => {
    for (let i = 0; i < 15; i++) recordBootFailure("api", `err-${i}`);
    const s = readSupervisionState();
    expect(s.recentFailures.length).toBe(10);
    expect(s.recentFailures.at(-1)).toMatchObject({ reason: "err-14" });
  });
});

describe("isCrashLooping", () => {
  test("true at >=3 failures within the window", () => {
    const now = 1_000_000;
    const fails = [now - 10, now - 20, now - 30].map((at) => ({ at, phase: "api" as const, reason: "x" }));
    expect(isCrashLooping({ bootAttempts: 3, lastReadyAt: 0, recentFailures: fails, lastExit: null }, now)).toBe(true);
    const old = [{ at: now - 10 * 60_000, phase: "api" as const, reason: "x" }];
    expect(isCrashLooping({ bootAttempts: 1, lastReadyAt: 0, recentFailures: old, lastExit: null }, now)).toBe(false);
  });
});

describe("breadcrumb file", () => {
  test("writeBreadcrumb then readBreadcrumb round-trips phase, pid, flavor", () => {
    writeBreadcrumb("api");
    const b = readBreadcrumb();
    expect(b).not.toBeNull();
    expect(b?.phase).toBe("api");
    expect(b?.pid).toBe(process.pid);
    expect(typeof b?.at).toBe("number");
  });

  test("readBreadcrumb returns null when no breadcrumb has been written", () => {
    removeBreadcrumbFile();
    expect(readBreadcrumb()).toBeNull();
  });
});
