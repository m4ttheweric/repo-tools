import { describe, test, expect, beforeEach } from "bun:test";
import { join as pathJoin } from "path";
import { fakeProbes, type ExecScript } from "../../setup/__tests__/fakes.ts";
import { UserActionableError } from "../../setup/errors.ts";
import { resetCltCacheForTests } from "../../setup/home-git.ts";
import { intentPath, readIntent, type InvitePointer, type SetupIntent } from "../../setup/intent.ts";
import type { Probes } from "../../setup/probes.ts";
import type { SettingsReader } from "../../setup/team-settings.ts";
import { decodeCode, encodeCode, openReply, seal } from "../invite-crypto.ts";
import { JoinKeyExchangeError, joinDryRun, joinRedeem, type JoinRedeemSeams } from "../join.ts";
import type { RelayClient } from "../relay-client.ts";
import type { SecretsSeams } from "../../secrets/store.ts";
import type { AgeExecResult, AgeKeySeam } from "../../home/age-key.ts";
import { readTeamLocal } from "../team-local.ts";

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
  reply?: RelayClient["reply"];
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
      callOrder.push("reply");
      if (opts.reply) return opts.reply(id, blob);
      replyCalls.push({ id, blob });
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

/** A `fetch` implementation serving a pointer sealed for the same id/key as CODE, so tests can exercise a hostile/traversal pointer through the exact same decode path as every other test. */
function relayServing(pointer: InvitePointer): RelayClient["fetch"] {
  return async () => ({ ciphertext: await seal(pointer, KEY, ID_HEX) });
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

/** A keychain that exists but can't be read right now — distinct from "absent" (which mints instead), this is the locked/denied case `ensureAgeKey` refuses to mint over. */
function fakeAgeKeySeamLocked(): AgeKeySeam {
  return {
    async run(): Promise<AgeExecResult> {
      return { code: 1, stdout: "", stderr: "keychain locked" };
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
    forgeToken: async () => null,
    warn: () => {},
    ...overrides,
  };
  return { seams, calls };
}

const NO_SECRETS: SecretsSeams = {} as SecretsSeams;

/** A script for git's answer alone: the CLT guard (`xcode-select -p`) that precedes the git call answers ok. */
function gitAnswers(script: ExecScript): ExecScript {
  return (argv, opts) => (argv[0] === "xcode-select" ? { code: 0, stdout: "/Library/Developer/CommandLineTools", stderr: "" } : script(argv, opts));
}

describe("joinDryRun", () => {
  beforeEach(() => resetCltCacheForTests());

  test("no Command Line Tools yet: git is never run (the xcode-select shim fails and raises Apple's dialog); access ok, intent written, message defers to the next screen", async () => {
    const seen: string[][] = [];
    const p = fakeProbes({
      home: HOME,
      now: NOW,
      exec: (argv) => {
        seen.push(argv);
        return argv[0] === "xcode-select" ? { code: 2, stdout: "", stderr: "xcode-select: error: unable to get active developer directory" } : { code: 0, stdout: "", stderr: "" };
      },
    });
    const relay = fakeRelay();

    const result = await joinDryRun(p, relay.client, CODE);

    expect(result.access).toBe("ok");
    expect(result.message).toContain("next screen");
    expect(readIntent(p)?.mode).toBe("join");
    expect(seen.some((argv) => argv[0] === "git")).toBe(false);
  });

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

  test("a programming error from relay.fetch is not swallowed into 'check your network'", async () => {
    const p = fakeProbes({ home: HOME });
    const relay = fakeRelay({
      fetch: async () => {
        throw new TypeError("boom: not a relay-client error at all");
      },
    });

    await expect(joinDryRun(p, relay.client, CODE)).rejects.toThrow(TypeError);
  });

  test("ls-remote auth failure: access denied, message has no URL and no raw git output", async () => {
    const p = fakeProbes({
      home: HOME,
      exec: gitAnswers(() => ({ code: 128, stdout: "", stderr: "fatal: Authentication failed for 'https://github.com/acme/widgets.git/'" })),
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

  // At Team Continue the joiner has connected no forge token yet (that is the
  // next screen), so a private team repo answers "could not read Username":
  // nothing was refused, git simply had nothing to offer. The checklist's
  // access.team-repo row, which has the token, is what gates Install.
  test("no credential at all (could not read Username) is not denied: access ok, intent written, message defers to the next screen", async () => {
    const p = fakeProbes({ home: HOME, now: NOW, exec: () => ({ code: 128, stdout: "", stderr: "fatal: could not read Username for 'https://gitlab.com': terminal prompts disabled" }) });
    const relay = fakeRelay();

    const result = await joinDryRun(p, relay.client, CODE);
    expect(result.access).toBe("ok");
    expect(result.message).toContain("next screen");
    expect(readIntent(p)?.mode).toBe("join");
  });

  test("a non-auth git failure reports access:unreachable, message says the network, not a guess", async () => {
    const p = fakeProbes({ home: HOME, exec: gitAnswers(() => ({ code: 128, stdout: "", stderr: "fatal: Could not resolve host: github.com" })) });
    const relay = fakeRelay();

    const result = await joinDryRun(p, relay.client, CODE);
    expect(result.access).toBe("unreachable");
    expect(result.message).toContain("check your network");
  });

  test("uses GIT_TERMINAL_PROMPT=0 and GIT_PROTOCOL_FROM_USER=0, --exit-code against the pointer's remote", async () => {
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

    const git = calls.filter((c) => c.argv[0] === "git");
    expect(git).toHaveLength(1);
    expect(git[0]!.argv).toEqual(["git", "ls-remote", "--exit-code", REMOTE, "HEAD"]);
    expect(git[0]!.opts?.env?.GIT_TERMINAL_PROMPT).toBe("0");
    expect(git[0]!.opts?.env?.GIT_PROTOCOL_FROM_USER).toBe("0");
  });

  describe("a hostile pointer is rejected before it ever reaches a path join or a git argv", () => {
    test("ext:: remote — never even attempts an exec call", async () => {
      const p = fakeProbes({ home: HOME });
      const relay = fakeRelay({ fetch: relayServing({ ...POINTER, remote: "ext::sh -c 'touch /tmp/pwned'" }) });

      await expect(joinDryRun(p, relay.client, CODE)).rejects.toMatchObject({ code: "invite-malformed" });
      expect(p.calls.exec).toHaveLength(0);
    });

    test("a traversal team slug — rejected before any local path is touched", async () => {
      const p = fakeProbes({ home: HOME });
      const relay = fakeRelay({ fetch: relayServing({ ...POINTER, team: "../../etc" }) });

      await expect(joinDryRun(p, relay.client, CODE)).rejects.toMatchObject({ code: "invite-malformed" });
      expect(p.calls.exec).toHaveLength(0);
    });

    test("file:// remote is rejected", async () => {
      const p = fakeProbes({ home: HOME });
      const relay = fakeRelay({ fetch: relayServing({ ...POINTER, remote: "file:///etc/passwd" }) });

      await expect(joinDryRun(p, relay.client, CODE)).rejects.toMatchObject({ code: "invite-malformed" });
      expect(p.calls.exec).toHaveLength(0);
    });

    test("a remote whose host starts with '-' (ssh option injection) is rejected", async () => {
      const p = fakeProbes({ home: HOME });
      const relay = fakeRelay({ fetch: relayServing({ ...POINTER, remote: "ssh://-oProxyCommand=x/acme/widgets.git" }) });

      await expect(joinDryRun(p, relay.client, CODE)).rejects.toMatchObject({ code: "invite-malformed" });
      expect(p.calls.exec).toHaveLength(0);
    });

    test("a remote carrying --upload-pack= (space-separated tail) is rejected", async () => {
      const p = fakeProbes({ home: HOME });
      const relay = fakeRelay({ fetch: relayServing({ ...POINTER, remote: "https://github.com/acme/widgets.git --upload-pack=touch /tmp/x" }) });

      await expect(joinDryRun(p, relay.client, CODE)).rejects.toMatchObject({ code: "invite-malformed" });
      expect(p.calls.exec).toHaveLength(0);
    });

    test("N5: the whitespace rule rejects --config= and -c tails just as symmetrically as --upload-pack=", async () => {
      for (const remote of [
        "https://github.com/acme/widgets.git --config=core.sshCommand=id",
        "https://github.com/acme/widgets.git -c core.pager=id",
      ]) {
        const p = fakeProbes({ home: HOME });
        const relay = fakeRelay({ fetch: relayServing({ ...POINTER, remote }) });

        await expect(joinDryRun(p, relay.client, CODE)).rejects.toMatchObject({ code: "invite-malformed" });
        expect(p.calls.exec).toHaveLength(0);
      }
    });

    test("N3: a 5000-char slug is rejected cleanly (not left to fail as ENAMETOOLONG deep in git)", async () => {
      const p = fakeProbes({ home: HOME });
      const relay = fakeRelay({ fetch: relayServing({ ...POINTER, team: "a".repeat(5000) }) });

      await expect(joinDryRun(p, relay.client, CODE)).rejects.toMatchObject({ code: "invite-malformed" });
      expect(p.calls.exec).toHaveLength(0);
    });

    test("N2: control characters and ANSI escapes in name/owner never reach the human message — sanitized, not merely tolerated", async () => {
      const p = fakeProbes({ home: HOME, now: NOW, exec: () => ({ code: 0, stdout: "", stderr: "" }) });
      const hostileName = "\x1b[2J\x1b[1;1HFAKE-SCREEN-CLEAR";
      const hostileOwner = "matt\nrt team join: Joined Acme (owner matt)";
      const relay = fakeRelay({ fetch: relayServing({ ...POINTER, name: hostileName, owner: hostileOwner }) });

      const result = await joinDryRun(p, relay.client, CODE);

      expect(result.access).toBe("ok");
      expect(result.team.name).not.toContain("\x1b");
      expect(result.team.owner).not.toContain("\n");
      expect(result.message).not.toContain("\x1b");
      expect(result.message).not.toContain("\n");
      expect(result.message).not.toMatch(/[\x00-\x1f\x7f]/);
    });

    test("a well-formed https, scp-like, ssh-with-port, and credential-bearing https remote all pass (regression guard)", async () => {
      for (const remote of [
        "https://github.com/acme/widgets.git",
        "git@github.com:acme/widgets.git",
        "ssh://git@github.com/acme/widgets.git",
        "ssh://git@github.com:2222/acme/widgets.git",
        "https://user:pass@github.com/acme/widgets.git",
      ]) {
        const p = fakeProbes({ home: HOME, now: NOW, exec: () => ({ code: 0, stdout: "", stderr: "" }) });
        const relay = fakeRelay({ fetch: relayServing({ ...POINTER, remote }) });
        const result = await joinDryRun(p, relay.client, CODE);
        expect(result.access).toBe("ok");
      }
    });
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

    // The code itself never leaks into the result.
    expect(JSON.stringify(result)).not.toContain(CODE);
  });

  test("clone uses GIT_TERMINAL_PROMPT=0 and GIT_PROTOCOL_FROM_USER=0", async () => {
    const calls: { argv: string[]; opts?: Parameters<Probes["exec"]>[1] }[] = [];
    const p = redeemProbes({
      exec: (argv, opts) => {
        calls.push({ argv, opts });
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const relay = fakeRelay();
    const { seams } = baseJoinRedeemSeams();

    await joinRedeem(p, relay.client, () => NO_SECRETS, { code: CODE }, seams);

    const clone = calls.find((c) => c.argv[1] === "clone")!;
    expect(clone.opts?.env?.GIT_TERMINAL_PROMPT).toBe("0");
    expect(clone.opts?.env?.GIT_PROTOCOL_FROM_USER).toBe("0");
  });

  test("a forge token rt holds is offered to the clone through the env, never argv, and to the forge-login check", async () => {
    const calls: { argv: string[]; opts?: Parameters<Probes["exec"]>[1] }[] = [];
    const p = redeemProbes({
      exec: (argv, opts) => {
        calls.push({ argv, opts });
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const relay = fakeRelay();
    const { seams, calls: seamCalls } = baseJoinRedeemSeams({ forgeToken: async () => "glpat-secret" });

    await joinRedeem(p, relay.client, () => NO_SECRETS, { code: CODE }, seams);

    const clone = calls.find((c) => c.argv.includes("clone"))!;
    expect(clone.argv.join(" ")).not.toContain("glpat-secret");
    expect(clone.argv).toContain("credential.helper=");
    expect(clone.opts?.env?.RT_GIT_TOKEN).toBe("glpat-secret");
    expect(clone.opts?.env?.GIT_TERMINAL_PROMPT).toBe("0");
    expect(seamCalls.forgeLogin[0]?.[3]).toBe("glpat-secret");
  });

  test("checkpoints the resumable intent as soon as the pointer resolves, before cloning", async () => {
    const p = redeemProbes({
      exec: (argv) => {
        // The intent write must have happened before the clone call runs.
        if (argv[1] === "clone") expect(p.calls.writes[intentPath(HOME)]).toBeDefined();
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const relay = fakeRelay();
    const { seams } = baseJoinRedeemSeams();

    await joinRedeem(p, relay.client, () => NO_SECRETS, { code: CODE }, seams);
    expect(p.calls.writes[intentPath(HOME)]).toBeDefined();
  });

  test("records joinedByRt BEFORE the clone runs, so the daemon watcher cannot race it", async () => {
    const seen: string[] = [];
    const p = redeemProbes({
      exec: (argv) => {
        if (argv[1] === "clone") seen.push(readTeamLocal(p, POINTER.team).joinedByRt ? "flag-first" : "clone-first");
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const relay = fakeRelay();
    const { seams } = baseJoinRedeemSeams();

    await joinRedeem(p, relay.client, () => NO_SECRETS, { code: CODE }, seams);

    expect(seen).toEqual(["flag-first"]);
    expect(readTeamLocal(p, POINTER.team).joinedByRt).toBe(true);
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

  test("switchboard url present but no readable admin token → peering:unavailable (there IS something to peer, and it could not), no request attempted", async () => {
    const p = redeemProbes();
    const relay = fakeRelay();
    const { seams } = baseJoinRedeemSeams({
      read: fakeRead({ "mattstack.integrations": { switchboard: { url: "https://sb.test" } } }),
      readTeamSecret: async () => null,
    });

    const result = await joinRedeem(p, relay.client, () => NO_SECRETS, { code: CODE }, seams);

    expect(result.peering).toBe("unavailable");
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

  describe("clone failures are classified honestly — 'check your network' only when it IS the network", () => {
    test("a non-auth, non-network clone failure does not blame the network", async () => {
      const p = redeemProbes({ exec: () => ({ code: 128, stdout: "", stderr: "fatal: destination path already exists and is not an empty directory" }) });
      const relay = fakeRelay();
      const { seams } = baseJoinRedeemSeams();

      const result = await joinRedeem(p, relay.client, () => NO_SECRETS, { code: CODE }, seams);
      expect(result.access).toBe("unreachable");
      expect(result.message).not.toContain("network");
      expect(result.message).toContain("already exists");
    });

    test("disk full reports a disk message, not a network one", async () => {
      const p = redeemProbes({ exec: () => ({ code: 128, stdout: "", stderr: "fatal: write error: No space left on device" }) });
      const relay = fakeRelay();
      const { seams } = baseJoinRedeemSeams();

      const result = await joinRedeem(p, relay.client, () => NO_SECRETS, { code: CODE }, seams);
      expect(result.message).toContain("space");
      expect(result.message).not.toContain("check your network");
    });

    test("a missing git binary (exit 127) reports that, not a network guess", async () => {
      const p = redeemProbes({ exec: () => ({ code: 127, stdout: "", stderr: "ENOENT: git" }) });
      const relay = fakeRelay();
      const { seams } = baseJoinRedeemSeams();

      const result = await joinRedeem(p, relay.client, () => NO_SECRETS, { code: CODE }, seams);
      expect(result.message).toContain("git is not installed");
      expect(result.message).not.toContain("check your network");
    });

    test("a genuine transport failure DOES say check your network", async () => {
      const p = redeemProbes({ exec: () => ({ code: 128, stdout: "", stderr: "fatal: unable to access: Could not resolve host: github.com" }) });
      const relay = fakeRelay();
      const { seams } = baseJoinRedeemSeams();

      const result = await joinRedeem(p, relay.client, () => NO_SECRETS, { code: CODE }, seams);
      expect(result.message).toContain("check your network");
    });
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

  test("a saved intent carrying a hostile pointer is still validated on resume", async () => {
    const intent: SetupIntent = {
      v: 1,
      at: NOW.toISOString(),
      mode: "join",
      join: { id: ID_HEX, keyB64: Buffer.from(KEY).toString("base64"), pointer: { ...POINTER, team: "../../etc" } },
    };
    const p = redeemProbes({ files: { [intentPath(HOME)]: JSON.stringify(intent) } });
    const relay = fakeRelay();
    const { seams } = baseJoinRedeemSeams();

    await expect(joinRedeem(p, relay.client, () => NO_SECRETS, {}, seams)).rejects.toMatchObject({ code: "invite-malformed" });
    expect(p.calls.exec).toHaveLength(0);
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

  test("a programming error while resolving the pointer is not swallowed into 'check your network'", async () => {
    const p = redeemProbes();
    const relay = fakeRelay({
      fetch: async () => {
        throw new TypeError("boom");
      },
    });
    const { seams } = baseJoinRedeemSeams();

    await expect(joinRedeem(p, relay.client, () => NO_SECRETS, { code: CODE }, seams)).rejects.toThrow(TypeError);
  });

  describe("a relay failure never exits 2 once the code has been redeemed — it's real infrastructure, not a dead invite", () => {
    test("relay.redeem itself unreachable: exit 0, access:unreachable, the clone is not lost", async () => {
      const p = redeemProbes();
      const relay = fakeRelay({
        redeem: async () => {
          throw new UserActionableError("relay-unreachable", "could not reach the invite relay");
        },
      });
      const { seams } = baseJoinRedeemSeams();

      const result = await joinRedeem(p, relay.client, () => NO_SECRETS, { code: CODE }, seams);

      expect(result.access).toBe("unreachable");
      expect(p.calls.exec).toContainEqual(["git", "clone", REMOTE, TEAM_DIR]);
      expect(result.message).not.toMatch(/invite.*(dead|unknown|expired)/i);
    });

    test("relay.redeem 5xx: exit 0, access:unreachable, not a thrown UserActionableError", async () => {
      const p = redeemProbes();
      const relay = fakeRelay({
        redeem: async () => {
          throw new UserActionableError("relay-error", "500 /v1/invites/x/redeem");
        },
      });
      const { seams } = baseJoinRedeemSeams();

      const result = await joinRedeem(p, relay.client, () => NO_SECRETS, { code: CODE }, seams);
      expect(result.access).toBe("unreachable");
    });

    test("relay.reply unreachable: still access:ok (the join itself succeeded), intent is NOT cleared so a retry can finish", async () => {
      const p = redeemProbes();
      const relay = fakeRelay({
        reply: async () => {
          throw new UserActionableError("relay-unreachable", "could not reach the invite relay");
        },
      });
      const { seams } = baseJoinRedeemSeams();

      const result = await joinRedeem(p, relay.client, () => NO_SECRETS, { code: CODE }, seams);

      expect(result.access).toBe("ok");
      expect(p.calls.removed).not.toContain(intentPath(HOME));
      expect(result.message).toContain("could not send your key back");
    });

    test("relay.reply 5xx: same honest half-state report, not exit 2", async () => {
      const p = redeemProbes();
      const relay = fakeRelay({
        reply: async () => {
          throw new UserActionableError("relay-error", "500 /v1/invites/x/reply");
        },
      });
      const { seams } = baseJoinRedeemSeams();

      const result = await joinRedeem(p, relay.client, () => NO_SECRETS, { code: CODE }, seams);
      expect(result.access).toBe("ok");
      expect(p.calls.removed).not.toContain(intentPath(HOME));
    });
  });

  test("finding-5 recovery: re-running with the SAME code after redeem-succeeded-but-reply-failed resumes from the matching saved intent instead of dead-ending on invite-unknown", async () => {
    // First attempt: reply fails, leaving the relay-side invite already redeemed and a saved intent behind.
    const p = redeemProbes();
    const relay = fakeRelay({
      reply: async () => {
        throw new UserActionableError("relay-unreachable", "down");
      },
    });
    const { seams } = baseJoinRedeemSeams();
    const first = await joinRedeem(p, relay.client, () => NO_SECRETS, { code: CODE }, seams);
    expect(first.access).toBe("ok");

    // Second attempt: the SAME code is re-typed. The relay now reports the id "gone"
    // (already redeemed) instead of serving the ciphertext again.
    const relay2 = fakeRelay({ fetch: async () => "gone" });
    const { seams: seams2 } = baseJoinRedeemSeams();
    const second = await joinRedeem(p, relay2.client, () => NO_SECRETS, { code: CODE }, seams2);

    expect(second.access).toBe("ok");
    expect(relay2.redeemCalls).toHaveLength(1); // resumed via the intent, then proceeded normally (alreadyCloned, so "already"/"redeemed" both fine)
  });

  test("keychain failure after clone+redeem: JoinKeyExchangeError, not a raw crash — names what completed", async () => {
    const p = redeemProbes();
    const relay = fakeRelay();
    const { seams } = baseJoinRedeemSeams({ ageKeySeam: fakeAgeKeySeamLocked() });

    let caught: unknown;
    try {
      await joinRedeem(p, relay.client, () => NO_SECRETS, { code: CODE }, seams);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(JoinKeyExchangeError);
    expect(caught).not.toBeInstanceOf(UserActionableError);
    const message = (caught as Error).message;
    expect(message).toContain("redeemed the invite");
    expect(message).toContain("run `rt team join` again");
    // The clone and the redeem really did happen — this is a reportable half-state, not a rollback.
    expect(p.calls.exec).toContainEqual(["git", "clone", REMOTE, TEAM_DIR]);
    expect(relay.redeemCalls).toEqual([ID_HEX]);
  });

  test("an undeterminable forge login never gets sealed as a guess — no $USER, no 'unknown' — and is refused BEFORE the invite is consumed (N1/R-T18-e)", async () => {
    const p = redeemProbes({ env: { USER: "localdev" } });
    const relay = fakeRelay();
    const { seams } = baseJoinRedeemSeams({ forgeLogin: async () => null });

    let caught: unknown;
    try {
      await joinRedeem(p, relay.client, () => NO_SECRETS, { code: CODE }, seams);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(UserActionableError);
    expect((caught as UserActionableError).code).toBe("forge-login-unknown");
    expect((caught as UserActionableError).message).not.toContain("localdev");
    expect((caught as UserActionableError).message).toContain("has not been used yet");
    // The team WAS cloned (identity resolution needs the just-cloned settings), but
    // relay.redeem must never have run — the invite is still valid for a retry.
    expect(p.calls.exec).toContainEqual(["git", "clone", REMOTE, TEAM_DIR]);
    expect(relay.redeemCalls).toHaveLength(0);
    expect(relay.replyCalls).toHaveLength(0);
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

  test("full success clears the saved intent", async () => {
    const p = redeemProbes({ files: { [intentPath(HOME)]: "{}" } });
    const relay = fakeRelay();
    const { seams } = baseJoinRedeemSeams();

    await joinRedeem(p, relay.client, () => NO_SECRETS, { code: CODE }, seams);
    expect(p.calls.removed).toContain(intentPath(HOME));
  });

  describe("a hostile pointer on the redeem path is rejected before any local mutation", () => {
    test("ext:: remote via a fresh code — no exec, no mkdirp", async () => {
      const p = redeemProbes();
      const relay = fakeRelay({ fetch: relayServing({ ...POINTER, remote: "ext::sh -c 'touch /tmp/pwned'" }) });
      const { seams } = baseJoinRedeemSeams();

      await expect(joinRedeem(p, relay.client, () => NO_SECRETS, { code: CODE }, seams)).rejects.toMatchObject({ code: "invite-malformed" });
      expect(p.calls.exec).toHaveLength(0);
    });

    test("a traversal team slug via a fresh code — never joins a path outside teams/", async () => {
      const p = redeemProbes();
      const relay = fakeRelay({ fetch: relayServing({ ...POINTER, team: "../../etc" }) });
      const { seams } = baseJoinRedeemSeams();

      await expect(joinRedeem(p, relay.client, () => NO_SECRETS, { code: CODE }, seams)).rejects.toMatchObject({ code: "invite-malformed" });
      expect(p.calls.exec).toHaveLength(0);
    });

    test("N3: a 5000-char slug via a fresh code is rejected before any exec", async () => {
      const p = redeemProbes();
      const relay = fakeRelay({ fetch: relayServing({ ...POINTER, team: "a".repeat(5000) }) });
      const { seams } = baseJoinRedeemSeams();

      await expect(joinRedeem(p, relay.client, () => NO_SECRETS, { code: CODE }, seams)).rejects.toMatchObject({ code: "invite-malformed" });
      expect(p.calls.exec).toHaveLength(0);
    });
  });

  test("N2: control characters in name/owner are sanitized in the redeem success message too", async () => {
    const p = redeemProbes();
    const relay = fakeRelay({ fetch: relayServing({ ...POINTER, name: "Acme\x1b[2J", owner: "matt\r\nFAKE LINE" }) });
    const { seams } = baseJoinRedeemSeams();

    const result = await joinRedeem(p, relay.client, () => NO_SECRETS, { code: CODE }, seams);

    expect(result.access).toBe("ok");
    expect(result.message).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(result.team.owner).not.toContain("\r");
  });
});
