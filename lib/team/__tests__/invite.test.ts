import { describe, test, expect } from "bun:test";
import { fakeProbes } from "../../setup/__tests__/fakes.ts";
import { UserActionableError } from "../../setup/errors.ts";
import type { SettingsReader } from "../../setup/team-settings.ts";
import { decodeCode, open } from "../invite-crypto.ts";
import { readInviteRecords } from "../invite-records.ts";
import { INVITE_TTL_DAYS, mintInvite, pasteBlock, type MintInviteSeams } from "../invite.ts";
import type { RelayClient } from "../relay-client.ts";
import type { setSetting } from "../../settings/write.ts";

const SLUG = "acme";
const NOW = new Date("2026-08-22T00:00:00.000Z");

function gitConfigWithRemote(remote: string): string {
  return `[remote "origin"]\n\turl = ${remote}\n`;
}

function fakeRead(values: Record<string, unknown>): SettingsReader {
  return <T>(key: string): T | undefined => values[key] as T | undefined;
}

interface WriteSettingCall {
  key: string;
  value: unknown;
  scope: string;
  opts: unknown;
}

function writeSettingSpy(): { spy: typeof setSetting; calls: WriteSettingCall[] } {
  const calls: WriteSettingCall[] = [];
  const spy = ((key: string, value: unknown, scope: string, opts?: unknown) => {
    calls.push({ key, value, scope, opts });
  }) as typeof setSetting;
  return { spy, calls };
}

interface FakeRelay {
  client: RelayClient;
  createCalls: Array<{ ciphertext: string; expiresAt: string; id?: string }>;
  deleteCalls: Array<{ id: string; creatorSecret: string }>;
}

function fakeRelayClient(opts: { createId?: (requestedId: string | undefined) => string } = {}): FakeRelay {
  const createCalls: FakeRelay["createCalls"] = [];
  const deleteCalls: FakeRelay["deleteCalls"] = [];
  let secretCounter = 0;

  const client: RelayClient = {
    async create(ciphertext, expiresAt, id) {
      createCalls.push({ ciphertext, expiresAt, id });
      secretCounter++;
      const assignedId = opts.createId ? opts.createId(id) : (id ?? "0".repeat(32));
      return { id: assignedId, creatorSecret: `creator-secret-${secretCounter}` };
    },
    async fetch() {
      throw new Error("fetch not used by mintInvite");
    },
    async redeem() {
      throw new Error("redeem not used by mintInvite");
    },
    async reply() {
      throw new Error("reply not used by mintInvite");
    },
    async readReply() {
      throw new Error("readReply not used by mintInvite");
    },
    async delete(id, creatorSecret) {
      deleteCalls.push({ id, creatorSecret });
    },
  };

  return { client, createCalls, deleteCalls };
}

function baseSeams(overrides: Partial<MintInviteSeams> = {}): { seams: MintInviteSeams; writeCalls: WriteSettingCall[] } {
  const { spy, calls } = writeSettingSpy();
  const seams: MintInviteSeams = {
    read: fakeRead({
      "mattstack.integrations": { forge: { host: "github.com", provider: "github" } },
      "board.title": "Acme Team",
      "board.members": [],
    }),
    writeSetting: spy,
    grantRead: async () => ({ access: "granted", manualSteps: [] }),
    forgeLogin: async () => "octocat",
    ...overrides,
  };
  return { seams, writeCalls: calls };
}

describe("pasteBlock", () => {
  test("contains the join deep link and the raw code", () => {
    const block = pasteBlock("ABCDE-FGHIJ");
    expect(block).toContain("mattstack://join/ABCDE-FGHIJ");
    expect(block).toContain("Invite code:\nABCDE-FGHIJ");
    expect(block).toContain("https://github.com/m4ttstack/rt/releases/latest");
  });

  test("honors a custom download URL", () => {
    const block = pasteBlock("CODE", "https://example.test/download");
    expect(block).toContain("https://example.test/download");
  });
});

