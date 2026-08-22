/**
 * The mattstack age key: one identity, custodied in the macOS keychain,
 * never written to any file. Every secret under the home repo's
 * `user/secrets/` encrypts to its public recipient (see renderSopsYaml).
 * renderSopsYaml's `path_regex` is `secrets/.*`, not `user/secrets/.*`: sops
 * matches it against the filename relative to cwd, and every sops spawn
 * pins cwd to `<mattstackHome>/user` (lib/secrets/store.ts) — the regex,
 * the cwd pin, and the `--filename-override` all move together or sops
 * silently matches no rule.
 *
 * All keychain/age-keygen calls route through the injected AgeKeySeam so
 * tests never touch the real keychain. The private key crosses process
 * boundaries via argv (the keychain write — see addCmd's doc for the
 * exposure that's accepted there) or stdin (age-keygen -y); it is never
 * logged in the clear — see withArgvRedaction.
 */

export interface AgeExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface AgeKeySeam {
  /**
   * `input`, when set, is piped to the child's stdin (age-keygen -y takes
   * the private key this way, keeping it out of argv).
   * `sensitive` marks a call whose argv or stdin carries key material, so a
   * logging wrapper (withArgvRedaction) knows to redact it.
   */
  run(cmd: string[], opts?: { input?: string; sensitive?: boolean }): Promise<AgeExecResult>;
}

const KEYCHAIN_ACCOUNT = "mattstack";
const KEYCHAIN_SERVICE = "mattstack-age-key";

const FIND_CMD = ["security", "find-generic-password", "-a", KEYCHAIN_ACCOUNT, "-s", KEYCHAIN_SERVICE, "-w"];

/**
 * `security` has no stdin form for `-w` — the private key is unavoidably a
 * literal argv value here, visible for this short-lived process's lifetime
 * to anything that can read another process's argv on the machine (`ps
 * auxww`, Activity Monitor). Accepted as a brief, single-machine exposure;
 * never logged (withArgvRedaction) and never written to a file. No `-U`
 * (update-if-exists): a duplicate item makes this call fail outright rather
 * than silently overwrite — see ensureAgeKey's doc.
 */
function addCmd(privateKey: string, opts?: { update?: boolean }): string[] {
  const cmd = ["security", "add-generic-password", "-a", KEYCHAIN_ACCOUNT, "-s", KEYCHAIN_SERVICE];
  if (opts?.update) cmd.push("-U");
  cmd.push("-w", privateKey);
  return cmd;
}

const ITEM_NOT_FOUND_EXIT_CODE = 44; // macOS security's errSecItemNotFound
const NOT_FOUND_STDERR_MARKER = "could not be found";

export type AgeKeyReadResult = { key: string } | { absent: true };

/**
 * Three-way outcome, not a nullable string: a locked keychain or a denied
 * access-control dialog also exits non-zero, and collapsing that into "no
 * key" would let a caller mint a replacement over a key that still exists,
 * orphaning every file already encrypted to it. Only the corroborated
 * "item genuinely absent" case (exit 44 + the stderr marker) is `absent`;
 * every other non-zero exit throws instead of guessing.
 */
export async function readAgeKey(seams: AgeKeySeam): Promise<AgeKeyReadResult> {
  const result = await seams.run(FIND_CMD, { sensitive: true });

  if (result.code === 0) {
    const key = result.stdout.trim();
    if (key.length === 0) {
      throw new Error("security find-generic-password: exited 0 but printed no key — unexpected keychain state");
    }
    return { key };
  }

  if (result.code === ITEM_NOT_FOUND_EXIT_CODE && result.stderr.toLowerCase().includes(NOT_FOUND_STDERR_MARKER)) {
    return { absent: true };
  }

  throw new Error(
    `security find-generic-password: keychain unreachable (exit ${result.code}) — refusing to mint, ` +
      `minting now would destroy the existing key\n${result.stderr}`,
  );
}

