import { describe, test, expect, beforeEach, spyOn } from "bun:test";
import {
  readSecret,
  writeSecret,
  rotateSecret,
  listSecretNames,
  secretsFilePath,
  resetSecretsMemo,
  formatDebugLine,
  buildSecretsSpawnOptions,
  NoAgeKeyError,
  InvalidSecretsSegmentError,
  type SecretsExecResult,
  type SecretsExecSeam,
  type SecretsSeams,
} from "../store.ts";
import { rtDir, mattstackHome } from "../../rt-paths.ts";
import type { AgeExecResult, AgeKeySeam } from "../../home/age-key.ts";
import { dirname, join } from "path";
import { secretsList } from "../../../commands/secrets.ts";

const NOT_FOUND_STDERR = "The specified item could not be found in the keychain.";
const DEFAULT_CIPHERTEXT = JSON.stringify({ data: "opaque", sops: { age: [] } });

beforeEach(() => resetSecretsMemo());

function fakeAgeKeySeamWithKey(key: string): AgeKeySeam {
  return {
    async run(cmd): Promise<AgeExecResult> {
      if (cmd[0] === "security" && cmd[1] === "find-generic-password") {
        return { code: 0, stdout: `${key}\n`, stderr: "" };
      }
      throw new Error(`fakeAgeKeySeamWithKey: unexpected call ${cmd.join(" ")}`);
    },
  };
}

function fakeAgeKeySeamAbsent(): AgeKeySeam {
  return {
    async run(): Promise<AgeExecResult> {
      return { code: 44, stdout: "", stderr: NOT_FOUND_STDERR };
    },
  };
}

function fakeAgeKeySeamThrows(): AgeKeySeam {
  return {
    async run(): Promise<AgeExecResult> {
      return { code: 36, stdout: "", stderr: "SecKeychainItemCopyContent: the user name or passphrase is not correct" };
    },
  };
}

type Call = { cmd: string[]; opts?: { env?: Record<string, string>; sensitive?: boolean } };

/** Models the write idiom's shape: `-e --output <tmp>` only writes simulated ciphertext to `files` on success, matching real sops. */
class FakeSecretsExecSeam implements SecretsExecSeam {
  calls: Call[] = [];
  files = new Map<string, string>();
  ensureDirCalls: { path: string; mode: number }[] = [];
  chmodCalls: { path: string; mode: number }[] = [];
  removeFileCalls: string[] = [];
  fsyncAndRenameCalls: { from: string; to: string }[] = [];

  constructor(
    private opts: {
      decrypt?: () => SecretsExecResult;
      encrypt?: (outputPath: string) => SecretsExecResult;
      encryptOutputContent?: string;
    } = {},
  ) {}

  fileExists(path: string): boolean {
    return this.files.has(path);
  }

  readFile(path: string): string {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`FakeSecretsExecSeam: readFile of missing path ${path}`);
    return content;
  }

  writeFile(path: string, content: string): void {
    this.files.set(path, content);
  }

  ensureDir(path: string, mode: number): void {
    this.ensureDirCalls.push({ path, mode });
  }

  chmod(path: string, mode: number): void {
    this.chmodCalls.push({ path, mode });
  }

  fsyncAndRename(from: string, to: string): void {
    this.fsyncAndRenameCalls.push({ from, to });
    const content = this.files.get(from);
    if (content !== undefined) {
      this.files.set(to, content);
      this.files.delete(from);
    }
  }

  removeFile(path: string): void {
    this.removeFileCalls.push(path);
    this.files.delete(path);
  }

  async run(cmd: string[], runOpts?: { env?: Record<string, string>; sensitive?: boolean }): Promise<SecretsExecResult> {
    this.calls.push({ cmd, opts: runOpts });

    if (cmd[0] === "sops" && cmd[1] === "-d") {
      return this.opts.decrypt ? this.opts.decrypt() : { code: 0, stdout: "{}", stderr: "" };
    }
    if (cmd[0] === "sops" && cmd[1] === "-e") {
      const outputIdx = cmd.indexOf("--output");
      const outputPath = cmd[outputIdx + 1]!;
      const result = this.opts.encrypt ? this.opts.encrypt(outputPath) : { code: 0, stdout: "", stderr: "" };
      if (result.code === 0) {
        this.files.set(outputPath, this.opts.encryptOutputContent ?? DEFAULT_CIPHERTEXT);
      }
      return result;
    }

    throw new Error(`FakeSecretsExecSeam: unexpected call ${cmd.join(" ")}`);
  }
}

/** The exact staging path writeSecret computes — process.pid is stable within this test process. */
function stagingPath(domain: string): string {
  return join(rtDir(), "tmp", `${domain}.${process.pid}.json`);
}

