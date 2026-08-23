import { describe, test, expect, spyOn } from "bun:test";
import {
  teamSecretsFile,
  teamSopsYamlPath,
  readTeamRecipients,
  writeTeamRecipients,
  readTeamSecret,
  writeTeamSecret,
  listTeamSecretNames,
  addTeamRecipient,
  removeTeamRecipient,
  reencryptTeamSecrets,
  buildTeamSpawnOptions,
  NoTeamRecipientsError,
  NoTeamCloneError,
  TeamSopsYamlHandEditedError,
  TeamReencryptError,
} from "../team-store.ts";
import { InvalidSecretsSegmentError, type SecretsExecResult, type SecretsExecSeam, type SecretsSeams } from "../store.ts";
import type { AgeExecResult, AgeKeySeam } from "../../home/age-key.ts";
import { teamsDir } from "../../rt-paths.ts";
import { join } from "path";
import { secretsList } from "../../../commands/secrets.ts";

function teamCloneRootFor(slug: string): string {
  return join(teamsDir(), slug);
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
      return { code: 44, stdout: "", stderr: "The specified item could not be found in the keychain." };
    },
  };
}

type Call = { cmd: string[]; opts?: { env?: Record<string, string>; sensitive?: boolean } };

/**
 * Same round-trippable-plaintext modeling as store.test.ts's own fake, plus
 * `listDir` (team-store's domain-file discovery) and `.sops.yaml` as just
 * another entry in the same `files` map — writeTeamRecipients/readTeamRecipients
 * go through the plain fileExists/readFile/writeFile trio, no sops involved.
 */
class FakeTeamExecSeam implements SecretsExecSeam {
  calls: Call[] = [];
  files = new Map<string, string>();
  stats = new Map<string, { mtimeMs: number; size: number }>();
  removeFileCalls: string[] = [];
  fsyncAndRenameCalls: { from: string; to: string }[] = [];
  private mtimeCounter = 0;
  private roundTrippablePlaintext = new Map<string, string>();
  private updatekeysResult: SecretsExecResult;
  private failUpdatekeysOnCall?: number;
  private updatekeysCallCount = 0;

  constructor(opts: { updatekeys?: SecretsExecResult; failUpdatekeysOnCall?: number } = {}) {
    this.updatekeysResult = opts.updatekeys ?? { code: 0, stdout: "", stderr: "" };
    this.failUpdatekeysOnCall = opts.failUpdatekeysOnCall;
  }

  fileExists(path: string): boolean {
    return this.files.has(path);
  }

  listDir(dirPath: string): string[] {
    const prefix = dirPath.endsWith("/") ? dirPath : `${dirPath}/`;
    const names: string[] = [];
    for (const p of this.files.keys()) {
      if (p.startsWith(prefix) && !p.slice(prefix.length).includes("/")) names.push(p.slice(prefix.length));
    }
    return names;
  }

  private touch(path: string): void {
    this.mtimeCounter += 1;
    this.stats.set(path, { mtimeMs: this.mtimeCounter, size: this.files.get(path)?.length ?? 0 });
  }

  statFile(path: string): { mtimeMs: number; size: number } | null {
    return this.stats.get(path) ?? null;
  }

