// lib/daemon/__tests__/herdr-process-manager-describe.test.ts
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { HerdrProcessManager } from "../herdr-process-manager.ts";
import { PaneMap } from "../herdr/pane-map.ts";
import { StateStore } from "../state-store.ts";

const wt = [{ repo: "assured-dev", path: "/repo/wt2", branch: "b" }];

function pmWith(panes: any[], dir: string) {
  const client = {
    async call(method: string) {
      if (method === "pane.list") return { panes };
      return {};
    },
    async available() { return true; },
  } as any;
  return new HerdrProcessManager({ client, paneMap: new PaneMap(dir), stateStore: new StateStore(dir), now: () => 1 });
}

describe("describe", () => {
  test("returns a ProcessRecord per herdr pane, worktree-enriched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rt-d-"));
    try {
      const pm = pmWith([{ pane_id: "w3:p1", terminal_id: "term_a", workspace_id: "w3", cwd: "/repo/wt2/apps/backend", agent_status: "working", foreground_cmd: "node s.js" }], dir);
      const recs = await pm.describe(wt as any);
      expect(recs).toHaveLength(1);
      expect(recs[0]).toMatchObject({ id: "term_a", cwd: "/repo/wt2/apps/backend", repo: "assured-dev", state: "running" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("reconcileOnBoot", () => {
  test("re-adopts surviving mapped panes as running, drops the gone ones", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rt-r-"));
    try {
      const pm = pmWith([{ pane_id: "w3:p1", terminal_id: "term_a", workspace_id: "w3", cwd: "/repo/wt2", agent_status: "working" }], dir);
      const map = (pm as any).paneMap as PaneMap;
      map.set({ id: "survivor", workspaceId: "w3", paneId: "w3:p1", terminalId: "term_a", cwd: "/repo/wt2", cmd: "x", startedAt: 1 });
      map.set({ id: "ghost", workspaceId: "w3", paneId: "w3:p9", terminalId: "term_z", cwd: "/repo/wt2", cmd: "y", startedAt: 1 });
      await pm.reconcileOnBoot();
      expect(map.get("survivor")).toBeDefined();
      expect(map.get("ghost")).toBeUndefined();
      expect((pm as any).stateStore.getState("survivor")).toBe("running");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