describe("readSecret", () => {
  test("decrypts an existing file; SOPS_AGE_KEY travels via env, argv never carries the key", async () => {
    const domain = "rt";
    const path = secretsFilePath(domain);
    const execSeam = new FakeSecretsExecSeam({
      decrypt: () => ({ code: 0, stdout: JSON.stringify({ linearApiKey: "lin_api_secret" }), stderr: "" }),
    });
    execSeam.writeFile(path, "ciphertext-placeholder");
    const seams: SecretsSeams = { ageKeySeam: fakeAgeKeySeamWithKey("AGE-SECRET-KEY-1TEST"), execSeam };

    const value = await readSecret(domain, "linearApiKey", seams);

    expect(value).toBe("lin_api_secret");
    expect(execSeam.calls).toEqual([
      { cmd: ["sops", "-d", path], opts: { env: { SOPS_AGE_KEY: "AGE-SECRET-KEY-1TEST" }, sensitive: true } },
    ]);
    expect(execSeam.calls.flatMap((c) => c.cmd)).not.toContain("AGE-SECRET-KEY-1TEST");
  });

  test("missing encrypted file -> null, no throw, no sops call, no keychain lookup", async () => {
    const execSeam = new FakeSecretsExecSeam();
    const seams: SecretsSeams = { ageKeySeam: fakeAgeKeySeamThrows(), execSeam };

    const value = await readSecret("rt", "anyKey", seams);

    expect(value).toBeNull();
    expect(execSeam.calls).toEqual([]);
  });

  test("a key absent from an existing domain's payload -> null", async () => {
    const domain = "rt";
    const path = secretsFilePath(domain);
    const execSeam = new FakeSecretsExecSeam({ decrypt: () => ({ code: 0, stdout: "{}", stderr: "" }) });
    execSeam.writeFile(path, "ciphertext");
    const seams: SecretsSeams = { ageKeySeam: fakeAgeKeySeamWithKey("AGE-X"), execSeam };

    expect(await readSecret(domain, "nope", seams)).toBeNull();
  });

  test("age key provably absent -> NoAgeKeyError pointing at `rt home init`, never an empty secret", async () => {
    const domain = "rt";
    const path = secretsFilePath(domain);
    const execSeam = new FakeSecretsExecSeam();
    execSeam.writeFile(path, "ciphertext");
    const seams: SecretsSeams = { ageKeySeam: fakeAgeKeySeamAbsent(), execSeam };

    await expect(readSecret(domain, "key", seams)).rejects.toThrow(NoAgeKeyError);
    await expect(readSecret(domain, "key", seams)).rejects.toThrow(/rt home init/);
  });

  test("keychain error propagates as a real error — never collapsed into absence or an empty secret", async () => {
    const domain = "rt";
    const path = secretsFilePath(domain);
    const execSeam = new FakeSecretsExecSeam();
    execSeam.writeFile(path, "ciphertext");
    const seams: SecretsSeams = { ageKeySeam: fakeAgeKeySeamThrows(), execSeam };

    await expect(readSecret(domain, "key", seams)).rejects.toThrow(/keychain unreachable/i);
  });

  test("a sops decrypt failure propagates as a real error", async () => {
    const domain = "rt";
    const path = secretsFilePath(domain);
    const execSeam = new FakeSecretsExecSeam({ decrypt: () => ({ code: 1, stdout: "", stderr: "sops: no matching creation rule" }) });
    execSeam.writeFile(path, "ciphertext");
    const seams: SecretsSeams = { ageKeySeam: fakeAgeKeySeamWithKey("AGE-X"), execSeam };

    await expect(readSecret(domain, "key", seams)).rejects.toThrow(/sops -d/);
  });

  test("a garbled decrypt payload's error message never echoes the raw (possibly secret-laden) stdout", async () => {
    const domain = "rt";
    const path = secretsFilePath(domain);
    const CANARY = "GARBLED_CANARY_VALUE";
    const execSeam = new FakeSecretsExecSeam({ decrypt: () => ({ code: 0, stdout: `not-json-but-contains-${CANARY}`, stderr: "" }) });
    execSeam.writeFile(path, "ciphertext");
    const seams: SecretsSeams = { ageKeySeam: fakeAgeKeySeamWithKey("AGE-X"), execSeam };

    let thrown: unknown;
    try {
      await listSecretNames(domain, seams);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).not.toContain(CANARY);
  });
});

