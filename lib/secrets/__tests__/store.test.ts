import { describe, test, expect, spyOn } from "bun:test";
import {
  readSecret,
  writeSecret,
  rotateSecret,
  listSecretNames,
  secretsFilePath,
  NoAgeKeyError,
  type SecretsExecResult,
  type SecretsExecSeam,
  type SecretsSeams,
} from "../store.ts";
import type { AgeExecResult, AgeKeySeam } from "../../home/age-key.ts";
import { secretsList } from "../../../commands/secrets.ts";

const NOT_FOUND_STDERR = "The specified item could not be found in the keychain.";

let domainCounter = 0;
/** A fresh domain name per test — domainMemo is a process-lifetime singleton. */
function uniqueDomain(): string {
  return `test-domain-${domainCounter++}`;
}

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

class FakeSecretsExecSeam implements SecretsExecSeam {
  calls: Call[] = [];
  files = new Map<string, string>();

  constructor(
    private opts: {
      decrypt?: () => SecretsExecResult;
      encrypt?: () => SecretsExecResult;
    } = {},
  ) {}

  fileExists(path: string): boolean {
    return this.files.has(path);
  }

  writeFile(path: string, content: string): void {
    this.files.set(path, content);
  }

  async run(cmd: string[], runOpts?: { env?: Record<string, string>; sensitive?: boolean }): Promise<SecretsExecResult> {
    this.calls.push({ cmd, opts: runOpts });

    if (cmd[0] === "sops" && cmd[1] === "-d") {
      return this.opts.decrypt ? this.opts.decrypt() : { code: 0, stdout: "{}", stderr: "" };
    }
    if (cmd[0] === "sops" && cmd[1] === "-e" && cmd[2] === "-i") {
      return this.opts.encrypt ? this.opts.encrypt() : { code: 0, stdout: "", stderr: "" };
    }

    throw new Error(`FakeSecretsExecSeam: unexpected call ${cmd.join(" ")}`);
  }
}

describe("readSecret", () => {
  test("decrypts an existing file; SOPS_AGE_KEY travels via env, argv never carries the key", async () => {
    const domain = uniqueDomain();
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
    const domain = uniqueDomain();
    const execSeam = new FakeSecretsExecSeam();
    const seams: SecretsSeams = { ageKeySeam: fakeAgeKeySeamThrows(), execSeam };

    const value = await readSecret(domain, "anyKey", seams);

    expect(value).toBeNull();
    expect(execSeam.calls).toEqual([]);
  });

  test("a key absent from an existing domain's payload -> null", async () => {
    const domain = uniqueDomain();
    const path = secretsFilePath(domain);
    const execSeam = new FakeSecretsExecSeam({ decrypt: () => ({ code: 0, stdout: "{}", stderr: "" }) });
    execSeam.writeFile(path, "ciphertext");
    const seams: SecretsSeams = { ageKeySeam: fakeAgeKeySeamWithKey("AGE-X"), execSeam };

    expect(await readSecret(domain, "nope", seams)).toBeNull();
  });

  test("age key provably absent -> NoAgeKeyError pointing at `rt home init`, never an empty secret", async () => {
    const domain = uniqueDomain();
    const path = secretsFilePath(domain);
    const execSeam = new FakeSecretsExecSeam();
    execSeam.writeFile(path, "ciphertext");
    const seams: SecretsSeams = { ageKeySeam: fakeAgeKeySeamAbsent(), execSeam };

    await expect(readSecret(domain, "key", seams)).rejects.toThrow(NoAgeKeyError);
    await expect(readSecret(domain, "key", seams)).rejects.toThrow(/rt home init/);
  });

  test("keychain error propagates as a real error — never collapsed into absence or an empty secret", async () => {
    const domain = uniqueDomain();
    const path = secretsFilePath(domain);
    const execSeam = new FakeSecretsExecSeam();
    execSeam.writeFile(path, "ciphertext");
    const seams: SecretsSeams = { ageKeySeam: fakeAgeKeySeamThrows(), execSeam };

    await expect(readSecret(domain, "key", seams)).rejects.toThrow(/keychain unreachable/i);
  });

  test("a sops decrypt failure propagates as a real error", async () => {
    const domain = uniqueDomain();
    const path = secretsFilePath(domain);
    const execSeam = new FakeSecretsExecSeam({ decrypt: () => ({ code: 1, stdout: "", stderr: "sops: no matching creation rule" }) });
    execSeam.writeFile(path, "ciphertext");
    const seams: SecretsSeams = { ageKeySeam: fakeAgeKeySeamWithKey("AGE-X"), execSeam };

    await expect(readSecret(domain, "key", seams)).rejects.toThrow(/sops -d/);
  });
});

