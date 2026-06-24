// lib/daemon/herdr/__tests__/pane-map.test.ts
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PaneMap, type PaneRef } from "../pane-map.ts";

const ref = (over: Partial<PaneRef>): PaneRef => ({
  id: "adjuster:start", workspaceId: "w3", paneId: "w3:p1", terminalId: "term_a",
  cwd: "/w", cmd: "pnpm start", startedAt: 1, ...over,
});

describe("PaneMap", () => {
  test("set/get/delete round-trip", () => {
    const dir = mkdtempSync(join(tmpdir(), "rt-pm-"));
    try {
      const m = new PaneMap(dir);
      m.set(ref({}));
      expect(m.get("adjuster:start")?.paneId).toBe("w3:p1");
      m.delete("adjuster:start");
      expect(m.get("adjuster:start")).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("persists across instances", () => {
    const dir = mkdtempSync(join(tmpdir(), "rt-pm-"));
    try {
      new PaneMap(dir).set(ref({ id: "x", paneId: "w1:p1" }));
      expect(new PaneMap(dir).get("x")?.paneId).toBe("w1:p1");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("reconcile drops entries whose pane is gone and returns their ids", () => {
    const dir = mkdtempSync(join(tmpdir(), "rt-pm-"));
    try {
      const m = new PaneMap(dir);
      m.set(ref({ id: "alive", paneId: "w3:p1" }));
      m.set(ref({ id: "dead", paneId: "w3:p9" }));
      const dropped = m.reconcile(new Set(["w3:p1"]));
      expect(dropped).toEqual(["dead"]);
      expect(m.get("alive")).toBeDefined();
      expect(m.get("dead")).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
