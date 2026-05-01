import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const tmpHome = mkdtempSync(join(tmpdir(), "rt-auto-fix-lock-"));
process.env.HOME = tmpHome;

const { acquireLock, releaseLock, autoFixLockPath, isLockHeld } =
  await import("../auto-fix-lock.ts");

const REPO = "test-repo";

afterEach(() => {
  try { rmSync(join(tmpHome, ".rt", REPO), { recursive: true, force: true }); } catch { /* */ }
});

describe("auto-fix-lock", () => {
  test("autoFixLockPath is ~/.rt/<repo>/auto-fix.lock", () => {
    expect(autoFixLockPath(REPO)).toBe(join(tmpHome, ".rt", REPO, "auto-fix.lock"));
  });

  test("acquireLock succeeds when no lock exists", () => {
    const ok = acquireLock(REPO, { branch: "feat/x", sha: "abc" });
    expect(ok).toBe(true);
    expect(isLockHeld(REPO)).toBe(true);
  });

  test("second acquireLock fails when first is held by a live PID", () => {
    expect(acquireLock(REPO, { branch: "feat/x", sha: "abc" })).toBe(true);
    expect(acquireLock(REPO, { branch: "feat/y", sha: "def" })).toBe(false);
  });

  test("releaseLock removes the file", () => {
    acquireLock(REPO, { branch: "feat/x", sha: "abc" });
    releaseLock(REPO);
    expect(isLockHeld(REPO)).toBe(false);
  });

  test("acquireLock succeeds over a stale lock (dead PID)", () => {
    const lockPath = autoFixLockPath(REPO);
    require("fs").mkdirSync(require("path").dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({
      branch: "feat/old", sha: "old", pid: 999999, startedAt: Date.now(),
    }));
    const ok = acquireLock(REPO, { branch: "feat/x", sha: "abc" });
    expect(ok).toBe(true);
  });

  test("isLockHeld is false for a stale lock", () => {
    const lockPath = autoFixLockPath(REPO);
    require("fs").mkdirSync(require("path").dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({
      branch: "feat/old", sha: "old", pid: 999999, startedAt: Date.now(),
    }));
    expect(isLockHeld(REPO)).toBe(false);
  });
});
