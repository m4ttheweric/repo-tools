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
import { envelope } from "../lib/setup/contract.ts";
import { UserActionableError, exitUserError } from "../lib/setup/errors.ts";
import { readIntent, teamRefFromIntent } from "../lib/setup/intent.ts";
import { createRealProbes, type Probes } from "../lib/setup/probes.ts";
import { readPackRequirements, type PackRequirements } from "../lib/setup/requirements.ts";
import { claudeConfigDirs, installTool, setupTool } from "../lib/setup/tools-install.ts";
import { listTeams } from "../lib/settings/stores.ts";

function tool(args: string[]): string | undefined {
  return args.find((a) => !a.startsWith("--"));
}

function flagValues(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1] !== undefined) values.push(args[i + 1]!);
  }
  return values;
}

/** Mirrors composePlan's own team resolution (readIntent → teamRefFromIntent) so a team-declared brew formula/vendor URL is found the same way the plan row that offered this Install action found it. No joined team is not an error — plenty of tools (herdr, claude, apple-clt) need no reqs at all. */
function resolveTeamReqs(p: Probes): PackRequirements[] {
  const ref = teamRefFromIntent(readIntent(p), listTeams());
  return ref.slug ? readPackRequirements(p, ref.slug) : [];
}

export async function toolsInstall(args: string[], _ctx: CommandContext = {}, p: Probes = createRealProbes()): Promise<void> {
  const json = args.includes("--json");
  const t = tool(args);
  if (!t) exitUserError(new UserActionableError("usage", "usage: rt tools install <tool> [--json]"), json, "tools install");

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
  const t = tool(args);
  if (!t) exitUserError(new UserActionableError("usage", "usage: rt tools setup <tool> [--config-dir <dir>]… [--json]"), json, "tools setup");

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
