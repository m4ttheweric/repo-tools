/**
 * rt secrets — sops-encrypted secrets under ~/.mattstack/user/secrets/.
 *
 *   rt secrets set <domain> <key> [--stdin]      write one key
 *   rt secrets list <domain>                     list a domain's key names (never values)
 *   rt secrets rotate <domain> <key> [--stdin]    replace a value, print the rotation commit message
 *
 * The value is NEVER a CLI arg — that would put it in argv (shell history,
 * `ps`, and rt's own CLI command log). It comes from a no-echo TTY prompt, or
 * from stdin with --stdin (scripting). All three verbs delegate to
 * lib/secrets/store.ts; this module only parses args, collects the value,
 * wires the real seams, and reports NoAgeKeyError/InvalidSecretsSegmentError
 * with a clear pointer (mirrors commands/home.ts's AgeKeyAbsentError handling).
 */

import type { CommandContext } from "../lib/command-tree.ts";
import { createRealAgeKeySeam } from "../lib/home/age-key.ts";
import { promptSecret } from "../lib/prompt-secret.ts";
import {
  InvalidSecretsSegmentError,
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

/** Strips only recognized flags — anything else (even a malformed "--x") stays positional so validation rejects it visibly instead of it silently vanishing. */
function positional(args: string[]): string[] {
  return args.filter((a) => a !== "--stdin");
}

function reportSecretsError(err: unknown): never {
  if (err instanceof NoAgeKeyError || err instanceof InvalidSecretsSegmentError) {
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

export async function secretsSet(
  args: string[],
  _ctx: CommandContext = {},
  seams: SecretsSeams = createRealSecretsSeams(),
): Promise<void> {
  const [domain, key] = positional(args);
  if (!domain || !key) {
    console.error("rt secrets set: usage: rt secrets set <domain> <key> [--stdin]");
    process.exit(1);
  }

  const value = await collectValue(`Value for ${domain}.${key}`, args);

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
  const [domain, key] = positional(args);
  if (!domain || !key) {
    console.error("rt secrets rotate: usage: rt secrets rotate <domain> <key> [--stdin]");
    process.exit(1);
  }

  const value = await collectValue(`New value for ${domain}.${key}`, args);

  let message: string;
  try {
    message = await rotateSecret(domain, key, () => value, seams);
  } catch (err) {
    reportSecretsError(err);
  }
  console.log(`rt secrets rotate: ${message}`);
}
