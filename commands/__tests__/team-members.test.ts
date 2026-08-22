import { describe, test, expect, spyOn } from "bun:test";
import { teamMembersRemove, type TeamDeps } from "../team.ts";
import { fakeProbes } from "../../lib/setup/__tests__/fakes.ts";

const HOME = "/home/x";

function baseDeps(overrides: Partial<TeamDeps> = {}): TeamDeps & { lines: string[] } {
  const lines: string[] = [];
  return {
    probes: fakeProbes({ home: HOME }),
    print: (s: string) => lines.push(s),
    lines,
    ...overrides,
  };
}

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

/**
 * `--key`'s value must actually reach `membersRemove`, not silently vanish —
 * this is the one flag in `commands/team.ts` where a dropped value falls
 * back to a DIFFERENT key (whatever the roster happens to record) rather
 * than to nothing. Both forms are proven the same way: an obviously-invalid
 * key makes `membersRemove`'s own bech32 validator throw before anything
 * team-clone-dependent runs, so reaching that exact `invalid-age-key` refusal
 * is proof the flag's value was parsed and passed through — a silently
 * dropped flag would instead fall through to the (empty, in this test)
 * roster lookup and exit 0.
 */
describe("teamMembersRemove --key parsing", () => {
  test("--key <value> (space form) reaches membersRemove", async () => {
    const deps = baseDeps();

    const code = await runExpectingProcessExit(() =>
      teamMembersRemove(["alice", "--key", "not-a-real-key", "--team", "acme", "--json"], {}, deps),
    );

    expect(code).toBe(2);
    const body = JSON.parse(deps.lines[0]!);
    expect(body.error.code).toBe("invalid-age-key");
  });

  test("--key=value (equals form) also reaches membersRemove, not silently dropped", async () => {
    const deps = baseDeps();

    const code = await runExpectingProcessExit(() =>
      teamMembersRemove(["alice", "--key=not-a-real-key", "--team", "acme", "--json"], {}, deps),
    );

    expect(code).toBe(2);
    const body = JSON.parse(deps.lines[0]!);
    expect(body.error.code).toBe("invalid-age-key");
  });

  test("--key=value does not leak into the positional handle", async () => {
    const deps = baseDeps();

    // No handle at all -> usage error, proving "--key=..." was stripped from positionals rather than being mistaken for one.
    const code = await runExpectingProcessExit(() => teamMembersRemove(["--key=age1whatever", "--team", "acme", "--json"], {}, deps));

    expect(code).toBe(2);
    const body = JSON.parse(deps.lines[0]!);
    expect(body.error.code).toBe("usage");
  });
});
