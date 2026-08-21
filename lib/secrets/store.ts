/**
 * The sops-backed secrets store: `~/.mattstack/user/secrets/<domain>.json`,
 * decrypted with the mattstack age key (lib/home/age-key.ts) via SOPS_AGE_KEY.
 * The key crosses into the sops subprocess ONLY through that env var — never
 * argv, never a file — mirroring readAgeKey's own custody rule and its
 * `.sops.yaml` creation rule for `user/secrets/**` (lib/home/age-key.ts).
 *
 * Write idiom: stage plaintext at `~/.mattstack/rt/tmp/<domain>.<pid>.json`
 * (rt/ is gitignored — never a tracked path), fsync it, encrypt with
 * `--filename-override user/secrets/<domain>.json` (keeps the `.sops.yaml`
 * path_regex matching even though the real input lives in rt/tmp) into
 * `<target>.tmp`, fsync + rename that over the real target, then read the
 * result back and confirm it looks like sops ciphertext before declaring
 * success. Every staging/output-tmp path is unlinked in a `finally`, so a
 * failure never leaves plaintext at a path the user has to find and delete —
 * the original target (untouched until the rename) is always the fallback.
 * This keeps the new value out of every subprocess's argv too, unlike
 * `sops --set`, which would put it on the sops command line.
 *
 * No file locking: two concurrent `rt secrets set` calls against the same
 * domain race on the same rename target (last one to rename wins, silently
 * dropping the other's merge). Acceptable for a single-operator CLI; not
 * safe for concurrent/multi-process writers.
 */

import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "fs";
import { dirname, join } from "path";
import { mattstackHome, rtDir } from "../rt-paths.ts";
import { readAgeKey, type AgeKeySeam } from "../home/age-key.ts";

