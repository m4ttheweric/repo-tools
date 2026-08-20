/**
 * rt secrets — sops-encrypted secrets under ~/.mattstack/user/secrets/.
 *
 *   rt secrets set <domain> <key> <value>      write one key
 *   rt secrets list <domain>                   list a domain's key names (never values)
 *   rt secrets rotate <domain> <key> <value>   replace a value, print the rotation commit message
 *
 * All three delegate to lib/secrets/store.ts; this module only parses args,
 * wires the real seams, and reports NoAgeKeyError with the `rt home init`
 * pointer (mirrors commands/home.ts's AgeKeyAbsentError handling).
 */

import type { CommandContext } from "../lib/command-tree.ts";
import { createRealAgeKeySeam } from "../lib/home/age-key.ts";
import {
  NoAgeKeyError,
  createRealSecretsExecSeam,
  listSecretNames,
  rotateSecret,
  writeSecret,
  type SecretsSeams,
} from "../lib/secrets/store.ts";

function createRealSecretsSeams(): SecretsSeams {
  return { ageKeySeam: createRealAgeKeySeam(), execSeam: createRealSecretsExecSeam() };
}

function positional(args: string[]): string[] {
  return args.filter((a) => !a.startsWith("--"));
}

function reportSecretsError(err: unknown): never {
  if (err instanceof NoAgeKeyError) {
    console.error(`rt secrets: ${err.message}`);
    process.exit(1);
  }
  throw err;
}

export async function secretsSet(
  args: string[],
  _ctx: CommandContext = {},
  seams: SecretsSeams = createRealSecretsSeams(),
): Promise<void> {
  const [domain, key, value] = positional(args);
  if (!domain || !key || value === undefined) {
    console.error("rt secrets set: usage: rt secrets set <domain> <key> <value>");
    process.exit(1);
  }

  try {
    await writeSecret(domain, key, value, seams);
  } catch (err) {
    reportSecretsError(err);
  }
  console.log(`rt secrets set: wrote ${domain}.${key}`);
}

export async function secretsList(
  args: string[],
  _ctx: CommandContext = {},
  seams: SecretsSeams = createRealSecretsSeams(),
): Promise<void> {
  const [domain] = positional(args);
  if (!domain) {
    console.error("rt secrets list: usage: rt secrets list <domain>");
    process.exit(1);
  }

  let names: string[];
  try {
    names = await listSecretNames(domain, seams);
  } catch (err) {
    reportSecretsError(err);
  }

  if (names.length === 0) {
    console.log(`rt secrets list: no secrets set for domain "${domain}"`);
    return;
  }
  console.log(`Secrets for "${domain}":`);
  for (const name of names) console.log(`  ${name}`);
}

export async function secretsRotate(
  args: string[],
  _ctx: CommandContext = {},
  seams: SecretsSeams = createRealSecretsSeams(),
): Promise<void> {
  const [domain, key, value] = positional(args);
  if (!domain || !key || value === undefined) {
    console.error("rt secrets rotate: usage: rt secrets rotate <domain> <key> <new-value>");
    process.exit(1);
  }

  let message: string;
  try {
    message = await rotateSecret(domain, key, () => value, seams);
  } catch (err) {
    reportSecretsError(err);
  }
  console.log(`rt secrets rotate: ${message}`);
}
