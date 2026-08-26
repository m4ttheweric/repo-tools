/**
 * lib/agent-herdr.ts - herdr transport for `rt agent` (and rebase
 * escalation): workspace find-or-create, tab-label dedup, pane run.
 *
 * Lifted from mr-board src/herdr.ts, which has months of production history
 * with exactly this sequence. Dedup rule: a live tab with the requested
 * label is focused, never re-run - re-invoking an action must not stack a
 * second claude in a fresh pane.
 *
 * herdr is invoked by absolute path with HERDR_SOCKET_PATH set explicitly:
 * under launchd the daemon's start PATH has neither, and Bun.spawn resolves
 * executables from the start env, not runtime process.env.
 *
 * The bounded-agent primitive for rt verbs (see rt-agent-boundary memory):
 * rt gathers context deterministically, an agent does one bounded step in a
 * visible pane, rt verifies the result from real state afterward.
 */

import { homedir } from "os";
import { join } from "path";
import { runCapture } from "./subprocess.ts";

export interface HerdrResult { stdout: string; exitCode: number }
export type HerdrRunner = (args: string[]) => Promise<HerdrResult>;

export function defaultHerdrRunner(): HerdrRunner {
  const home = process.env.HOME ?? homedir();
  const bin = process.env.HERDR_BIN ?? join(home, ".local", "bin", "herdr");
  const socket = process.env.HERDR_SOCKET_PATH ?? join(home, ".config", "herdr", "herdr.sock");
  return async (args) => {
    const r = await runCapture([bin, ...args], {
      timeoutMs: 15_000,
      stderr: "pipe",
      env: { ...process.env, HERDR_SOCKET_PATH: socket },
    });
    return { stdout: r.stdout || r.stderr, exitCode: r.exitCode };
  };
}

async function herdrJson(runner: HerdrRunner, args: string[]): Promise<any> {
  const r = await runner(args);
  if (r.exitCode !== 0) throw new Error(`herdr ${args.join(" ")} failed (${r.exitCode}): ${r.stdout.slice(0, 400)}`);
  try {
    return JSON.parse(r.stdout);
  } catch {
    return {};
  }
}

export interface LaunchOutcome {
  workspaceId: string;
  tabId: string;
  paneId: string;
  focusedExisting: boolean;
}

export async function launchInWorkspace(
  opts: { workspaceLabel: string; tabLabel: string; paneCommand: string },
  runner: HerdrRunner = defaultHerdrRunner(),
): Promise<LaunchOutcome> {
  const list = await herdrJson(runner, ["workspace", "list"]);
  const workspaces: any[] = list?.result?.workspaces ?? [];
  const existing = workspaces.find((w) => w?.label === opts.workspaceLabel);

  if (!existing) {
    // A fresh workspace ships with an initial tab; reuse it instead of
    // orphaning a blank one.
    const created = await herdrJson(runner, ["workspace", "create", "--label", opts.workspaceLabel, "--no-focus"]);
    const root = created?.result?.root_pane;
    if (!root?.pane_id) throw new Error("herdr workspace create returned no root pane");
    await runner(["tab", "rename", root.tab_id, opts.tabLabel]);
    await runner(["pane", "run", root.pane_id, opts.paneCommand]);
    return { workspaceId: root.workspace_id, tabId: root.tab_id, paneId: root.pane_id, focusedExisting: false };
  }

  const wsId: string = existing.workspace_id;
  const tabs = await herdrJson(runner, ["tab", "list", "--workspace", wsId]);
  const match = (tabs?.result?.tabs ?? []).find((t: any) => t?.label === opts.tabLabel);
  if (match) {
    await runner(["tab", "focus", match.tab_id]);
    return { workspaceId: wsId, tabId: match.tab_id, paneId: "", focusedExisting: true };
  }

  const created = await herdrJson(runner, ["tab", "create", "--workspace", wsId, "--label", opts.tabLabel, "--no-focus"]);
  const root = created?.result?.root_pane;
  if (!root?.pane_id) throw new Error("herdr tab create returned no root pane");
  await runner(["pane", "run", root.pane_id, opts.paneCommand]);
  return { workspaceId: wsId, tabId: root.tab_id, paneId: root.pane_id, focusedExisting: false };
}

export async function herdrAgentWait(
  paneId: string,
  until: string[],
  timeoutMs: number,
  runner: HerdrRunner = defaultHerdrRunner(),
): Promise<boolean> {
  const args = ["agent", "wait", paneId];
  for (const u of until) args.push("--until", u);
  args.push("--timeout", String(timeoutMs));
  const r = await runner(args);
  return r.exitCode === 0;
}
