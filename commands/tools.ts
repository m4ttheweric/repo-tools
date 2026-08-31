/**
 * rt tools install|setup — what a setup plan row's Install button spawns.
 *
 *   rt tools install <tool> [--json]
 *   rt tools setup <tool> [--config-dir <dir>]… [--json]
 *
 * Thin CLI shell over lib/setup/tools-install.ts: this module only parses
 * args, resolves the joined team's pack requirements (for team-declared
 * brew formulas/vendor URLs), and renders.
 */

import type { CommandContext } from "../lib/command-tree.ts";
import { flagValues } from "../lib/cli-args.ts";
import { envelope } from "../lib/setup/contract.ts";
import { UserActionableError, exitUserError } from "../lib/setup/errors.ts";
import { readIntent, teamRefFromIntent } from "../lib/setup/intent.ts";
import { createRealProbes, type Probes } from "../lib/setup/probes.ts";
import { readPackRequirements, type PackRequirements } from "../lib/setup/requirements.ts";
import { BREW_FORMULAE, VENDOR_INSTALLERS, claudeConfigDirs, installTool, setupTool } from "../lib/setup/tools-install.ts";
import { bundledToolExec } from "../lib/deps/resolve.ts";
import { DEFAULT_EXPOSED } from "../lib/deps/links.ts";
import { listTeams } from "../lib/settings/stores.ts";

function tool(args: string[]): string | undefined {
  return args.find((a) => !a.startsWith("--"));
}

/** Mirrors composePlan's own team resolution (readIntent → teamRefFromIntent) so a team-declared brew formula/vendor URL is found the same way the plan row that offered this Install action found it. No joined team is not an error — plenty of tools (herdr, claude, apple-clt) need no reqs at all. */
function resolveTeamReqs(p: Probes): PackRequirements[] {
  const ref = teamRefFromIntent(readIntent(p), listTeams());
  return ref.slug ? readPackRequirements(p, ref.slug) : [];
}

/** What installTool can act on here, mirroring its branch order: apple-clt, rt's bundled tools that resolve in this environment, its hardcoded brew/vendor formulae, and the joined team's declared tools. */
function installableTools(p: Probes, reqs: PackRequirements[]): string[] {
  const names = new Set<string>(["apple-clt", ...Object.keys(BREW_FORMULAE), ...Object.keys(VENDOR_INSTALLERS)]);
  for (const name of DEFAULT_EXPOSED) if (name !== "rt" && bundledToolExec(p, name)) names.add(name);
  for (const r of reqs) for (const t of r.tools) names.add(t.name);
  return [...names].sort();
}

/** The tools setupTool has a post-install routine for (its only branches). */
const SETUP_TOOLS = ["herdr", "fast-browser", "extension"];

async function pickTool(message: string, names: string[]): Promise<string | null> {
  const { filterableSelect } = await import("../lib/rt-render.ts");
  return filterableSelect({ message, options: names.map((n) => ({ value: n, label: n })), stderr: true });
}

export async function toolsInstall(args: string[], _ctx: CommandContext = {}, p: Probes = createRealProbes()): Promise<void> {
  const json = args.includes("--json");
  let t = tool(args);
  if (!t) {
    if (process.stdin.isTTY && !json && !process.env.RT_BATCH) {
      t = (await pickTool("Install which tool?", installableTools(p, resolveTeamReqs(p)))) ?? undefined;
      if (!t) process.exit(0);
    } else {
      exitUserError(new UserActionableError("usage", "usage: rt tools install <tool> [--json]"), json, "tools install");
    }
  }

  const reqs = resolveTeamReqs(p);

  let result: Awaited<ReturnType<typeof installTool>>;
  try {
    result = await installTool(p, t, reqs);
  } catch (err) {
    if (err instanceof UserActionableError) exitUserError(err, json, "tools install");
    throw err;
  }

  if (json) {
    console.log(JSON.stringify(envelope(result)));
    if (!result.ok) process.exit(1);
    return;
  }
  console.log(`rt tools install: ${t} (${result.via}) — ${result.ok ? "ok" : "failed"}: ${result.detail}`);
  if (!result.ok) process.exit(1);
}

export async function toolsSetup(args: string[], _ctx: CommandContext = {}, p: Probes = createRealProbes()): Promise<void> {
  const json = args.includes("--json");
  let t = tool(args);
  if (!t) {
    if (process.stdin.isTTY && !json && !process.env.RT_BATCH) {
      t = (await pickTool("Set up which tool?", SETUP_TOOLS)) ?? undefined;
      if (!t) process.exit(0);
    } else {
      exitUserError(new UserActionableError("usage", "usage: rt tools setup <tool> [--config-dir <dir>]… [--json]"), json, "tools setup");
    }
  }

  const configDirs = claudeConfigDirs(p, flagValues(args, "--config-dir"));

  let result: Awaited<ReturnType<typeof setupTool>>;
  try {
    result = await setupTool(p, t, { configDirs });
  } catch (err) {
    if (err instanceof UserActionableError) exitUserError(err, json, "tools setup");
    throw err;
  }

  if (json) {
    console.log(JSON.stringify(envelope(result)));
    if (!result.ok) process.exit(1);
    return;
  }
  console.log(`rt tools setup: ${t} — ${result.ok ? "ok" : "failed"}: ${result.detail}`);
  if (!result.ok) process.exit(1);
}