describe("domain/key validation — before any filesystem touch", () => {
  test("a path-escaping domain is rejected, no exec/fs calls at all", async () => {
    const execSeam = new FakeSecretsExecSeam();
    const seams: SecretsSeams = { ageKeySeam: fakeAgeKeySeamWithKey("AGE-X"), execSeam };

    await expect(readSecret("../skills", "key", seams)).rejects.toThrow(InvalidSecretsSegmentError);
    expect(execSeam.calls).toEqual([]);
  });

  test("an invalid key is rejected on write, before the keychain or any file is touched", async () => {
    const execSeam = new FakeSecretsExecSeam();
    const seams: SecretsSeams = { ageKeySeam: fakeAgeKeySeamWithKey("AGE-X"), execSeam };

    await expect(writeSecret("rt", "bad key with spaces", "v", seams)).rejects.toThrow(InvalidSecretsSegmentError);
    expect(execSeam.calls).toEqual([]);
  });

  test("uppercase, underscores, and a leading hyphen are all rejected", async () => {
    const execSeam = new FakeSecretsExecSeam();
    const seams: SecretsSeams = { ageKeySeam: fakeAgeKeySeamWithKey("AGE-X"), execSeam };

    for (const bad of ["RT", "rt_domain", "-rt", "rt/../etc"]) {
      await expect(readSecret(bad, "key", seams)).rejects.toThrow(InvalidSecretsSegmentError);
    }
  });
});

describe("writeSecret", () => {
  test("a brand-new domain still requires a real age key up front (encryption alone wouldn't need it)", async () => {
    const execSeam = new FakeSecretsExecSeam();
    const seams: SecretsSeams = { ageKeySeam: fakeAgeKeySeamAbsent(), execSeam };

    await expect(writeSecret("rt", "gitlabToken", "v", seams)).rejects.toThrow(NoAgeKeyError);
    // Never even attempted to encrypt: a machine with no key must never
    // silently write a credential it can't read back.
    expect(execSeam.calls).toEqual([]);
    expect(execSeam.files.size).toBe(0);
  });

  test("stages plaintext under rt/tmp (gitignored), encrypts with --filename-override to a .tmp output, fsync+renames over the target", async () => {
    const domain = "rt";
    const path = secretsFilePath(domain);
    const execSeam = new FakeSecretsExecSeam({
      decrypt: () => ({ code: 0, stdout: JSON.stringify({ existingKey: "existingVal" }), stderr: "" }),
    });
    execSeam.writeFile(path, "ciphertext-before");
    const seams: SecretsSeams = { ageKeySeam: fakeAgeKeySeamWithKey("AGE-X"), execSeam };

    await writeSecret(domain, "newKey", "newVal", seams);

    const staging = stagingPath(domain);
    const outputTmp = `${path}.tmp`;

    expect(execSeam.calls.map((c) => c.cmd)).toEqual([
      ["sops", "-d", path],
      ["sops", "-e", "--filename-override", join("user", "secrets", `${domain}.json`), "--output", outputTmp, staging],
    ]);
    expect(execSeam.fsyncAndRenameCalls).toEqual([{ from: outputTmp, to: path }]);
    expect(execSeam.chmodCalls).toEqual([
      { path: outputTmp, mode: 0o600 },
      { path, mode: 0o600 },
    ]);
    // Both the staging plaintext and the output-tmp path are cleaned up unconditionally.
    expect(execSeam.removeFileCalls.sort()).toEqual([outputTmp, staging].sort());
    // Nothing plaintext survives at either transient path.
    expect(execSeam.files.has(staging)).toBe(false);
    expect(execSeam.files.has(outputTmp)).toBe(false);
    // The real target holds the (simulated) ciphertext, not plaintext.
    expect(execSeam.files.get(path)).toBe(DEFAULT_CIPHERTEXT);
  });

  test("no existing file -> starts from an empty payload, still encrypts via the same atomic path", async () => {
    const domain = "rt";
    const path = secretsFilePath(domain);
    const execSeam = new FakeSecretsExecSeam();
    const seams: SecretsSeams = { ageKeySeam: fakeAgeKeySeamWithKey("AGE-X"), execSeam };

    await writeSecret(domain, "onlyKey", "onlyVal", seams);

    expect(execSeam.calls.map((c) => c.cmd)).toEqual([
      ["sops", "-e", "--filename-override", join("user", "secrets", `${domain}.json`), "--output", `${path}.tmp`, stagingPath(domain)],
    ]);
    expect(execSeam.files.get(path)).toBe(DEFAULT_CIPHERTEXT);
  });

  test("the new value never appears in any subprocess argv", async () => {
    const domain = "rt";
    const execSeam = new FakeSecretsExecSeam();
    const seams: SecretsSeams = { ageKeySeam: fakeAgeKeySeamWithKey("AGE-X"), execSeam };

    await writeSecret(domain, "k", "super-secret-value-never-in-argv", seams);

    expect(execSeam.calls.flatMap((c) => c.cmd)).not.toContain("super-secret-value-never-in-argv");
  });

  test("directories are created 0700 before any write", async () => {
    const domain = "rt";
    const path = secretsFilePath(domain);
    const execSeam = new FakeSecretsExecSeam();
    const seams: SecretsSeams = { ageKeySeam: fakeAgeKeySeamWithKey("AGE-X"), execSeam };

    await writeSecret(domain, "k", "v", seams);

    expect(execSeam.ensureDirCalls).toEqual([
      { path: join(rtDir(), "tmp"), mode: 0o700 },
      { path: dirname(path), mode: 0o700 },
    ]);
  });

  test("an encrypt failure throws, and both the staging file and any partial output are still cleaned up (no file for the user to delete)", async () => {
    const domain = "rt";
    const path = secretsFilePath(domain);
    const execSeam = new FakeSecretsExecSeam({ encrypt: () => ({ code: 1, stdout: "", stderr: "sops: encrypt failed" }) });
    const seams: SecretsSeams = { ageKeySeam: fakeAgeKeySeamWithKey("AGE-X"), execSeam };

    await expect(writeSecret(domain, "k", "v", seams)).rejects.toThrow(/sops -e/);

    expect(execSeam.files.has(stagingPath(domain))).toBe(false);
    expect(execSeam.files.has(`${path}.tmp`)).toBe(false);
    expect(execSeam.files.has(path)).toBe(false); // the (nonexistent) target was never created
    expect(execSeam.removeFileCalls.sort()).toEqual([`${path}.tmp`, stagingPath(domain)].sort());
  });

  test("a post-encrypt read-back that doesn't look like sops ciphertext refuses to declare success", async () => {
    const domain = "rt";
    const execSeam = new FakeSecretsExecSeam({ encryptOutputContent: "not sops output at all" });
    const seams: SecretsSeams = { ageKeySeam: fakeAgeKeySeamWithKey("AGE-X"), execSeam };

    await expect(writeSecret(domain, "k", "v", seams)).rejects.toThrow(/read-back/i);
  });
});

