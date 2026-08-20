/**
 * The mattstack age key: one identity, custodied in the macOS keychain,
 * never written to any file. Every secret path under the home repo's
 * `user/secrets/` encrypts to its public recipient (see renderSopsYaml).
 *
 * All keychain/age-keygen calls route through the injected AgeKeySeam so
 * tests never touch the real keychain. The private key crosses process
 * boundaries only via argv (the keychain write, unavoidable — `security`
 * has no stdin form for `-w`) or stdin (age-keygen -y); it is never logged
 * in the clear — see withArgvRedaction.
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

function addCmd(privateKey: string): string[] {
  return ["security", "add-generic-password", "-a", KEYCHAIN_ACCOUNT, "-s", KEYCHAIN_SERVICE, "-w", privateKey, "-U"];
}

/** Null on any non-zero exit — `security` exits 44 when the item doesn't exist yet. */
export async function readAgeKey(seams: AgeKeySeam): Promise<string | null> {
  const result = await seams.run(FIND_CMD, { sensitive: true });
  if (result.code !== 0) return null;
  const key = result.stdout.trim();
  return key.length > 0 ? key : null;
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
 * Idempotent: reads the existing keychain entry first. Only mints and
 * stores a new key when none exists yet — a second call never overwrites
 * the custodied key.
 */
export async function ensureAgeKey(seams: AgeKeySeam): Promise<{ publicKey: string }> {
  const existing = await readAgeKey(seams);
  if (existing) {
    const derived = await seams.run(["age-keygen", "-y"], { input: existing, sensitive: true });
    if (derived.code !== 0) {
      throw new Error(`age-keygen -y: could not derive the public key from the stored private key\n${derived.stderr}`);
    }
    return { publicKey: derived.stdout.trim() };
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

  return { publicKey };
}

export function renderSopsYaml(publicKey: string): string {
  return ["creation_rules:", "  - path_regex: user/secrets/.*", `    age: ${publicKey}`, ""].join("\n");
}

const EXPORT_WARNING = [
  "############################################################",
  "# rt home key export — mattstack age private key",
  "#",
  "# WARNING: this decrypts every secret in the home repo. Save",
  "# it to your password manager now — it is never written to a",
  "# file and rt will not print it again.",
  "############################################################",
  "",
].join("\n");

/**
 * Reads the private key and prints it, with a warning header, in one call
 * to `print` — the only place this module hands the key to the outside
 * world, and it is stdout only: never a file (see the module doc).
 */
export async function keyExport(seams: AgeKeySeam, print: (text: string) => void): Promise<void> {
  let key = await readAgeKey(seams);
  if (!key) {
    await ensureAgeKey(seams);
    key = await readAgeKey(seams);
  }
  if (!key) throw new Error("rt home key export: no age key found even after minting one");
  print(`${EXPORT_WARNING}${key}`);
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

/** The real seam: Bun.spawn-based capture, env passed live (PATH-snapshot gotcha). */
export function createRealAgeKeySeam(): AgeKeySeam {
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
