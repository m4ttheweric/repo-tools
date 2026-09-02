import { describe, test, expect } from "bun:test";
import { join } from "path";
import { fakeProbes } from "../../setup/__tests__/fakes.ts";
import type { AgeExecResult, AgeKeySeam } from "../../home/age-key.ts";
import { readTeamRecipients, teamSecretsFile, writeTeamRecipients } from "../../secrets/team-store.ts";
import type { SecretsExecResult, SecretsExecSeam, SecretsSeams } from "../../secrets/store.ts";
import { UserActionableError } from "../../setup/errors.ts";
import { teamsDir } from "../../rt-paths.ts";
import { seal, sealReply } from "../invite-crypto.ts";
import { upsertInviteRecord, type InviteRecord } from "../invite-records.ts";
import { membersRemove, membersSync, MembersSyncAbortedError, type MembersSeams } from "../members.ts";
import type { RelayClient } from "../relay-client.ts";

const HOME = "/home/x";
const SLUG = "acme";
const OWNER_PUBLIC_KEY = "age19gmvtjcupd0gq46003yh9tepvlj4fr97pfg4zh024fpq0kqfqyys5ftxdh";
const ALICE_PUBLIC_KEY = "age1g7smmpu6s9480mmmczw9vvcukwetteh3s7grduzr2zw74d8j99msrdyzhx";
const ID_HEX = "0102030405060708090a0b0c0d0e0f10";
const KEY = new Uint8Array(32).fill(9);
const CREATOR_SECRET = "creator-secret-alice";

function teamCloneRootFor(slug: string): string {
  return join(teamsDir(), slug);
}

function fakeAgeKeySeam(privateKey = "AGE-SECRET-KEY-1OWNER", publicKey = OWNER_PUBLIC_KEY): AgeKeySeam {
  return {
    async run(cmd): Promise<AgeExecResult> {
      if (cmd[0] === "security" && cmd[1] === "find-generic-password") return { code: 0, stdout: `${privateKey}\n`, stderr: "" };
      if (cmd[0] === "age-keygen" && cmd[1] === "-y") return { code: 0, stdout: `${publicKey}\n`, stderr: "" };
      throw new Error(`fakeAgeKeySeam: unexpected call ${cmd.join(" ")}`);
    },
  };
}

/**
 * A keychain with provably no key yet (readAgeKey's `{absent: true}`
 * outcome) — every command it sees is recorded, so a test can assert
 * `membersRemove`'s own-key guard never mints (never calls
 * `security add-generic-password`/`age-keygen` with no `-y`) just to check
 * whether a removal target is this machine's own key.
 */
function fakeAgeKeySeamAbsent(): AgeKeySeam & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async run(cmd): Promise<AgeExecResult> {
      calls.push(cmd);
      if (cmd[0] === "security" && cmd[1] === "find-generic-password") {
        return { code: 44, stdout: "", stderr: "The specified item could not be found in the keychain." };
      }
      throw new Error(`fakeAgeKeySeamAbsent: unexpected call ${cmd.join(" ")} — a removal must never provision a keychain item`);
    },
  };
}

/** Mirrors lib/secrets/__tests__/team-store.test.ts's own fake — a minimal round-trippable-plaintext sops/age stand-in, local to this file since that one isn't exported. */
class FakeTeamExecSeam implements SecretsExecSeam {
  calls: { cmd: string[]; opts?: { env?: Record<string, string>; sensitive?: boolean } }[] = [];
  files = new Map<string, string>();
  private mtimeCounter = 0;
  private stats = new Map<string, { mtimeMs: number; size: number }>();
  private roundTrippablePlaintext = new Map<string, string>();
  private updatekeysCallCount = 0;
  private failUpdatekeysOnCall?: number;

  constructor(opts: { failUpdatekeysOnCall?: number } = {}) {
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
    const content = this.files.get(from);
    if (content !== undefined) {
      this.files.set(to, content);
      this.files.delete(from);
      this.stats.delete(from);
      this.touch(to);
    }
    const plaintext = this.roundTrippablePlaintext.get(from);
    if (plaintext !== undefined) {
      this.roundTrippablePlaintext.set(to, plaintext);
      this.roundTrippablePlaintext.delete(from);
    }
  }

  removeFile(path: string): void {
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
      return { code: 0, stdout: "", stderr: "" };
    }

    throw new Error(`FakeTeamExecSeam: unexpected call ${cmd.join(" ")}`);
  }
}

