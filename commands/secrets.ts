/**
 * rt secrets — sops-encrypted secrets under ~/.mattstack/user/secrets/, or
 * (with --team) the N-recipient team store under ~/.mattstack/teams/<slug>/.
 *
 *   rt secrets set <domain> <key> [--team <slug>] [--stdin]      write one key
 *   rt secrets list <domain> [--team <slug>]                     list a domain's key names (never values)
 *   rt secrets rotate <domain> <key> [--team <slug>] [--stdin]   replace a value, print the rotation commit message
 *   rt secrets rotate --team <slug>                               re-encrypt every domain file to the team's current recipients (no value to prompt/pipe, so no --stdin)
 *
 * The value is NEVER a CLI arg — that would put it in argv (shell history,
 * `ps`, and rt's own CLI command log). It comes from a no-echo TTY prompt, or
 * from stdin with --stdin (scripting). Every verb delegates to
 * lib/secrets/store.ts (personal) or lib/secrets/team-store.ts (--team);
 * this module only parses args, collects the value, wires the real seams,
 * and reports NoAgeKeyError/InvalidSecretsSegmentError/NoTeamRecipientsError
 * with a clear pointer (mirrors commands/home.ts's AgeKeyAbsentError handling).
 */

import { readdirSync } from "fs";
import { dirname, join } from "path";
import type { CommandContext } from "../lib/command-tree.ts";
import { createRealAgeKeySeam } from "../lib/home/age-key.ts";
import { promptSecret } from "../lib/prompt-secret.ts";
import { mattstackHome } from "../lib/rt-paths.ts";
import {
  InvalidSecretsSegmentError,
  NoAgeKeyError,
  createRealSecretsExecSeam,
  listSecretNames,
  rotateSecret,
  writeSecret,
  type SecretsSeams,
} from "../lib/secrets/store.ts";
import {
  NoTeamRecipientsError,
  TeamReencryptError,
  createRealTeamSecretsSeams,
  listTeamSecretNames,
  reencryptTeamSecrets,
  teamSecretsFile,
  writeTeamSecret,
} from "../lib/secrets/team-store.ts";

function createRealSecretsSeams(): SecretsSeams {
  return { ageKeySeam: createRealAgeKeySeam(), execSeam: createRealSecretsExecSeam() };
}

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Strips recognized flags (and --team's value) — anything else stays positional so validation rejects it visibly instead of it silently vanishing. */
function positional(args: string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--stdin") continue;
    if (a === "--team") {
      i++; // also skip the flag's value
      continue;
    }
    result.push(a);
  }
  return result;
}

/** Existing domain filenames (`.json` stripped) in the personal or `--team` secrets dir; [] when the dir is absent. */
function existingDomains(team: string | undefined): string[] {
  const dir = team ? dirname(teamSecretsFile(team, "x")) : join(mattstackHome(), "user", "secrets");
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.replace(/\.json$/, ""))
      .sort();
  } catch {
    return [];
  }
}

function reportSecretsError(err: unknown): never {
  if (
    err instanceof NoAgeKeyError ||
    err instanceof InvalidSecretsSegmentError ||
    err instanceof NoTeamRecipientsError ||
    err instanceof TeamReencryptError
  ) {
    // TeamReencryptError's own message already names the completed vs.
    // remaining files — a half-rotated team must be loudly described here,
    // not collapsed into a bare "it failed" line.
    console.error(`rt secrets: ${err.message}`);
    process.exit(1);
  }
  throw err;
}

async function readValueFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

async function collectValue(message: string, args: string[]): Promise<string> {
  return args.includes("--stdin") ? readValueFromStdin() : promptSecret(message);
}

export async function secretsSet(args: string[], _ctx: CommandContext = {}, seams?: SecretsSeams): Promise<void> {
  const team = flagValue(args, "--team");
  let [domain, key] = positional(args);
  if ((!domain || !key) && process.stdin.isTTY && !process.env.RT_BATCH) {
    const { textInput } = await import("../lib/rt-render.ts");
    if (!domain) {
      const existing = existingDomains(team);
      const hint = existing.length ? ` (existing: ${existing.join(", ")})` : "";
      const picked = (await textInput({ message: `Domain${hint}`, stderr: true })).trim();
      if (!picked) process.exit(0);
      domain = picked;
    }
    if (!key) {
      const picked = (await textInput({ message: `Key for ${domain}`, stderr: true })).trim();
      if (!picked) process.exit(0);
      key = picked;
    }
  }
  if (!domain || !key) {
    console.error("rt secrets set: usage: rt secrets set <domain> <key> [--team <slug>] [--stdin]");
    process.exit(1);
  }

  const value = await collectValue(`Value for ${domain}.${key}`, args);

  try {
    if (team) {
      await writeTeamSecret(team, domain, key, value, seams ?? createRealTeamSecretsSeams(team));
    } else {
      await writeSecret(domain, key, value, seams ?? createRealSecretsSeams());
    }
  } catch (err) {
    reportSecretsError(err);
  }
  console.log(`rt secrets set: wrote ${team ? `${team}/` : ""}${domain}.${key}`);
}