function parseAgeKeygenOutput(output: string): { publicKey: string; privateKey: string } {
  const publicMatch = output.match(/^# public key: (age1\S+)/m);
  const privateMatch = output.match(/^(AGE-SECRET-KEY-1\S+)/m);
  if (!publicMatch || !privateMatch) {
    throw new Error("age-keygen: could not parse a public/private key pair from its output");
  }
  return { publicKey: publicMatch[1]!, privateKey: privateMatch[1]! };
}

/**
 * Mints and stores a new key ONLY on readAgeKey's provable `absent` —
 * anything else (including a keychain-access error) throws instead of
 * risking a mint over a key that's still there. `addCmd` carries no `-U`
 * on top of that: if an item exists anyway, the keychain write itself
 * fails rather than overwriting, the last-resort guard against clobbering
 * the custodied key.
 *
 * `minted` tells the caller whether THIS call is the one that generated the
 * key (vs. deriving the public half of one already in the keychain) — the
 * signal `rt home init` needs to tell "a machine with no key yet" apart
 * from "a machine that already has the right key", since only the former
 * can safely treat a mismatched `.sops.yaml` recipient as stale rather than
 * as evidence of secrets encrypted to a key this machine doesn't hold.
 */
export async function ensureAgeKey(seams: AgeKeySeam): Promise<{ publicKey: string; minted: boolean }> {
  const existing = await readAgeKey(seams);
  if ("key" in existing) {
    const derived = await seams.run(["age-keygen", "-y"], { input: existing.key, sensitive: true });
    if (derived.code !== 0) {
      throw new Error(`age-keygen -y: could not derive the public key from the stored private key\n${derived.stderr}`);
    }
    return { publicKey: derived.stdout.trim(), minted: false };
  }

  const generated = await seams.run(["age-keygen"], { sensitive: true });
  if (generated.code !== 0) {
    throw new Error(`age-keygen: failed to generate a new age key\n${generated.stderr}`);
  }
  const { publicKey, privateKey } = parseAgeKeygenOutput(generated.stdout);

  const stored = await seams.run(addCmd(privateKey), { sensitive: true });
  if (stored.code !== 0) {
    throw new Error(`security add-generic-password: failed to store the age key in the keychain\n${stored.stderr}`);
  }

  return { publicKey, minted: true };
}

const PRIVATE_KEY_PREFIX = "AGE-SECRET-KEY-1";

export type ImportAgeKeyResult =
  | { ok: true; publicKey: string }
  | { ok: false; reason: "malformed" }
  | { ok: false; reason: "exists"; existingPublicKey: string };

/**
 * The fresh-machine counterpart to ensureAgeKey's mint: imports a key
 * supplied by the caller (a password manager paste) instead of generating
 * one. Shape is checked twice — the `AGE-SECRET-KEY-1` prefix rejects an
 * obviously-wrong paste before any subprocess runs, and `age-keygen -y`
 * rejects anything with the right prefix but invalid key bytes — both
 * collapse to the same typed `malformed` refusal.
 *
 * An existing keychain item is a typed refusal too, not a throw, so the
 * caller (a CLI command) can decide what to do — prompt, `--force`, abort —
 * without unwinding a stack for an expected, recoverable state. Only
 * `force` overwrites, via `-U`; without it, an existing item is never
 * touched, and `readAgeKey` runs first specifically so this refusal can
 * name the recipient already there.
 */
export async function importAgeKey(
  seams: AgeKeySeam,
  privateKey: string,
  opts: { force?: boolean } = {},
): Promise<ImportAgeKeyResult> {
  if (!privateKey.startsWith(PRIVATE_KEY_PREFIX)) {
    return { ok: false, reason: "malformed" };
  }

  const derived = await seams.run(["age-keygen", "-y"], { input: privateKey, sensitive: true });
  if (derived.code !== 0) {
    return { ok: false, reason: "malformed" };
  }
  const publicKey = derived.stdout.trim();

  if (!opts.force) {
    const existing = await readAgeKey(seams);
    if ("key" in existing) {
      const existingDerived = await seams.run(["age-keygen", "-y"], { input: existing.key, sensitive: true });
      if (existingDerived.code !== 0) {
        throw new Error(
          `age-keygen -y: could not derive the public key from the already-stored private key\n${existingDerived.stderr}`,
        );
      }
      return { ok: false, reason: "exists", existingPublicKey: existingDerived.stdout.trim() };
    }
  }

  const stored = await seams.run(addCmd(privateKey, { update: opts.force }), { sensitive: true });
  if (stored.code !== 0) {
    throw new Error(`security add-generic-password: failed to store the imported age key in the keychain\n${stored.stderr}`);
  }

  return { ok: true, publicKey };
}

export function renderSopsYaml(publicKey: string): string {
  return ["creation_rules:", "  - path_regex: secrets/.*", `    age: ${publicKey}`, ""].join("\n");
}

/** The inverse of renderSopsYaml: the `age:` recipient from a rendered .sops.yaml, or null if the shape doesn't match (a hand-edited file with no recognizable recipient line). */
export function sopsYamlRecipient(content: string): string | null {
  return content.match(/^\s*age:\s*(\S+)/m)?.[1] ?? null;
}

/** Thrown by keyExport when the keychain provably holds no key yet — minting is `rt home init`'s job, never export's. */
export class AgeKeyAbsentError extends Error {}

const EXPORT_WARNING = [
  "############################################################",
  "# rt home key export — mattstack age private key",
  "#",
  "# WARNING: this decrypts every secret in the home repo. It",
  "# lives only in the keychain and is never written to a file —",
  "# save it to your password manager now.",
  "############################################################",
  "",
].join("\n");

/**
 * Reads the existing key and prints it once, with a warning header — the
 * only place this module hands the key to the outside world, and it is
 * stdout only: never a file (see the module doc). Never mints: that keeps
 * a keychain-access error here from ever being mistaken for "no key yet"
 * and triggering a mint that would orphan the real one. Minting is
 * `rt home init`'s job (ensureAgeKey), run once, ahead of time.
 */
export async function keyExport(seams: AgeKeySeam, print: (text: string) => void): Promise<void> {
  const result = await readAgeKey(seams);
  if (!("key" in result)) {
    throw new AgeKeyAbsentError("no age key found in the keychain yet — run `rt home init` first");
  }
  print(`${EXPORT_WARNING}${result.key}`);
}

/** Redacts the value following a `-w` flag; nothing else in argv can carry the key. */
function redactArgv(cmd: string[]): string[] {
  return cmd.map((arg, i) => (i > 0 && cmd[i - 1] === "-w" ? "<redacted>" : arg));
}

/**
 * Wraps a seam so callers can log every command that runs without ever
 * logging key material: sensitive calls have their `-w` value (the only
 * argv slot the key ever occupies) redacted before `log` sees it. `log`
 * receives argv only — never stdout/stderr/input — so a call whose key
 * travels via stdin or return value is never exposed here either.
 */
export function withArgvRedaction(seam: AgeKeySeam, log: (cmd: string[]) => void): AgeKeySeam {
  return {
    async run(cmd, opts) {
      log(opts?.sensitive ? redactArgv(cmd) : cmd);
      return seam.run(cmd, opts);
    },
  };
}

const CLI_DEBUG = process.env.RT_LOG_LEVEL === "debug";

/**
 * The CLI process has no per-call debug channel of its own (that's a
 * daemon-only seam — see CLAUDE.md's logging architecture); this mirrors
 * its RT_LOG_LEVEL=debug gating rather than inventing a separate one.
 */
function debugLog(cmd: string[]): void {
  if (CLI_DEBUG) console.error(`[age-key] ${cmd.join(" ")}`);
}

/** Bun.spawn-based capture, env passed live (PATH-snapshot gotcha). Unexported: only reachable wrapped, via createRealAgeKeySeam. */
function createRawAgeKeySeam(): AgeKeySeam {
  return {
    async run(cmd, opts) {
      const proc = Bun.spawn(cmd, {
        env: process.env,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      // Always close stdin (EOF) even with no input: commands that never
      // read it ignore the close, but age-keygen -y blocks on EOF otherwise.
      if (opts?.input !== undefined) proc.stdin.write(opts.input);
      proc.stdin.end();
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { code, stdout, stderr };
    },
  };
}

/**
 * The real seam. Always the redacting wrapper — the raw, unredacted seam
 * above is never exported, so there is no reachable path to an unredacted
 * default.
 */
export function createRealAgeKeySeam(): AgeKeySeam {
  return withArgvRedaction(createRawAgeKeySeam(), debugLog);
}
