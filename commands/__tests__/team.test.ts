import { afterEach, beforeEach, describe, test, expect, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { teamCreate, teamInvite, teamPublish, type TeamDeps } from "../team.ts";
import { fakeProbes } from "../../lib/setup/__tests__/fakes.ts";
import type { AgeExecResult, AgeKeySeam } from "../../lib/home/age-key.ts";
import type { ExecScript } from "../../lib/setup/__tests__/fakes.ts";
import type { Probes } from "../../lib/setup/probes.ts";
import { pasteBlock } from "../../lib/team/invite.ts";

const FAKE_PUBLIC_KEY = "age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";
const FAKE_PRIVATE_KEY = "AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ";
const ZONE_DIR = "/home/x/.mattstack/teams/acme";

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

/** `publishTeam` prechecks the zone exists — every teamPublish test that means to reach the git steps needs it seeded. */
function depsWithZone(overrides: Partial<TeamDeps> = {}) {
  return baseDeps({ probes: fakeProbes({ home: "/home/x", dirs: { [ZONE_DIR]: [] } }), ...overrides });
}

/** Every exit path (usage refusals included, now that they route through `exitUserError`) calls the real `process.exit(2)`, never `deps.exit` — `deps.exit` stays only as a defensive sentinel that would fail a test loudly if some future path called it unexpectedly. */
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
  test("--json prints the exact contract envelope shape", async () => {
    const deps = baseDeps();
    await teamCreate(["Acme", "--remote", "https://github.com/acme/mattstack-team-acme.git", "--json"], {}, deps);

    expect(deps.lines).toHaveLength(1);
    const { at, ...body } = JSON.parse(deps.lines[0]!);
    expect(typeof at).toBe("string");
    expect(body).toEqual({
      contract: 1,
      slug: "acme",
      name: "Acme",
      remote: "https://github.com/acme/mattstack-team-acme.git",
      dir: ZONE_DIR,
      created: true,
    });
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

  test("missing name, --json: exits 2 with the usage envelope, not a plain-text line", async () => {
    const deps = baseDeps();
    const code = await runExpectingProcessExit(() => teamCreate(["--remote", "https://github.com/acme/repo.git", "--json"], {}, deps));

    expect(code).toBe(2);
    const body = JSON.parse(deps.lines[0]!);
    expect(body.error.code).toBe("usage");
    expect(body.error.message).toContain("usage:");
  });

  test("missing name, human mode: prints usage and exits 2", async () => {
    const deps = baseDeps();
    const code = await runExpectingProcessExit(() => teamCreate(["--remote", "https://github.com/acme/repo.git"], {}, deps));

    expect(code).toBe(2);
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
    const deps = depsWithZone();
    await teamPublish(["--team", "acme", "--remote", "https://github.com/acme/repo.git"], {}, deps);

    expect(deps.lines[0]).toContain("acme");
    expect(deps.lines[0]).toContain("https://github.com/acme/repo.git");
  });

  test("--team explicit, --json prints the exact contract envelope shape", async () => {
    const deps = depsWithZone();
    await teamPublish(["--team", "acme", "--remote", "https://github.com/acme/repo.git", "--json"], {}, deps);

    const { at, ...body } = JSON.parse(deps.lines[0]!);
    expect(typeof at).toBe("string");
    expect(body).toEqual({
      contract: 1,
      remote: "https://github.com/acme/repo.git",
      pushed: true,
      detail: "pushed to https://github.com/acme/repo.git",
    });
  });

  test("the push carries the forge token rt holds for the remote, through the env", async () => {
    const seen: { argv: string[]; env?: Record<string, string> }[] = [];
    const probes = fakeProbes({
      home: "/home/x",
      dirs: { [ZONE_DIR]: [] },
      exec: (argv, opts) => {
        seen.push({ argv, env: opts?.env });
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const deps = baseDeps({ probes, forgeToken: async (_p, remote) => (remote.includes("acme/repo") ? "ghp-secret" : null) });

    await teamPublish(["--team", "acme", "--remote", "https://github.com/acme/repo.git"], {}, deps);

    const push = seen.find((c) => c.argv.includes("push"))!;
    expect(push.argv).toContain("credential.helper=");
    expect(push.env?.RT_GIT_TOKEN).toBe("ghp-secret");
    expect(push.argv.join(" ")).not.toContain("ghp-secret");
  });

  test("no --team and no local team clone exits 2 with no-team", async () => {
    const deps = baseDeps();
    const code = await runExpectingProcessExit(() => teamPublish(["--remote", "https://github.com/acme/repo.git", "--json"], {}, deps));

    expect(code).toBe(2);
    const body = JSON.parse(deps.lines[0]!);
    expect(body.error.code).toBe("no-team");
  });

  test("--team given but no zone on disk exits 2 with no-team-zone", async () => {
    const deps = baseDeps(); // ZONE_DIR deliberately not seeded
    const code = await runExpectingProcessExit(() => teamPublish(["--team", "acme", "--remote", "https://github.com/acme/repo.git", "--json"], {}, deps));

    expect(code).toBe(2);
    const body = JSON.parse(deps.lines[0]!);
    expect(body.error.code).toBe("no-team-zone");
  });
});

/**
 * `teamInvite` mints through `mintInvite`'s DEFAULT seams (not injectable at
 * the command layer), which read/write real settings stores via
 * process.env.HOME — so, unlike the fakeProbes-only tests above, this needs
 * a real temp HOME seeded with a real team store, mirrored into fakeProbes
 * at the same paths for the Probes-mediated reads (git config, exec, fetch).
 */
describe("teamInvite", () => {
  const origHome = process.env.HOME;
  let home: string;
  let teamDir: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-team-invite-cmd-home-")));
    process.env.HOME = home;

    teamDir = join(home, ".mattstack", "teams", "acme");
    mkdirSync(join(teamDir, "mattstack"), { recursive: true });
    writeFileSync(join(teamDir, "mattstack", "settings.team.jsonc"), `${JSON.stringify({ "board.title": "Acme Team" }, null, 2)}\n`);
    mkdirSync(join(teamDir, ".git"), { recursive: true });
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(home, { recursive: true, force: true });
  });

  const GIT_CONFIG = `[remote "origin"]\n\turl = git@github.com:acme/widgets.git\n`;

  function ghExec(putResult: { code: number; stdout: string; stderr: string } = { code: 0, stdout: "", stderr: "" }): ExecScript {
    return (argv) => {
      if (argv[0] === "gh" && argv[1] === "api" && argv[2] === "user") return { code: 0, stdout: JSON.stringify({ login: "octocat" }), stderr: "" };
      if (argv[0] === "gh" && argv[2] === "-X" && argv[3] === "PUT") return putResult;
      return { code: 0, stdout: "", stderr: "" };
    };
  }

  function relayFetch(): Probes["fetch"] {
    return async (url, init) => {
      if (init?.method === "POST" && url.endsWith("/v1/invites")) {
        const body = JSON.parse(init.body ?? "{}") as { id?: string };
        return { status: 200, body: JSON.stringify({ id: body.id ?? "0".repeat(32), creatorSecret: "creator-secret-1" }), headers: {} };
      }
      return { status: 404, body: "", headers: {} };
    };
  }

  function inviteDeps(overrides: { exec?: ExecScript } = {}): TeamDeps & { lines: string[]; exitCodes: number[] } {
    return baseDeps({
      probes: fakeProbes({
        home,
        files: { [join(teamDir, ".git", "config")]: GIT_CONFIG },
        exec: overrides.exec ?? ghExec(),
        fetch: relayFetch(),
      }),
    });
  }

  test("--json prints the exact contract envelope shape", async () => {
    const deps = inviteDeps();
    await teamInvite(["--handle", "zaphod", "--json"], {}, deps);

    expect(deps.lines).toHaveLength(1);
    const parsed = JSON.parse(deps.lines[0]!);
    expect(Object.keys(parsed).sort()).toEqual(["at", "code", "contract", "expiresAt", "forgeAccess", "manualSteps", "pasteBlock"]);
    expect(typeof parsed.at).toBe("string");
    // `code` is a fresh random secret every mint — every other field is exact, and pasteBlock is exact once code is known.
    expect(typeof parsed.code).toBe("string");
    expect(parsed.contract).toBe(1);
    expect(parsed.expiresAt).toBe("2026-01-08T00:00:00.000Z");
    // "skipped" is the default shape since MAT-387: rt does not administer
    // membership on a team repo unless explicitly permitted. The value is one
    // the contract and the app already accept ("granted"|"manual"|"skipped").
    expect(parsed.forgeAccess).toBe("skipped");
    expect(parsed.manualSteps).toHaveLength(1);
    expect((parsed.manualSteps as string[])[0]).toContain("Ask whoever administers");
    expect(parsed.pasteBlock).toBe(pasteBlock(parsed.code));
  });

  test("missing --handle, --json: exits 2 with the usage envelope", async () => {
    const deps = baseDeps();
    const code = await runExpectingProcessExit(() => teamInvite(["--json"], {}, deps));

    expect(code).toBe(2);
    const body = JSON.parse(deps.lines[0]!);
    expect(body.error.code).toBe("usage");
    expect(body.error.message).toContain("usage:");
  });

  test("missing --handle, human mode: prints usage and exits 2", async () => {
    const deps = baseDeps();
    const code = await runExpectingProcessExit(() => teamInvite([], {}, deps));

    expect(code).toBe(2);
    expect(deps.lines[0]).toContain("usage:");
  });

  test("human output names who to ask, since rt does not manage membership", async () => {
    const deps = inviteDeps({ exec: ghExec({ code: 127, stdout: "", stderr: "ENOENT: gh" }) });
    await teamInvite(["--handle", "zaphod"], {}, deps);

    expect(deps.lines[0]).toContain("mattstack://join/");
    const rest = deps.lines.slice(1).join("\n");
    expect(rest).toContain("forge access is skipped");
    expect(rest).toContain("Ask whoever administers");
    expect(rest).toContain("zaphod");
  });
});
