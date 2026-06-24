// lib/daemon/__tests__/herdr-process-manager-output.test.ts
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { HerdrProcessManager } from "../herdr-process-manager.ts";
import { PaneMap } from "../herdr/pane-map.ts";
import { StateStore } from "../state-store.ts";

describe("subscribeToOutput (poll diff)", () => {
  test("emits only newly-appended text between polls", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rt-o-"));
    try {
      let buf = "line1\n";
      const client = {
        async call(m: string) {
          // Mock returns the real socket shape for pane.read
          return m === "pane.read" ? { type: "pane_read", read: { text: buf } } : {};
        },
        async available() { return true; },
      } as any;
      const pm = new HerdrProcessManager({ client, paneMap: new PaneMap(dir), stateStore: new StateStore(dir), now: () => 1 });
      (pm as any).paneMap.set({ id: "x", workspaceId: "w", paneId: "w:p1", terminalId: "t", cwd: "/", cmd: "c", startedAt: 1 });
      const got: string[] = [];
      const unsub = pm.subscribeToOutput("x", (c) => got.push(new TextDecoder().decode(c)));
      await (pm as any).pollOutput("x");   // first poll: whole buffer is "new"
      buf += "line2\n";
      await (pm as any).pollOutput("x");   // second poll: only "line2\n" is new
      unsub();
      expect(got.join("")).toContain("line1");
      expect(got.join("")).toContain("line2");
      expect(got[1]).not.toContain("line1");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("unsubscribe stops the interval timer and removes subscriber", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rt-unsub-"));
    try {
      const client = {
        async call(m: string) { return m === "pane.read" ? { text: "data\n" } : {}; },
        async available() { return true; },
      } as any;
      const pm = new HerdrProcessManager({ client, paneMap: new PaneMap(dir), stateStore: new StateStore(dir), now: () => 1 });
      (pm as any).paneMap.set({ id: "y", workspaceId: "w", paneId: "w:p2", terminalId: "t2", cwd: "/", cmd: "c", startedAt: 1 });
      const unsub = pm.subscribeToOutput("y", () => {});
      expect((pm as any).pollTimers.has("y")).toBe(true);
      unsub();
      expect((pm as any).pollTimers.has("y")).toBe(false);
      expect((pm as any).outputHooks.has("y")).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("emitNotice delivers text synchronously to current subscribers", () => {
    const dir = mkdtempSync(join(tmpdir(), "rt-notice-"));
    try {
      const client = {
        async call() { return {}; },
        async available() { return true; },
      } as any;
      const pm = new HerdrProcessManager({ client, paneMap: new PaneMap(dir), stateStore: new StateStore(dir), now: () => 1 });
      (pm as any).paneMap.set({ id: "z", workspaceId: "w", paneId: "w:p3", terminalId: "t3", cwd: "/", cmd: "c", startedAt: 1 });
      const got: string[] = [];
      const unsub = pm.subscribeToOutput("z", (c) => got.push(new TextDecoder().decode(c)));
      pm.emitNotice("z", "NOTICE: restarting\n");
      unsub();
      expect(got).toEqual(["NOTICE: restarting\n"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