export async function secretsList(args: string[], _ctx: CommandContext = {}, seams?: SecretsSeams): Promise<void> {
  const team = flagValue(args, "--team");
  let [domain] = positional(args);
  if (!domain && process.stdin.isTTY && !process.env.RT_BATCH) {
    const domains = existingDomains(team);
    if (domains.length > 0) {
      const { filterableSelect } = await import("../lib/rt-render.ts");
      const picked = await filterableSelect({
        message: "Domain",
        options: domains.map((d) => ({ value: d, label: d })),
        stderr: true,
      });
      if (!picked) process.exit(0);
      domain = picked;
    }
  }
  if (!domain) {
    console.error("rt secrets list: usage: rt secrets list <domain> [--team <slug>]");
    process.exit(1);
  }

  let names: string[];
  try {
    names = team
      ? await listTeamSecretNames(team, domain, seams ?? createRealTeamSecretsSeams(team))
      : await listSecretNames(domain, seams ?? createRealSecretsSeams());
  } catch (err) {
    reportSecretsError(err);
  }

  const label = team ? `${team}/${domain}` : domain;
  if (names.length === 0) {
    console.log(`rt secrets list: no secrets set for domain "${label}"`);
    return;
  }
  console.log(`Secrets for "${label}":`);
  for (const name of names) console.log(`  ${name}`);
}

async function rotateTeamAll(team: string, seams?: SecretsSeams): Promise<void> {
  const activeSeams = seams ?? createRealTeamSecretsSeams(team);
  let reencrypted: string[];
  try {
    reencrypted = await reencryptTeamSecrets(team, activeSeams);
  } catch (err) {
    reportSecretsError(err);
  }

  if (reencrypted.length === 0) {
    console.log(`rt secrets rotate: no domain files to re-encrypt for team "${team}"`);
    return;
  }
  console.log(`rt secrets rotate: re-encrypted ${reencrypted.length} file(s) for team "${team}":`);
  for (const f of reencrypted) console.log(`  ${f}`);
  console.log(
    "Note: any member already removed from this team keeps whatever plaintext they already decrypted before " +
      "removal — re-encrypting only stops future decryption, it can't retroactively revoke what they already read.",
  );
}

export async function secretsRotate(args: string[], _ctx: CommandContext = {}, seams?: SecretsSeams): Promise<void> {
  const team = flagValue(args, "--team");
  let [domain, key] = positional(args);

  if (team && !domain && !key) {
    await rotateTeamAll(team, seams);
    return;
  }

  if ((!domain || !key) && process.stdin.isTTY && !process.env.RT_BATCH) {
    const { filterableSelect, textInput } = await import("../lib/rt-render.ts");
    if (!domain) {
      const domains = existingDomains(team);
      if (domains.length > 0) {
        const picked = await filterableSelect({
          message: "Domain",
          options: domains.map((d) => ({ value: d, label: d })),
          stderr: true,
        });
        if (!picked) process.exit(0);
        domain = picked;
      }
    }
    if (domain && !key) {
      const picked = (await textInput({ message: `Key for ${domain}`, stderr: true })).trim();
      if (!picked) process.exit(0);
      key = picked;
    }
  }

  if (!domain || !key) {
    console.error(
      "rt secrets rotate: usage: rt secrets rotate <domain> <key> [--team <slug>] [--stdin]\n" +
        "                or: rt secrets rotate --team <slug>   (re-encrypts every domain file — no value, so no --stdin)",
    );
    process.exit(1);
  }

  const value = await collectValue(`New value for ${domain}.${key}`, args);

  if (team) {
    try {
      await writeTeamSecret(team, domain, key, value, seams ?? createRealTeamSecretsSeams(team));
    } catch (err) {
      reportSecretsError(err);
    }
    console.log(`rt secrets rotate: secrets: rotate ${team}/${domain}.${key}`);
    return;
  }

  let message: string;
  try {
    message = await rotateSecret(domain, key, () => value, seams ?? createRealSecretsSeams());
  } catch (err) {
    reportSecretsError(err);
  }
  console.log(`rt secrets rotate: ${message}`);
}
