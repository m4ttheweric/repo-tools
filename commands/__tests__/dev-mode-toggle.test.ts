import { describe, test, expect } from "bun:test";
import { devModeGuardVerdict, renderTupleReadout } from "../settings.ts";

describe("dev-mode guard tuple", () => {
  const dev = { mode: "dev" as const, provenance: "setting" as const };

  test("all legs agree: no-op verdict", () => {
    expect(devModeGuardVerdict("dev", { intended: dev, cliFlavor: "dev", daemon: { flavor: "dev", pid: 1 } })).toBe("noop");
  });

  test("CLI dev but prod daemon serving: repair, not noop (the 2026-08-25 half-state)", () => {
    expect(devModeGuardVerdict("dev", { intended: dev, cliFlavor: "dev", daemon: { flavor: "prod", pid: 9 } })).toBe("repair");
  });

  test("daemon down counts as agreement for the guard (handoff will start it)", () => {
    expect(devModeGuardVerdict("dev", { intended: dev, cliFlavor: "dev", daemon: null })).toBe("noop");
  });

  test("different target is always a switch", () => {
    expect(devModeGuardVerdict("prod", { intended: dev, cliFlavor: "dev", daemon: { flavor: "dev", pid: 1 } })).toBe("switch");
  });
});

describe("read-only tuple output", () => {
  test("--json emits machine-readable tuple", () => {
    const out = renderTupleReadout({ intended: { mode: "dev", provenance: "setting" }, cliFlavor: "dev", daemon: null }, true);
    expect(JSON.parse(out)).toMatchObject({ intended: { mode: "dev" }, cliFlavor: "dev", daemon: null });
  });
});
