import { describe, test, expect, spyOn } from "bun:test";
import { join } from "path";
import { teamStatus, type TeamDeps } from "../team.ts";
import { fakeProbes } from "../../lib/setup/__tests__/fakes.ts";
import type { SettingsReader } from "../../lib/setup/team-settings.ts";

const HOME = "/home/x";
const SLUG = "acme";
const TEAM_DIR = join(HOME, ".mattstack", "teams", SLUG);
const GIT_CONFIG = `[remote "origin"]\n\turl = git@github.com:acme/widgets.git\n`;

function baseDeps(overrides: Partial<TeamDeps> = {}): TeamDeps & { lines: string[] } {
  const lines: string[] = [];
  return {
    probes: fakeProbes({ home: HOME }),
    print: (s: string) => lines.push(s),
    lines,
    ...overrides,
  };
}

function fakeRead(values: Record<string, unknown>): SettingsReader {
  return <T>(key: string): T | undefined => values[key] as T | undefined;
}

function clonedDeps(overrides: { exec?: TeamDeps["probes"]["exec"]; read?: Record<string, unknown> } = {}): TeamDeps & { lines: string[] } {
  return baseDeps({
    probes: fakeProbes({
      home: HOME,
      dirs: { [TEAM_DIR]: [] },
      files: { [join(TEAM_DIR, ".git", "config")]: GIT_CONFIG },
      exec: overrides.exec,
    }),
    statusRead: fakeRead(overrides.read ?? {}),
  });
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

describe("teamStatus", () => {
  test("--json prints the exact contract envelope: slug, name, remote, lastPush, members", async () => {
    const deps = clonedDeps({
      exec: async (argv) => {
        if (argv[0] === "git" && argv[2] === TEAM_DIR && argv[3] === "log") {
          return { code: 0, stdout: "2026-08-21T10:00:00+00:00\n", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      read: { "board.title": "Acme Team", "board.members": [{ username: "matt" }] },
    });

    await teamStatus(["--team", SLUG, "--json"], {}, deps);

    expect(deps.lines).toHaveLength(1);
    const { at, ...body } = JSON.parse(deps.lines[0]!);
    expect(typeof at).toBe("string");
    expect(body).toEqual({
      contract: 1,
      slug: "acme",
      name: "Acme Team",
      remote: "git@github.com:acme/widgets.git",
      lastPush: "2026-08-21T10:00:00+00:00",
      members: [{ username: "matt" }],
    });
  });

  test("no board.title -> name falls back to the slug", async () => {
    const deps = clonedDeps({ exec: async () => ({ code: 0, stdout: "2026-08-21T10:00:00+00:00\n", stderr: "" }) });

    await teamStatus(["--team", SLUG, "--json"], {}, deps);

    const body = JSON.parse(deps.lines[0]!);
    expect(body.name).toBe("acme");
    expect(body.members).toEqual([]);
  });

  test("git log failing -> lastPush is null, not the exit code or an empty string", async () => {
    const deps = clonedDeps({ exec: async () => ({ code: 128, stdout: "", stderr: "fatal: bad revision 'origin/main'" }) });

    await teamStatus(["--team", SLUG, "--json"], {}, deps);

    const body = JSON.parse(deps.lines[0]!);
    expect(body.lastPush).toBeNull();
  });

  test("no team cloned locally -> exits 2 with no-team", async () => {
    const deps = baseDeps({ probes: fakeProbes({ home: HOME }) }); // no team dir at all

    const code = await runExpectingProcessExit(() => teamStatus(["--team", SLUG, "--json"], {}, deps));

    expect(code).toBe(2);
    const body = JSON.parse(deps.lines[0]!);
    expect(body.error.code).toBe("no-team");
  });

  test("no --team and zero local teams -> exits 2 with no-team, from resolveTeamSlug", async () => {
    const deps = baseDeps();

    const code = await runExpectingProcessExit(() => teamStatus(["--json"], {}, deps));

    expect(code).toBe(2);
    const body = JSON.parse(deps.lines[0]!);
    expect(body.error.code).toBe("no-team");
  });

  test("human mode names the team and remote", async () => {
    const deps = clonedDeps({
      exec: async () => ({ code: 0, stdout: "2026-08-21T10:00:00+00:00\n", stderr: "" }),
      read: { "board.title": "Acme Team" },
    });

    await teamStatus(["--team", SLUG], {}, deps);

    expect(deps.lines[0]).toContain("Acme Team");
    expect(deps.lines[0]).toContain("widgets.git");
  });
});