describe("writeSecret", () => {
  test("merges into the existing decrypted payload, writes plaintext, then encrypts in place — argv pinned", async () => {
    const domain = uniqueDomain();
    const path = secretsFilePath(domain);
    const execSeam = new FakeSecretsExecSeam({
      decrypt: () => ({ code: 0, stdout: JSON.stringify({ existingKey: "existingVal" }), stderr: "" }),
    });
    execSeam.writeFile(path, "ciphertext-before");
    const seams: SecretsSeams = { ageKeySeam: fakeAgeKeySeamWithKey("AGE-X"), execSeam };

    await writeSecret(domain, "newKey", "newVal", seams);

    expect(execSeam.calls.map((c) => c.cmd)).toEqual([
      ["sops", "-d", path],
      ["sops", "-e", "-i", path],
    ]);
    expect(JSON.parse(execSeam.files.get(path)!)).toEqual({ existingKey: "existingVal", newKey: "newVal" });
  });

  test("no existing file -> starts from an empty payload, still encrypts in place", async () => {
    const domain = uniqueDomain();
    const path = secretsFilePath(domain);
    const execSeam = new FakeSecretsExecSeam();
    const seams: SecretsSeams = { ageKeySeam: fakeAgeKeySeamWithKey("AGE-X"), execSeam };

    await writeSecret(domain, "onlyKey", "onlyVal", seams);

    expect(execSeam.calls.map((c) => c.cmd)).toEqual([["sops", "-e", "-i", path]]);
    expect(JSON.parse(execSeam.files.get(path)!)).toEqual({ onlyKey: "onlyVal" });
  });

  test("the new value never appears in any subprocess argv", async () => {
    const domain = uniqueDomain();
    const path = secretsFilePath(domain);
    const execSeam = new FakeSecretsExecSeam();
    const seams: SecretsSeams = { ageKeySeam: fakeAgeKeySeamWithKey("AGE-X"), execSeam };

    await writeSecret(domain, "k", "super-secret-value-never-in-argv", seams);

    expect(execSeam.calls.flatMap((c) => c.cmd)).not.toContain("super-secret-value-never-in-argv");
  });

  test("an encrypt failure throws (the caller sees the file may hold plaintext)", async () => {
    const domain = uniqueDomain();
    const execSeam = new FakeSecretsExecSeam({ encrypt: () => ({ code: 1, stdout: "", stderr: "sops: encrypt failed" }) });
    const seams: SecretsSeams = { ageKeySeam: fakeAgeKeySeamWithKey("AGE-X"), execSeam };

    await expect(writeSecret(domain, "k", "v", seams)).rejects.toThrow(/sops -e -i/);
  });
});

describe("per-process memo", () => {
  test("writeSecret invalidates the domain's memo — the next read re-decrypts instead of serving stale data", async () => {
    const domain = uniqueDomain();
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
});

describe("listSecretNames", () => {
  test("returns keys only, never values", async () => {
    const domain = uniqueDomain();
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
    const domain = uniqueDomain();
    const execSeam = new FakeSecretsExecSeam();
    const seams: SecretsSeams = { ageKeySeam: fakeAgeKeySeamThrows(), execSeam };

    expect(await listSecretNames(domain, seams)).toEqual([]);
  });
});

describe("rotateSecret", () => {
  test("mints via the injected minter, writes the new value, and returns the rotation commit message", async () => {
    const domain = uniqueDomain();
    const path = secretsFilePath(domain);
    const execSeam = new FakeSecretsExecSeam({ decrypt: () => ({ code: 0, stdout: "{}", stderr: "" }) });
    execSeam.writeFile(path, "ciphertext");
    const seams: SecretsSeams = { ageKeySeam: fakeAgeKeySeamWithKey("AGE-X"), execSeam };

    const message = await rotateSecret(domain, "gitlabToken", () => "glpat-new-value", seams);

    expect(message).toBe(`secrets: rotate ${domain}.gitlabToken`);
    expect(JSON.parse(execSeam.files.get(path)!)).toEqual({ gitlabToken: "glpat-new-value" });
  });

  test("supports an async minter", async () => {
    const domain = uniqueDomain();
    const execSeam = new FakeSecretsExecSeam();
    const seams: SecretsSeams = { ageKeySeam: fakeAgeKeySeamWithKey("AGE-X"), execSeam };

    const message = await rotateSecret(domain, "k", async () => "minted-async", seams);

    expect(message).toBe(`secrets: rotate ${domain}.k`);
  });
});

describe("rt secrets list (command layer)", () => {
  test("prints secret names but never the canary value", async () => {
    const domain = uniqueDomain();
    const path = secretsFilePath(domain);
    const CANARY = "sk_super_secret_canary_value_should_never_print";
    const execSeam = new FakeSecretsExecSeam({
      decrypt: () => ({ code: 0, stdout: JSON.stringify({ apiKey: CANARY, other: "value2" }), stderr: "" }),
    });
    execSeam.writeFile(path, "ciphertext");
    const seams: SecretsSeams = { ageKeySeam: fakeAgeKeySeamWithKey("AGE-X"), execSeam };

    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
      logs.push(parts.map(String).join(" "));
    });

    try {
      await secretsList([domain], {}, seams);
    } finally {
      logSpy.mockRestore();
    }

    const output = logs.join("\n");
    expect(output).toContain("apiKey");
    expect(output).toContain("other");
    expect(output).not.toContain(CANARY);
    expect(output).not.toContain("value2");
  });
});
