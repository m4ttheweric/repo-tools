import { describe, test, expect, spyOn } from "bun:test";
import { join as pathJoin } from "path";
import { teamJoin, type TeamDeps } from "../team.ts";
import { fakeProbes } from "../../lib/setup/__tests__/fakes.ts";
import type { AgeExecResult, AgeKeySeam } from "../../lib/home/age-key.ts";
import { encodeCode, seal } from "../../lib/team/invite-crypto.ts";
import type { JoinRedeemSeams } from "../../lib/team/join.ts";
import type { InvitePointer } from "../../lib/setup/intent.ts";
import type { Probes } from "../../lib/setup/probes.ts";
import type { SettingsReader } from "../../lib/setup/team-settings.ts";

const HOME = "/home/x";
const ID_HEX = "0102030405060708090a0b0c0d0e0f10";
const KEY = new Uint8Array(32).fill(7);
const CODE = encodeCode(ID_HEX, KEY);
const REMOTE = "git@github.com:acme/widgets.git";

const POINTER: InvitePointer = {
  v: 1,
  team: "acme",
  name: "Acme",
  remote: REMOTE,
  owner: "matt",
  forge: "github.com",
  createdAt: "2026-08-01T00:00:00.000Z",
};

const FAKE_PUBLIC_KEY = "age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";

class FakeAgeKeySeam implements AgeKeySeam {
  async run(cmd: string[]): Promise<AgeExecResult> {
    if (cmd[1] === "find-generic-password") return { code: 0, stdout: "AGE-SECRET-KEY-1QQQ\n", stderr: "" };
    if (cmd[0] === "age-keygen" && cmd[1] === "-y") return { code: 0, stdout: `${FAKE_PUBLIC_KEY}\n`, stderr: "" };
    throw new Error(`FakeAgeKeySeam: unexpected call ${cmd.join(" ")}`);
  }
}

/** A locked/unreadable keychain — distinct from "absent" (which mints instead). */
class FakeAgeKeySeamLocked implements AgeKeySeam {
  async run(): Promise<AgeExecResult> {
    return { code: 1, stdout: "", stderr: "keychain locked" };
  }
}

function fakeRead(values: Record<string, unknown> = {}): SettingsReader {
  return <T>(key: string): T | undefined => values[key] as T | undefined;
}

/**
 * Explicit fakes for every redeem-side seam `teamJoin` doesn't own directly
 * (`read`/`readTeamSecret`/`forgeLogin`) — routed through `TeamDeps.joinRedeemSeams`
 * so this suite's outcomes depend on what a test configures, never on
 * whatever the isolated test HOME happens to have (or not have) configured
 * for `mattstack.integrations`.
 */
function fakeJoinRedeemSeams(overrides: Partial<JoinRedeemSeams> = {}): JoinRedeemSeams {
  return {
    ageKeySeam: new FakeAgeKeySeam(),
    read: fakeRead(),
    readTeamSecret: async () => null,
    forgeLogin: async () => "zaphod",
    warn: () => {},
    ...overrides,
  };
}

function baseDeps(overrides: Partial<TeamDeps> = {}): TeamDeps & { lines: string[] } {
  const lines: string[] = [];
  return {
    probes: fakeProbes({ home: HOME, exec: () => ({ code: 0, stdout: "", stderr: "" }) }),
    print: (s: string) => lines.push(s),
    ageKeySeam: new FakeAgeKeySeam(),
    readCode: async () => CODE,
    joinRedeemSeams: fakeJoinRedeemSeams(),
    lines,
    ...overrides,
  };
}

/** Every exit path calls the real `process.exit` (via `exitUserError`, or directly for `JoinKeyExchangeError`), never `deps.exit` — spying is mandatory here or an un-mocked `process.exit` kills the whole test run silently. */
async function runExpectingProcessExit(fn: () => Promise<void>): Promise<number | undefined> {
  const exitSpy = spyOn(process, "exit").mockImplementation(() => {
    throw new Error("process.exit sentinel");
  });
  try {
    await fn();
    return undefined;
  } catch {
    return exitSpy.mock.calls.at(-1)?.[0] as number | undefined;
  } finally {
    exitSpy.mockRestore();
  }
}

function relayFetch(): Probes["fetch"] {
  return async (url) => {
    if (url.endsWith(`/v1/invites/${ID_HEX}`)) {
      const ciphertext = await seal(POINTER, KEY, ID_HEX);
      return { status: 200, body: JSON.stringify({ ciphertext }), headers: {} };
    }
    if (url.endsWith(`/v1/invites/${ID_HEX}/redeem`)) return { status: 200, body: "", headers: {} };
    if (url.endsWith(`/v1/invites/${ID_HEX}/reply`)) return { status: 200, body: "", headers: {} };
    return { status: 404, body: "", headers: {} };
  };
}

