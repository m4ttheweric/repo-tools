import { test, expect, afterEach } from "bun:test";
import { fakeHerdr } from "../../herdr/__tests__/fake-herdr.ts";
import { HerdrEngine, EngineError, wrapCommand } from "../engine.ts";

let stop: (() => void) | undefined;
afterEach(() => { stop?.(); stop = undefined; });

function engineWith(handler: Parameters<typeof fakeHerdr>[0]) {
  const f = fakeHerdr(handler);
  stop = f.stop;
  return { engine: new HerdrEngine(f.sock), seen: f.seen };
}

test("wrapCommand cds, runs, and prints the exit sentinel", () => {
  expect(wrapCommand("/tmp/a b", "bun run dev")).toBe("cd '/tmp/a b' && bun run dev; printf '\\n__rt_exit %s\\n' $?");
});

test("createWorkspace creates unfocused and reads the root pane from the reply", async () => {
  const { engine, seen } = engineWith((method, params) => {
    if (method === "workspace.create") return { type: "workspace_created", workspace: { workspace_id: "wX", label: params.label }, tab: { tab_id: "wX:t1" }, root_pane: { pane_id: "wX:p1", tab_id: "wX:t1" } };
    throw new Error("unexpected " + method);
  });
  const ws = await engine.createWorkspace("rt-runner-a3f9");
  expect(ws).toEqual({ workspaceId: "wX", tabId: "wX:t1", paneId: "wX:p1" });
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ method: "workspace.create", params: { label: "rt-runner-a3f9", focus: false } });
});

test("createWorkspace falls back to pane.list when the reply carries no root pane", async () => {
  const { engine, seen } = engineWith((method) => {
    if (method === "workspace.create") return { type: "workspace_created", workspace: { workspace_id: "wX" } };
    if (method === "pane.list") return { type: "pane_list", panes: [{ pane_id: "wX:p1", tab_id: "wX:t1", workspace_id: "wX" }] };
    throw new Error("unexpected " + method);
  });
  expect(await engine.createWorkspace("rt-runner-a3f9")).toEqual({ workspaceId: "wX", tabId: "wX:t1", paneId: "wX:p1" });
  expect(seen[1]).toMatchObject({ method: "pane.list", params: { workspace_id: "wX" } });
});

test("createTab creates unfocused and reads its root pane from the reply", async () => {
  const { engine, seen } = engineWith((method) => {
    if (method === "tab.create") return { type: "tab_created", tab: { tab_id: "wX:t2", workspace_id: "wX" }, root_pane: { pane_id: "wX:p2", tab_id: "wX:t2" } };
    throw new Error("unexpected " + method);
  });
  expect(await engine.createTab("wX", "api")).toEqual({ tabId: "wX:t2", paneId: "wX:p2" });
  expect(seen[0]).toMatchObject({ method: "tab.create", params: { workspace_id: "wX", label: "api", focus: false } });
});

test("createTab falls back to pane.list filtered by tab when the reply carries no root pane", async () => {
  const { engine } = engineWith((method) => {
    if (method === "tab.create") return { type: "tab_created", tab: { tab_id: "wX:t3", workspace_id: "wX" } };
    if (method === "pane.list") return { type: "pane_list", panes: [{ pane_id: "wX:p1", tab_id: "wX:t1" }, { pane_id: "wX:p3", tab_id: "wX:t3" }] };
    throw new Error("unexpected " + method);
  });
  expect(await engine.createTab("wX", "worker")).toEqual({ tabId: "wX:t3", paneId: "wX:p3" });
});

test("run sends the wrapped text then Enter; interrupt sends ctrl+c", async () => {
  const { engine, seen } = engineWith(() => ({ type: "ok" }));
  await engine.run("wX:p2", "/repo/web", "bun run dev");
  await engine.interrupt("wX:p2");
  expect(seen.map((s) => s.method)).toEqual(["pane.send_text", "pane.send_keys", "pane.send_keys"]);
  expect(seen[0]!.params).toEqual({ pane_id: "wX:p2", text: wrapCommand("/repo/web", "bun run dev") });
  expect(seen[1]!.params).toEqual({ pane_id: "wX:p2", keys: ["enter"] });
  expect(seen[2]!.params).toEqual({ pane_id: "wX:p2", keys: ["ctrl+c"] });
});

test("processInfo and read map the socket shapes", async () => {
  const { engine, seen } = engineWith((method) => {
    if (method === "pane.process_info") return { type: "pane_process_info", process_info: { pane_id: "wX:p2", foreground_process_group_id: 4242, shell_pid: 4000, foreground_processes: [{ pid: 4242, name: "bun", cmdline: "bun run dev" }] } };
    if (method === "pane.read") return { type: "pane_read", read: { text: "line one\nline two\n", truncated: false } };
    throw new Error("unexpected " + method);
  });
  expect(await engine.processInfo("wX:p2")).toEqual({ foregroundPgid: 4242, shellPid: 4000, foreground: [{ pid: 4242, name: "bun", cmdline: "bun run dev" }] });
  expect(await engine.read("wX:p2", 200)).toBe("line one\nline two\n");
  expect(seen[1]!.params).toEqual({ pane_id: "wX:p2", source: "recent_unwrapped", lines: 200, strip_ansi: true, format: "text" });
});

test("a herdr error becomes an EngineError with the code and message", async () => {
  const { HerdrFakeError } = await import("../../herdr/__tests__/fake-herdr.ts");
  const { engine } = engineWith(() => new HerdrFakeError("not_found", "no such pane"));
  await expect(engine.focusTab("wX:t9")).rejects.toMatchObject({ name: "EngineError", code: "not_found", message: "no such pane" });
});

test("an unreachable socket is an EngineError too", async () => {
  const engine = new HerdrEngine("/nonexistent/herdr.sock");
  await expect(engine.closeWorkspace("wX")).rejects.toBeInstanceOf(EngineError);
});
