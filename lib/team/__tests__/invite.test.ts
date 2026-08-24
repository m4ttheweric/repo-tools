import { describe, test, expect } from "bun:test";
import { fakeProbes } from "../../setup/__tests__/fakes.ts";
import { UserActionableError } from "../../setup/errors.ts";
import type { Probes } from "../../setup/probes.ts";
import type { SettingsReader } from "../../setup/team-settings.ts";
import { decodeCode, open } from "../invite-crypto.ts";
import { readInviteRecords } from "../invite-records.ts";
import { INVITE_TTL_DAYS, mintInvite, pasteBlock, type MintInviteSeams } from "../invite.ts";
import type { RelayClient } from "../relay-client.ts";
import type { setSetting } from "../../settings/write.ts";

const SLUG = "acme";
const NOW = new Date("2026-08-22T00:00:00.000Z");
const HOME = "/home";
const GIT_CONFIG_PATH = "/home/.mattstack/teams/acme/.git/config";

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

/** Wraps a fakeProbes instance so `writeFile` throws for a chosen path — simulates a malformed/unwritable settings or records store without a dedicated fakeProbes knob. */
function withThrowingWrite(p: Probes, pathSubstring: string, message: string): Probes {
  return {
    ...p,
    writeFile(path, content, mode) {
      if (path.includes(pathSubstring)) throw new Error(message);
      p.writeFile(path, content, mode);
    },
  };
}

interface FakeRelay {
  client: RelayClient;
  createCalls: Array<{ ciphertext: string; expiresAt: string; id?: string }>;
  createReturns: Array<{ id: string; creatorSecret: string }>;
  deleteCalls: Array<{ id: string; creatorSecret: string }>;
  callOrder: string[];
}

function fakeRelayClient(opts: { createId?: (requestedId: string | undefined) => string; onDelete?: (id: string, creatorSecret: string) => void } = {}): FakeRelay {
  const createCalls: FakeRelay["createCalls"] = [];
  const createReturns: FakeRelay["createReturns"] = [];
  const deleteCalls: FakeRelay["deleteCalls"] = [];
  const callOrder: string[] = [];
  let secretCounter = 0;

  const client: RelayClient = {
    async create(ciphertext, expiresAt, id) {
      callOrder.push("create");
      createCalls.push({ ciphertext, expiresAt, id });
      secretCounter++;
      const assignedId = opts.createId ? opts.createId(id) : (id ?? "0".repeat(32));
      const result = { id: assignedId, creatorSecret: `creator-secret-${secretCounter}` };
      createReturns.push(result);
      return result;
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
      callOrder.push("delete");
      deleteCalls.push({ id, creatorSecret });
      opts.onDelete?.(id, creatorSecret);
    },
  };

  return { client, createCalls, createReturns, deleteCalls, callOrder };
}

function baseSeams(overrides: Partial<MintInviteSeams> = {}): { seams: MintInviteSeams; writeCalls: WriteSettingCall[]; warnings: string[] } {
  const { spy, calls } = writeSettingSpy();
  const warnings: string[] = [];
  const seams: MintInviteSeams = {
    read: fakeRead({
      "mattstack.integrations": { forge: { host: "github.com", provider: "github" } },
      "board.title": "Acme Team",
    }),
    readTeamStore: () => ({ "board.members": [] }),
    writeSetting: spy,
    grantRead: async () => ({ access: "granted", manualSteps: [] }),
    // Default ON so the existing suite keeps exercising the grant path it was
    // written for; the tests below cover the default-off behaviour explicitly.
    readTeamLocal: () => ({ createdByRt: true, rtMayManageMembership: true }),
    forgeLogin: async () => "octocat",
    warn: (m) => warnings.push(m),
    ...overrides,
  };
  return { seams, writeCalls: calls, warnings };
}

function probesWithRemote(remote: string, extraFiles: Record<string, string> = {}): ReturnType<typeof fakeProbes> {
  return fakeProbes({ home: HOME, files: { [GIT_CONFIG_PATH]: gitConfigWithRemote(remote), ...extraFiles } });
}