export interface SecretsExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface SecretsExecSeam {
  run(cmd: string[], opts?: { env?: Record<string, string>; sensitive?: boolean }): Promise<SecretsExecResult>;
  fileExists(path: string): boolean;
  /**
   * mtime/size signature for the domain memo's staleness check — a rotation
   * landing on disk from another process (a CLI `rt secrets set` next to a
   * long-lived daemon) changes this even though nothing in THIS process
   * called writeSecret to invalidate the memo. Null when the file can't be
   * stat'd (treated as "can't prove freshness" — never trust the memo then).
   */
  statFile(path: string): { mtimeMs: number; size: number } | null;
  /** Raw fs read (no decryption) — used for the post-encrypt ciphertext readback. */
  readFile(path: string): string;
  /** Writes the plaintext staging file only: 0600, fsynced. Never used for the real target. */
  writeFile(path: string, content: string): void;
  ensureDir(path: string, mode: number): void;
  chmod(path: string, mode: number): void;
  /** fsyncs `from`, then renames it over `to` — the atomic publish step. */
  fsyncAndRename(from: string, to: string): void;
  /** Best-effort unlink; never throws (cleanup must not mask the real error). */
  removeFile(path: string): void;
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

// `domain` feeds a filesystem path directly, so it's held to the strict,
// path-escape-proof shape. `key` never touches a path (it's a JSON object
// key), and the brief's own inventory needs room a bare `[a-z0-9-]*` domain
// pattern doesn't give: camelCase names (linearApiKey) and one dotted
// compound (deck's passwordHash.<app>) — so it gets a calibrated pattern
// that still rejects the dangerous shapes (spaces, slashes, control chars)
// without breaking every real key this store is meant to hold.
const DOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** `domain`/`key` become path/object-key components — reject anything else before any fs/exec call. */
export class InvalidSecretsSegmentError extends Error {
  constructor(kind: "domain" | "key", value: string, pattern: RegExp) {
    super(`invalid ${kind} "${value}" — must match ${pattern}`);
  }
}

function validateDomain(domain: string): void {
  if (!DOMAIN_PATTERN.test(domain)) throw new InvalidSecretsSegmentError("domain", domain, DOMAIN_PATTERN);
}

function validateKey(key: string): void {
  if (!KEY_PATTERN.test(key)) throw new InvalidSecretsSegmentError("key", key, KEY_PATTERN);
}

/** Validates `domain` — every path construction routes through here, so this is the one choke point. */
export function secretsFilePath(domain: string): string {
  validateDomain(domain);
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

async function sopsDecrypt(filePath: string, env: Record<string, string>, execSeam: SecretsExecSeam): Promise<Record<string, string>> {
  const result = await execSeam.run(["sops", "-d", filePath], { env, sensitive: true });
  if (result.code !== 0) {
    throw new Error(`sops -d ${filePath}: ${result.stderr}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`sops -d ${filePath}: decrypted output was not valid JSON`);
  }
}

interface DomainSig { mtimeMs: number; size: number }
interface DomainMemoEntry { payload: Record<string, string>; sig: DomainSig }

/**
 * One decrypted domain object per process per domain, valid only while the
 * file's mtime/size match the sig it was decrypted under — see
 * `freshMemoEntry`. writeSecret still deletes its own entry outright (the
 * simplest possible invalidation for the writer's own process); the sig
 * check is what catches a rotation from a DIFFERENT process (the long-lived
 * daemon sitting next to a CLI `rt secrets set`) that never touches this
 * process's memo directly.
 */
const domainMemo = new Map<string, DomainMemoEntry>();

/** Test-only: bun test shares one process across the whole file — clear cross-test state. */
export function resetSecretsMemo(): void {
  domainMemo.clear();
}

function sameSig(a: DomainSig, b: DomainSig): boolean {
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

/** Cached payload if the file's current stat still matches the sig it was decrypted under; undefined otherwise (miss OR can't-stat). */
function freshMemoEntry(domain: string, filePath: string, seams: SecretsSeams): Record<string, string> | undefined {
  const cached = domainMemo.get(domain);
  if (!cached) return undefined;
  const sig = seams.execSeam.statFile(filePath);
  if (!sig || !sameSig(cached.sig, sig)) return undefined;
  return cached.payload;
}

/**
 * Null means the file doesn't exist — distinct from a keychain error, which
 * throws. fileExists is checked BEFORE consulting the memo (not after) so a
 * domain deleted out from under the process re-reads as missing instead of
 * serving a stale cached value.
 */
async function decryptDomain(domain: string, seams: SecretsSeams): Promise<Record<string, string> | null> {
  const filePath = secretsFilePath(domain);
  if (!seams.execSeam.fileExists(filePath)) {
    domainMemo.delete(domain);
    return null;
  }

  const fresh = freshMemoEntry(domain, filePath, seams);
  if (fresh) return fresh;

  const env = await sopsAgeKeyEnv(seams.ageKeySeam);
  const parsed = await sopsDecrypt(filePath, env, seams.execSeam);
  const sig = seams.execSeam.statFile(filePath) ?? { mtimeMs: -1, size: -1 };
  domainMemo.set(domain, { payload: parsed, sig });
  return parsed;
}

export async function readSecret(domain: string, key: string, seams: SecretsSeams): Promise<string | null> {
  validateKey(key);
  const secrets = await decryptDomain(domain, seams);
  if (secrets === null) return null;
  return secrets[key] ?? null;
}

/** Names only — never call this to expose values; commands/secrets.ts prints just the keys. */
export async function listSecretNames(domain: string, seams: SecretsSeams): Promise<string[]> {
  const secrets = await decryptDomain(domain, seams);
  return secrets === null ? [] : Object.keys(secrets);
}

function looksLikeSopsCiphertext(content: string): boolean {
  try {
    const parsed = JSON.parse(content);
    return typeof parsed === "object" && parsed !== null && "sops" in parsed;
  } catch {
    return false;
  }
}

/**
 * Stage → encrypt-to-tmp → fsync+rename → readback. Every path this touches
 * outside the real target is removed in `finally`, so a thrown error never
 * needs to name a file for the user to clean up — there isn't one.
 */
async function encryptDomain(domain: string, targetPath: string, payload: Record<string, string>, execSeam: SecretsExecSeam): Promise<void> {
  const stagingDir = join(rtDir(), "tmp");
  execSeam.ensureDir(stagingDir, 0o700);
  execSeam.ensureDir(dirname(targetPath), 0o700);

  const stagingPath = join(stagingDir, `${domain}.${process.pid}.json`);
  const outputTmpPath = `${targetPath}.tmp`;
  // Relative to the home root, matching .sops.yaml's `path_regex:
  // user/secrets/.*` — the real input path (under rt/tmp) would never match.
  const filenameOverride = join("user", "secrets", `${domain}.json`);

  try {
    execSeam.writeFile(stagingPath, JSON.stringify(payload, null, 2));

    const result = await execSeam.run(
      ["sops", "-e", "--filename-override", filenameOverride, "--output", outputTmpPath, stagingPath],
      { sensitive: true },
    );
    if (result.code !== 0) {
      throw new Error(
        `sops -e ${domain}: encryption failed — ${result.stderr}\n` +
          "no plaintext was left on disk (staging files are always cleaned up)",
      );
    }

    // sops creates outputTmpPath itself, at umask-derived (not 0600) perms.
    execSeam.chmod(outputTmpPath, 0o600);
    execSeam.fsyncAndRename(outputTmpPath, targetPath);
    execSeam.chmod(targetPath, 0o600);

    const readback = execSeam.readFile(targetPath);
    if (!looksLikeSopsCiphertext(readback)) {
      throw new Error(`sops -e ${domain}: post-encrypt read-back of ${targetPath} does not look like sops ciphertext — refusing to declare success`);
    }
  } finally {
    execSeam.removeFile(stagingPath);
    execSeam.removeFile(outputTmpPath);
  }
}

export async function writeSecret(domain: string, key: string, value: string, seams: SecretsSeams): Promise<void> {
  validateKey(key);
  const filePath = secretsFilePath(domain);

  // Encryption alone only needs the recipient's PUBLIC key (from .sops.yaml)
  // — a brand-new domain would otherwise encrypt successfully even on a
  // machine that holds no private key at all, silently writing a credential
  // this machine can never read back. Assert it up front, unconditionally,
  // not only when there happens to be an existing file to decrypt.
  const env = await sopsAgeKeyEnv(seams.ageKeySeam);

  let existing: Record<string, string>;
  if (!seams.execSeam.fileExists(filePath)) {
    existing = {};
  } else {
    existing = freshMemoEntry(domain, filePath, seams) ?? await sopsDecrypt(filePath, env, seams.execSeam);
  }

  // Invalidate before mutating disk: after a failed encrypt the file may
  // hold nothing usable, so a cached ciphertext-derived read would be stale.
  domainMemo.delete(domain);

  const updated = { ...existing, [key]: value };
  await encryptDomain(domain, filePath, updated, seams.execSeam);
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
  validateDomain(domain);
  validateKey(key);
  const newValue = await minter();
  await writeSecret(domain, key, newValue, seams);
  return `secrets: rotate ${domain}.${key}`;
}

const CLI_DEBUG = process.env.RT_LOG_LEVEL === "debug";

/**
 * Pure formatter, exported so its redaction can be unit-tested without a
 * real subprocess: for a sensitive call this must never echo `opts.env`
 * (SOPS_AGE_KEY) or `result.stdout`/`stderr` (the decrypted payload),
 * whatever they contain — only argv, which by this module's design never
 * carries a secret (SOPS_AGE_KEY travels via env, values via files, never
 * argv), so nothing needs positional redaction the way age-key.ts's `-w`
 * value does.
 */
export function formatDebugLine(cmd: string[], opts?: { sensitive?: boolean }): string {
  return `[secrets] ${cmd.join(" ")}${opts?.sensitive ? " (env/output redacted)" : ""}`;
}

function debugLog(cmd: string[], sensitive: boolean | undefined): void {
  if (!CLI_DEBUG) return;
  console.error(formatDebugLine(cmd, { sensitive }));
}

/**
 * Pure builder for the real seam's Bun.spawn opts, split out from `run` so
 * the cwd pin is unit-testable without spawning a subprocess: sops discovers
 * `.sops.yaml` cwd-relative, so a spawn from a foreign cwd (e.g. a CLI
 * command invoked from inside some other repo) can silently match that
 * repo's own `.sops.yaml` rules and encrypt to the wrong recipients instead
 * of erroring. Pinning `cwd` to `mattstackHome()` makes every sops call
 * resolve the home repo's rules regardless of the caller's cwd.
 */
export function buildSecretsSpawnOptions(opts?: { env?: Record<string, string> }): {
  cwd: string;
  env: Record<string, string | undefined>;
  stdout: "pipe";
  stderr: "pipe";
} {
  return {
    cwd: mattstackHome(),
    // A fresh object every call (not a live reference/pass-through like
    // init-exec.ts's raw `env: process.env`) — but since it's built from
    // process.env at call time rather than cached once at module load, a
    // runtime PATH mutation is still visible; opts.env only layers
    // SOPS_AGE_KEY on top.
    env: { ...process.env, ...opts?.env },
    stdout: "pipe",
    stderr: "pipe",
  };
}

/** Real seam: Bun.spawn-based capture, real fs reads/writes. */
export function createRealSecretsExecSeam(): SecretsExecSeam {
  return {
    async run(cmd, opts) {
      debugLog(cmd, opts?.sensitive);
      const proc = Bun.spawn(cmd, buildSecretsSpawnOptions(opts));
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
    statFile(path) {
      try {
        const st = statSync(path);
        return { mtimeMs: st.mtimeMs, size: st.size };
      } catch {
        return null;
      }
    },
    readFile(path) {
      return readFileSync(path, "utf8");
    },
    writeFile(path, content) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const fd = openSync(path, "w", 0o600);
      try {
        writeSync(fd, content);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      chmodSync(path, 0o600); // mode at open() only applies to a freshly-created inode
    },
    ensureDir(path, mode) {
      mkdirSync(path, { recursive: true, mode });
      chmodSync(path, mode);
    },
    chmod(path, mode) {
      chmodSync(path, mode);
    },
    fsyncAndRename(from, to) {
      const fd = openSync(from, "r+");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(from, to);
    },
    removeFile(path) {
      try {
        unlinkSync(path);
      } catch {
        // already gone, or nothing was ever written — cleanup is best-effort
      }
    },
  };
}
