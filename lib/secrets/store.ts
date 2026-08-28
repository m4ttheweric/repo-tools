/**
 * The sops-backed secrets store: `~/.mattstack/user/secrets/<domain>.json`,
 * decrypted with the mattstack age key (lib/home/age-key.ts) via SOPS_AGE_KEY.
 * The key crosses into the sops subprocess ONLY through that env var — never
 * argv, never a file — mirroring readAgeKey's own custody rule and its
 * `.sops.yaml` creation rule for `secrets/**` (lib/home/age-key.ts). sops
 * resolves `.sops.yaml` and matches `path_regex` cwd-relative, so every sops
 * spawn pins cwd to `<mattstackHome>/user` (buildSecretsSpawnOptions) — the
 * regex, the cwd pin, and the `--filename-override` below all move together
 * or sops silently matches no rule and encrypts to the wrong recipient.
 *
 * Write idiom: stage plaintext at `~/.mattstack/rt/tmp/<domain>.<pid>.json`
 * (rt/ is gitignored — never a tracked path), fsync it, encrypt with
 * `--filename-override secrets/<domain>.json` (relative to the pinned cwd,
 * keeping the `.sops.yaml` path_regex matching even though the real input
 * lives in rt/tmp) into
 * `<target>.<pid>.tmp` (pid-qualified so two concurrent writers can't
 * unlink each other's tmp output), decrypt that tmp output and confirm the
 * newly written key round-trips — a real check that the encrypt used the
 * right recipient, not a content heuristic — and only then fsync + rename
 * it over the real target. Every staging/output-tmp path is unlinked in a
 * `finally`, so a failure never leaves plaintext at a path the user has to
 * find and delete — the original target (untouched until the rename) is
 * always the fallback. This keeps the new value out of every subprocess's
 * argv too, unlike `sops --set`, which would put it on the sops command
 * line.
 *
 * No file locking: two concurrent `rt secrets set` calls against the same
 * domain race on the same rename target (last one to rename wins, silently
 * dropping the other's merge). Acceptable for a single-operator CLI; not
 * safe for concurrent/multi-process writers.
 */

import { resolveBundledTool } from "../bundled-tool.ts";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeSync } from "fs";
import { dirname, join } from "path";
import { mattstackHome, rtDir } from "../rt-paths.ts";
import { readAgeKey, type AgeKeySeam } from "../home/age-key.ts";