describe("per-process memo", () => {
  test("writeSecret invalidates the domain's memo — the next read re-decrypts instead of serving stale data", async () => {
    const domain = "rt";
    const path = secretsFilePath(domain);
    let decryptCalls = 0;
    const execSeam = new FakeSecretsExecSeam({
      decrypt: () => {
        decryptCalls++;
        return { code: 0, stdout: JSON.stringify({ k: `v${decryptCalls}` }), stderr: "" };
      },
    });
    execSeam.writeFile(path, "ciphertext");
    const seams: SecretsSeams = { ageKeySeam: fakeAgeKeySeamWithKey("AGE-X"), execSeam };

    expect(await readSecret(domain, "k", seams)).toBe("v1");
    expect(decryptCalls).toBe(1);

    // Second read within the same process hits the memo: no new decrypt call.
    expect(await readSecret(domain, "k", seams)).toBe("v1");
    expect(decryptCalls).toBe(1);

    await writeSecret(domain, "other", "x", seams);

    // Post-write read must re-decrypt (proves invalidation), not serve v1 again.
    expect(await readSecret(domain, "k", seams)).toBe("v2");
    expect(decryptCalls).toBe(2);
  });

  test("a domain deleted out from under the process re-reads as missing, not a stale cached value", async () => {
    const domain = "rt";
    const path = secretsFilePath(domain);
    const execSeam = new FakeSecretsExecSeam({
      decrypt: () => ({ code: 0, stdout: JSON.stringify({ k: "cached-value" }), stderr: "" }),
    });
    execSeam.writeFile(path, "ciphertext");
    const seams: SecretsSeams = { ageKeySeam: fakeAgeKeySeamWithKey("AGE-X"), execSeam };

    expect(await readSecret(domain, "k", seams)).toBe("cached-value");

    execSeam.files.delete(path); // simulate external deletion

    expect(await readSecret(domain, "k", seams)).toBeNull();
  });
});

