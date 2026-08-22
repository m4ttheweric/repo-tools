import { describe, test, expect } from "bun:test";
import { join } from "path";
import { fakeProbes } from "../../setup/__tests__/fakes.ts";
import type { AgeExecResult, AgeKeySeam } from "../../home/age-key.ts";
import { readTeamRecipients, teamSecretsFile } from "../../secrets/team-store.ts";
import type { SecretsExecResult, SecretsExecSeam, SecretsSeams } from "../../secrets/store.ts";
import { teamsDir } from "../../rt-paths.ts";
import { seal, sealReply } from "../invite-crypto.ts";
import { upsertInviteRecord, type InviteRecord } from "../invite-records.ts";
import { membersRemove, membersSync, type MembersSeams } from "../members.ts";
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

/** Mirrors lib/secrets/__tests__/team-store.test.ts's own fake — a minimal round-trippable-plaintext sops/age stand-in, local to this file since that one isn't exported. */
class FakeTeamExecSeam implements SecretsExecSeam {
  calls: { cmd: string[]; opts?: { env?: Record<string, string>; sensitive?: boolean } }[] = [];
  files = new Map<string, string>();
  private mtimeCounter = 0;
  private stats = new Map<string, { mtimeMs: number; size: number }>();
  private roundTrippablePlaintext = new Map<string, string>();

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
      return { code: 0, stdout: "", stderr: "" };
    }

    throw new Error(`FakeTeamExecSeam: unexpected call ${cmd.join(" ")}`);
  }
}

function seamsWithClone(slug = SLUG): { execSeam: FakeTeamExecSeam; secrets: SecretsSeams } {
  const execSeam = new FakeTeamExecSeam();
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

describe("membersSync", () => {
  test("a record whose reply exists gets added, sops updatekeys runs, and the invite record is removed", async () => {
    const p = fakeProbes({ home: HOME });
    upsertInviteRecord(p, SLUG, "alice", aliceRecord());
    const { execSeam, secrets } = seamsWithClone();
    execSeam.writeFile(teamSecretsFile(SLUG, "board"), JSON.stringify({ data: "opaque", sops: {} }));
    const { seams, writes } = fakeMembersSeams();
    const blob = await sealReply({ v: 1, agePublicKey: ALICE_PUBLIC_KEY, handle: "alice" }, KEY, ID_HEX);
    const relay = fakeRelay({ readReply: async () => ({ blob }) });

    const result = await membersSync(p, relay, secrets, SLUG, seams);

    expect(result.added).toEqual([ALICE_PUBLIC_KEY]);
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

  test("no reply yet -> the handle is reported pending, the invite record stays", async () => {
    const p = fakeProbes({ home: HOME });
    upsertInviteRecord(p, SLUG, "alice", aliceRecord());
    const { secrets } = seamsWithClone();
    const { seams } = fakeMembersSeams();
    const relay = fakeRelay(); // readReply -> "none"

    const result = await membersSync(p, relay, secrets, SLUG, seams);

    expect(result.added).toEqual([]);
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
    const blob = await sealReply({ v: 1, agePublicKey: "not-an-age-key\nage: age1attacker", handle: "alice" }, KEY, ID_HEX);
    const relay = fakeRelay({ readReply: async () => ({ blob }) });

    const result = await membersSync(p, relay, secrets, SLUG, seams);

    expect(result.added).toEqual([]);
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

    expect(result.added).toEqual([]);
    expect(result.pending).toEqual(["alice"]);
  });

  test("reencrypted lists every file touched across the owner-ensure call and every added invite, deduped", async () => {
    const p = fakeProbes({ home: HOME });
    upsertInviteRecord(p, SLUG, "alice", aliceRecord());
    const { execSeam, secrets } = seamsWithClone();
    const { seams } = fakeMembersSeams();
    execSeam.writeFile(teamSecretsFile(SLUG, "board"), JSON.stringify({ data: "opaque", sops: {} }));
    const blob = await sealReply({ v: 1, agePublicKey: ALICE_PUBLIC_KEY }, KEY, ID_HEX);
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
});

describe("membersRemove", () => {
  function gitConfigWithRemote(remote: string): string {
    return `[remote "origin"]\n\turl = ${remote}\n`;
  }

  test("revokes forge access, writes the roster without the handle, re-encrypts, and returns a non-empty residue note", async () => {
    const remote = "git@github.com:acme/widgets.git";
    const p = fakeProbes({ home: HOME, files: { [join(HOME, ".mattstack", "teams", SLUG, ".git", "config")]: gitConfigWithRemote(remote) } });
    const { execSeam, secrets } = seamsWithClone();
    // alice is already a recipient (as if membersSync had run for her already), with a real domain file to re-encrypt.
    const { writeTeamRecipients } = await import("../../secrets/team-store.ts");
    writeTeamRecipients(SLUG, [OWNER_PUBLIC_KEY, ALICE_PUBLIC_KEY], secrets);
    execSeam.writeFile(teamSecretsFile(SLUG, "board"), JSON.stringify({ data: "opaque", sops: {} }));

    const revokeCalls: { remote: string; handle: string }[] = [];
    const { seams, writes } = fakeMembersSeams({
      readTeamStore: () => ({ "board.members": [{ username: "matt" }, { username: "alice", agePublicKey: ALICE_PUBLIC_KEY }] }),
      revokeRead: async (_p, r, h) => {
        revokeCalls.push({ remote: r, handle: h });
        return { access: "revoked", manualSteps: [] };
      },
    });

    const result = await membersRemove(p, secrets, SLUG, "alice", undefined, seams);

    expect(revokeCalls).toEqual([{ remote, handle: "alice" }]);
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
    const { writeTeamRecipients } = await import("../../secrets/team-store.ts");
    writeTeamRecipients(SLUG, [OWNER_PUBLIC_KEY, ALICE_PUBLIC_KEY], secrets);
    const { seams } = fakeMembersSeams({ readTeamStore: () => ({ "board.members": [] }) });

    const result = await membersRemove(p, secrets, SLUG, "alice", ALICE_PUBLIC_KEY, seams);

    expect(readTeamRecipients(SLUG, secrets)).toEqual([OWNER_PUBLIC_KEY]);
    expect(result.rosterRemoved).toBe(false); // no roster entry to remove, but the recipient still comes out
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
});
