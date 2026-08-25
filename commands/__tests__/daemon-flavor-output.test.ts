import { describe, test, expect } from "bun:test";
import { tupleWarning, flavorHintPath } from "../daemon.ts";

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

  test("hint path follows intended mode", () => {
    expect(flavorHintPath({ mode: "dev", provenance: "setting" })).toContain("mattstack-dev.app");
    expect(flavorHintPath({ mode: "prod", provenance: "setting" })).not.toContain("mattstack-dev.app");
  });
});
