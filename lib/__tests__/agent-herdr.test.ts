import { expect, test } from "bun:test";
import { herdrAgentWait, launchInWorkspace, type HerdrRunner } from "../agent-herdr.ts";

function scripted(responses: Record<string, { stdout: string; exitCode?: number }>) {
  const calls: string[][] = [];
  const runner: HerdrRunner = async (args) => {
    calls.push(args);
    const r = responses[args.slice(0, 2).join(" ")] ?? { stdout: "{}" };
    return { stdout: r.stdout, exitCode: r.exitCode ?? 0 };
  };
  return { calls, runner };
}

const WS_CREATE = JSON.stringify({
  result: {
    root_pane: { pane_id: "wA:p1", tab_id: "wA:t1", workspace_id: "wA" },
    tab: { tab_id: "wA:t1" },
    workspace: { workspace_id: "wA" },
  },
});
const TAB_CREATE = JSON.stringify({
  result: { root_pane: { pane_id: "wA:p2", tab_id: "wA:t2", workspace_id: "wA" } },
});

test("no workspace: create, rename initial tab, pane run", async () => {
  const { calls, runner } = scripted({
    "workspace list": { stdout: JSON.stringify({ result: { workspaces: [] } }) },
    "workspace create": { stdout: WS_CREATE },
  });
  const out = await launchInWorkspace({ workspaceLabel: "reviews", tabLabel: "!7", paneCommand: "cd '/r' && claude" }, runner);
  expect(calls).toEqual([
    ["workspace", "list"],
    ["workspace", "create", "--label", "reviews", "--no-focus"],
    ["tab", "rename", "wA:t1", "!7"],
    ["pane", "run", "wA:p1", "cd '/r' && claude"],
  ]);
  expect(out).toEqual({ workspaceId: "wA", tabId: "wA:t1", paneId: "wA:p1", focusedExisting: false });
});

test("workspace exists, tab label free: tab create + pane run", async () => {
  const { calls, runner } = scripted({
    "workspace list": { stdout: JSON.stringify({ result: { workspaces: [{ workspace_id: "wA", label: "reviews" }] } }) },
    "tab list": { stdout: JSON.stringify({ result: { tabs: [{ tab_id: "wA:t1", label: "other" }] } }) },
    "tab create": { stdout: TAB_CREATE },
  });
  const out = await launchInWorkspace({ workspaceLabel: "reviews", tabLabel: "!7", paneCommand: "X" }, runner);
  expect(calls[1]).toEqual(["tab", "list", "--workspace", "wA"]);
  expect(calls[2]).toEqual(["tab", "create", "--workspace", "wA", "--label", "!7", "--no-focus"]);
  expect(calls[3]).toEqual(["pane", "run", "wA:p2", "X"]);
  expect(out.focusedExisting).toBe(false);
});

test("live tab with same label: focus, never re-run", async () => {
  const { calls, runner } = scripted({
    "workspace list": { stdout: JSON.stringify({ result: { workspaces: [{ workspace_id: "wA", label: "reviews" }] } }) },
    "tab list": { stdout: JSON.stringify({ result: { tabs: [{ tab_id: "wA:t9", label: "!7" }] } }) },
  });
  const out = await launchInWorkspace({ workspaceLabel: "reviews", tabLabel: "!7", paneCommand: "X" }, runner);
  expect(calls.map((c) => c[0])).toEqual(["workspace", "tab", "tab"]);
  expect(calls[2]).toEqual(["tab", "focus", "wA:t9"]);
  expect(out.focusedExisting).toBe(true);
  expect(calls.flat()).not.toContain("run");
});

test("herdr failure propagates as a throw", async () => {
  const runner: HerdrRunner = async () => ({ stdout: "boom", exitCode: 1 });
  await expect(launchInWorkspace({ workspaceLabel: "w", tabLabel: "t", paneCommand: "X" }, runner)).rejects.toThrow(/herdr/);
});

test("a failed pane run makes the launch throw, not report success", async () => {
  const { runner } = scripted({
    "workspace list": { stdout: JSON.stringify({ result: { workspaces: [] } }) },
    "workspace create": { stdout: WS_CREATE },
    "pane run": { stdout: "claude: command not found", exitCode: 127 },
  });
  await expect(
    launchInWorkspace({ workspaceLabel: "reviews", tabLabel: "!7", paneCommand: "cd '/r' && claude" }, runner),
  ).rejects.toThrow(/herdr pane run/);
});

test("malformed workspace list JSON (exit 0) makes the launch throw", async () => {
  const runner: HerdrRunner = async () => ({ stdout: "not json", exitCode: 0 });
  await expect(
    launchInWorkspace({ workspaceLabel: "reviews", tabLabel: "!7", paneCommand: "X" }, runner),
  ).rejects.toThrow(/invalid JSON/);
});

test("herdrAgentWait builds the current verb (agent wait --until)", async () => {
  const { calls, runner } = scripted({ "agent wait": { stdout: "" } });
  await herdrAgentWait("wA:p1", ["idle", "done"], 45000, runner);
  expect(calls[0]).toEqual(["agent", "wait", "wA:p1", "--until", "idle", "--until", "done", "--timeout", "45000"]);
});