describe("listSecretNames", () => {
  test("returns keys only, never values", async () => {
    const domain = "rt";
    const path = secretsFilePath(domain);
    const execSeam = new FakeSecretsExecSeam({
      decrypt: () => ({ code: 0, stdout: JSON.stringify({ linearApiKey: "SECRET_A", gitlabToken: "SECRET_B" }), stderr: "" }),
    });
    execSeam.writeFile(path, "ciphertext");
    const seams: SecretsSeams = { ageKeySeam: fakeAgeKeySeamWithKey("AGE-X"), execSeam };

    const names = await listSecretNames(domain, seams);

    expect(names.sort()).toEqual(["gitlabToken", "linearApiKey"]);
  });

  test("missing file -> empty list, no throw", async () => {
    const execSeam = new FakeSecretsExecSeam();
    const seams: SecretsSeams = { ageKeySeam: fakeAgeKeySeamThrows(), execSeam };

    expect(await listSecretNames("rt", seams)).toEqual([]);
  });
});

describe("rotateSecret", () => {
  test("mints via the injected minter, writes the new value, and returns the rotation commit message", async () => {
    const domain = "rt";
    const path = secretsFilePath(domain);
    const execSeam = new FakeSecretsExecSeam({ decrypt: () => ({ code: 0, stdout: "{}", stderr: "" }) });
    execSeam.writeFile(path, "ciphertext");
    const seams: SecretsSeams = { ageKeySeam: fakeAgeKeySeamWithKey("AGE-X"), execSeam };

    const message = await rotateSecret(domain, "gitlabToken", () => "glpat-new-value", seams);

    expect(message).toBe(`secrets: rotate ${domain}.gitlabToken`);
  });

  test("supports an async minter", async () => {
    const domain = "rt";
    const execSeam = new FakeSecretsExecSeam();
    const seams: SecretsSeams = { ageKeySeam: fakeAgeKeySeamWithKey("AGE-X"), execSeam };

    const message = await rotateSecret(domain, "k", async () => "minted-async", seams);

    expect(message).toBe(`secrets: rotate ${domain}.k`);
  });

  test("validates domain/key before ever calling the minter", async () => {
    const execSeam = new FakeSecretsExecSeam();
    const seams: SecretsSeams = { ageKeySeam: fakeAgeKeySeamWithKey("AGE-X"), execSeam };
    let minted = false;

    await expect(
      rotateSecret(
        "../escape",
        "k",
        () => {
          minted = true;
          return "v";
        },
        seams,
      ),
    ).rejects.toThrow(InvalidSecretsSegmentError);
    expect(minted).toBe(false);
  });
});

describe("real seam spawn options — cwd pin (Task 5 carried review item)", () => {
  test("pins cwd to mattstackHome() so sops resolves THIS home's .sops.yaml, never a foreign cwd's", () => {
    const opts = buildSecretsSpawnOptions();
    expect(opts.cwd).toBe(mattstackHome());
  });

  test("still layers opts.env (e.g. SOPS_AGE_KEY) over process.env alongside the cwd pin", () => {
    const opts = buildSecretsSpawnOptions({ env: { SOPS_AGE_KEY: "age-secret-key-test" } });
    expect(opts.cwd).toBe(mattstackHome());
    expect(opts.env.SOPS_AGE_KEY).toBe("age-secret-key-test");
  });
});

describe("formatDebugLine (the debugLog path)", () => {
  test("a sensitive call's line never includes env values or stdout/stderr, whatever they'd contain", () => {
    const line = formatDebugLine(["sops", "-d", "/some/path"], { sensitive: true });
    expect(line).toBe("[secrets] sops -d /some/path (env/output redacted)");
    expect(line).not.toContain("SOPS_AGE_KEY");
  });

  test("a non-sensitive call's line is unmarked (still argv-only — nothing to redact by construction)", () => {
    expect(formatDebugLine(["sops", "-e", "/some/path"])).toBe("[secrets] sops -e /some/path");
  });
});

describe("rt secrets list (command layer)", () => {
  test("prints secret names but never the canary value, on stdout OR stderr", async () => {
    const domain = "rt";
    const path = secretsFilePath(domain);
    const CANARY = "sk_super_secret_canary_value_should_never_print";
    const execSeam = new FakeSecretsExecSeam({
      decrypt: () => ({ code: 0, stdout: JSON.stringify({ apiKey: CANARY, other: "value2" }), stderr: "" }),
    });
    execSeam.writeFile(path, "ciphertext");
    const seams: SecretsSeams = { ageKeySeam: fakeAgeKeySeamWithKey("AGE-X"), execSeam };

    const logs: string[] = [];
    const errors: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
      logs.push(parts.map(String).join(" "));
    });
    const errorSpy = spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
      errors.push(parts.map(String).join(" "));
    });

    try {
      await secretsList([domain], {}, seams);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }

    const output = [...logs, ...errors].join("\n");
    expect(output).toContain("apiKey");
    expect(output).toContain("other");
    expect(output).not.toContain(CANARY);
    expect(output).not.toContain("value2");
  });
});