const REMOTE = "git@github.com:acme/widgets.git";

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
  test("rejects a handle outside the forge-username charset before touching anything", async () => {
    const p = fakeProbes({ home: HOME });
    const { seams } = baseSeams();
    const relay = fakeRelayClient();

    await expect(mintInvite(p, relay.client, { slug: SLUG, handle: "bad handle!", now: NOW }, seams)).rejects.toThrow(UserActionableError);
    expect(relay.createCalls).toHaveLength(0);
  });

  test("throws no-team-remote when the team has no git remote configured", async () => {
    const p = fakeProbes({ home: HOME });
    const { seams } = baseSeams();
    const relay = fakeRelayClient();

    await expect(mintInvite(p, relay.client, { slug: SLUG, handle: "zaphod", now: NOW }, seams)).rejects.toThrow(UserActionableError);
  });

  test("posts only ciphertext to the relay — the pointer's plaintext AND the code's key never appear in the request", async () => {
    const remote = "git@github.com:acme-corp/secret-repo-name.git";
    const p = probesWithRemote(remote);
    const { seams } = baseSeams();
    const relay = fakeRelayClient();

    const result = await mintInvite(p, relay.client, { slug: SLUG, handle: "zaphod", now: NOW }, seams);

    expect(relay.createCalls).toHaveLength(1);
    const body = relay.createCalls[0]!.ciphertext;
    expect(body).not.toContain("github.com");
    expect(body).not.toContain("acme-corp");
    expect(body).not.toContain("secret-repo-name");
    expect(body).not.toContain(SLUG);

    const { key } = decodeCode(result.code);
    expect(body).not.toContain(Buffer.from(key).toString("base64"));
    expect(body).not.toContain(Buffer.from(key).toString("hex"));

    // base64 alphabet only — never raw JSON leaking through unsealed.
    expect(body).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  test("expiresAt is now + 7 days, ISO", async () => {
    const p = probesWithRemote(REMOTE);
    const { seams } = baseSeams();
    const relay = fakeRelayClient();

    const result = await mintInvite(p, relay.client, { slug: SLUG, handle: "zaphod", now: NOW }, seams);

    const expected = new Date(NOW.getTime() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
    expect(result.expiresAt).toBe(expected);
    expect(relay.createCalls[0]!.expiresAt).toBe(expected);
  });

  test("appends the handle to board.members via the writeSetting seam, unless already present", async () => {
    const p = probesWithRemote(REMOTE);
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

  test("does not re-add a handle already on the team's own roster", async () => {
    const p = probesWithRemote(REMOTE);
    const { seams, writeCalls } = baseSeams({ readTeamStore: () => ({ "board.members": [{ username: "zaphod" }] }) });
    const relay = fakeRelayClient();

    await mintInvite(p, relay.client, { slug: SLUG, handle: "zaphod", now: NOW }, seams);

    expect(writeCalls).toHaveLength(0);
  });

  test("addToRoster consults the team's OWN store, not the multi-team overlay `read` exposes", async () => {
    const p = probesWithRemote(REMOTE);
    // The overlay (`read`) claims zaphod is already on some team's roster; this team's own store says otherwise.
    const { seams, writeCalls } = baseSeams({
      read: fakeRead({
        "mattstack.integrations": { forge: { host: "github.com", provider: "github" } },
        "board.title": "Acme Team",
        "board.members": [{ username: "zaphod" }],
      }),
      readTeamStore: () => ({ "board.members": [] }),
    });
    const relay = fakeRelayClient();

    await mintInvite(p, relay.client, { slug: SLUG, handle: "zaphod", now: NOW }, seams);

    expect(writeCalls).toHaveLength(1);
  });

  test("replace-on-mint creates the new invite before revoking the old one; a failed old-delete does not wedge the mint", async () => {
    const p = probesWithRemote(REMOTE, {
      "/home/.mattstack/rt/invites/acme.json": JSON.stringify({
        zaphod: { id: "1".repeat(32), creatorSecret: "old-secret", keyB64: "a2V5", expiresAt: "2030-01-01T00:00:00.000Z" },
      }),
    });
    const { seams, warnings } = baseSeams();
    const relay = fakeRelayClient({
      onDelete: () => {
        throw new UserActionableError("relay-error", "403 forbidden");
      },
    });

    const result = await mintInvite(p, relay.client, { slug: SLUG, handle: "zaphod", now: NOW }, seams);

    expect(result.code).toBeTruthy();
    expect(relay.callOrder).toEqual(["create", "delete"]);
    expect(relay.deleteCalls).toEqual([{ id: "1".repeat(32), creatorSecret: "old-secret" }]);
    expect(warnings.some((w) => w.includes("could not revoke the previous"))).toBe(true);
  });

  test("the returned code decodes back to the relay-assigned id and opens the sealed pointer", async () => {
    const p = probesWithRemote(REMOTE);
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
      remote: REMOTE,
      owner: "octocat",
      forge: "github.com",
      createdAt: NOW.toISOString(),
    });

    expect(result.pasteBlock).toContain("mattstack://join/");
  });

  test("falls back to the slug as the pointer name when board.title is unset", async () => {
    const p = probesWithRemote(REMOTE);
    const { seams } = baseSeams({
      read: fakeRead({ "mattstack.integrations": { forge: { host: "github.com", provider: "github" } } }),
    });
    const relay = fakeRelayClient();

    const result = await mintInvite(p, relay.client, { slug: SLUG, handle: "zaphod", now: NOW }, seams);

    const { idHex, key } = decodeCode(result.code);
    const pointer = await open(relay.createCalls[0]!.ciphertext, key, idHex);
    expect(pointer.name).toBe(SLUG);
  });

  test("derives forge host/provider from the remote when mattstack.integrations is unset", async () => {
    const p = probesWithRemote(REMOTE);
    const { seams } = baseSeams({ read: fakeRead({ "board.title": "Acme Team" }) });
    const relay = fakeRelayClient();

    const result = await mintInvite(p, relay.client, { slug: SLUG, handle: "zaphod", now: NOW }, seams);

    const { idHex, key } = decodeCode(result.code);
    const pointer = await open(relay.createCalls[0]!.ciphertext, key, idHex);
    expect(pointer.forge).toBe("github.com");
  });

  test("falls back to p.env.USER as owner when no forge login is available", async () => {
    const p = fakeProbes({ home: HOME, env: { USER: "localuser" }, files: { [GIT_CONFIG_PATH]: gitConfigWithRemote(REMOTE) } });
    const { seams } = baseSeams({ read: fakeRead({ "board.title": "Acme Team" }), forgeLogin: async () => null });
    const relay = fakeRelayClient();

    const result = await mintInvite(p, relay.client, { slug: SLUG, handle: "zaphod", now: NOW }, seams);

    const { idHex, key } = decodeCode(result.code);
    const pointer = await open(relay.createCalls[0]!.ciphertext, key, idHex);
    expect(pointer.owner).toBe("localuser");
  });

  test("surfaces forgeAccess and manualSteps from the grantRead seam", async () => {
    const p = probesWithRemote(REMOTE);
    const { seams } = baseSeams({
      grantRead: async () => ({ access: "manual", manualSteps: ["Open https://github.com/acme/widgets/settings/access", "Invite zaphod with Read"] }),
    });
    const relay = fakeRelayClient();

    const result = await mintInvite(p, relay.client, { slug: SLUG, handle: "zaphod", now: NOW }, seams);

    expect(result.forgeAccess).toBe("manual");
    expect(result.manualSteps).toEqual(["Open https://github.com/acme/widgets/settings/access", "Invite zaphod with Read"]);
  });

  test("persists the mint record for later revoke/replace, 0600, BEFORE grantRead/addToRoster run", async () => {
    const p = probesWithRemote(REMOTE);
    const order: string[] = [];
    const { seams } = baseSeams({
      grantRead: async (probe, remote, handle) => {
        const records = readInviteRecords(probe, SLUG);
        expect(records[handle]).toBeDefined();
        order.push("grantRead-saw-record");
        return { access: "granted", manualSteps: [] };
      },
    });
    const relay = fakeRelayClient();

    const result = await mintInvite(p, relay.client, { slug: SLUG, handle: "zaphod", now: NOW }, seams);

    expect(order).toEqual(["grantRead-saw-record"]);
    const records = readInviteRecords(p, SLUG);
    expect(records.zaphod?.id).toBe(relay.createCalls[0]!.id!);
    expect(records.zaphod?.expiresAt).toBe(result.expiresAt);
    expect(p.calls.modes["/home/.mattstack/rt/invites/acme.json"]).toBe(0o600);
  });

  test("a throwing roster write still leaves the mint record recoverable", async () => {
    const p = probesWithRemote(REMOTE);
    const { seams } = baseSeams({
      writeSetting: (() => {
        throw new Error("malformed team store");
      }) as typeof setSetting,
    });
    const relay = fakeRelayClient();

    await expect(mintInvite(p, relay.client, { slug: SLUG, handle: "zaphod", now: NOW }, seams)).rejects.toThrow();

    const records = readInviteRecords(p, SLUG);
    expect(records.zaphod?.id).toBe(relay.createReturns[0]!.id);
    expect(records.zaphod?.creatorSecret).toBe(relay.createReturns[0]!.creatorSecret);
  });

  test("a failing record write throws, naming the invite id and code so it is recoverable by hand", async () => {
    const p = withThrowingWrite(probesWithRemote(REMOTE), "/rt/invites/", "disk full");
    const { seams } = baseSeams();
    const relay = fakeRelayClient();

    let caught: unknown;
    try {
      await mintInvite(p, relay.client, { slug: SLUG, handle: "zaphod", now: NOW }, seams);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(UserActionableError);
    const err = caught as UserActionableError;
    expect(err.code).toBe("invite-record-write-failed");
    expect(err.message).toContain(relay.createReturns[0]!.id);
  });

  test("throws relay-id-mismatch if the relay does not honor the requested invite id", async () => {
    const p = probesWithRemote(REMOTE);
    const { seams } = baseSeams();
    const relay = fakeRelayClient({ createId: () => "f".repeat(32) });

    await expect(mintInvite(p, relay.client, { slug: SLUG, handle: "zaphod", now: NOW }, seams)).rejects.toThrow(UserActionableError);
  });
});

// ─── membership permission (MAT-387) ─────────────────────────────────────────

describe("mintInvite: forge membership is not rt's to grant", () => {
  test("default (permission absent): never calls the forge, and says who to ask", async () => {
    const grantCalls: string[] = [];
    const { seams } = baseSeams({
      readTeamLocal: () => ({ createdByRt: true, rtMayManageMembership: false }),
      grantRead: async (_p, _remote, handle) => {
        grantCalls.push(handle);
        return { access: "granted", manualSteps: [] };
      },
    });
    const relay = fakeRelayClient();

    const result = await mintInvite(probesWithRemote(REMOTE), relay.client, { slug: SLUG, handle: "alice", now: NOW }, seams);

    expect(grantCalls).toEqual([]);
    expect(result.forgeAccess).toBe("skipped");
    expect(result.manualSteps.join(" ")).toContain("Ask whoever administers");
    expect(result.manualSteps.join(" ")).toContain("alice");
  });

  // createdByRt alone must not be enough: provenance decides whether the
  // permission can be OFFERED, never whether it is held.
  test("createdByRt without the permission still does not touch the forge", async () => {
    const grantCalls: string[] = [];
    const { seams } = baseSeams({
      readTeamLocal: () => ({ createdByRt: true, rtMayManageMembership: false }),
      grantRead: async () => {
        grantCalls.push("called");
        return { access: "granted", manualSteps: [] };
      },
    });
    const relay = fakeRelayClient();
    await mintInvite(probesWithRemote(REMOTE), relay.client, { slug: SLUG, handle: "alice", now: NOW }, seams);
    expect(grantCalls).toEqual([]);
  });

  test("permission granted: the forge call happens, as before", async () => {
    const grantCalls: string[] = [];
    const { seams } = baseSeams({
      readTeamLocal: () => ({ createdByRt: true, rtMayManageMembership: true }),
      grantRead: async (_p, _remote, handle) => {
        grantCalls.push(handle);
        return { access: "granted", manualSteps: [] };
      },
    });
    const relay = fakeRelayClient();
    const result = await mintInvite(probesWithRemote(REMOTE), relay.client, { slug: SLUG, handle: "alice", now: NOW }, seams);
    expect(grantCalls).toEqual(["alice"]);
    expect(result.forgeAccess).toBe("granted");
  });

  // The invite must still be usable — declining to administer someone's repo
  // is not a failure to mint.
  test("the invite is still minted and returned when rt cannot grant", async () => {
    const { seams } = baseSeams({ readTeamLocal: () => ({ createdByRt: false, rtMayManageMembership: false }) });
    const relay = fakeRelayClient();
    const result = await mintInvite(probesWithRemote(REMOTE), relay.client, { slug: SLUG, handle: "alice", now: NOW }, seams);
    expect(relay.createCalls.length).toBe(1);
    expect(result.code.length).toBeGreaterThan(0);
  });
});
