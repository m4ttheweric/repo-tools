/**
 * rt team create|publish|invite|join — the team-repo lifecycle verbs.
 *
 *   rt team create <name> (--remote <url> | --create-repo <owner>) [--others] [--json]
 *   rt team publish [--team <slug>] --remote <url> [--json]
 *   rt team invite --handle <h> [--team <slug>] [--json]
 *   rt team join [--dry-run] [--json]   (code on stdin as {"code":"..."}, or a prompt on a TTY)
 *
 * Every mutating path funnels through one `UserActionableError` → exit-2
 * envelope, via `exitUserError` (lib/setup/errors.ts).
 */

import type { AgeKeySeam } from "../lib/home/age-key.ts";
import { createRealAgeKeySeam } from "../lib/home/age-key.ts";
import { promptSecret } from "../lib/prompt-secret.ts";
import { createRealTeamSecretsSeams } from "../lib/secrets/team-store.ts";
import { listTeams } from "../lib/settings/stores.ts";
import { envelope } from "../lib/setup/contract.ts";
import { UserActionableError, exitUserError } from "../lib/setup/errors.ts";
import { createRealProbes, readStdinJson, type Probes } from "../lib/setup/probes.ts";
import { createTeam } from "../lib/team/create.ts";
import { mintInvite } from "../lib/team/invite.ts";
import { JoinKeyExchangeError, joinDryRun, joinRedeem, realJoinRedeemSeams, type JoinRedeemSeams, type JoinResult } from "../lib/team/join.ts";
import { publishTeam } from "../lib/team/publish.ts";
import { createRelayClient, inviteRelayUrl } from "../lib/team/relay-client.ts";
import type { CommandContext } from "../lib/command-tree.ts";

export interface TeamDeps {
  probes: Probes;
  print: (s: string) => void;
  exit?: (code: number) => never;
  ageKeySeam?: AgeKeySeam;
  /** `json` gates the interactive TTY prompt — a machine caller must never block waiting on a terminal that isn't there. */
  readCode?: (json: boolean) => Promise<string>;
  /** Overrides `joinRedeem`'s `read`/`readTeamSecret`/`forgeLogin`/`warn` seams — real by default, so a test never has to rely on the isolated test HOME happening to lack a switchboard config. */
  joinRedeemSeams?: Partial<JoinRedeemSeams>;
}

async function defaultReadCode(json: boolean): Promise<string> {
  if (!json && process.stdin.isTTY) {
    return promptSecret("Invite code");
  }
  const parsed = await readStdinJson<{ code?: string }>();
  if (!parsed?.code) {
    throw new UserActionableError("usage", 'pass the invite code on stdin as {"code": "..."}');
  }
  return parsed.code;
}

export function realTeamDeps(): TeamDeps {
  return { probes: createRealProbes(), print: (s) => console.log(s), exit: process.exit, ageKeySeam: createRealAgeKeySeam(), readCode: defaultReadCode };
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

/** Every verb's usage guard routes through here so `--json` gets the same exit-2 envelope a real failure gets, instead of a plain-text line that would corrupt an app-side parse. */
function usageError(deps: TeamDeps, json: boolean, verb: string, usage: string): never {
  exitUserError(new UserActionableError("usage", `usage: ${usage}`), json, verb, deps.print);
}

export async function teamCreate(args: string[], _ctx: CommandContext = {}, deps: TeamDeps = realTeamDeps()): Promise<void> {
  const json = args.includes("--json");
  const others = args.includes("--others");
  const remote = flagValue(args, "--remote") ?? null;
  const createRepoOwner = flagValue(args, "--create-repo");
  const name = positional(args, ["--remote", "--create-repo"])[0];

  if (!name) {
    usageError(deps, json, "team create", "rt team create <name> (--remote <url> | --create-repo <owner>) [--others] [--json]");
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

export async function teamInvite(args: string[], _ctx: CommandContext = {}, deps: TeamDeps = realTeamDeps()): Promise<void> {
  const json = args.includes("--json");
  const handle = flagValue(args, "--handle");

  if (!handle) {
    usageError(deps, json, "team invite", "rt team invite --handle <h> [--team <slug>] [--json]");
  }

  try {
    const slug = resolveTeamSlug(args);
    const relay = createRelayClient(deps.probes.fetch, inviteRelayUrl(deps.probes.env));
    const result = await mintInvite(deps.probes, relay, { slug, handle, now: deps.probes.now() });

    if (json) {
      deps.print(JSON.stringify(envelope(result)));
      return;
    }

    deps.print(result.pasteBlock);
    if (result.forgeAccess !== "granted") {
      deps.print("");
      deps.print(`rt team invite: forge access is ${result.forgeAccess} — finish it by hand:`);
      for (const step of result.manualSteps) deps.print(`  - ${step}`);
    }
  } catch (err) {
    if (err instanceof UserActionableError) exitUserError(err, json, "team invite", deps.print);
    throw err;
  }
}

export async function teamJoin(args: string[], _ctx: CommandContext = {}, deps: TeamDeps = realTeamDeps()): Promise<void> {
  const json = args.includes("--json");
  const dryRun = args.includes("--dry-run");
  const extra = positional(args, ["--dry-run", "--json"]);

  try {
    if (extra.length > 0) {
      throw new UserActionableError("code-on-argv", "pass the invite code on stdin, never as an argument");
    }

    const code = await (deps.readCode ?? defaultReadCode)(json);
    const relay = createRelayClient(deps.probes.fetch, inviteRelayUrl(deps.probes.env));

    let result: JoinResult;
    if (dryRun) {
      result = await joinDryRun(deps.probes, relay, code);
    } else {
      // ageKeySeam is resolved LAST and always from TeamDeps.ageKeySeam first (the field teamCreate also uses) — never
      // from realJoinRedeemSeams' own default, so a test-injected fake never lets a real redeem touch the actual keychain,
      // and never silently loses to a joinRedeemSeams override that didn't set one.
      const seams: JoinRedeemSeams = {
        ...realJoinRedeemSeams(),
        ...deps.joinRedeemSeams,
        ageKeySeam: deps.ageKeySeam ?? deps.joinRedeemSeams?.ageKeySeam ?? createRealAgeKeySeam(),
      };
      result = await joinRedeem(deps.probes, relay, createRealTeamSecretsSeams, { code }, seams);
    }

    if (json) {
      deps.print(JSON.stringify(envelope(result)));
      return;
    }
    deps.print(`rt team join: ${result.message}`);
  } catch (err) {
    if (err instanceof JoinKeyExchangeError) {
      deps.print(json ? JSON.stringify(envelope({ error: { code: "age-key-unavailable", message: err.message } })) : `rt team join: ${err.message}`);
      process.exit(1);
    }
    if (err instanceof UserActionableError) exitUserError(err, json, "team join", deps.print);
    throw err;
  }
}
