import { describe, test, expect, spyOn } from "bun:test";
import { join as pathJoin } from "path";
import { teamJoin, type TeamDeps } from "../team.ts";
import { fakeProbes } from "../../lib/setup/__tests__/fakes.ts";
import type { AgeExecResult, AgeKeySeam } from "../../lib/home/age-key.ts";
import { encodeCode, seal } from "../../lib/team/invite-crypto.ts";
import type { InvitePointer } from "../../lib/setup/intent.ts";
import type { Probes } from "../../lib/setup/probes.ts";

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

function baseDeps(overrides: Partial<TeamDeps> = {}): TeamDeps & { lines: string[] } {
  const lines: string[] = [];
  return {
    probes: fakeProbes({ home: HOME, exec: () => ({ code: 0, stdout: "", stderr: "" }) }),
    print: (s: string) => lines.push(s),
    ageKeySeam: new FakeAgeKeySeam(),
    readCode: async () => CODE,
    lines,
    ...overrides,
  };
}

/** Every exit path calls the real `process.exit(2)` (via `exitUserError`), never `deps.exit`. */
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
    expect(["applied", "idle", "unavailable"]).toContain(body.peering);
    expect(body.message).toBe("Joined Acme (owner matt)");

    const dir = pathJoin(HOME, ".mattstack", "teams", "acme");
    expect(probes.calls.exec).toContainEqual(["git", "clone", REMOTE, dir]);
  });

  test("redeem success clears the saved setup intent", async () => {
    const intentPath = pathJoin(HOME, ".mattstack", "rt", "setup-intent.json");
    const probes = fakeProbes({ home: HOME, fetch: relayFetch(), files: { [intentPath]: "{}" } });
    const deps = baseDeps({ probes });

    await teamJoin(["--json"], {}, deps);

    expect(probes.calls.removed).toContain(intentPath);
  });
});