function seamsWithClone(slug = SLUG, opts: { failUpdatekeysOnCall?: number } = {}): { execSeam: FakeTeamExecSeam; secrets: SecretsSeams } {
  const execSeam = new FakeTeamExecSeam(opts);
  execSeam.files.set(teamCloneRootFor(slug), "");
  return { execSeam, secrets: { ageKeySeam: fakeAgeKeySeam(), execSeam } };
}

function fakeMembersSeams(overrides: Partial<MembersSeams> = {}): { seams: MembersSeams; writes: { key: string; value: unknown; scope: string; opts: unknown }[] } {
  const writes: { key: string; value: unknown; scope: string; opts: unknown }[] = [];
  let store: Record<string, unknown> = {};
  const seams: MembersSeams = {
    readTeamStore: () => store,
    writeSetting: ((key: string, value: unknown, scope: string, opts?: unknown) => {
      writes.push({ key, value, scope, opts });
      if (key === "board.members") store = { ...store, "board.members": value };
    }) as MembersSeams["writeSetting"],
    revokeRead: async () => ({ access: "revoked", manualSteps: [] }),
    readTeamLocal: () => ({ createdByRt: true, rtMayManageMembership: true }),
    forgeToken: async () => null,
    warn: () => {},
    ...overrides,
  };
  return { seams, writes };
}

interface FakeRelayOpts {
  readReply?: RelayClient["readReply"];
}

function fakeRelay(opts: FakeRelayOpts = {}): RelayClient {
  return {
    async create() {
      throw new Error("create not used by members sync/remove");
    },
    async fetch() {
      throw new Error("fetch not used by members sync/remove");
    },
    async redeem() {
      throw new Error("redeem not used by members sync/remove");
    },
    async reply() {
      throw new Error("reply not used by members sync/remove");
    },
    async readReply(id, creatorSecret) {
      if (opts.readReply) return opts.readReply(id, creatorSecret);
      return "none";
    },
    async delete() {
      throw new Error("delete not used by members sync/remove");
    },
  };
}

function aliceRecord(overrides: Partial<InviteRecord> = {}): InviteRecord {
  return { id: ID_HEX, creatorSecret: CREATOR_SECRET, keyB64: Buffer.from(KEY).toString("base64"), expiresAt: "2026-12-01T00:00:00.000Z", ...overrides };
}

async function replyBlob(agePublicKey: string, handle?: string): Promise<string> {
  return sealReply({ v: 1, agePublicKey, handle }, KEY, ID_HEX);
}

