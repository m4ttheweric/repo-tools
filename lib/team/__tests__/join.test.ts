import { describe, test, expect } from "bun:test";
import { join as pathJoin } from "path";
import { fakeProbes } from "../../setup/__tests__/fakes.ts";
import { UserActionableError } from "../../setup/errors.ts";
import { intentPath, type InvitePointer, type SetupIntent } from "../../setup/intent.ts";
import type { Probes } from "../../setup/probes.ts";
import type { SettingsReader } from "../../setup/team-settings.ts";
import { decodeCode, encodeCode, openReply, seal } from "../invite-crypto.ts";
import { joinDryRun, joinRedeem, type JoinRedeemSeams } from "../join.ts";
import type { RelayClient } from "../relay-client.ts";
import type { SecretsSeams } from "../../secrets/store.ts";
import type { AgeExecResult, AgeKeySeam } from "../../home/age-key.ts";

const HOME = "/home";
const ID_HEX = "0102030405060708090a0b0c0d0e0f10";
const KEY = new Uint8Array(32).fill(7);
const CODE = encodeCode(ID_HEX, KEY);
const REMOTE = "git@github.com:acme/widgets.git";
const TEAM_DIR = pathJoin(HOME, ".mattstack", "teams", "acme");

const POINTER: InvitePointer = {
  v: 1,
  team: "acme",
  name: "Acme",
  remote: REMOTE,
  owner: "matt",
  forge: "github.com",
  createdAt: "2026-08-01T00:00:00.000Z",
};

const NOW = new Date("2026-08-22T00:00:00.000Z");

function gitConfigWithRemote(remote: string): string {
  return `[remote "origin"]\n\turl = ${remote}\n`;
}

interface FakeRelayOpts {
  fetch?: RelayClient["fetch"];
  redeem?: RelayClient["redeem"];
}

interface FakeRelay {
  client: RelayClient;
  fetchCalls: string[];
  redeemCalls: string[];
  replyCalls: { id: string; blob: string }[];
  callOrder: string[];
}

function fakeRelay(opts: FakeRelayOpts = {}): FakeRelay {
  const fetchCalls: string[] = [];
  const redeemCalls: string[] = [];
  const replyCalls: FakeRelay["replyCalls"] = [];
  const callOrder: string[] = [];

  const client: RelayClient = {
    async create() {
      throw new Error("create not used by join");
    },
    async fetch(id) {
      fetchCalls.push(id);
      callOrder.push("fetch");
      if (opts.fetch) return opts.fetch(id);
      const ciphertext = await seal(POINTER, KEY, ID_HEX);
      return { ciphertext };
    },
    async redeem(id) {
      redeemCalls.push(id);
      callOrder.push("redeem");
      if (opts.redeem) return opts.redeem(id);
      return "redeemed";
    },
    async reply(id, blob) {
      replyCalls.push({ id, blob });
      callOrder.push("reply");
    },
    async readReply() {
      throw new Error("readReply not used by join");
    },
    async delete() {
      throw new Error("delete not used by join");
    },
  };

  return { client, fetchCalls, redeemCalls, replyCalls, callOrder };
}

function fakeRead(values: Record<string, unknown> = {}): SettingsReader {
  return <T>(key: string): T | undefined => values[key] as T | undefined;
}

const FAKE_PUBLIC_KEY = "age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";

function fakeAgeKeySeam(): AgeKeySeam {
  return {
    async run(cmd: string[]): Promise<AgeExecResult> {
      if (cmd[1] === "find-generic-password") return { code: 0, stdout: "AGE-SECRET-KEY-1QQQ\n", stderr: "" };
      if (cmd[0] === "age-keygen" && cmd[1] === "-y") return { code: 0, stdout: `${FAKE_PUBLIC_KEY}\n`, stderr: "" };
      throw new Error(`fakeAgeKeySeam: unexpected call ${cmd.join(" ")}`);
    },
  };
}