export interface SecretsExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface SecretsExecSeam {
  /** `timeoutMs` overrides the default kill-and-reject deadline (see SecretsTimeoutError). */
  run(cmd: string[], opts?: { env?: Record<string, string>; sensitive?: boolean; timeoutMs?: number }): Promise<SecretsExecResult>;
  fileExists(path: string): boolean;
  /**
   * Direct child names of a directory (not recursive); [] when the directory
   * doesn't exist. Only team-store's domain-file discovery
   * (`reencryptTeamSecrets`) needs this — optional so other
   * `SecretsExecSeam` implementations elsewhere in the codebase don't have
   * to grow a method they'll never call.
   */
  listDir?(path: string): string[];
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

/**
 * Where one domain's ciphertext lives and how sops should address it —
 * factored out so the personal store (`user/secrets/<domain>.json`, cwd
 * `<mattstackHome>/user`) and the team store (`team-store.ts`'s
 * `teams/<slug>/mattstack/secrets/<domain>.json`, cwd the team clone root)
 * share the same encrypt/decrypt machinery below instead of two divergent
 * copies of it. `filenameOverride` is cwd-relative on purpose — see
 * `encryptAtLocation`'s doc for why it can't be `filePath` itself.
 */
export interface SecretsLocation {
  filePath: string;
  filenameOverride: string;
  cwd: string;
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
// Team slugs share the domain shape (both become filesystem path segments
// under a fixed root, so the same path-escape-proof pattern applies) but are
// ALSO capped at slugify's own MAX_LENGTH (lib/team/slug.ts) — an oversized
// slug (an attacker-minted invite pointer, not just a hand-typed one) should
// fail validation cleanly here, not surface as an opaque ENAMETOOLONG deep
// inside a git invocation.
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** `domain`/`key`/`slug` become path/object-key components — reject anything else before any fs/exec call. */
export class InvalidSecretsSegmentError extends Error {
  constructor(kind: "domain" | "key" | "slug", value: string, pattern: RegExp) {
    super(`invalid ${kind} "${value}" — must match ${pattern}`);
  }
}

export function validateDomain(domain: string): void {
  if (!DOMAIN_PATTERN.test(domain)) throw new InvalidSecretsSegmentError("domain", domain, DOMAIN_PATTERN);
}

export function validateKey(key: string): void {
  if (!KEY_PATTERN.test(key)) throw new InvalidSecretsSegmentError("key", key, KEY_PATTERN);
}

/** team-store.ts's one choke point for a team slug, mirroring `validateDomain`. */
export function validateSlug(slug: string): void {
  if (!SLUG_PATTERN.test(slug)) throw new InvalidSecretsSegmentError("slug", slug, SLUG_PATTERN);
}

/** Thrown when a sops/keychain spawn does not exit in time (a locked keychain pops a GUI dialog and blocks until clicked). */
export class SecretsTimeoutError extends Error {}

const DEFAULT_SECRETS_TIMEOUT_MS = 30_000;

/** Validates `domain` — every path construction routes through here, so this is the one choke point. */
export function secretsFilePath(domain: string): string {
  validateDomain(domain);
  return join(mattstackHome(), "user", "secrets", `${domain}.json`);
}

/** The personal store's `SecretsLocation`: `user/secrets/<domain>.json`, cwd `<mattstackHome>/user`. */
function personalLocation(domain: string): SecretsLocation {
  return {
    filePath: secretsFilePath(domain), // validates domain
    filenameOverride: join("secrets", `${domain}.json`),
    cwd: join(mattstackHome(), "user"),
  };
}

/**
 * `{absent:true}` becomes this module's own error, never an empty secret —
 * collapsing "no key yet" into "no value" would be indistinguishable from a
 * real missing key at every process-decrypting call site downstream.
 * Exported so team-store.ts's `sops updatekeys` calls (which decrypt an
 * existing multi-recipient file just like `sopsDecrypt` does) resolve
 * `SOPS_AGE_KEY` through this exact same path rather than inventing a
 * second, divergent one — a real `sops updatekeys` with no `SOPS_AGE_KEY` at
 * all exits 128 ("failed to load age identities"), since rt never writes an
 * age `keys.txt` the env-less default location would otherwise find.
 */
export async function sopsAgeKeyEnv(ageKeySeam: AgeKeySeam): Promise<Record<string, string>> {
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
 * location deleted out from under the process re-reads as missing instead of
 * serving a stale cached value. `memoKey` opts a caller into the per-process
 * memo (personal domains use their domain name; team-store reads skip it —
 * see its own module doc for why).
 */
export async function decryptAtLocation(
  location: SecretsLocation,
  seams: SecretsSeams,
  memoKey?: string,
): Promise<Record<string, string> | null> {
  if (!seams.execSeam.fileExists(location.filePath)) {
    if (memoKey) domainMemo.delete(memoKey);
    return null;
  }

  if (memoKey) {
    const fresh = freshMemoEntry(memoKey, location.filePath, seams);
    if (fresh) return fresh;
  }

  const env = await sopsAgeKeyEnv(seams.ageKeySeam);
  const parsed = await sopsDecrypt(location.filePath, env, seams.execSeam);
  if (memoKey) {
    const sig = seams.execSeam.statFile(location.filePath) ?? { mtimeMs: -1, size: -1 };
    domainMemo.set(memoKey, { payload: parsed, sig });
  }
  return parsed;
}

function decryptDomain(domain: string, seams: SecretsSeams): Promise<Record<string, string> | null> {
  return decryptAtLocation(personalLocation(domain), seams, domain);
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

/**
 * Stage → encrypt-to-tmp → decrypt-readback → fsync+rename. The readback
 * decrypts the tmp output (before it ever replaces the target) and checks
 * that `key` round-trips to `value` — catching a wrong-recipient encrypt
 * (a `.sops.yaml` shadowed from $HOME, a stale recipient after rotation)
 * that a plaintext/heuristic check on the ciphertext shape could never see.
 * Every path this touches outside the real target is removed in `finally`,
 * so a thrown error never needs to name a file for the user to clean up —
 * there isn't one, and the target is untouched on every failure.
 *
 * `location.filenameOverride` (not `location.filePath`) is what sops matches
 * against its `.sops.yaml` `path_regex`, cwd-relative — the real staged
 * input lives under `rt/tmp`, which would never match.
 */
export async function encryptAtLocation(
  location: SecretsLocation,
  stagingKey: string,
  payload: Record<string, string>,
  key: string,
  value: string,
  env: Record<string, string>,
  execSeam: SecretsExecSeam,
): Promise<void> {
  const stagingDir = join(rtDir(), "tmp");
  execSeam.ensureDir(stagingDir, 0o700);
  execSeam.ensureDir(dirname(location.filePath), 0o700);

  const stagingPath = join(stagingDir, `${stagingKey}.${process.pid}.json`);
  const outputTmpPath = `${location.filePath}.${process.pid}.tmp`;

  try {
    execSeam.writeFile(stagingPath, JSON.stringify(payload, null, 2));

    const result = await execSeam.run(
      ["sops", "-e", "--filename-override", location.filenameOverride, "--output", outputTmpPath, stagingPath],
      { sensitive: true },
    );
    if (result.code !== 0) {
      throw new Error(
        `sops -e ${stagingKey}: encryption failed — ${result.stderr}\n` +
          "no plaintext was left on disk (staging files are always cleaned up)",
      );
    }

    // sops creates outputTmpPath itself, at umask-derived (not 0600) perms.
    execSeam.chmod(outputTmpPath, 0o600);

    // sops picks the data store from the file extension; the `.tmp` suffix would
    // select the binary store and fail on a JSON tree, so the read-back names
    // the store explicitly (the real `.json` targets need no override).
    const decryptResult = await execSeam.run(
      ["sops", "-d", "--input-type", "json", "--output-type", "json", outputTmpPath],
      { env, sensitive: true },
    );
    let roundTripped: Record<string, string> | undefined;
    if (decryptResult.code === 0) {
      try {
        roundTripped = JSON.parse(decryptResult.stdout);
      } catch {
        roundTripped = undefined;
      }
    }
    if (roundTripped?.[key] !== value) {
      throw new Error(
        `sops -e ${stagingKey}: post-encrypt read-back of ${outputTmpPath} does not round-trip "${key}" — ` +
          `refusing to declare success (${location.filePath} was left untouched)`,
      );
    }

    execSeam.fsyncAndRename(outputTmpPath, location.filePath);
    execSeam.chmod(location.filePath, 0o600);
  } finally {
    execSeam.removeFile(stagingPath);
    execSeam.removeFile(outputTmpPath);
  }
}

/**
 * The read-merge-encrypt body shared by `writeSecret` and team-store's
 * `writeTeamSecret`: decrypts whatever's already at `location` (nothing if
 * absent), merges in `key`/`value`, and re-encrypts through
 * `encryptAtLocation`. Callers validate `domain`/`key`/`slug` themselves
 * before reaching here — this trusts `location` and `key` are already safe
 * path/object-key components.
 */
export async function writeAtLocation(
  location: SecretsLocation,
  stagingKey: string,
  key: string,
  value: string,
  seams: SecretsSeams,
  memoKey?: string,
): Promise<void> {
  // Encryption alone only needs the recipient's PUBLIC key (from .sops.yaml)
  // — a brand-new domain would otherwise encrypt successfully even on a
  // machine that holds no private key at all, silently writing a credential
  // this machine can never read back. Assert it up front, unconditionally,
  // not only when there happens to be an existing file to decrypt.
  const env = await sopsAgeKeyEnv(seams.ageKeySeam);

  let existing: Record<string, string>;
  if (!seams.execSeam.fileExists(location.filePath)) {
    existing = {};
  } else {
    existing =
      (memoKey ? freshMemoEntry(memoKey, location.filePath, seams) : undefined) ??
      (await sopsDecrypt(location.filePath, env, seams.execSeam));
  }

  // Invalidate before mutating disk: after a failed encrypt the file may
  // hold nothing usable, so a cached ciphertext-derived read would be stale.
  if (memoKey) domainMemo.delete(memoKey);

  const updated = { ...existing, [key]: value };
  await encryptAtLocation(location, stagingKey, updated, key, value, env, seams.execSeam);
}

export async function writeSecret(domain: string, key: string, value: string, seams: SecretsSeams): Promise<void> {
  validateKey(key);
  const location = personalLocation(domain);
  await writeAtLocation(location, domain, key, value, seams, domain);
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
 * of erroring. Pinning `cwd` to `<mattstackHome>/user` makes every sops call
 * resolve the home repo's `.sops.yaml` (also under `user/`) and its
 * `secrets/.*` path_regex regardless of the caller's cwd — the regex is
 * cwd-relative, not root-relative, so this cwd and that regex move together.
 * `opts.cwd`, when given, overrides the `<mattstackHome>/user` default —
 * team-store's real seam is the one caller that ever passes it (its own
 * `.sops.yaml` lives at the team clone root, not under `user/`); every
 * personal-store call leaves it unset, so the default is unchanged.
 */
export function buildSecretsSpawnOptions(opts?: { env?: Record<string, string>; cwd?: string }): {
  cwd: string;
  env: Record<string, string | undefined>;
  stdout: "pipe";
  stderr: "pipe";
} {
  return {
    cwd: opts?.cwd ?? join(mattstackHome(), "user"),
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

type SecretsSpawn = (argv: string[], opts: any) => {
  stdout: ReadableStream;
  stderr: ReadableStream;
  exited: Promise<number>;
  kill: (sig?: number | string) => void;
};

/**
 * Real seam: Bun.spawn-based capture, real fs reads/writes. `cwd`, when
 * given, is pinned for every sops spawn this seam instance makes — the
 * personal store's default seam (`cwd` omitted) resolves `<mattstackHome>/user`;
 * team-store.ts constructs its own instance per team with `cwd` set to that
 * team's clone root (see `buildTeamSpawnOptions`). `spawn` is injectable so
 * tests can model a hanging child without a real subprocess; the default is
 * the real `Bun.spawn`, so production behavior is unchanged.
 */
export function createRealSecretsExecSeam(cwd?: string, spawn: SecretsSpawn = Bun.spawn as unknown as SecretsSpawn): SecretsExecSeam {
  return {
    async run(cmd, opts) {
      debugLog(cmd, opts?.sensitive);
      // argv[0] resolves to the sops inside mattstack.app before PATH — see
      // the same treatment in age-key.ts's raw seam. Resolved at the spawn,
      // not where the argv is built, so the pure callers and their fake seams
      // stay unaware of the bundle.
      const [bin, ...args] = cmd;
      const resolved = bin === undefined ? cmd : [resolveBundledTool(bin), ...args];
      const proc = spawn(resolved, buildSecretsSpawnOptions({ env: opts?.env, cwd }));
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_SECRETS_TIMEOUT_MS;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          proc.kill();
        } catch {
          // already exited
        }
      }, timeoutMs);
      try {
        const [stdout, stderr, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        if (timedOut) {
          throw new SecretsTimeoutError(`${cmd[0]}: did not exit within ${timeoutMs}ms (keychain prompt pending?)`);
        }
        return { code, stdout, stderr };
      } finally {
        clearTimeout(timer);
      }
    },
    fileExists(path) {
      return existsSync(path);
    },
    listDir(path) {
      try {
        return readdirSync(path);
      } catch {
        return [];
      }
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
