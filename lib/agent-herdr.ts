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

import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { runCapture } from "./subprocess.ts";

export interface HerdrResult { stdout: string; exitCode: number }
export type HerdrRunner = (args: string[]) => Promise<HerdrResult>;

/**
 * Mirrors lib/cswap.ts's cswapBin(): Bun.which reads process.env.PATH at
 * call time, and the daemon overlays the user's full login PATH onto
 * process.env.PATH at boot (lib/daemon.ts resolveUserPath), so this resolves
 * a brew-installed herdr even though the daemon's start-env PATH does not
 * carry it. The ~/.local/bin fallback preserves the vendor-script install.
 */
export function resolveHerdrBin(
  env: NodeJS.ProcessEnv = process.env,
  which: (cmd: string) => string | null = (cmd) => Bun.which(cmd),
): string {
  if (env.HERDR_BIN) return env.HERDR_BIN;
  const onPath = which("herdr");
  if (onPath) return onPath;
  const home = env.HOME ?? homedir();
  return join(home, ".local", "bin", "herdr");
}

export function defaultHerdrRunner(env: NodeJS.ProcessEnv = process.env): HerdrRunner {
  const home = env.HOME ?? homedir();
  const bin = resolveHerdrBin(env);
  const socket = env.HERDR_SOCKET_PATH ?? join(home, ".config", "herdr", "herdr.sock");
  return async (args) => {
    if (!existsSync(bin)) {
      throw new Error(`herdr not found at ${bin} (install via \`rt setup\` / brew)`);
    }
    const r = await runCapture([bin, ...args], {
      timeoutMs: 15_000,
      stderr: "pipe",
      env: { ...process.env, HERDR_SOCKET_PATH: socket },
    });
    return { stdout: r.stdout || r.stderr, exitCode: r.exitCode };
  };
}

/** Every herdr invocation in this module goes through here: a non-zero exit must fail the launch, never look like a quiet no-op. */
async function runHerdr(runner: HerdrRunner, args: string[]): Promise<HerdrResult> {
  const r = await runner(args);
  if (r.exitCode !== 0) throw new Error(`herdr ${args.join(" ")} failed (${r.exitCode}): ${r.stdout.slice(0, 400)}`);
  return r;
}

async function herdrJson(runner: HerdrRunner, args: string[]): Promise<any> {
  const r = await runHerdr(runner, args);
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(`herdr ${args.join(" ")} returned invalid JSON: ${r.stdout.slice(0, 400)}`);
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
    await runHerdr(runner, ["tab", "rename", root.tab_id, opts.tabLabel]);
    await runHerdr(runner, ["pane", "run", root.pane_id, opts.paneCommand]);
    return { workspaceId: root.workspace_id, tabId: root.tab_id, paneId: root.pane_id, focusedExisting: false };
  }

  const wsId: string = existing.workspace_id;
  const tabs = await herdrJson(runner, ["tab", "list", "--workspace", wsId]);
  const match = (tabs?.result?.tabs ?? []).find((t: any) => t?.label === opts.tabLabel);
  if (match) {
    await runHerdr(runner, ["tab", "focus", match.tab_id]);
    return { workspaceId: wsId, tabId: match.tab_id, paneId: "", focusedExisting: true };
  }

  const created = await herdrJson(runner, ["tab", "create", "--workspace", wsId, "--label", opts.tabLabel, "--no-focus"]);
  const root = created?.result?.root_pane;
  if (!root?.pane_id) throw new Error("herdr tab create returned no root pane");
  await runHerdr(runner, ["pane", "run", root.pane_id, opts.paneCommand]);
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