function baseJoinRedeemSeams(overrides: Partial<JoinRedeemSeams> = {}): { seams: JoinRedeemSeams; calls: { readTeamSecret: unknown[][]; forgeLogin: unknown[][] } } {
  const calls = { readTeamSecret: [] as unknown[][], forgeLogin: [] as unknown[][] };
  const seams: JoinRedeemSeams = {
    ageKeySeam: fakeAgeKeySeam(),
    read: fakeRead(),
    readTeamSecret: (async (...args: unknown[]) => {
      calls.readTeamSecret.push(args);
      return null;
    }) as JoinRedeemSeams["readTeamSecret"],
    forgeLogin: (async (...args: unknown[]) => {
      calls.forgeLogin.push(args);
      return "zaphod";
    }) as JoinRedeemSeams["forgeLogin"],
    warn: () => {},
    ...overrides,
  };
  return { seams, calls };
}

const NO_SECRETS: SecretsSeams = {} as SecretsSeams;

describe("joinDryRun", () => {
  test("happy path: access ok, writes the resumable intent, exact message", async () => {
    const p = fakeProbes({ home: HOME, now: NOW, exec: () => ({ code: 0, stdout: "", stderr: "" }) });
    const relay = fakeRelay();

    const result = await joinDryRun(p, relay.client, CODE);

    expect(result).toEqual({
      team: { slug: "acme", name: "Acme", owner: "matt" },
      access: "ok",
      peering: "idle",
      message: "Joining Acme (owner matt)",
    });

    const raw = p.calls.writes[intentPath(HOME)];
    expect(raw).toBeDefined();
    const intent = JSON.parse(raw!) as SetupIntent;
    expect(intent.mode).toBe("join");
    expect(intent.join?.id).toBe(ID_HEX);
    expect(intent.join?.keyB64).toBe(Buffer.from(KEY).toString("base64"));
    expect(intent.join?.pointer).toEqual(POINTER);
  });

  test("a malformed code never reaches the relay", async () => {
    const p = fakeProbes({ home: HOME });
    const relay = fakeRelay();

    await expect(joinDryRun(p, relay.client, "not-a-real-code")).rejects.toThrow(UserActionableError);
    expect(relay.fetchCalls).toHaveLength(0);
  });

  test("relay 'gone' throws invite-unknown, exact message", async () => {
    const p = fakeProbes({ home: HOME });
    const relay = fakeRelay({ fetch: async () => "gone" });

    let caught: unknown;
    try {
      await joinDryRun(p, relay.client, CODE);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UserActionableError);
    expect((caught as UserActionableError).code).toBe("invite-unknown");
    expect((caught as UserActionableError).message).toBe("invite not recognized or expired: ask the team owner for a new one");
  });

  test("an undecodable blob (wrong key/id) also maps to invite-unknown", async () => {
    const p = fakeProbes({ home: HOME });
    const relay = fakeRelay({
      fetch: async () => ({ ciphertext: await seal(POINTER, KEY, "f".repeat(32)) }), // sealed under a different AAD id
    });

    await expect(joinDryRun(p, relay.client, CODE)).rejects.toMatchObject({ code: "invite-unknown" });
  });

  test("relay-unreachable reports access:unreachable at exit 0 (no throw), empty team", async () => {
    const p = fakeProbes({ home: HOME });
    const relay = fakeRelay({
      fetch: async () => {
        throw new UserActionableError("relay-unreachable", "could not reach the invite relay");
      },
    });

    const result = await joinDryRun(p, relay.client, CODE);
    expect(result.access).toBe("unreachable");
    expect(result.team).toEqual({ slug: "", name: "", owner: "" });
    expect(result.peering).toBe("idle");
  });

  test("ls-remote auth failure: access denied, message has no URL and no raw git output", async () => {
    const p = fakeProbes({
      home: HOME,
      exec: () => ({ code: 128, stdout: "", stderr: "fatal: Authentication failed for 'https://github.com/acme/widgets.git/'" }),
    });
    const relay = fakeRelay();

    const result = await joinDryRun(p, relay.client, CODE);

    expect(result.access).toBe("denied");
    expect(result.message).toBe("you don't have access yet: ask matt to grant you access to Acme");
    expect(result.message).not.toContain("http");
    expect(result.message).not.toContain("fatal:");
  });

  test("ls-remote exit 2 (empty repo, no HEAD) still counts as access ok", async () => {
    const p = fakeProbes({ home: HOME, now: NOW, exec: () => ({ code: 2, stdout: "", stderr: "" }) });
    const relay = fakeRelay();

    const result = await joinDryRun(p, relay.client, CODE);
    expect(result.access).toBe("ok");
  });

  test("a non-auth git failure reports access:unreachable", async () => {
    const p = fakeProbes({ home: HOME, exec: () => ({ code: 128, stdout: "", stderr: "fatal: Could not resolve host: github.com" }) });
    const relay = fakeRelay();

    const result = await joinDryRun(p, relay.client, CODE);
    expect(result.access).toBe("unreachable");
  });

  test("uses GIT_TERMINAL_PROMPT=0 and --exit-code against the pointer's remote", async () => {
    const calls: { argv: string[]; opts?: Parameters<Probes["exec"]>[1] }[] = [];
    const p = fakeProbes({
      home: HOME,
      exec: (argv, opts) => {
        calls.push({ argv, opts });
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const relay = fakeRelay();

    await joinDryRun(p, relay.client, CODE);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.argv).toEqual(["git", "ls-remote", "--exit-code", REMOTE, "HEAD"]);
    expect(calls[0]!.opts?.env?.GIT_TERMINAL_PROMPT).toBe("0");
  });
});

describe("joinRedeem", () => {
  function redeemProbes(overrides: Parameters<typeof fakeProbes>[0] = {}): ReturnType<typeof fakeProbes> {
    return fakeProbes({ home: HOME, now: NOW, exec: () => ({ code: 0, stdout: "", stderr: "" }), ...overrides });
  }

  test("clones, redeems after the clone, and posts a reply blob the inviter can open", async () => {
    const p = redeemProbes();
    const relay = fakeRelay();
    const { seams } = baseJoinRedeemSeams();

    const result = await joinRedeem(p, relay.client, () => NO_SECRETS, { code: CODE }, seams);

    expect(result.access).toBe("ok");
    expect(p.calls.exec).toContainEqual(["git", "clone", REMOTE, TEAM_DIR]);
    expect(relay.callOrder).toEqual(["fetch", "redeem", "reply"]);
    expect(relay.redeemCalls).toEqual([ID_HEX]);

    expect(relay.replyCalls).toHaveLength(1);
    const reply = await openReply(relay.replyCalls[0]!.blob, KEY, ID_HEX);
    expect(reply.agePublicKey).toBe(FAKE_PUBLIC_KEY);
    expect(reply.handle).toBe("zaphod");
  });

  test("switchboard url + a readable admin token → peering applied, POSTs /peer/join with the joiner's forge login", async () => {
    const fetchCalls: { url: string; init?: Parameters<Probes["fetch"]>[1] }[] = [];
    const p = redeemProbes({
      fetch: async (url, init) => {
        fetchCalls.push({ url, init });
        return { status: 200, body: "", headers: {} };
      },
    });
    const relay = fakeRelay();
    const { seams } = baseJoinRedeemSeams({
      read: fakeRead({ "mattstack.integrations": { switchboard: { url: "https://sb.test" } } }),
      readTeamSecret: async () => "admin-token-xyz",
    });

    const result = await joinRedeem(p, relay.client, () => NO_SECRETS, { code: CODE }, seams);

    expect(result.peering).toBe("applied");
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe("https://sb.test/peer/join");
    expect(fetchCalls[0]!.init?.method).toBe("POST");
    expect(fetchCalls[0]!.init?.headers?.Authorization).toBe("Bearer admin-token-xyz");
    expect(JSON.parse(fetchCalls[0]!.init?.body ?? "{}")).toEqual({ member: "zaphod" });
  });

  test("no switchboard url → peering idle, no peer/join request", async () => {
    const p = redeemProbes();
    const relay = fakeRelay();
    const { seams } = baseJoinRedeemSeams();

    const result = await joinRedeem(p, relay.client, () => NO_SECRETS, { code: CODE }, seams);

    expect(result.peering).toBe("idle");
    expect(p.calls.fetch).toHaveLength(0);
  });

  test("switchboard url present but no readable admin token → peering idle, no request attempted", async () => {
    const p = redeemProbes();
    const relay = fakeRelay();
    const { seams } = baseJoinRedeemSeams({
      read: fakeRead({ "mattstack.integrations": { switchboard: { url: "https://sb.test" } } }),
      readTeamSecret: async () => null,
    });

    const result = await joinRedeem(p, relay.client, () => NO_SECRETS, { code: CODE }, seams);

    expect(result.peering).toBe("idle");
    expect(p.calls.fetch).toHaveLength(0);
  });

  test("a failed peer/join request reports peering:unavailable without failing the join", async () => {
    const p = redeemProbes({ fetch: async () => ({ status: 500, body: "", headers: {} }) });
    const relay = fakeRelay();
    const { seams } = baseJoinRedeemSeams({
      read: fakeRead({ "mattstack.integrations": { switchboard: { url: "https://sb.test" } } }),
      readTeamSecret: async () => "admin-token",
    });

    const result = await joinRedeem(p, relay.client, () => NO_SECRETS, { code: CODE }, seams);

    expect(result.peering).toBe("unavailable");
    expect(result.access).toBe("ok");
  });

  test("clone auth failure returns access:denied without ever calling relay.redeem", async () => {
    const p = redeemProbes({ exec: () => ({ code: 128, stdout: "", stderr: "fatal: Authentication failed" }) });
    const relay = fakeRelay();
    const { seams } = baseJoinRedeemSeams();

    const result = await joinRedeem(p, relay.client, () => NO_SECRETS, { code: CODE }, seams);

    expect(result.access).toBe("denied");
    expect(result.message).toBe("you don't have access yet: ask matt to grant you access to Acme");
    expect(relay.redeemCalls).toHaveLength(0);
  });

  test("a non-auth clone failure returns access:unreachable", async () => {
    const p = redeemProbes({ exec: () => ({ code: 128, stdout: "", stderr: "fatal: Could not resolve host" }) });
    const relay = fakeRelay();
    const { seams } = baseJoinRedeemSeams();

    const result = await joinRedeem(p, relay.client, () => NO_SECRETS, { code: CODE }, seams);
    expect(result.access).toBe("unreachable");
  });

  test("redeem race lost on a fresh clone throws invite-unknown with the used-invite message", async () => {
    const p = redeemProbes();
    const relay = fakeRelay({ redeem: async () => "already" });
    const { seams } = baseJoinRedeemSeams();

    let caught: unknown;
    try {
      await joinRedeem(p, relay.client, () => NO_SECRETS, { code: CODE }, seams);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UserActionableError);
    expect((caught as UserActionableError).code).toBe("invite-unknown");
    expect((caught as UserActionableError).message).toBe("this invite was already used: ask matt for a new one");
  });

  test("resuming after a crash: the team is already cloned, redeem reports 'already' — that is NOT an error", async () => {
    const p = redeemProbes({
      dirs: { [TEAM_DIR]: [".git"] },
      files: { [pathJoin(TEAM_DIR, ".git", "config")]: gitConfigWithRemote(REMOTE) },
    });
    const relay = fakeRelay({ redeem: async () => "already" });
    const { seams } = baseJoinRedeemSeams();

    const result = await joinRedeem(p, relay.client, () => NO_SECRETS, { code: CODE }, seams);

    expect(result.access).toBe("ok");
    expect(p.calls.exec.some((argv) => argv[0] === "git" && argv[1] === "clone")).toBe(false);
  });

  test("an existing clone with a DIFFERENT remote throws instead of silently reusing it", async () => {
    const p = redeemProbes({
      dirs: { [TEAM_DIR]: [".git"] },
      files: { [pathJoin(TEAM_DIR, ".git", "config")]: gitConfigWithRemote("git@github.com:someone-else/other.git") },
    });
    const relay = fakeRelay();
    const { seams } = baseJoinRedeemSeams();

    await expect(joinRedeem(p, relay.client, () => NO_SECRETS, { code: CODE }, seams)).rejects.toMatchObject({ code: "team-remote-mismatch" });
  });

  test("no code and no saved intent throws no-join-intent", async () => {
    const p = redeemProbes();
    const relay = fakeRelay();
    const { seams } = baseJoinRedeemSeams();

    await expect(joinRedeem(p, relay.client, () => NO_SECRETS, {}, seams)).rejects.toMatchObject({ code: "no-join-intent" });
  });

  test("no code: resumes from the intent saved by a prior dry-run", async () => {
    const intent: SetupIntent = {
      v: 1,
      at: NOW.toISOString(),
      mode: "join",
      join: { id: ID_HEX, keyB64: Buffer.from(KEY).toString("base64"), pointer: POINTER },
    };
    const p = redeemProbes({ files: { [intentPath(HOME)]: JSON.stringify(intent) } });
    const relay = fakeRelay();
    const { seams } = baseJoinRedeemSeams();

    const result = await joinRedeem(p, relay.client, () => NO_SECRETS, {}, seams);

    expect(result.access).toBe("ok");
    expect(relay.fetchCalls).toHaveLength(0); // never re-fetched the relay — the pointer came from the saved intent
  });

  test("relay-unreachable while resolving a fresh code returns access:unreachable, no throw", async () => {
    const p = redeemProbes();
    const relay = fakeRelay({
      fetch: async () => {
        throw new UserActionableError("relay-unreachable", "could not reach the invite relay");
      },
    });
    const { seams } = baseJoinRedeemSeams();

    const result = await joinRedeem(p, relay.client, () => NO_SECRETS, { code: CODE }, seams);
    expect(result.access).toBe("unreachable");
    expect(result.team).toEqual({ slug: "", name: "", owner: "" });
  });

  test("fromApply clears the saved intent; the plain CLI form (fromApply unset) leaves it for the caller to clear", async () => {
    const p = redeemProbes({ files: { [intentPath(HOME)]: "{}" } });
    const relay = fakeRelay();
    const { seams } = baseJoinRedeemSeams();

    await joinRedeem(p, relay.client, () => NO_SECRETS, { code: CODE, fromApply: true }, seams);
    expect(p.calls.removed).toContain(intentPath(HOME));
  });

  test("without fromApply, joinRedeem itself does not clear the intent", async () => {
    const p = redeemProbes({ files: { [intentPath(HOME)]: "{}" } });
    const relay = fakeRelay();
    const { seams } = baseJoinRedeemSeams();

    await joinRedeem(p, relay.client, () => NO_SECRETS, { code: CODE }, seams);
    expect(p.calls.removed).not.toContain(intentPath(HOME));
  });

  test("passes the pointer's own team slug into the secrets factory", async () => {
    const p = redeemProbes();
    const relay = fakeRelay();
    const factorySlugs: string[] = [];
    const { seams } = baseJoinRedeemSeams({
      read: fakeRead({ "mattstack.integrations": { switchboard: { url: "https://sb.test" } } }),
      readTeamSecret: async () => null,
    });

    await joinRedeem(
      p,
      relay.client,
      (slug) => {
        factorySlugs.push(slug);
        return NO_SECRETS;
      },
      { code: CODE },
      seams,
    );
    expect(factorySlugs).toEqual(["acme"]);
  });
});
