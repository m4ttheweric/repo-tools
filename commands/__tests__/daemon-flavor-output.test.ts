import { describe, test, expect } from "bun:test";
import { tupleWarning, flavorHintPath, flavorMismatchLines, stillShuttingDownLine } from "../daemon.ts";

describe("flavor-aware daemon output", () => {
  test("agreeing tuple produces no warning", () => {
    expect(tupleWarning({ intended: { mode: "dev", provenance: "setting" }, cliFlavor: "dev", daemon: { flavor: "dev", pid: 1 } })).toBeNull();
  });

  test("stale prod daemon under dev intent names the exact remedy", () => {
    const w = tupleWarning({ intended: { mode: "dev", provenance: "setting" }, cliFlavor: "dev", daemon: { flavor: "prod", pid: 99 } });
    expect(w).toContain("prod");
    expect(w).toContain("rt settings dev-mode dev");
  });

  test("daemon down is not a mismatch", () => {
    expect(tupleWarning({ intended: { mode: "dev", provenance: "setting" }, cliFlavor: "dev", daemon: null })).toBeNull();
  });

  test("cliFlavor-only mismatch still warns, naming all three legs", () => {
    const w = tupleWarning({ intended: { mode: "dev", provenance: "setting" }, cliFlavor: "prod", daemon: { flavor: "dev", pid: 5 } });
    expect(w).toContain("intended dev");
    expect(w).toContain("CLI prod");
    expect(w).toContain("daemon dev");
  });

  test("hint path follows intended mode", () => {
    expect(flavorHintPath({ mode: "dev", provenance: "setting" })).toContain("mattstack-dev.app");
    expect(flavorHintPath({ mode: "prod", provenance: "setting" })).not.toContain("mattstack-dev.app");
  });

  test("stop's mismatch line says the holder still holds the socket", () => {
    const [headline, remedy] = flavorMismatchLines("stop", { flavor: "prod", pid: 42 }, "dev");
    expect(headline).toContain("still holds rt.sock");
    expect(headline).toContain("prod");
    expect(headline).toContain("pid 42");
    expect(remedy).toBe("Fix: rt settings dev-mode dev");
  });

  test("start/restart's mismatch line says the holder answered, not held", () => {
    for (const op of ["start", "restart"] as const) {
      const [headline] = flavorMismatchLines(op, { flavor: "prod", pid: 7 }, "dev");
      expect(headline).toContain("answered on rt.sock");
      expect(headline).not.toContain("still holds");
    }
  });

  test("start/restart mismatch fires on an unknown-flavor holder too", () => {
    const [headline] = flavorMismatchLines("start", { flavor: "unknown flavor", pid: null }, "dev");
    expect(headline).toContain("unknown flavor");
    expect(headline).not.toContain("pid");
  });

  test("still-shutting-down line names the pid and carries no dev-mode remedy", () => {
    const line = stillShuttingDownLine({ pid: 123 });
    expect(line).toContain("still shutting down");
    expect(line).toContain("pid 123");
    expect(line).not.toContain("dev-mode");
  });

  test("still-shutting-down line tolerates a missing pid", () => {
    expect(stillShuttingDownLine({ pid: null })).toBe("still shutting down — give it a moment");
  });
});
