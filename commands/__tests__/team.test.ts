import { describe, test, expect, spyOn } from "bun:test";
import { teamCreate, teamPublish, type TeamDeps } from "../team.ts";
import { fakeProbes } from "../../lib/setup/__tests__/fakes.ts";
import type { AgeExecResult, AgeKeySeam } from "../../lib/home/age-key.ts";

const FAKE_PUBLIC_KEY = "age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";
const FAKE_PRIVATE_KEY = "AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ";

class FakeAgeKeySeam implements AgeKeySeam {
  async run(cmd: string[]): Promise<AgeExecResult> {
    if (cmd[1] === "find-generic-password") return { code: 0, stdout: `${FAKE_PRIVATE_KEY}\n`, stderr: "" };
    if (cmd[0] === "age-keygen" && cmd[1] === "-y") return { code: 0, stdout: `${FAKE_PUBLIC_KEY}\n`, stderr: "" };
    throw new Error(`FakeAgeKeySeam: unexpected call ${cmd.join(" ")}`);
  }
}

function baseDeps(overrides: Partial<TeamDeps> = {}): TeamDeps & { lines: string[]; exitCodes: number[] } {
  const lines: string[] = [];
  const exitCodes: number[] = [];
  return {
    probes: fakeProbes({ home: "/home/x" }),
    print: (s: string) => lines.push(s),
    exit: (code: number) => {
      exitCodes.push(code);
      throw new Error("exit sentinel");
    },
    ageKeySeam: new FakeAgeKeySeam(),
    lines,
    exitCodes,
    ...overrides,
  };
}

/** For the `deps.exit`-injected exit-1 usage path (a bad-args refusal, no UserActionableError involved). */
async function expectDepsExit(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    throw new Error("expected exit sentinel, function returned normally");
  } catch (err) {
    if (!(err instanceof Error) || err.message !== "exit sentinel") throw err;
  }
}

/** `exitUserError` (lib/setup/errors.ts) calls the real `process.exit(2)` directly, not `deps.exit` — every UserActionableError path needs the process.exit spy, not the deps.exit sentinel. */
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

describe("teamCreate", () => {
  test("--json prints the contract envelope", async () => {
    const deps = baseDeps();
    await teamCreate(["Acme", "--remote", "https://github.com/acme/mattstack-team-acme.git", "--json"], {}, deps);

    expect(deps.lines).toHaveLength(1);
    const body = JSON.parse(deps.lines[0]!);
    expect(body).toMatchObject({
      contract: 1,
      slug: "acme",
      name: "Acme",
      remote: "https://github.com/acme/mattstack-team-acme.git",
      created: true,
    });
    expect(typeof body.at).toBe("string");
  });

  test("--others is recorded on the intent, not the printed envelope", async () => {
    const deps = baseDeps();
    await teamCreate(["Acme", "--remote", "https://github.com/acme/repo.git", "--others", "--json"], {}, deps);
    const body = JSON.parse(deps.lines[0]!);
    expect(body.slug).toBe("acme");
  });

  test("missing both --remote and --create-repo exits 2 with remote-required", async () => {
    const deps = baseDeps();
    const code = await runExpectingProcessExit(() => teamCreate(["Acme", "--json"], {}, deps));

    expect(code).toBe(2);
    const body = JSON.parse(deps.lines[0]!);
    expect(body.error.code).toBe("remote-required");
  });

  test("missing name prints usage and exits 1", async () => {
    const deps = baseDeps();
    await expectDepsExit(() => teamCreate(["--remote", "https://github.com/acme/repo.git"], {}, deps));

    expect(deps.exitCodes).toEqual([1]);
    expect(deps.lines[0]).toContain("usage:");
  });

  test("human output on success names the slug and remote", async () => {
    const deps = baseDeps();
    await teamCreate(["Acme", "--remote", "https://github.com/acme/repo.git"], {}, deps);

    expect(deps.lines[0]).toContain("acme");
    expect(deps.lines[0]).toContain("https://github.com/acme/repo.git");
  });
});

describe("teamPublish", () => {
  test("--team explicit: pushes and prints a human summary", async () => {
    const deps = baseDeps();
    await teamPublish(["--team", "acme", "--remote", "https://github.com/acme/repo.git"], {}, deps);

    expect(deps.lines[0]).toContain("acme");
    expect(deps.lines[0]).toContain("https://github.com/acme/repo.git");
  });

  test("--team explicit, --json prints the contract envelope", async () => {
    const deps = baseDeps();
    await teamPublish(["--team", "acme", "--remote", "https://github.com/acme/repo.git", "--json"], {}, deps);

    const body = JSON.parse(deps.lines[0]!);
    expect(body).toMatchObject({ contract: 1, remote: "https://github.com/acme/repo.git", pushed: true });
  });

  test("no --team and no local team clone exits 2 with no-team", async () => {
    const deps = baseDeps();
    const code = await runExpectingProcessExit(() => teamPublish(["--remote", "https://github.com/acme/repo.git", "--json"], {}, deps));

    expect(code).toBe(2);
    const body = JSON.parse(deps.lines[0]!);
    expect(body.error.code).toBe("no-team");
  });
});
