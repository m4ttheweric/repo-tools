/**
 * Herdr agent driver: spawn a Claude Code agent in a herdr pane, hand it a
 * task file, and wait for it to finish.
 *
 * The bounded-agent primitive for rt verbs (see rt-agent-boundary memory):
 * rt gathers context deterministically, the agent does one bounded step in a
 * visible pane, rt verifies the result from real state afterward.
 */

import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

import { getSelfPaneId, shellQuote } from "./herdr-launch.ts";

export interface PaneRef {
  paneId: string;
}

export const AGENT_WAIT_TIMEOUT_MS = 10 * 60_000;

const SOCKET_FALLBACK = join(homedir(), ".config", "herdr", "herdr.sock");
// 15s was too tight for a cold claude start and matched against the ASCII
// ">" prompt, which Claude Code never renders (it draws "❯"); herdr's own
// agent-status detection is rendering-agnostic, so use that instead.
const CLAUDE_READY_TIMEOUT_MS = 60_000;

// env is passed explicitly (not left to the spawnSync default) because Bun
// resolves the executable path from a startup snapshot of the environment
// otherwise, ignoring PATH mutated at runtime; tests that fake `herdr` on
// PATH would silently hit the real binary without this.
function herdrJson(args: string[]): any {
  const r = spawnSync("herdr", args, { encoding: "utf8", stdio: "pipe", env: process.env });
  if (r.status !== 0) {
    throw new Error(`herdr ${args.join(" ")} failed: ${(r.stderr ?? "").trim() || `exit ${r.status}`}`);
  }
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(`herdr ${args.join(" ")} returned non-JSON output`);
  }
}

export function herdrAvailable(): boolean {
  const socket = process.env.HERDR_SOCKET_PATH ?? SOCKET_FALLBACK;
  if (!existsSync(socket)) return false;
  const r = spawnSync("herdr", ["workspace", "list"], { stdio: "pipe", env: process.env });
  return r.status === 0;
}

export function spawnAgentPane(opts: { cwd: string; label: string; repoName: string }): PaneRef {
  // Only resolve a self pane when HERDR_PANE_ID is actually set: getSelfPaneId's
  // fallback (querying the focused pane) is for older herdr versions inside an
  // interactive session, not a signal that we're inside one at all.
  const selfPaneId = process.env.HERDR_PANE_ID ? getSelfPaneId() : undefined;
  if (selfPaneId) {
    const parsed = herdrJson(["pane", "split", selfPaneId, "--direction", "right", "--no-focus"]);
    const paneId = parsed.result?.pane?.pane_id;
    if (!paneId) throw new Error("herdr pane split did not return a pane_id");
    return { paneId };
  }

  const ws = herdrJson(["workspace", "list"]);
  const workspaces: Array<{ workspace_id: string; label: string }> = ws.result?.workspaces ?? [];
  const match = workspaces.find((w) => w.label === opts.repoName);
  if (match) {
    const tab = herdrJson(["tab", "create", "--workspace", match.workspace_id, "--label", opts.label, "--no-focus"]);
    const paneId = tab.result?.root_pane?.pane_id;
    if (!paneId) throw new Error("herdr tab create did not return a root pane");
    return { paneId };
  }

  const created = herdrJson(["workspace", "create", "--cwd", opts.cwd, "--label", opts.label, "--no-focus"]);
  const paneId = created.result?.root_pane?.pane_id;
  if (!paneId) throw new Error("herdr workspace create did not return a root pane");
  return { paneId };
}

export function startClaude(pane: PaneRef, cwd: string): void {
  // The pane may not have been created with this cwd (split panes inherit
  // the parent's, tab-create in a matched workspace passes none), so cd
  // explicitly before launching claude.
  const cmd = `cd ${shellQuote(cwd)} && claude`;
  const run = spawnSync("herdr", ["pane", "run", pane.paneId, cmd], { stdio: "pipe", env: process.env });
  if (run.status !== 0) throw new Error("herdr pane run (claude) failed");

  const wait = spawnSync(
    "herdr",
    ["wait", "agent-status", pane.paneId, "--status", "idle", "--timeout", String(CLAUDE_READY_TIMEOUT_MS)],
    { stdio: "pipe", env: process.env },
  );
  if (wait.status !== 0) throw new Error("claude did not become ready in the pane");
}

export function sendTask(pane: PaneRef, taskFilePath: string): void {
  const message = `Read ${taskFilePath} and complete the task it describes.`;
  const r = spawnSync("herdr", ["pane", "run", pane.paneId, message], { stdio: "pipe", env: process.env });
  if (r.status !== 0) throw new Error("herdr pane run (task) failed");

  if (waitAgentWorking(pane, 5_000) === "working") return;

  // The real Claude Code TUI can absorb the Enter bundled into "pane run"'s
  // paste into the composer instead of submitting it, leaving the task typed
  // but never sent. A follow-up Enter keypress submits whatever is sitting
  // in the composer.
  const nudge = spawnSync("herdr", ["pane", "send-keys", pane.paneId, "Enter"], { stdio: "pipe", env: process.env });
  if (nudge.status !== 0) throw new Error("herdr pane send-keys (Enter nudge) failed");

  if (waitAgentWorking(pane, 10_000) === "working") return;

  throw new Error("agent never picked up the task");
}

// Synchronous (unlike waitAgentIdle): this wait is short (default 15s) and
// runs before the long idle wait, not across a Ctrl+C-able window.
export function waitAgentWorking(pane: PaneRef, timeoutMs = 15_000): "working" | "timeout" {
  const r = spawnSync(
    "herdr",
    ["wait", "agent-status", pane.paneId, "--status", "working", "--timeout", String(timeoutMs)],
    { stdio: "pipe", env: process.env },
  );
  return r.status === 0 ? "working" : "timeout";
}

export async function waitAgentIdle(
  pane: PaneRef,
  timeoutMs: number = AGENT_WAIT_TIMEOUT_MS,
): Promise<"idle" | "timeout"> {
  // Async spawn, not spawnSync: a caller SIGINT handler (Ctrl+C to detach)
  // must be able to fire while we're blocked here for up to ten minutes.
  const proc = Bun.spawn(
    ["herdr", "wait", "agent-status", pane.paneId, "--status", "idle", "--timeout", String(timeoutMs)],
    { stdout: "pipe", stderr: "pipe", env: process.env },
  );
  const code = await proc.exited;
  return code === 0 ? "idle" : "timeout";
}

export function readPane(pane: PaneRef, lines = 40): string {
  const r = spawnSync(
    "herdr",
    ["pane", "read", pane.paneId, "--source", "recent", "--lines", String(lines)],
    { encoding: "utf8", stdio: "pipe", env: process.env },
  );
  return r.status === 0 ? (r.stdout ?? "") : "";
}
