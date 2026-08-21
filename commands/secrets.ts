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
import {
  InvalidSecretsSegmentError,
  NoAgeKeyError,
  createRealSecretsExecSeam,
  listSecretNames,
  rotateSecret,
  writeSecret,
  type SecretsSeams,
} from "../lib/secrets/store.ts";

const CTRL_C = "";
const DEL = "";

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

/**
 * No-echo prompt (like `read -s`): raw mode so keystrokes never reach the
 * terminal, and nothing is echoed back (not even asterisks) — the value
 * never touches argv, so this is the only place it's typed.
 */
function promptSecretValue(message: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return Promise.reject(new Error(`${message}: not a TTY — pass --stdin to read the value from stdin instead`));
  }
  process.stdout.write(`${message}: `);
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    let value = "";
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
    };
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\n" || ch === "\r") {
          cleanup();
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (ch === CTRL_C) {
          cleanup();
          process.stdout.write("\n");
          reject(new Error("cancelled"));
          return;
        }
        if (ch === DEL || ch === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += ch;
      }
    };
    stdin.resume();
    stdin.setRawMode(true);
    stdin.on("data", onData);
  });
}

async function collectValue(message: string, args: string[]): Promise<string> {
  return args.includes("--stdin") ? readValueFromStdin() : promptSecretValue(message);
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
