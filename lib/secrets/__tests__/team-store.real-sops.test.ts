/**
 * Real-sops/age integration coverage for the team store. A fake exec seam
 * that always returns `code: 0` for `sops updatekeys` can't catch a missing
 * `SOPS_AGE_KEY` — real sops requires it (or a `keys.txt` this codebase
 * never writes) and exits 128 "failed to load age identities" without it —
 * so this file drives the REAL `sops`/`age` binaries against a real
 * filesystem tree instead. Only the keychain lookup is faked (two
 * locally-generated age identities stand in for "this machine's personal
 * key" without ever touching the real keychain). Skips itself when
 * `sops`/`age-keygen` aren't on PATH rather than failing CI on a machine
 * without them.
 */
import { describe, test, expect } from "bun:test";
import { mkdirSync } from "fs";
import { join } from "path";
import {
  createRealSecretsExecSeam,
  type SecretsSeams,
} from "../store.ts";
import {
  addTeamRecipient,
  readTeamSecret,
  reencryptTeamSecrets,
  removeTeamRecipient,
  writeTeamRecipients,
  writeTeamSecret,
} from "../team-store.ts";
import { teamsDir } from "../../rt-paths.ts";
import type { AgeExecResult, AgeKeySeam } from "../../home/age-key.ts";

const hasRealSops = Bun.which("sops") !== null && Bun.which("age-keygen") !== null;

async function generateAgeKeypair(): Promise<{ publicKey: string; privateKey: string }> {
  const proc = Bun.spawn(["age-keygen"], { stdout: "pipe", stderr: "pipe" });
  const [stdout, , code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error("age-keygen failed");
  const publicKey = stdout.match(/^# public key: (age1\S+)/m)?.[1];
  const privateKey = stdout.match(/^(AGE-SECRET-KEY-1\S+)/m)?.[1];
  if (!publicKey || !privateKey) throw new Error(`could not parse age-keygen output: ${stdout}`);
  return { publicKey, privateKey };
}

/** Stands in for the real keychain — hands back exactly one fixed private key, never touching `security`. */
function fakeAgeKeySeamWithKey(privateKey: string): AgeKeySeam {
  return {
    async run(cmd): Promise<AgeExecResult> {
      if (cmd[0] === "security" && cmd[1] === "find-generic-password") {
        return { code: 0, stdout: `${privateKey}\n`, stderr: "" };
      }
      throw new Error(`fakeAgeKeySeamWithKey: unexpected call ${cmd.join(" ")}`);
    },
  };
}

describe.skipIf(!hasRealSops)("team-store against real sops + age", () => {
  test("writeTeamRecipients + writeTeamSecret + addTeamRecipient + removeTeamRecipient all round-trip against real sops, with real SOPS_AGE_KEY injection into updatekeys", async () => {
    const slug = `realsops-${process.pid}`;
    const root = join(teamsDir(), slug);
    mkdirSync(join(root, "mattstack", "secrets"), { recursive: true });

    const a = await generateAgeKeypair();
    const b = await generateAgeKeypair();

    const execSeam = createRealSecretsExecSeam(root);
    const seamsA: SecretsSeams = { ageKeySeam: fakeAgeKeySeamWithKey(a.privateKey), execSeam };
    const seamsB: SecretsSeams = { ageKeySeam: fakeAgeKeySeamWithKey(b.privateKey), execSeam };

    // 1. Single recipient (A), one real encrypt.
    writeTeamRecipients(slug, [a.publicKey], seamsA);
    await writeTeamSecret(slug, "board", "slackClientSecret", "real-sops-value", seamsA);
    expect(await readTeamSecret(slug, "board", "slackClientSecret", seamsA)).toBe("real-sops-value");

    // 2. addTeamRecipient(B) -> real `sops updatekeys -y`, which needs
    // SOPS_AGE_KEY injected the same way every other sops call gets it.
    // Both A and B must now decrypt the SAME ciphertext.
    const addResult = await addTeamRecipient(slug, b.publicKey, seamsA);
    expect(addResult.added).toBe(true);
    expect(addResult.reencrypted.length).toBe(1);
    expect(await readTeamSecret(slug, "board", "slackClientSecret", seamsA)).toBe("real-sops-value");
    expect(await readTeamSecret(slug, "board", "slackClientSecret", seamsB)).toBe("real-sops-value");

    // 3. A second domain file, so rotate-all (reencryptTeamSecrets, the
    // mechanic behind `rt secrets rotate --team <slug>` with no domain/key)
    // has more than one file to walk.
    await writeTeamSecret(slug, "rt", "switchboardAdminToken", "another-real-value", seamsB);
    const rotateAll = await reencryptTeamSecrets(slug, seamsA);
    expect(rotateAll.length).toBe(2);
    expect(await readTeamSecret(slug, "rt", "switchboardAdminToken", seamsB)).toBe("another-real-value");

    // 4. removeTeamRecipient(A) -> real re-encryption to [B] only. B still
    // decrypts every file; A — genuinely revoked now, not just on paper —
    // can no longer decrypt EITHER file.
    const removeResult = await removeTeamRecipient(slug, a.publicKey, seamsA);
    expect(removeResult.removed).toBe(true);
    expect(removeResult.reencrypted.length).toBe(2);
    expect(await readTeamSecret(slug, "board", "slackClientSecret", seamsB)).toBe("real-sops-value");
    expect(await readTeamSecret(slug, "rt", "switchboardAdminToken", seamsB)).toBe("another-real-value");
    await expect(readTeamSecret(slug, "board", "slackClientSecret", seamsA)).rejects.toThrow();
  }, 30_000);
});
