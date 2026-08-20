/**
 * The sops-backed secrets store: `~/.mattstack/user/secrets/<domain>.json`,
 * decrypted with the mattstack age key (lib/home/age-key.ts) via SOPS_AGE_KEY.
 * The key crosses into the sops subprocess ONLY through that env var — never
 * argv, never a file — mirroring readAgeKey's own custody rule and its
 * `.sops.yaml` creation rule for `user/secrets/**` (lib/home/age-key.ts).
 *
 * Write idiom: decrypt (or start from `{}`), merge in JS, write plaintext to
 * the real path, then `sops -e -i` it in place. This keeps the new value out
 * of every subprocess's argv (the alternative, `sops --set`, would put it on
 * the sops command line). The brief window where the file holds plaintext
 * mid-write is the same one `sops <file>`'s own interactive edit flow
 * accepts; the file is written 0600 to bound the exposure.
 */

import { existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { mattstackHome } from "../rt-paths.ts";
import { readAgeKey, type AgeKeySeam } from "../home/age-key.ts";

export interface SecretsExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface SecretsExecSeam {
  run(cmd: string[], opts?: { env?: Record<string, string>; sensitive?: boolean }): Promise<SecretsExecResult>;
  fileExists(path: string): boolean;
  writeFile(path: string, content: string): void;
}

export interface SecretsSeams {
  ageKeySeam: AgeKeySeam;
  execSeam: SecretsExecSeam;
}

/** Thrown when the keychain provably holds no age key yet (readAgeKey's `{absent:true}`). */
export class NoAgeKeyError extends Error {
  constructor() {
    super("no age key in the keychain — run `rt home init` first");
  }
}

export function secretsFilePath(domain: string): string {
  return join(mattstackHome(), "user", "secrets", `${domain}.json`);
}

/**
 * `{absent:true}` becomes this module's own error, never an empty secret —
 * collapsing "no key yet" into "no value" would be indistinguishable from a
 * real missing key at every call site downstream.
 */
async function sopsAgeKeyEnv(ageKeySeam: AgeKeySeam): Promise<Record<string, string>> {
  const result = await readAgeKey(ageKeySeam);
  if (!("key" in result)) throw new NoAgeKeyError();
  return { SOPS_AGE_KEY: result.key };
}

/** One decrypted domain object per process per domain; writeSecret is the only invalidator. */
const domainMemo = new Map<string, Record<string, string>>();

/** Null means the file doesn't exist — distinct from a keychain error, which throws. */
async function decryptDomain(domain: string, seams: SecretsSeams): Promise<Record<string, string> | null> {
  if (domainMemo.has(domain)) return domainMemo.get(domain)!;

  const filePath = secretsFilePath(domain);
  if (!seams.execSeam.fileExists(filePath)) return null;

  const env = await sopsAgeKeyEnv(seams.ageKeySeam);
  const result = await seams.execSeam.run(["sops", "-d", filePath], { env, sensitive: true });
  if (result.code !== 0) {
    throw new Error(`sops -d ${filePath}: ${result.stderr}`);
  }

  let parsed: Record<string, string>;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`sops -d ${filePath}: decrypted output was not valid JSON`);
  }

  domainMemo.set(domain, parsed);
  return parsed;
}

export async function readSecret(domain: string, key: string, seams: SecretsSeams): Promise<string | null> {
  const secrets = await decryptDomain(domain, seams);
  if (secrets === null) return null;
  return secrets[key] ?? null;
}

/** Names only — never call this to expose values; commands/secrets.ts prints just the keys. */
export async function listSecretNames(domain: string, seams: SecretsSeams): Promise<string[]> {
  const secrets = await decryptDomain(domain, seams);
  return secrets === null ? [] : Object.keys(secrets);
}

export async function writeSecret(domain: string, key: string, value: string, seams: SecretsSeams): Promise<void> {
  const filePath = secretsFilePath(domain);
  const existing = (await decryptDomain(domain, seams)) ?? {};
  const updated = { ...existing, [key]: value };

  // Invalidate before mutating disk: after a failed encrypt the file may
  // hold plaintext, so a cached ciphertext-derived read would be stale too.
  domainMemo.delete(domain);

  seams.execSeam.writeFile(filePath, JSON.stringify(updated, null, 2));

  const result = await seams.execSeam.run(["sops", "-e", "-i", filePath], { sensitive: true });
  if (result.code !== 0) {
    throw new Error(`sops -e -i ${filePath}: encryption failed — ${filePath} may still hold plaintext: ${result.stderr}`);
  }
}

/**
 * Re-mints via the injected minter (a provider-specific token/hash generator
 * lives with the caller, not here), writes it, and hands back the commit
 * message — committing is the caller's job (a live-machine step).
 */
export async function rotateSecret(
  domain: string,
  key: string,
  minter: () => string | Promise<string>,
  seams: SecretsSeams,
): Promise<string> {
  const newValue = await minter();
  await writeSecret(domain, key, newValue, seams);
  return `secrets: rotate ${domain}.${key}`;
}

const CLI_DEBUG = process.env.RT_LOG_LEVEL === "debug";

/**
 * Mirrors age-key.ts's withArgvRedaction in spirit, not mechanics: the
 * secret here never touches argv (it's SOPS_AGE_KEY in env, or the decrypted
 * JSON on stdout), so there's no argv position to redact — instead the
 * `sensitive` marker suppresses env and stdout/stderr from the debug line,
 * logging only the command name and path.
 */
function debugLog(cmd: string[], sensitive: boolean | undefined): void {
  if (!CLI_DEBUG) return;
  console.error(`[secrets] ${cmd.join(" ")}${sensitive ? " (env/output redacted)" : ""}`);
}

/** Real seam: Bun.spawn-based capture, real fs reads/writes. */
export function createRealSecretsExecSeam(): SecretsExecSeam {
  return {
    async run(cmd, opts) {
      debugLog(cmd, opts?.sensitive);
      const proc = Bun.spawn(cmd, {
        // Live reference, not a snapshot: matches lib/home/init-exec.ts's
        // PATH-resolution note. SOPS_AGE_KEY overrides via opts.env only.
        env: { ...process.env, ...opts?.env },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { code, stdout, stderr };
    },
    fileExists(path) {
      return existsSync(path);
    },
    writeFile(path, content) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content, { mode: 0o600 });
    },
  };
}
