import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestHome, rt, rtRaw } from "../harness.ts";

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

  test("tray app reports expected warning", () => {
    const check = findCheck("rt-tray.app");
    expect(check).toBeDefined();
    expect(["warn", "fail"]).toContain(check!.status);
  });

  test("daemon checks warn in CI (no Login Items approval)", () => {
    const daemonRunning = findCheck("daemon running");
    if (daemonRunning) {
      expect(["warn", "fail", "skip"]).toContain(daemonRunning.status);
    }
  });
});