  readFile(path: string): string {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`FakeTeamExecSeam: readFile of missing path ${path}`);
    return content;
  }

  writeFile(path: string, content: string): void {
    this.files.set(path, content);
    this.touch(path);
  }

  ensureDir(): void {}
  chmod(): void {}

  fsyncAndRename(from: string, to: string): void {
    this.fsyncAndRenameCalls.push({ from, to });
    const content = this.files.get(from);
    if (content !== undefined) {
      this.files.set(to, content);
      this.files.delete(from);
      this.stats.delete(from);
      this.touch(to);
    }
    // A later plain `sops -d <to>` (readTeamSecret, or the next write's
    // read-existing-before-merge) must still resolve real plaintext after
    // the rename — the round-trip map's key has to move with the file.
    const plaintext = this.roundTrippablePlaintext.get(from);
    if (plaintext !== undefined) {
      this.roundTrippablePlaintext.set(to, plaintext);
      this.roundTrippablePlaintext.delete(from);
    }
  }

  removeFile(path: string): void {
    this.removeFileCalls.push(path);
    this.files.delete(path);
    this.stats.delete(path);
  }

  async run(cmd: string[], runOpts?: { env?: Record<string, string>; sensitive?: boolean }): Promise<SecretsExecResult> {
    this.calls.push({ cmd, opts: runOpts });

    if (cmd[0] === "sops" && cmd[1] === "-d") {
      const target = cmd[cmd.length - 1]!;
      const staged = this.roundTrippablePlaintext.get(target);
      return { code: 0, stdout: staged ?? "{}", stderr: "" };
    }
    if (cmd[0] === "sops" && cmd[1] === "-e") {
      const outputIdx = cmd.indexOf("--output");
      const outputPath = cmd[outputIdx + 1]!;
      const stagingInputPath = cmd[cmd.length - 1]!;
      this.files.set(outputPath, JSON.stringify({ data: "opaque", sops: {} }));
      this.touch(outputPath);
      const staged = this.files.get(stagingInputPath);
      if (staged !== undefined) this.roundTrippablePlaintext.set(outputPath, staged);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (cmd[0] === "sops" && cmd[1] === "updatekeys") {
      this.updatekeysCallCount += 1;
      if (this.failUpdatekeysOnCall === this.updatekeysCallCount) {
        return { code: 1, stdout: "", stderr: "sops: boom" };
      }
      return this.updatekeysResult;
    }

    throw new Error(`FakeTeamExecSeam: unexpected call ${cmd.join(" ")}`);
  }
}

/** Registers `slug`'s clone root as present in the fake — every test below operates against an already-cloned team unless it's specifically testing the no-clone refusal. */
function seamsWithKey(key = "AGE-TEAM-KEY", slug = "acme"): { execSeam: FakeTeamExecSeam; seams: SecretsSeams } {
  const execSeam = new FakeTeamExecSeam();
  execSeam.files.set(teamCloneRootFor(slug), "");
  return { execSeam, seams: { ageKeySeam: fakeAgeKeySeamWithKey(key), execSeam } };
}

describe("teamSecretsFile / teamSopsYamlPath", () => {
  test("layout matches the contract: teams/<slug>/mattstack/secrets/<domain>.json and teams/<slug>/.sops.yaml", () => {
    expect(teamSecretsFile("acme", "board")).toBe(join(teamsDir(), "acme", "mattstack", "secrets", "board.json"));
    expect(teamSopsYamlPath("acme")).toBe(join(teamsDir(), "acme", ".sops.yaml"));
  });

  test("an invalid domain is rejected before any path is returned", () => {
    expect(() => teamSecretsFile("acme", "../etc")).toThrow(InvalidSecretsSegmentError);
  });

  test("an invalid slug is rejected", () => {
    expect(() => teamSecretsFile("../escape", "board")).toThrow(InvalidSecretsSegmentError);
  });
});

