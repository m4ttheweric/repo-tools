// lib/daemon/__tests__/herdr-process-manager.test.ts
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { HerdrProcessManager } from "../herdr-process-manager.ts";
import { PaneMap } from "../herdr/pane-map.ts";
import { StateStore } from "../state-store.ts";

function harness() {
  const calls: { method: string; params: any }[] = [];
  const client = {
    async call(method: string, params: any) {
      calls.push({ method, params });
      if (method === "workspace.create") return { root_pane: { pane_id: "w9:p1", terminal_id: "term_x", workspace_id: "w9" }, workspace: { workspace_id: "w9" } };
      if (method === "pane.run") return { type: "ok" };
      if (method === "pane.close") return { type: "ok" };
      return {};
    },
    async available() { return true; },
  } as any;
  const dir = mkdtempSync(join(tmpdir(), "rt-hpm-"));
  const pm = new HerdrProcessManager({ client, paneMap: new PaneMap(dir), stateStore: new StateStore(dir), now: () => 1000 });
  return { pm, calls, dir };
}

describe("HerdrProcessManager.spawn", () => {
  test("creates a herdr pane, records the map entry, sets state running", async () => {
    const { pm, calls, dir } = harness();
    try {
      await pm.spawn("backend:start", "pnpm start", { cwd: "/repo/wt2/apps/backend", env: { PORT: "4000" } });
      expect(calls.some((c) => c.method === "workspace.create")).toBe(true);
      const ranWith = calls.find((c) => c.method === "pane.run")?.params;
      expect(ranWith.pane_id).toBe("w9:p1");
      expect(String(ranWith.text ?? ranWith.command)).toContain("pnpm start");
      const cfg = pm.getSpawnConfig("backend:start");
      expect(cfg?.cwd).toBe("/repo/wt2/apps/backend");
      expect(cfg?.env?.PORT).toBe("4000");
      expect(pm.list().map((p) => p.id)).toEqual(["backend:start"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("HerdrProcessManager.kill", () => {
  test("closes the pane and drops the map entry", async () => {
    const { pm, calls, dir } = harness();
    try {
      await pm.spawn("x", "sleep 1", { cwd: "/tmp" });
      await pm.kill("x");
      expect(calls.some((c) => c.method === "pane.close")).toBe(true);
      expect(pm.getSpawnConfig("x")).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
