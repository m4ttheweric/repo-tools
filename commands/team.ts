/**
 * rt team create|publish — scaffold the local team zone and push it.
 *
 *   rt team create <name> (--remote <url> | --create-repo <owner>) [--others] [--json]
 *   rt team publish [--team <slug>] --remote <url> [--json]
 *
 * join/invite/members are separate tasks; this module only owns the two
 * verbs above. Every mutating path funnels through one `UserActionableError`
 * → exit-2 envelope, via `exitUserError` (lib/setup/errors.ts).
 */

import type { AgeKeySeam } from "../lib/home/age-key.ts";
import { createRealAgeKeySeam } from "../lib/home/age-key.ts";
import { listTeams } from "../lib/settings/stores.ts";
import { envelope } from "../lib/setup/contract.ts";
import { UserActionableError, exitUserError } from "../lib/setup/errors.ts";
import { createRealProbes, type Probes } from "../lib/setup/probes.ts";
import { createTeam } from "../lib/team/create.ts";
import { publishTeam } from "../lib/team/publish.ts";
import type { CommandContext } from "../lib/command-tree.ts";

export interface TeamDeps {
  probes: Probes;
  print: (s: string) => void;
  exit?: (code: number) => never;
  ageKeySeam?: AgeKeySeam;
}

export function realTeamDeps(): TeamDeps {
  return { probes: createRealProbes(), print: (s) => console.log(s), exit: process.exit, ageKeySeam: createRealAgeKeySeam() };
}

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Strips every recognized flag (and its value) so what's left is positional — an unrecognized token stays visible instead of silently vanishing. */
function positional(args: string[], valueFlags: string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (valueFlags.includes(a)) {
      i++;
      continue;
    }
    if (a.startsWith("--")) continue;
    result.push(a);
  }
  return result;
}

export async function teamCreate(args: string[], _ctx: CommandContext = {}, deps: TeamDeps = realTeamDeps()): Promise<void> {
  const json = args.includes("--json");
  const others = args.includes("--others");
  const remote = flagValue(args, "--remote") ?? null;
  const createRepoOwner = flagValue(args, "--create-repo");
  const name = positional(args, ["--remote", "--create-repo"])[0];

  if (!name) {
    deps.print("rt team create: usage: rt team create <name> (--remote <url> | --create-repo <owner>) [--others] [--json]");
    return (deps.exit ?? process.exit)(1);
  }

  try {
    const result = await createTeam(deps.probes, { name, remote, createRepoOwner, others }, deps.ageKeySeam);
    if (json) {
      deps.print(JSON.stringify(envelope(result)));
      return;
    }
    deps.print(
      result.created
        ? `rt team create: scaffolded "${result.slug}" at ${result.dir} (remote ${result.remote})`
        : `rt team create: "${result.slug}" already exists at ${result.dir} (remote ${result.remote}) — nothing to do`,
    );
  } catch (err) {
    if (err instanceof UserActionableError) exitUserError(err, json, "team create", deps.print);
    throw err;
  }
}

/** `--team` omitted falls back to the one locally-cloned team, mirroring `rt settings set --scope team`'s own resolution (packages/rt-client/src/settings/write.ts's `resolveStorePath`). */
function resolveTeamSlug(args: string[]): string {
  const explicit = flagValue(args, "--team");
  if (explicit) return explicit;

  const teams = listTeams();
  if (teams.length === 0) {
    throw new UserActionableError("no-team", "no local team store found — run `rt team create` first, or pass --team");
  }
  if (teams.length > 1) {
    throw new UserActionableError("ambiguous-team", `multiple local team stores found (${teams.join(", ")}) — pass --team to choose one`);
  }
  return teams[0]!;
}

export async function teamPublish(args: string[], _ctx: CommandContext = {}, deps: TeamDeps = realTeamDeps()): Promise<void> {
  const json = args.includes("--json");
  const remote = flagValue(args, "--remote") ?? null;

  try {
    const slug = resolveTeamSlug(args);
    const result = await publishTeam(deps.probes, slug, remote);
    if (json) {
      deps.print(JSON.stringify(envelope(result)));
      return;
    }
    deps.print(`rt team publish: pushed "${slug}" to ${result.remote}`);
  } catch (err) {
    if (err instanceof UserActionableError) exitUserError(err, json, "team publish", deps.print);
    throw err;
  }
}