describe("readTeamRecipients / writeTeamRecipients", () => {
  test("writeTeamRecipients renders a .sops.yaml with both keys and the team path_regex", () => {
    const { execSeam, seams } = seamsWithKey();

    writeTeamRecipients("acme", ["age1bbb", "age1aaa"], seams);

    const content = execSeam.readFile(teamSopsYamlPath("acme"));
    expect(content).toContain("path_regex: mattstack/secrets/.*");
    expect(content).toContain("age1aaa");
    expect(content).toContain("age1bbb");
  });

  test("recipients are sorted and deduped on write", () => {
    const { execSeam, seams } = seamsWithKey();

    writeTeamRecipients("acme", ["age1zzz", "age1aaa", "age1zzz"], seams);

    const content = execSeam.readFile(teamSopsYamlPath("acme"));
    const ageLine = content.split("\n").find((l) => l.includes("age:"))!;
    expect(ageLine).toBe("    age: age1aaa,age1zzz");
  });

  test("round-trips through readTeamRecipients", () => {
    const { seams } = seamsWithKey();

    writeTeamRecipients("acme", ["age1bbb", "age1aaa"], seams);

    expect(readTeamRecipients("acme", seams)).toEqual(["age1aaa", "age1bbb"]);
  });

  test("no .sops.yaml yet -> []", () => {
    const { seams } = seamsWithKey();
    expect(readTeamRecipients("acme", seams)).toEqual([]);
  });

  test("a slug with no local clone -> NoTeamCloneError, never a silently-created team directory", () => {
    const execSeam = new FakeTeamExecSeam(); // no clone root registered
    const seams: SecretsSeams = { ageKeySeam: fakeAgeKeySeamWithKey("AGE-X"), execSeam };

    expect(() => writeTeamRecipients("nonexistent-team", ["age1aaa"], seams)).toThrow(NoTeamCloneError);
    expect(execSeam.fileExists(teamCloneRootFor("nonexistent-team"))).toBe(false);
    expect(execSeam.fileExists(teamSopsYamlPath("nonexistent-team"))).toBe(false);
  });

  test("an existing .sops.yaml with more than one creation rule -> TeamSopsYamlHandEditedError, never silently collapsed", () => {
    const { execSeam, seams } = seamsWithKey();
    const handEdited = [
      "creation_rules:",
      "  - path_regex: mattstack/secrets/.*",
      "    age: age1aaa",
      "  - path_regex: other/.*",
      "    age: age1bbb",
      "",
    ].join("\n");
    execSeam.writeFile(teamSopsYamlPath("acme"), handEdited);

    expect(() => writeTeamRecipients("acme", ["age1ccc"], seams)).toThrow(TeamSopsYamlHandEditedError);
    // The hand-edited file must survive untouched.
    expect(execSeam.readFile(teamSopsYamlPath("acme"))).toBe(handEdited);
  });

  test("a single-rule .sops.yaml is still freely rewritten", () => {
    const { seams } = seamsWithKey();
    writeTeamRecipients("acme", ["age1aaa"], seams);

    expect(() => writeTeamRecipients("acme", ["age1aaa", "age1bbb"], seams)).not.toThrow();
    expect(readTeamRecipients("acme", seams)).toEqual(["age1aaa", "age1bbb"]);
  });
});

describe("writeTeamSecret", () => {
  test("argv pins --filename-override mattstack/secrets/board.json", async () => {
    const { execSeam, seams } = seamsWithKey();
    writeTeamRecipients("acme", ["age1aaa"], seams);

    await writeTeamSecret("acme", "board", "slackClientSecret", "shh", seams);

    const encryptCall = execSeam.calls.find((c) => c.cmd[1] === "-e")!;
    const overrideIdx = encryptCall.cmd.indexOf("--filename-override");
    expect(encryptCall.cmd[overrideIdx + 1]).toBe(join("mattstack", "secrets", "board.json"));
  });

  test("the value round-trips into the team domain file", async () => {
    const { seams } = seamsWithKey();
    writeTeamRecipients("acme", ["age1aaa"], seams);

    await writeTeamSecret("acme", "board", "slackClientSecret", "shh", seams);

    expect(await readTeamSecret("acme", "board", "slackClientSecret", seams)).toBe("shh");
  });

  test("zero recipients -> NoTeamRecipientsError, no sops call at all", async () => {
    const { execSeam, seams } = seamsWithKey();

    await expect(writeTeamSecret("acme", "board", "k", "v", seams)).rejects.toThrow(NoTeamRecipientsError);
    await expect(writeTeamSecret("acme", "board", "k", "v", seams)).rejects.toThrow(/rt team members sync/);
    expect(execSeam.calls).toEqual([]);
  });

  test("no age key on this machine -> NoAgeKeyError (the interim seam's staging-fallback trigger)", async () => {
    const execSeam = new FakeTeamExecSeam();
    execSeam.files.set(teamCloneRootFor("acme"), "");
    const seams: SecretsSeams = { ageKeySeam: fakeAgeKeySeamAbsent(), execSeam };
    writeTeamRecipients("acme", ["age1aaa"], seams);

    await expect(writeTeamSecret("acme", "board", "k", "v", seams)).rejects.toThrow(/no age key/);
  });
});

