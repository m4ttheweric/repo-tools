import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";
import { createTestHome, rt, rtRaw } from "../harness.ts";
import { TRAY_APP_BUNDLE, DEV_TRAY_APP_BUNDLE } from "../../lib/rt-paths.ts";

// Mirrors lib/dev-mode.ts's currentMode() logic, but evaluated against the
// SUBPROCESS's fixture `home` — currentMode() itself binds HOME at module
// load time in *this* (outer) test process, so importing it here would check
// the wrong HOME entirely. The e2e harness never writes a dev-mode wrapper
// into the fixture home, so this is expected to always resolve "prod" today;
// asserting it explicitly (rather than hardcoding the prod bundle name)
// keeps this test honest if that ever changes.
function activeFlavor(home: string): "dev" | "prod" {
  return existsSync(join(home, ".local", "bin", "rt")) ? "dev" : "prod";
}

interface VerifyCheck {
  name: string;
  status: "pass" | "fail" | "warn" | "skip";
  detail: string;
  severity: "critical" | "warning" | "info";
}

interface VerifyOutput {
  passed: boolean;
  summary: {
    total: number;
    pass: number;
    fail: number;
    warn: number;
    skip: number;
  };
  checks: VerifyCheck[];
}

describe("verify", () => {
  let home: string;
  let cleanup: () => void;
  let verifyResult: VerifyOutput;

  beforeAll(async () => {
    ({ path: home, cleanup } = createTestHome());

    // Trigger first-run setup so the HOME is initialized
    await rtRaw(["daemon", "install"], { home });

    // Now run verify --json against the initialized HOME
    const result = await rt(["verify", "--json"], { home });
    verifyResult = JSON.parse(result.stdout);
  }, 60_000);

  afterAll(() => cleanup());

  function findCheck(name: string): VerifyCheck | undefined {
    return verifyResult.checks.find((c) => c.name === name);
  }

  test("verify returns valid JSON structure", () => {
    expect(verifyResult).toHaveProperty("passed");
    expect(typeof verifyResult.passed).toBe("boolean");
    expect(verifyResult.summary).toHaveProperty("total");
    expect(verifyResult.summary).toHaveProperty("pass");
    expect(verifyResult.summary).toHaveProperty("fail");
    expect(verifyResult.summary).toHaveProperty("warn");
    expect(verifyResult.summary).toHaveProperty("skip");
    expect(Array.isArray(verifyResult.checks)).toBe(true);
    expect(verifyResult.checks.length).toBeGreaterThan(0);
  });

  test("rt binary check passes", () => {
    const check = findCheck("rt binary");
    expect(check).toBeDefined();
    expect(check!.status).toBe("pass");
  });

  test("fzf check passes", () => {
    const check = findCheck("fzf");
    expect(check).toBeDefined();
    expect(check!.status).toBe("pass");
  });

  test("active flavor's tray app: hard-fails when genuinely nowhere on this machine", () => {
    // installedTrayAppPath (Item 5) also checks the real, absolute
    // /Applications — a location the fixture `home` (passed as the
    // subprocess's HOME) can never isolate, unlike ~/Applications. A machine
    // that genuinely has the bundle installed there is expected to pass this
    // check even against an otherwise-empty fixture home, so assert against
    // that reality instead of assuming a fixed "always fails" outcome.
    const activeBundle = activeFlavor(home) === "dev" ? DEV_TRAY_APP_BUNDLE : TRAY_APP_BUNDLE;
    const check = findCheck(activeBundle);
    expect(check).toBeDefined();
    const reallyInstalledSystemWide = existsSync(join("/Applications", activeBundle));
    expect(check!.status).toBe(reallyInstalledSystemWide ? "pass" : "fail");
  });

  test("inactive flavor's tray app is informational, never a failure", () => {
    const inactiveBundle = activeFlavor(home) === "dev" ? TRAY_APP_BUNDLE : DEV_TRAY_APP_BUNDLE;
    const check = findCheck(inactiveBundle);
    expect(check).toBeDefined();
    expect(check!.status).toBe("skip");
    expect(check!.severity).toBe("info");
  });

  test("daemon checks warn in CI (no Login Items approval)", () => {
    const daemonRunning = findCheck("daemon running");
    if (daemonRunning) {
      expect(["warn", "fail", "skip"]).toContain(daemonRunning.status);
    }
  });
});
