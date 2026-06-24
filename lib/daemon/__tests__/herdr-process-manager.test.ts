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
      if (method === "pane.send_text" || method === "pane.send_keys") return { type: "ok" };
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
      const sent = calls.find((c) => c.method === "pane.send_text")?.params;
      expect(sent.pane_id).toBe("w9:p1");
      expect(String(sent.text)).toContain("pnpm start");
      expect(calls.some((c) => c.method === "pane.send_keys")).toBe(true);
      const cfg = pm.getSpawnConfig("backend:start");
      expect(cfg?.cwd).toBe("/repo/wt2/apps/backend");
      expect(cfg?.env?.PORT).toBe("4000");
      expect(pm.list().map((p) => p.id)).toEqual(["backend:start"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("on a herdr failure, leaves no map entry and ends in stopped, rethrowing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rt-fail-"));
    try {
      const client = {
        async call(method: string) {
          if (method === "workspace.create") return { root_pane: { pane_id: "w9:p1", terminal_id: "t", workspace_id: "w9" }, workspace: { workspace_id: "w9" } };
          if (method === "pane.send_text") throw new Error("herdr boom");
          return {};
        },
        async available() { return true; },
      } as any;
      const pm = new HerdrProcessManager({ client, paneMap: new PaneMap(dir), stateStore: new StateStore(dir), now: () => 1 });
      await expect(pm.spawn("x", "boom", { cwd: "/tmp" })).rejects.toThrow("herdr boom");
      expect(pm.getSpawnConfig("x")).toBeUndefined();
      expect((pm as any).stateStore.getState("x")).toBe("stopped");
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

describe("HerdrProcessManager.getProcess", () => {
  test("returns the herdr foreground pid from the nested process_info shape", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rt-gp-"));
    try {
      const client = {
        async call(m: string, _p?: any) {
          if (m === "workspace.create") return { root_pane: { pane_id: "w9:p1", terminal_id: "t", workspace_id: "w9" }, workspace: { workspace_id: "w9" } };
          if (m === "pane.send_text" || m === "pane.send_keys") return { type: "ok" };
          if (m === "pane.process_info") return { process_info: { foreground_processes: [{ pid: 4242 }], shell_pid: 1 } };
          return {};
        },
        async available() { return true; },
      } as any;
      const pm = new HerdrProcessManager({ client, paneMap: new PaneMap(dir), stateStore: new StateStore(dir), now: () => 1 });
      await pm.spawn("x", "sleep 9", { cwd: "/tmp" });
      expect(await pm.getProcess("x")).toEqual({ pid: 4242 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("falls back to shell_pid when no foreground_processes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rt-gp2-"));
    try {
      const client = {
        async call(m: string, _p?: any) {
          if (m === "workspace.create") return { root_pane: { pane_id: "w9:p1", terminal_id: "t", workspace_id: "w9" }, workspace: { workspace_id: "w9" } };
          if (m === "pane.send_text" || m === "pane.send_keys") return { type: "ok" };
          if (m === "pane.process_info") return { process_info: { foreground_processes: [], shell_pid: 999 } };
          return {};
        },
        async available() { return true; },
      } as any;
      const pm = new HerdrProcessManager({ client, paneMap: new PaneMap(dir), stateStore: new StateStore(dir), now: () => 1 });
      await pm.spawn("x", "sleep 9", { cwd: "/tmp" });
      expect(await pm.getProcess("x")).toEqual({ pid: 999 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("returns undefined for an unknown id", async () => {
    const { pm, dir } = harness();
    try {
      expect(await pm.getProcess("nonexistent")).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