describe("buildTeamSpawnOptions", () => {
  test("cwd = this team's clone root, not <mattstackHome>/user", () => {
    const opts = buildTeamSpawnOptions("acme");
    expect(opts.cwd).toBe(join(teamsDir(), "acme"));
  });

  test("a different slug gets a different cwd", () => {
    expect(buildTeamSpawnOptions("otherteam").cwd).toBe(join(teamsDir(), "otherteam"));
  });
});

describe("listTeamSecretNames", () => {
  test("returns keys only, never values", async () => {
    const { seams } = seamsWithKey();
    writeTeamRecipients("acme", ["age1aaa"], seams);
    await writeTeamSecret("acme", "board", "slackClientSecret", "shh", seams);
    await writeTeamSecret("acme", "board", "slackSigningSecret", "shh2", seams);

    expect((await listTeamSecretNames("acme", "board", seams)).sort()).toEqual(["slackClientSecret", "slackSigningSecret"]);
  });

  test("missing domain file -> []", async () => {
    const { seams } = seamsWithKey();
    expect(await listTeamSecretNames("acme", "board", seams)).toEqual([]);
  });
});

describe("addTeamRecipient", () => {
  test("adds the key and runs sops updatekeys -y once per existing domain file", async () => {
    const { execSeam, seams } = seamsWithKey();
    writeTeamRecipients("acme", ["age1aaa"], seams);
    await writeTeamSecret("acme", "board", "slackClientSecret", "shh", seams);
    await writeTeamSecret("acme", "rt", "switchboardAdminToken", "tok", seams);
    execSeam.calls.length = 0; // only care about calls made by addTeamRecipient itself

    const result = await addTeamRecipient("acme", "age1bbb", seams);

    expect(result.added).toBe(true);
    expect(result.reencrypted.sort()).toEqual(
      [teamSecretsFile("acme", "board"), teamSecretsFile("acme", "rt")].sort(),
    );
    const updatekeysCalls = execSeam.calls.filter((c) => c.cmd[1] === "updatekeys");
    expect(updatekeysCalls.length).toBe(2);
    for (const call of updatekeysCalls) expect(call.cmd[0]).toBe("sops");
    expect(readTeamRecipients("acme", seams)).toEqual(["age1aaa", "age1bbb"]);
  });

  test("already a recipient -> no-op, no updatekeys call", async () => {
    const { execSeam, seams } = seamsWithKey();
    writeTeamRecipients("acme", ["age1aaa"], seams);
    execSeam.calls.length = 0;

    const result = await addTeamRecipient("acme", "age1aaa", seams);

    expect(result).toEqual({ added: false, reencrypted: [] });
    expect(execSeam.calls).toEqual([]);
  });

  test("a re-encryption failure rolls .sops.yaml back to the previous recipient set", async () => {
    const execSeam = new FakeTeamExecSeam({ failUpdatekeysOnCall: 1 });
    execSeam.files.set(teamCloneRootFor("acme"), "");
    const seams: SecretsSeams = { ageKeySeam: fakeAgeKeySeamWithKey("AGE-TEAM-KEY"), execSeam };
    writeTeamRecipients("acme", ["age1aaa"], seams);
    await writeTeamSecret("acme", "board", "k", "v", seams);

    await expect(addTeamRecipient("acme", "age1bbb", seams)).rejects.toThrow(/re-encryption failed/);

    expect(readTeamRecipients("acme", seams)).toEqual(["age1aaa"]);
  });
});