describe("mintInvite", () => {
  test("throws no-team-remote when the team has no git remote configured", async () => {
    const p = fakeProbes({ home: "/home" });
    const { seams } = baseSeams();
    const relay = fakeRelayClient();

    await expect(mintInvite(p, relay.client, { slug: SLUG, handle: "zaphod", now: NOW }, seams)).rejects.toThrow(UserActionableError);
  });

  test("posts only ciphertext to the relay — the remote, host, and team plaintext never appear in the request", async () => {
    const remote = "git@github.com:acme-corp/secret-repo-name.git";
    const p = fakeProbes({
      home: "/home",
      files: { "/home/.mattstack/teams/acme/.git/config": gitConfigWithRemote(remote) },
    });
    const { seams } = baseSeams();
    const relay = fakeRelayClient();

    await mintInvite(p, relay.client, { slug: SLUG, handle: "zaphod", now: NOW }, seams);

    expect(relay.createCalls).toHaveLength(1);
    const body = relay.createCalls[0]!.ciphertext;
    expect(body).not.toContain("github.com");
    expect(body).not.toContain("acme-corp");
    expect(body).not.toContain("secret-repo-name");
    expect(body).not.toContain(SLUG);
    // base64 alphabet only — never raw JSON leaking through unsealed.
    expect(body).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  test("expiresAt is now + 7 days, ISO", async () => {
    const remote = "git@github.com:acme/widgets.git";
    const p = fakeProbes({
      home: "/home",
      files: { "/home/.mattstack/teams/acme/.git/config": gitConfigWithRemote(remote) },
    });
    const { seams } = baseSeams();
    const relay = fakeRelayClient();

    const result = await mintInvite(p, relay.client, { slug: SLUG, handle: "zaphod", now: NOW }, seams);

    const expected = new Date(NOW.getTime() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
    expect(result.expiresAt).toBe(expected);
    expect(relay.createCalls[0]!.expiresAt).toBe(expected);
  });

  test("appends the handle to board.members via the writeSetting seam, unless already present", async () => {
    const remote = "git@github.com:acme/widgets.git";
    const p = fakeProbes({
      home: "/home",
      files: { "/home/.mattstack/teams/acme/.git/config": gitConfigWithRemote(remote) },
    });
    const { seams, writeCalls } = baseSeams();
    const relay = fakeRelayClient();

    await mintInvite(p, relay.client, { slug: SLUG, handle: "zaphod", now: NOW }, seams);

    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0]).toEqual({
      key: "board.members",
      value: [{ username: "zaphod" }],
      scope: "team",
      opts: { team: SLUG },
    });
  });

  test("does not re-add a handle already on the roster", async () => {
    const remote = "git@github.com:acme/widgets.git";
    const p = fakeProbes({
      home: "/home",
      files: { "/home/.mattstack/teams/acme/.git/config": gitConfigWithRemote(remote) },
    });
    const { seams, writeCalls } = baseSeams({
      read: fakeRead({
        "mattstack.integrations": { forge: { host: "github.com", provider: "github" } },
        "board.title": "Acme Team",
        "board.members": [{ username: "zaphod" }],
      }),
    });
    const relay = fakeRelayClient();

    await mintInvite(p, relay.client, { slug: SLUG, handle: "zaphod", now: NOW }, seams);

    expect(writeCalls).toHaveLength(0);
  });

  test("replace-on-mint: deletes the prior relay record for the same handle", async () => {
    const remote = "git@github.com:acme/widgets.git";
    const p = fakeProbes({
      home: "/home",
      files: {
        "/home/.mattstack/teams/acme/.git/config": gitConfigWithRemote(remote),
        "/home/.mattstack/rt/invites/acme.json": JSON.stringify({
          zaphod: { id: "1".repeat(32), creatorSecret: "old-secret", keyB64: "a2V5", expiresAt: "2030-01-01T00:00:00.000Z" },
        }),
      },
    });
    const { seams } = baseSeams();
    const relay = fakeRelayClient();

    await mintInvite(p, relay.client, { slug: SLUG, handle: "zaphod", now: NOW }, seams);

    expect(relay.deleteCalls).toEqual([{ id: "1".repeat(32), creatorSecret: "old-secret" }]);
  });

  test("the returned code decodes back to the relay-assigned id and opens the sealed pointer", async () => {
    const remote = "git@github.com:acme/widgets.git";
    const p = fakeProbes({
      home: "/home",
      files: { "/home/.mattstack/teams/acme/.git/config": gitConfigWithRemote(remote) },
    });
    const { seams } = baseSeams();
    const relay = fakeRelayClient();

    const result = await mintInvite(p, relay.client, { slug: SLUG, handle: "zaphod", now: NOW }, seams);

    const { idHex, key } = decodeCode(result.code);
    expect(idHex).toBe(relay.createCalls[0]!.id!);

    const pointer = await open(relay.createCalls[0]!.ciphertext, key, idHex);
    expect(pointer).toEqual({
      v: 1,
      team: SLUG,
      name: "Acme Team",
      remote,
      owner: "octocat",
      forge: "github.com",
      createdAt: NOW.toISOString(),
    });

    expect(result.pasteBlock).toContain("mattstack://join/");
  });

  test("falls back to the slug as the pointer name when board.title is unset", async () => {
    const remote = "git@github.com:acme/widgets.git";
    const p = fakeProbes({
      home: "/home",
      files: { "/home/.mattstack/teams/acme/.git/config": gitConfigWithRemote(remote) },
    });
    const { seams } = baseSeams({
      read: fakeRead({ "mattstack.integrations": { forge: { host: "github.com", provider: "github" } }, "board.members": [] }),
    });
    const relay = fakeRelayClient();

    const result = await mintInvite(p, relay.client, { slug: SLUG, handle: "zaphod", now: NOW }, seams);

    const { idHex, key } = decodeCode(result.code);
    const pointer = await open(relay.createCalls[0]!.ciphertext, key, idHex);
    expect(pointer.name).toBe(SLUG);
  });

  test("falls back to p.env.USER as owner when no forge login is available", async () => {
    const remote = "git@github.com:acme/widgets.git";
    const p = fakeProbes({
      home: "/home",
      env: { USER: "localuser" },
      files: { "/home/.mattstack/teams/acme/.git/config": gitConfigWithRemote(remote) },
    });
    const { seams } = baseSeams({ read: fakeRead({ "board.title": "Acme Team", "board.members": [] }), forgeLogin: async () => null });
    const relay = fakeRelayClient();

    const result = await mintInvite(p, relay.client, { slug: SLUG, handle: "zaphod", now: NOW }, seams);

    const { idHex, key } = decodeCode(result.code);
    const pointer = await open(relay.createCalls[0]!.ciphertext, key, idHex);
    expect(pointer.owner).toBe("localuser");
  });

  test("surfaces forgeAccess and manualSteps from the grantRead seam", async () => {
    const remote = "git@github.com:acme/widgets.git";
    const p = fakeProbes({
      home: "/home",
      files: { "/home/.mattstack/teams/acme/.git/config": gitConfigWithRemote(remote) },
    });
    const { seams } = baseSeams({
      grantRead: async () => ({ access: "manual", manualSteps: ["Open https://github.com/acme/widgets/settings/access", "Invite zaphod with Read"] }),
    });
    const relay = fakeRelayClient();

    const result = await mintInvite(p, relay.client, { slug: SLUG, handle: "zaphod", now: NOW }, seams);

    expect(result.forgeAccess).toBe("manual");
    expect(result.manualSteps).toEqual(["Open https://github.com/acme/widgets/settings/access", "Invite zaphod with Read"]);
  });

  test("persists the mint record for later revoke/replace, 0600", async () => {
    const remote = "git@github.com:acme/widgets.git";
    const p = fakeProbes({
      home: "/home",
      files: { "/home/.mattstack/teams/acme/.git/config": gitConfigWithRemote(remote) },
    });
    const { seams } = baseSeams();
    const relay = fakeRelayClient();

    const result = await mintInvite(p, relay.client, { slug: SLUG, handle: "zaphod", now: NOW }, seams);

    const records = readInviteRecords(p, SLUG);
    expect(records.zaphod?.id).toBe(relay.createCalls[0]!.id);
    expect(records.zaphod?.expiresAt).toBe(result.expiresAt);
    expect(p.calls.modes["/home/.mattstack/rt/invites/acme.json"]).toBe(0o600);
  });

  test("throws relay-id-mismatch if the relay does not honor the requested invite id", async () => {
    const remote = "git@github.com:acme/widgets.git";
    const p = fakeProbes({
      home: "/home",
      files: { "/home/.mattstack/teams/acme/.git/config": gitConfigWithRemote(remote) },
    });
    const { seams } = baseSeams();
    const relay = fakeRelayClient({ createId: () => "f".repeat(32) });

    await expect(mintInvite(p, relay.client, { slug: SLUG, handle: "zaphod", now: NOW }, seams)).rejects.toThrow(UserActionableError);
  });
});