describe("teamJoin", () => {
  test("an invite code passed as an argument exits 2 with code-on-argv, before touching the relay", async () => {
    const fetchCalls: string[] = [];
    const deps = baseDeps({
      probes: fakeProbes({ home: HOME, fetch: async (url) => (fetchCalls.push(url), { status: 404, body: "", headers: {} }) }),
    });

    const code = await runExpectingProcessExit(() => teamJoin(["ABC", "--json"], {}, deps));

    expect(code).toBe(2);
    const body = JSON.parse(deps.lines[0]!);
    expect(body.error.code).toBe("code-on-argv");
    expect(body.error.message).toBe("pass the invite code on stdin, never as an argument");
    expect(fetchCalls).toHaveLength(0);
    // The code the CLI would have refused is never in the code-on-argv envelope.
    expect(deps.lines[0]).not.toContain(CODE);
  });

  test("human mode: code-on-argv prints the message and exits 2", async () => {
    const deps = baseDeps();
    const code = await runExpectingProcessExit(() => teamJoin(["ABC"], {}, deps));

    expect(code).toBe(2);
    expect(deps.lines[0]).toContain("pass the invite code on stdin, never as an argument");
  });

  test("--dry-run --json prints the exact contract envelope for an accessible invite", async () => {
    const deps = baseDeps({ probes: fakeProbes({ home: HOME, fetch: relayFetch(), exec: () => ({ code: 0, stdout: "", stderr: "" }) }) });

    await teamJoin(["--dry-run", "--json"], {}, deps);

    expect(deps.lines).toHaveLength(1);
    const { at, ...body } = JSON.parse(deps.lines[0]!);
    expect(typeof at).toBe("string");
    expect(body).toEqual({
      contract: 1,
      team: { slug: "acme", name: "Acme", owner: "matt" },
      access: "ok",
      peering: "idle",
      message: "Joining Acme (owner matt)",
    });
    // The stdout envelope never carries the raw code back, either.
    expect(deps.lines[0]).not.toContain(CODE);
  });

  test("--dry-run, denied access: human output carries the message, no URL or git output", async () => {
    const deps = baseDeps({
      probes: fakeProbes({
        home: HOME,
        fetch: relayFetch(),
        exec: () => ({ code: 128, stdout: "", stderr: "fatal: Authentication failed for 'https://github.com/acme/widgets.git/'" }),
      }),
    });

    await teamJoin(["--dry-run"], {}, deps);

    expect(deps.lines[0]).toContain("you don't have access yet: ask matt to grant you access to Acme");
    expect(deps.lines[0]).not.toContain("http");
  });

  test("--dry-run rejects a hostile ext:: remote before any exec call, exit 2 invite-malformed", async () => {
    const probes = fakeProbes({
      home: HOME,
      fetch: async () => ({ status: 200, body: JSON.stringify({ ciphertext: await seal({ ...POINTER, remote: "ext::sh -c id" }, KEY, ID_HEX) }), headers: {} }),
    });
    const deps = baseDeps({ probes });

    const code = await runExpectingProcessExit(() => teamJoin(["--dry-run", "--json"], {}, deps));

    expect(code).toBe(2);
    const body = JSON.parse(deps.lines[0]!);
    expect(body.error.code).toBe("invite-malformed");
    expect(probes.calls.exec).toHaveLength(0);
  });

  test("redeem: clones, redeems, and prints the exact contract envelope on success", async () => {
    const probes = fakeProbes({
      home: HOME,
      fetch: relayFetch(),
      exec: (argv) => {
        if (argv[0] === "git" && argv[1] === "clone") return { code: 0, stdout: "", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const deps = baseDeps({ probes });

    await teamJoin(["--json"], {}, deps);

    const { at, ...body } = JSON.parse(deps.lines[0]!);
    expect(typeof at).toBe("string");
    expect(body.contract).toBe(1);
    expect(body.team).toEqual({ slug: "acme", name: "Acme", owner: "matt" });
    expect(body.access).toBe("ok");
    expect(body.peering).toBe("idle"); // no switchboard.url configured in this test's joinRedeemSeams.read
    expect(body.message).toBe("Joined Acme (owner matt)");

    const dir = pathJoin(HOME, ".mattstack", "teams", "acme");
    expect(probes.calls.exec).toContainEqual(["git", "clone", REMOTE, dir]);
  });

  test("redeem: switchboard url + admin token, explicitly faked via TeamDeps — peering applied", async () => {
    const fetchCalls: string[] = [];
    const probes = fakeProbes({
      home: HOME,
      fetch: async (url, init) => {
        fetchCalls.push(url);
        if (url.endsWith("/peer/join")) return { status: 200, body: "", headers: {} };
        return relayFetch()(url, init);
      },
      exec: () => ({ code: 0, stdout: "", stderr: "" }),
    });
    const deps = baseDeps({
      probes,
      joinRedeemSeams: fakeJoinRedeemSeams({
        read: fakeRead({ "mattstack.integrations": { switchboard: { url: "https://sb.test" } } }),
        readTeamSecret: async () => "admin-token",
      }),
    });

    await teamJoin(["--json"], {}, deps);

    const body = JSON.parse(deps.lines[0]!);
    expect(body.peering).toBe("applied");
    expect(fetchCalls).toContain("https://sb.test/peer/join");
  });

  test("redeem success clears the saved setup intent", async () => {
    const intentPath = pathJoin(HOME, ".mattstack", "rt", "setup-intent.json");
    const probes = fakeProbes({ home: HOME, fetch: relayFetch(), files: { [intentPath]: "{}" } });
    const deps = baseDeps({ probes });

    await teamJoin(["--json"], {}, deps);

    expect(probes.calls.removed).toContain(intentPath);
  });

  test("a relay failure during redeem exits 0 with access:unreachable, never 2", async () => {
    const probes = fakeProbes({
      home: HOME,
      fetch: async (url, init) => {
        if (url.endsWith(`/v1/invites/${ID_HEX}/redeem`)) return { status: 503, body: "", headers: {} };
        return relayFetch()(url, init);
      },
    });
    const deps = baseDeps({ probes });
    const exitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit sentinel — should not fire");
    });

    try {
      await teamJoin(["--json"], {}, deps);
    } finally {
      exitSpy.mockRestore();
    }

    expect(exitSpy).not.toHaveBeenCalled();
    const body = JSON.parse(deps.lines[0]!);
    expect(body.access).toBe("unreachable");
  });

  test("a keychain failure after clone+redeem is user-actionable — exit 2 with a decodable envelope, a distinct code keeping it from reading as a dead invite", async () => {
    const probes = fakeProbes({ home: HOME, fetch: relayFetch(), exec: () => ({ code: 0, stdout: "", stderr: "" }) });
    const deps = baseDeps({ probes, ageKeySeam: new FakeAgeKeySeamLocked() });

    const code = await runExpectingProcessExit(() => teamJoin(["--json"], {}, deps));

    expect(code).toBe(2);
    const body = JSON.parse(deps.lines[0]!);
    expect(body.error.code).toBe("age-key-unavailable");
    expect(body.error.message).toContain("redeemed the invite");
  });

  test("a keychain failure in human mode prints a clean one-liner, not a raw stack", async () => {
    const probes = fakeProbes({ home: HOME, fetch: relayFetch(), exec: () => ({ code: 0, stdout: "", stderr: "" }) });
    const deps = baseDeps({ probes, ageKeySeam: new FakeAgeKeySeamLocked() });

    const code = await runExpectingProcessExit(() => teamJoin([], {}, deps));

    expect(code).toBe(2);
    expect(deps.lines[0]).toContain("rt team join:");
    expect(deps.lines[0]).not.toContain("at ");
  });

  test("an undeterminable forge login exits 2, does not seal a guessed identity, and never redeems the invite (N1/R-T18-e)", async () => {
    const urls: string[] = [];
    const probes = fakeProbes({
      home: HOME,
      fetch: async (url, init) => {
        urls.push(url);
        return relayFetch()(url, init);
      },
      exec: () => ({ code: 0, stdout: "", stderr: "" }),
    });
    const deps = baseDeps({ probes, joinRedeemSeams: fakeJoinRedeemSeams({ forgeLogin: async () => null }) });

    const code = await runExpectingProcessExit(() => teamJoin(["--json"], {}, deps));

    expect(code).toBe(2);
    const body = JSON.parse(deps.lines[0]!);
    expect(body.error.code).toBe("forge-login-unknown");
    expect(body.error.message).toContain("has not been used yet");
    expect(urls.some((u) => u.endsWith("/redeem"))).toBe(false);
    const dir = pathJoin(HOME, ".mattstack", "teams", "acme");
    expect(probes.calls.exec).toContainEqual(["git", "clone", REMOTE, dir]);
  });
});