describe("removeTeamRecipient", () => {
  test("rewrites .sops.yaml without the key and re-encrypts every domain file", async () => {
    const { execSeam, seams } = seamsWithKey();
    writeTeamRecipients("acme", ["age1aaa", "age1bbb"], seams);
    await writeTeamSecret("acme", "board", "slackClientSecret", "shh", seams);
    execSeam.calls.length = 0;

    const result = await removeTeamRecipient("acme", "age1bbb", seams);

    expect(result.removed).toBe(true);
    expect(result.reencrypted).toEqual([teamSecretsFile("acme", "board")]);
    expect(readTeamRecipients("acme", seams)).toEqual(["age1aaa"]);
  });

  test("not currently a recipient -> no-op", async () => {
    const { execSeam, seams } = seamsWithKey();
    writeTeamRecipients("acme", ["age1aaa"], seams);
    execSeam.calls.length = 0;

    const result = await removeTeamRecipient("acme", "age1zzz", seams);

    expect(result).toEqual({ removed: false, reencrypted: [] });
    expect(execSeam.calls).toEqual([]);
  });

  test("a re-encryption failure rolls .sops.yaml back — and the error says the removed member can still decrypt until rotation succeeds", async () => {
    const execSeam = new FakeTeamExecSeam({ failUpdatekeysOnCall: 1 });
    execSeam.files.set(teamCloneRootFor("acme"), "");
    const seams: SecretsSeams = { ageKeySeam: fakeAgeKeySeamWithKey("AGE-TEAM-KEY"), execSeam };
    writeTeamRecipients("acme", ["age1aaa", "age1bbb"], seams);
    await writeTeamSecret("acme", "board", "k", "v", seams);

    let thrown: unknown;
    try {
      await removeTeamRecipient("acme", "age1bbb", seams);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/age1bbb is STILL a recipient/);
    expect((thrown as Error).message).toMatch(/can still decrypt/);
    // .sops.yaml rolled back to the pre-removal recipient set — the file on
    // disk matches what the error claims: age1bbb genuinely is still named.
    expect(readTeamRecipients("acme", seams)).toEqual(["age1aaa", "age1bbb"]);
  });
});