describe("membersSync", () => {
  test("a record whose reply exists gets added (alongside the owner's own bootstrap key), sops updatekeys runs, and the invite record is removed", async () => {
    const p = fakeProbes({ home: HOME });
    upsertInviteRecord(p, SLUG, "alice", aliceRecord());
    const { execSeam, secrets } = seamsWithClone();
    execSeam.writeFile(teamSecretsFile(SLUG, "board"), JSON.stringify({ data: "opaque", sops: {} }));
    const { seams, writes } = fakeMembersSeams();
    const blob = await replyBlob(ALICE_PUBLIC_KEY, "alice");
    const relay = fakeRelay({ readReply: async () => ({ blob }) });

    const result = await membersSync(p, relay, secrets, SLUG, seams);

    // Owner's own bootstrap add is reported too — a fresh team's first sync
    // must not read as "added 0 key(s)".
    expect(result.added).toEqual([OWNER_PUBLIC_KEY, ALICE_PUBLIC_KEY]);
    expect(result.pending).toEqual([]);
    expect(execSeam.calls.some((c) => c.cmd[0] === "sops" && c.cmd[1] === "updatekeys")).toBe(true);
    expect(p.readFile(join(HOME, ".mattstack", "rt", "invites", `${SLUG}.json`))).toBe("{}");
    // Roster gained alice with her age key, via writeSetting("board.members", ..., "team", { team: slug }).
    const rosterWrite = writes.find((w) => w.key === "board.members" && (w.value as { username: string }[]).some((m) => m.username === "alice"));
    expect(rosterWrite).toBeDefined();
    expect((rosterWrite!.value as { username: string; agePublicKey?: string }[]).find((m) => m.username === "alice")?.agePublicKey).toBe(ALICE_PUBLIC_KEY);
    expect(rosterWrite!.scope).toBe("team");
    expect(rosterWrite!.opts).toEqual({ team: SLUG });
  });

  test("a second sync run with no new replies reports nothing added (the owner's key is already a recipient)", async () => {
    const p = fakeProbes({ home: HOME });
    const { secrets } = seamsWithClone();
    const { seams } = fakeMembersSeams();
    const relay = fakeRelay();

    await membersSync(p, relay, secrets, SLUG, seams); // bootstrap run
    const result = await membersSync(p, relay, secrets, SLUG, seams); // second run

    expect(result.added).toEqual([]);
  });

  test("no reply yet -> the handle is reported pending, the invite record stays", async () => {
    const p = fakeProbes({ home: HOME });
    upsertInviteRecord(p, SLUG, "alice", aliceRecord());
    const { secrets } = seamsWithClone();
    const { seams } = fakeMembersSeams();
    const relay = fakeRelay(); // readReply -> "none"

    const result = await membersSync(p, relay, secrets, SLUG, seams);

    expect(result.added).toEqual([OWNER_PUBLIC_KEY]); // just the bootstrap add
    expect(result.pending).toEqual(["alice"]);
    const raw = p.readFile(join(HOME, ".mattstack", "rt", "invites", `${SLUG}.json`));
    expect(JSON.parse(raw!)).toHaveProperty("alice");
  });

  test("the owner's own key is always a recipient afterwards, even with zero invite records", async () => {
    const p = fakeProbes({ home: HOME });
    const { secrets } = seamsWithClone();
    const { seams } = fakeMembersSeams();
    const relay = fakeRelay();

    await membersSync(p, relay, secrets, SLUG, seams);

    expect(readTeamRecipients(SLUG, secrets)).toContain(OWNER_PUBLIC_KEY);
  });

  test("a reply that decrypts but carries a malformed age key never reaches .sops.yaml, and stays pending for a retry", async () => {
    const p = fakeProbes({ home: HOME });
    upsertInviteRecord(p, SLUG, "alice", aliceRecord());
    const { secrets } = seamsWithClone();
    const { seams } = fakeMembersSeams();
    // A structurally-valid reply (decrypts, has a string agePublicKey) but the string is not a real age1 recipient.
    const blob = await replyBlob("not-an-age-key\nage: age1attacker", "alice");
    const relay = fakeRelay({ readReply: async () => ({ blob }) });

    const result = await membersSync(p, relay, secrets, SLUG, seams);

    expect(result.added).toEqual([OWNER_PUBLIC_KEY]);
    expect(result.pending).toEqual(["alice"]);
    expect(readTeamRecipients(SLUG, secrets)).not.toContain("not-an-age-key\nage: age1attacker");
    // The invite record survives so a legitimate reply can still be picked up next sync.
    const raw = p.readFile(join(HOME, ".mattstack", "rt", "invites", `${SLUG}.json`));
    expect(JSON.parse(raw!)).toHaveProperty("alice");
  });

  test("a reply that fails to decrypt (wrong key material) is treated the same as malformed, not a crash", async () => {
    const p = fakeProbes({ home: HOME });
    upsertInviteRecord(p, SLUG, "alice", aliceRecord());
    const { secrets } = seamsWithClone();
    const { seams } = fakeMembersSeams();
    const wrongKey = new Uint8Array(32).fill(1);
    const blob = await sealReply({ v: 1, agePublicKey: ALICE_PUBLIC_KEY }, wrongKey, ID_HEX); // sealed under a DIFFERENT key than the record's keyB64
    const relay = fakeRelay({ readReply: async () => ({ blob }) });

    const result = await membersSync(p, relay, secrets, SLUG, seams);

    expect(result.added).toEqual([OWNER_PUBLIC_KEY]);
    expect(result.pending).toEqual(["alice"]);
  });

  describe("the age-key bech32 checksum gate", () => {
    test("age1 + 50 junk characters (the old regex's minimum) is rejected", async () => {
      const p = fakeProbes({ home: HOME });
      upsertInviteRecord(p, SLUG, "alice", aliceRecord());
      const { secrets } = seamsWithClone();
      const { seams } = fakeMembersSeams();
      const junk = `age1${"q".repeat(50)}`;
      const blob = await replyBlob(junk);
      const relay = fakeRelay({ readReply: async () => ({ blob }) });

      const result = await membersSync(p, relay, secrets, SLUG, seams);

      expect(result.pending).toEqual(["alice"]);
      expect(readTeamRecipients(SLUG, secrets)).not.toContain(junk);
    });

    test("age1 + 200 junk characters (no upper bound under the old regex) is rejected", async () => {
      const p = fakeProbes({ home: HOME });
      upsertInviteRecord(p, SLUG, "alice", aliceRecord());
      const { secrets } = seamsWithClone();
      const { seams } = fakeMembersSeams();
      const junk = `age1${"q".repeat(200)}`;
      const blob = await replyBlob(junk);
      const relay = fakeRelay({ readReply: async () => ({ blob }) });

      const result = await membersSync(p, relay, secrets, SLUG, seams);

      expect(result.pending).toEqual(["alice"]);
      expect(readTeamRecipients(SLUG, secrets)).not.toContain(junk);
    });

    test("a real key with its checksum corrupted (right length, right charset, wrong checksum) is rejected", async () => {
      const p = fakeProbes({ home: HOME });
      upsertInviteRecord(p, SLUG, "alice", aliceRecord());
      const { secrets } = seamsWithClone();
      const { seams } = fakeMembersSeams();
      const corrupted = `${ALICE_PUBLIC_KEY.slice(0, -1)}${ALICE_PUBLIC_KEY.at(-1) === "x" ? "y" : "x"}`;
      expect(corrupted).not.toBe(ALICE_PUBLIC_KEY);
      expect(corrupted.length).toBe(ALICE_PUBLIC_KEY.length);
      const blob = await replyBlob(corrupted);
      const relay = fakeRelay({ readReply: async () => ({ blob }) });

      const result = await membersSync(p, relay, secrets, SLUG, seams);

      expect(result.pending).toEqual(["alice"]);
      expect(readTeamRecipients(SLUG, secrets)).not.toContain(corrupted);
    });

    test("a forged key with a VALID checksum but a dirty final padding group (BIP-173's non-zero-padding rule) is rejected", async () => {
      // A real key (last payload group's low bits legitimately zero) with those bits set and the checksum recomputed to match — real `age -r` rejects this exact key with "non-zero padding".
      const forged = "age1dxgc42vutd4a6q5zqkdg6q4jccysl8q9lqg7j5r78cd9y5m2usq0wmgpdc";
      expect(forged.length).toBe(62);

      const p = fakeProbes({ home: HOME });
      upsertInviteRecord(p, SLUG, "alice", aliceRecord());
      const { secrets } = seamsWithClone();
      const { seams } = fakeMembersSeams();
      const blob = await replyBlob(forged);
      const relay = fakeRelay({ readReply: async () => ({ blob }) });

      const result = await membersSync(p, relay, secrets, SLUG, seams);

      expect(result.pending).toEqual(["alice"]);
      expect(readTeamRecipients(SLUG, secrets)).not.toContain(forged);
    });

    test("the real key the forged one above was derived from is still accepted — the padding check must not over-reject a genuine age-keygen key", async () => {
      const real = "age1dxgc42vutd4a6q5zqkdg6q4jccysl8q9lqg7j5r78cd9y5m2usqq3kmajq";
      expect(real.length).toBe(62);

      const p = fakeProbes({ home: HOME });
      upsertInviteRecord(p, SLUG, "alice", aliceRecord());
      const { secrets } = seamsWithClone();
      const { seams } = fakeMembersSeams();
      const blob = await replyBlob(real, "alice");
      const relay = fakeRelay({ readReply: async () => ({ blob }) });

      const result = await membersSync(p, relay, secrets, SLUG, seams);

      expect(result.added).toContain(real);
      expect(result.pending).toEqual([]);
      expect(readTeamRecipients(SLUG, secrets)).toContain(real);
    });
  });

  describe("first-claim-wins: a reply echoing an already-recorded key", () => {
    test("a reply that echoes the OWNER's own key is rejected at sync time, never recorded on the handle's roster entry", async () => {
      const p = fakeProbes({ home: HOME });
      upsertInviteRecord(p, SLUG, "alice", aliceRecord());
      const { secrets } = seamsWithClone();
      const { seams, writes } = fakeMembersSeams();
      // The owner's .sops.yaml is public in the team repo — this is the exact echo attack.
      const blob = await replyBlob(OWNER_PUBLIC_KEY, "alice");
      const relay = fakeRelay({ readReply: async () => ({ blob }) });

      const result = await membersSync(p, relay, secrets, SLUG, seams);

      expect(result.added).toEqual([OWNER_PUBLIC_KEY]); // only the owner's own bootstrap add, not a second "add" of the same key for alice
      expect(result.pending).toEqual(["alice"]);
      // The invite record is retained so a legitimate reply can still land.
      const raw = p.readFile(join(HOME, ".mattstack", "rt", "invites", `${SLUG}.json`));
      expect(JSON.parse(raw!)).toHaveProperty("alice");
      // No roster entry was ever written recording the owner's key as alice's.
      const aliceRosterWrite = writes.find((w) => w.key === "board.members" && (w.value as { username: string }[]).some((m) => m.username === "alice"));
      expect(aliceRosterWrite).toBeUndefined();
      expect(readTeamRecipients(SLUG, secrets)).toEqual([OWNER_PUBLIC_KEY]);
    });

    test("a reply echoing another member's already-synced key is likewise rejected, not just the owner's", async () => {
      const p = fakeProbes({ home: HOME });
      upsertInviteRecord(p, SLUG, "alice", aliceRecord());
      upsertInviteRecord(p, SLUG, "mallory", aliceRecord({ id: "1102030405060708090a0b0c0d0e0f10", creatorSecret: "creator-secret-mallory" }));
      const { secrets } = seamsWithClone();
      const { seams } = fakeMembersSeams();
      const aliceBlob = await replyBlob(ALICE_PUBLIC_KEY, "alice");
      const malloryBlob = await replyBlob(ALICE_PUBLIC_KEY, "mallory"); // echoes alice's key, not the owner's
      const relay = fakeRelay({
        readReply: async (id) => ({ blob: id === ID_HEX ? aliceBlob : malloryBlob }),
      });

      const result = await membersSync(p, relay, secrets, SLUG, seams);

      expect(result.added).toEqual([OWNER_PUBLIC_KEY, ALICE_PUBLIC_KEY]);
      expect(result.pending).toEqual(["mallory"]);
      expect(readTeamRecipients(SLUG, secrets)).toEqual([ALICE_PUBLIC_KEY, OWNER_PUBLIC_KEY].sort());
    });
  });

  test("reencrypted lists every file touched across the owner-ensure call and every added invite, deduped", async () => {
    const p = fakeProbes({ home: HOME });
    upsertInviteRecord(p, SLUG, "alice", aliceRecord());
    const { execSeam, secrets } = seamsWithClone();
    const { seams } = fakeMembersSeams();
    execSeam.writeFile(teamSecretsFile(SLUG, "board"), JSON.stringify({ data: "opaque", sops: {} }));
    const blob = await replyBlob(ALICE_PUBLIC_KEY);
    const relay = fakeRelay({ readReply: async () => ({ blob }) });

    const result = await membersSync(p, relay, secrets, SLUG, seams);

    expect(result.reencrypted).toEqual([teamSecretsFile(SLUG, "board")]);
  });

  test("multiple pending handles are all reported, sorted by iteration order", async () => {
    const p = fakeProbes({ home: HOME });
    upsertInviteRecord(p, SLUG, "alice", aliceRecord());
    upsertInviteRecord(p, SLUG, "bob", aliceRecord({ id: "1102030405060708090a0b0c0d0e0f10", creatorSecret: "creator-secret-bob" }));
    const { secrets } = seamsWithClone();
    const { seams } = fakeMembersSeams();
    const relay = fakeRelay();

    const result = await membersSync(p, relay, secrets, SLUG, seams);

    expect(result.pending.sort()).toEqual(["alice", "bob"]);
  });

  test("a mid-sync infrastructure failure throws MembersSyncAbortedError carrying what already landed", async () => {
    const p = fakeProbes({ home: HOME });
    upsertInviteRecord(p, SLUG, "alice", aliceRecord());
    upsertInviteRecord(p, SLUG, "bob", aliceRecord({ id: "1102030405060708090a0b0c0d0e0f10", creatorSecret: "creator-secret-bob" }));
    // Call 1: owner's bootstrap add (no domain files yet, no updatekeys call).
    // Call 2: alice's add — the first real updatekeys call — force IT to fail.
    const { execSeam, secrets } = seamsWithClone(SLUG, { failUpdatekeysOnCall: 1 });
    execSeam.writeFile(teamSecretsFile(SLUG, "board"), JSON.stringify({ data: "opaque", sops: {} }));
    const { seams } = fakeMembersSeams();
    const aliceBlob = await replyBlob(ALICE_PUBLIC_KEY, "alice");
    const bobBlob = await replyBlob("age1g7smmpu6s9480mmmczw9vvcukwetteh3s7grduzr2zw74d8j99msrdyzhx", "bob"); // never reached
    const relay = fakeRelay({ readReply: async (id) => ({ blob: id === ID_HEX ? aliceBlob : bobBlob }) });

    let thrown: unknown;
    try {
      await membersSync(p, relay, secrets, SLUG, seams);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(MembersSyncAbortedError);
    const err = thrown as MembersSyncAbortedError;
    // Nothing landed before the failing add — the owner's own bootstrap add had no domain file to re-encrypt yet.
    expect(err.added).toEqual([]);
    expect(err.pending).toEqual([]);
    expect(err.message).toContain("aborted after adding 0 key(s)");
  });
});

describe("membersRemove", () => {
  function gitConfigWithRemote(remote: string): string {
    return `[remote "origin"]\n\turl = ${remote}\n`;
  }

  // MAT-387: removal FAILS OPEN — the person keeps repo access when rt is not
  // permitted to revoke it. Silence there would read as "removed" while they
  // could still clone, so the warning is the point of these two tests.
  test("without the membership permission: never calls the forge, and says they still have access", async () => {
    const remote = "git@github.com:acme/widgets.git";
    const p = fakeProbes({ home: HOME, files: { [join(HOME, ".mattstack", "teams", SLUG, ".git", "config")]: gitConfigWithRemote(remote) } });
    const { execSeam, secrets } = seamsWithClone();
    writeTeamRecipients(SLUG, [OWNER_PUBLIC_KEY, ALICE_PUBLIC_KEY], secrets);
    execSeam.writeFile(teamSecretsFile(SLUG, "board"), JSON.stringify({ data: "opaque", sops: {} }));

    const revokeCalls: unknown[] = [];
    const { seams } = fakeMembersSeams({
      readTeamStore: () => ({ "board.members": [{ username: "matt" }, { username: "alice", agePublicKey: ALICE_PUBLIC_KEY }] }),
      readTeamLocal: () => ({ createdByRt: false, rtMayManageMembership: false }),
      revokeRead: async (...args) => {
        revokeCalls.push(args);
        return { access: "revoked", manualSteps: [] };
      },
    });

    const result = await membersRemove(p, secrets, SLUG, "alice", undefined, seams);

    expect(revokeCalls).toEqual([]);
    expect(result.forgeAccess).toBe("skipped");
    expect(result.manualSteps.join(" ")).toContain("still has access");
    expect(result.manualSteps.join(" ")).toContain(remote);
    // The rest of the removal still happens — declining to administer someone
    // else's repo must not leave the member half-removed locally.
    expect(result.rosterRemoved).toBe(true);
    expect(readTeamRecipients(SLUG, secrets)).toEqual([OWNER_PUBLIC_KEY]);
  });

  test("revokes forge access, writes the roster without the handle, re-encrypts, and returns a non-empty residue note", async () => {
    const remote = "git@github.com:acme/widgets.git";
    const p = fakeProbes({ home: HOME, files: { [join(HOME, ".mattstack", "teams", SLUG, ".git", "config")]: gitConfigWithRemote(remote) } });
    const { execSeam, secrets } = seamsWithClone();
    // alice is already a recipient (as if membersSync had run for her already), with a real domain file to re-encrypt.
    writeTeamRecipients(SLUG, [OWNER_PUBLIC_KEY, ALICE_PUBLIC_KEY], secrets);
    execSeam.writeFile(teamSecretsFile(SLUG, "board"), JSON.stringify({ data: "opaque", sops: {} }));

    const revokeCalls: { remote: string; handle: string; token: string | null | undefined }[] = [];
    const { seams, writes } = fakeMembersSeams({
      readTeamStore: () => ({ "board.members": [{ username: "matt" }, { username: "alice", agePublicKey: ALICE_PUBLIC_KEY }] }),
      readTeamLocal: () => ({ createdByRt: true, rtMayManageMembership: true }),
      forgeToken: async () => "ghp-secret",
      revokeRead: async (_p, r, h, token) => {
        revokeCalls.push({ remote: r, handle: h, token });
        return { access: "revoked", manualSteps: [] };
      },
    });

    const result = await membersRemove(p, secrets, SLUG, "alice", undefined, seams);

    expect(revokeCalls).toEqual([{ remote, handle: "alice", token: "ghp-secret" }]);
    expect(result.forgeAccess).toBe("revoked");
    expect(result.rosterRemoved).toBe(true);
    const rosterWrite = writes.find((w) => w.key === "board.members");
    expect((rosterWrite!.value as { username: string }[]).map((m) => m.username)).toEqual(["matt"]);
    expect(result.reencrypted).toEqual([teamSecretsFile(SLUG, "board")]);
    expect(execSeam.calls.some((c) => c.cmd[0] === "sops" && c.cmd[1] === "updatekeys")).toBe(true);
    expect(readTeamRecipients(SLUG, secrets)).toEqual([OWNER_PUBLIC_KEY]);
    expect(result.residueNote.length).toBeGreaterThan(0);
    expect(result.residueNote).toContain("rotate the values themselves");
  });

  test("an explicit agePublicKey overrides whatever the roster carries", async () => {
    const p = fakeProbes({ home: HOME });
    const { secrets } = seamsWithClone();
    writeTeamRecipients(SLUG, [OWNER_PUBLIC_KEY, ALICE_PUBLIC_KEY], secrets);
    const { seams } = fakeMembersSeams({ readTeamStore: () => ({ "board.members": [] }) });

    const result = await membersRemove(p, secrets, SLUG, "alice", ALICE_PUBLIC_KEY, seams);

    expect(readTeamRecipients(SLUG, secrets)).toEqual([OWNER_PUBLIC_KEY]);
    expect(result.rosterRemoved).toBe(false); // no roster entry to remove, but the recipient still comes out
  });

  test("an explicit --key with no roster entry removes a recipient the roster never recorded", async () => {
    const p = fakeProbes({ home: HOME });
    const { secrets } = seamsWithClone();
    // A recipient with no roster entry at all — a hand-edited store, or a key that was never legitimately assigned to any handle.
    writeTeamRecipients(SLUG, [OWNER_PUBLIC_KEY, ALICE_PUBLIC_KEY], secrets);
    const { seams } = fakeMembersSeams({ readTeamStore: () => ({ "board.members": [] }) });

    const result = await membersRemove(p, secrets, SLUG, "unrecorded-recipient", ALICE_PUBLIC_KEY, seams);

    expect(result.rosterRemoved).toBe(false);
    expect(readTeamRecipients(SLUG, secrets)).toEqual([OWNER_PUBLIC_KEY]);
  });

  test("an explicit --key that fails the bech32 checksum is refused before any mutation", async () => {
    const p = fakeProbes({ home: HOME });
    const { secrets } = seamsWithClone();
    writeTeamRecipients(SLUG, [OWNER_PUBLIC_KEY, ALICE_PUBLIC_KEY], secrets);
    const { seams, writes } = fakeMembersSeams({ readTeamStore: () => ({ "board.members": [] }) });

    await expect(membersRemove(p, secrets, SLUG, "alice", `age1${"q".repeat(50)}`, seams)).rejects.toThrow(UserActionableError);

    expect(writes).toEqual([]);
    expect(readTeamRecipients(SLUG, secrets)).toEqual([OWNER_PUBLIC_KEY, ALICE_PUBLIC_KEY]);
  });

  test("no git remote configured -> forge access is skipped, never a crash", async () => {
    const p = fakeProbes({ home: HOME }); // no .git/config at all
    const { secrets } = seamsWithClone();
    const { seams } = fakeMembersSeams({ readTeamStore: () => ({ "board.members": [] }) });

    const result = await membersRemove(p, secrets, SLUG, "alice", undefined, seams);

    expect(result.forgeAccess).toBe("skipped");
  });

  test("no agePublicKey anywhere (never synced) -> no recipient-removal call, still reports the residue note honestly", async () => {
    const p = fakeProbes({ home: HOME });
    const { execSeam, secrets } = seamsWithClone();
    const { seams } = fakeMembersSeams({ readTeamStore: () => ({ "board.members": [{ username: "alice" }] }) });
    execSeam.calls.length = 0;

    const result = await membersRemove(p, secrets, SLUG, "alice", undefined, seams);

    expect(result.reencrypted).toEqual([]);
    expect(execSeam.calls.filter((c) => c.cmd[1] === "updatekeys")).toEqual([]);
    expect(result.residueNote).toContain("rotate the values themselves");
  });

  test("a machine with no local age key yet removes cleanly, without minting one — the own-key guard skips the comparison rather than provisioning a keychain item", async () => {
    const p = fakeProbes({ home: HOME });
    const { execSeam } = seamsWithClone();
    const absentAgeKeySeam = fakeAgeKeySeamAbsent();
    const secrets: SecretsSeams = { ageKeySeam: absentAgeKeySeam, execSeam };
    writeTeamRecipients(SLUG, [OWNER_PUBLIC_KEY, ALICE_PUBLIC_KEY], secrets);
    const { seams } = fakeMembersSeams({ readTeamStore: () => ({ "board.members": [{ username: "alice", agePublicKey: ALICE_PUBLIC_KEY }] }) });

    const result = await membersRemove(p, secrets, SLUG, "alice", undefined, seams);

    expect(result.rosterRemoved).toBe(true);
    expect(readTeamRecipients(SLUG, secrets)).toEqual([OWNER_PUBLIC_KEY]);
    // fakeAgeKeySeamAbsent throws on anything but find-generic-password, so
    // reaching here at all already proves no mint was attempted — asserted
    // explicitly too, and pinned to exactly one lookup (no retry-as-mint).
    expect(absentAgeKeySeam.calls).toEqual([["security", "find-generic-password", "-a", "mattstack", "-s", "mattstack-age-key", "-w"]]);
  });

  describe("refusing to remove the operator's own key", () => {
    test("a roster entry that carries the owner's OWN key (e.g. from a poisoned echo, or hand-edited data) refuses removal outright — no revoke, no roster write, no recipient change", async () => {
      const remote = "git@github.com:acme/widgets.git";
      const p = fakeProbes({ home: HOME, files: { [join(HOME, ".mattstack", "teams", SLUG, ".git", "config")]: gitConfigWithRemote(remote) } });
      const { secrets } = seamsWithClone();
      writeTeamRecipients(SLUG, [OWNER_PUBLIC_KEY, ALICE_PUBLIC_KEY], secrets);
      const revokeCalls: unknown[] = [];
      const { seams, writes } = fakeMembersSeams({
        // Simulates the roster having already recorded the owner's key under "alice" — the exact end state the echo attack (defense i) exists to prevent, tested here in isolation so defense ii is proven to hold even if defense i were bypassed.
        readTeamStore: () => ({ "board.members": [{ username: "alice", agePublicKey: OWNER_PUBLIC_KEY }] }),
        readTeamLocal: () => ({ createdByRt: true, rtMayManageMembership: true }),
        revokeRead: async (...args) => {
          revokeCalls.push(args);
          return { access: "revoked", manualSteps: [] };
        },
      });

      await expect(membersRemove(p, secrets, SLUG, "alice", undefined, seams)).rejects.toThrow(UserActionableError);

      expect(revokeCalls).toEqual([]); // refused before forge revoke ever ran
      expect(writes).toEqual([]); // refused before the roster was touched
      expect(readTeamRecipients(SLUG, secrets)).toEqual([OWNER_PUBLIC_KEY, ALICE_PUBLIC_KEY]); // untouched
    });

    test("carries the own-key-removal-refused code", async () => {
      const p = fakeProbes({ home: HOME });
      const { secrets } = seamsWithClone();
      writeTeamRecipients(SLUG, [OWNER_PUBLIC_KEY], secrets);
      const { seams } = fakeMembersSeams({ readTeamStore: () => ({ "board.members": [{ username: "alice", agePublicKey: OWNER_PUBLIC_KEY }] }) });

      let caught: unknown;
      try {
        await membersRemove(p, secrets, SLUG, "alice", undefined, seams);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(UserActionableError);
      expect((caught as UserActionableError).code).toBe("own-key-removal-refused");
    });

    test("also refuses an explicit --key matching the owner's own key, not just a roster-recorded one", async () => {
      const p = fakeProbes({ home: HOME });
      const { secrets } = seamsWithClone();
      writeTeamRecipients(SLUG, [OWNER_PUBLIC_KEY], secrets);
      const { seams } = fakeMembersSeams({ readTeamStore: () => ({ "board.members": [] }) });

      await expect(membersRemove(p, secrets, SLUG, "whoever", OWNER_PUBLIC_KEY, seams)).rejects.toThrow(UserActionableError);
      expect(readTeamRecipients(SLUG, secrets)).toEqual([OWNER_PUBLIC_KEY]);
    });

    test("full attack sequence: an echoed owner key is rejected at sync time, so the later routine remove is a safe no-op and the owner stays a recipient throughout", async () => {
      const remote = "git@github.com:acme/widgets.git";
      const p = fakeProbes({ home: HOME, files: { [join(HOME, ".mattstack", "teams", SLUG, ".git", "config")]: gitConfigWithRemote(remote) } });
      const { secrets } = seamsWithClone();
      upsertInviteRecord(p, SLUG, "alice", aliceRecord());
      const { seams } = fakeMembersSeams();
      const echoBlob = await replyBlob(OWNER_PUBLIC_KEY, "alice"); // alice's reply echoes the owner's public key

      // 1. echo → sync: defense (i) catches it, alice stays pending, nothing poisoned.
      const syncResult = await membersSync(p, fakeRelay({ readReply: async () => ({ blob: echoBlob }) }), secrets, SLUG, seams);
      expect(syncResult.pending).toEqual(["alice"]);
      expect(readTeamRecipients(SLUG, secrets)).toEqual([OWNER_PUBLIC_KEY]);

      // 2. remove: alice was never actually assigned a key, so removal is a genuine no-op — never touches the owner's recipient entry.
      const removeResult = await membersRemove(p, secrets, SLUG, "alice", undefined, seams);
      expect(removeResult.reencrypted).toEqual([]);

      // 3. owner still a recipient throughout.
      expect(readTeamRecipients(SLUG, secrets)).toContain(OWNER_PUBLIC_KEY);
    });
  });
});