describe("reencryptTeamSecrets", () => {
  test("re-encrypts every existing domain file and returns their paths", async () => {
    const { execSeam, seams } = seamsWithKey();
    writeTeamRecipients("acme", ["age1aaa"], seams);
    await writeTeamSecret("acme", "board", "slackClientSecret", "shh", seams);
    await writeTeamSecret("acme", "rt", "switchboardAdminToken", "tok", seams);
    execSeam.calls.length = 0;

    const reencrypted = await reencryptTeamSecrets("acme", seams);

    expect(reencrypted.sort()).toEqual([teamSecretsFile("acme", "board"), teamSecretsFile("acme", "rt")].sort());
    expect(execSeam.calls.map((c) => c.cmd)).toEqual(
      reencrypted.map((f) => ["sops", "updatekeys", "-y", f]),
    );
  });

  test("no domain files yet -> [] , no sops call", async () => {
    const { execSeam, seams } = seamsWithKey();
    writeTeamRecipients("acme", ["age1aaa"], seams);
    execSeam.calls.length = 0;

    expect(await reencryptTeamSecrets("acme", seams)).toEqual([]);
    expect(execSeam.calls).toEqual([]);
  });

  test("a failing updatekeys call propagates as a real error", async () => {
    const execSeam = new FakeTeamExecSeam({ updatekeys: { code: 1, stdout: "", stderr: "sops: no matching creation rule" } });
    execSeam.files.set(teamCloneRootFor("acme"), "");
    const seams: SecretsSeams = { ageKeySeam: fakeAgeKeySeamWithKey("AGE-TEAM-KEY"), execSeam };
    writeTeamRecipients("acme", ["age1aaa"], seams);
    await writeTeamSecret("acme", "board", "k", "v", seams);

    await expect(reencryptTeamSecrets("acme", seams)).rejects.toThrow(/updatekeys/);
  });

  test("SOPS_AGE_KEY is injected into every updatekeys call — real sops exits 128 with no env at all", async () => {
    const { execSeam, seams } = seamsWithKey("AGE-TEAM-KEY");
    writeTeamRecipients("acme", ["age1aaa"], seams);
    await writeTeamSecret("acme", "board", "k", "v", seams);
    execSeam.calls.length = 0;

    await reencryptTeamSecrets("acme", seams);

    const updatekeysCalls = execSeam.calls.filter((c) => c.cmd[1] === "updatekeys");
    expect(updatekeysCalls.length).toBeGreaterThan(0);
    for (const call of updatekeysCalls) {
      expect(call.opts?.env).toEqual({ SOPS_AGE_KEY: "AGE-TEAM-KEY" });
      expect(call.opts?.sensitive).toBe(true);
    }
  });

  test("no age key on this machine -> NoAgeKeyError before any sops call, not a bare sops failure (same identity resolution as every other sops call)", async () => {
    const execSeam = new FakeTeamExecSeam();
    execSeam.files.set(teamCloneRootFor("acme"), "");
    const keyedSeams = seamsWithKey();
    writeTeamRecipients("acme", ["age1aaa"], keyedSeams.seams);
    await writeTeamSecret("acme", "board", "k", "v", keyedSeams.seams);
    // Same on-disk state, but this seams pair has no age key — mirrors the
    // scenario where a second machine has the domain file but never ran
    // `rt home init`, only the personal identity is missing.
    execSeam.files = keyedSeams.execSeam.files;
    const seams: SecretsSeams = { ageKeySeam: fakeAgeKeySeamAbsent(), execSeam };

    await expect(reencryptTeamSecrets("acme", seams)).rejects.toThrow(/no age key/);
    expect(execSeam.calls.filter((c) => c.cmd[1] === "updatekeys")).toEqual([]);
  });

  test("a partial failure reports completed vs. remaining files, not just the one that failed", async () => {
    const execSeam = new FakeTeamExecSeam({ failUpdatekeysOnCall: 2 });
    execSeam.files.set(teamCloneRootFor("acme"), "");
    const seams: SecretsSeams = { ageKeySeam: fakeAgeKeySeamWithKey("AGE-TEAM-KEY"), execSeam };
    writeTeamRecipients("acme", ["age1aaa"], seams);
    await writeTeamSecret("acme", "board", "k", "v", seams);
    await writeTeamSecret("acme", "deck", "k", "v", seams);
    await writeTeamSecret("acme", "rt", "k", "v", seams);

    let thrown: unknown;
    try {
      await reencryptTeamSecrets("acme", seams);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(TeamReencryptError);
    const err = thrown as TeamReencryptError;
    expect(err.completed.length).toBe(1);
    expect(err.remaining.length).toBe(2);
    expect(err.message).toContain("re-encrypted (on the NEW recipients)");
    expect(err.message).toContain("NOT re-encrypted (still on the OLD recipients)");
  });
});

// Leak-table coverage extended to team paths (store.test.ts covers the
// personal-store equivalents): a value must never surface in argv, and
// `rt secrets list --team` must print names only.
describe("team secrets never leak a value", () => {
  test("writeTeamSecret's value never appears in any subprocess argv", async () => {
    const { execSeam, seams } = seamsWithKey();
    writeTeamRecipients("acme", ["age1aaa"], seams);

    await writeTeamSecret("acme", "board", "k", "super-secret-value-never-in-argv", seams);

    expect(execSeam.calls.flatMap((c) => c.cmd)).not.toContain("super-secret-value-never-in-argv");
  });

  test("rt secrets list --team prints secret names but never the canary value, on stdout OR stderr", async () => {
    const CANARY = "sk_super_secret_team_canary_value_should_never_print";
    const { seams } = seamsWithKey();
    writeTeamRecipients("acme", ["age1aaa"], seams);
    await writeTeamSecret("acme", "board", "apiKey", CANARY, seams);
    await writeTeamSecret("acme", "board", "other", "value2", seams);

    const logs: string[] = [];
    const errors: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
      logs.push(parts.map(String).join(" "));
    });
    const errorSpy = spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
      errors.push(parts.map(String).join(" "));
    });

    try {
      await secretsList(["board", "--team", "acme"], {}, seams);
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
