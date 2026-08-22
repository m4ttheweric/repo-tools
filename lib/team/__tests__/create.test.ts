import { describe, test, expect } from "bun:test";
import { join } from "path";
import { fakeProbes } from "../../setup/__tests__/fakes.ts";
import { createTeam, scaffoldFiles } from "../create.ts";
import { UserActionableError } from "../../setup/errors.ts";
import { readIntent } from "../../setup/intent.ts";
import type { AgeExecResult, AgeKeySeam } from "../../home/age-key.ts";

const FAKE_PUBLIC_KEY = "age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";
const FAKE_PRIVATE_KEY = "AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ";

/** An age key already in the keychain — ensureAgeKey only derives its public half, never mints. */
class FakeAgeKeySeam implements AgeKeySeam {
  calls: string[][] = [];
  async run(cmd: string[]): Promise<AgeExecResult> {
    this.calls.push(cmd);
    if (cmd[1] === "find-generic-password") return { code: 0, stdout: `${FAKE_PRIVATE_KEY}\n`, stderr: "" };
    if (cmd[0] === "age-keygen" && cmd[1] === "-y") return { code: 0, stdout: `${FAKE_PUBLIC_KEY}\n`, stderr: "" };
    throw new Error(`FakeAgeKeySeam: unexpected call ${cmd.join(" ")}`);
  }
}

/** `settings.team.jsonc`'s content is a one-line header comment followed by the JSON body. */
function parseSettingsBody(content: string): Record<string, unknown> {
  return JSON.parse(content.split("\n").slice(1).join("\n"));
}

/**
 * `createTeam`'s idempotency check reads `.git/config` (mirroring
 * `team-settings.ts`'s own `readTeamSnapshot`), which real git writes as a
 * side effect of `git remote add`. A fake exec has no such side effect on
 * its own, so this simulates just enough of it for a second `createTeam`
 * call against the same fake to see the first call's remote.
 */
function fakeProbesWithGitRemoteSideEffect(home: string) {
  const p = fakeProbes({
    home,
    exec: (argv, execOpts) => {
      if (argv[0] === "git" && argv[1] === "remote" && argv[2] === "add" && execOpts?.cwd) {
        p.writeFile(join(execOpts.cwd, ".git", "config"), `[remote "origin"]\n\turl = ${argv[4]}\n`);
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  return p;
}

describe("scaffoldFiles", () => {
  test("gitlab remote: forge + board.gitlabHost both present", () => {
    const files = scaffoldFiles("acme", "Acme", "https://gitlab.example.com/g/acme.git");
    const settings = parseSettingsBody(files["mattstack/settings.team.jsonc"]!);
    expect((settings["mattstack.integrations"] as any).forge).toEqual({ host: "gitlab.example.com", provider: "gitlab" });
    expect(settings["board.gitlabHost"]).toBe("gitlab.example.com");
  });

  test("github remote: no board.gitlabHost key at all", () => {
    const files = scaffoldFiles("acme", "Acme", "https://github.com/acme/mattstack-team-acme.git");
    const settings = parseSettingsBody(files["mattstack/settings.team.jsonc"]!);
    expect((settings["mattstack.integrations"] as any).forge).toEqual({ host: "github.com", provider: "github" });
    expect("board.gitlabHost" in settings).toBe(false);
  });

  test("seeds .sops.yaml with the given recipients, not empty", () => {
    const files = scaffoldFiles("acme", "Acme", "https://github.com/acme/repo.git", [FAKE_PUBLIC_KEY]);
    expect(files[".sops.yaml"]).toContain(`age: ${FAKE_PUBLIC_KEY}`);
  });

  test("mattstack.jsonc names the owner parsed from the remote", () => {
    const files = scaffoldFiles("acme", "Acme", "https://github.com/acme/mattstack-team-acme.git");
    expect(JSON.parse(files["mattstack/mattstack.jsonc"]!)).toEqual({ role: "team", namespace: "acme", org: "acme" });
  });
});

describe("createTeam", () => {
  test("argv sequence is init → add → commit → remote add, never push", async () => {
    const p = fakeProbes({ home: "/home/x" });
    const result = await createTeam(
      p,
      { name: "Acme", remote: "https://github.com/acme/mattstack-team-acme.git", others: false },
      new FakeAgeKeySeam(),
    );

    expect(result).toEqual({
      slug: "acme",
      name: "Acme",
      remote: "https://github.com/acme/mattstack-team-acme.git",
      dir: join("/home/x", ".mattstack", "teams", "acme"),
      created: true,
    });

    expect(p.calls.exec).toEqual([
      ["git", "init", "-b", "main"],
      ["git", "add", "-A"],
      ["git", "commit", "-m", "team: scaffold acme"],
      ["git", "remote", "add", "origin", "https://github.com/acme/mattstack-team-acme.git"],
    ]);
  });

  test("writes the setup intent for the daemon/apply to resume from", async () => {
    const p = fakeProbes({ home: "/home/x" });
    await createTeam(p, { name: "Acme", remote: "https://github.com/acme/repo.git", others: true }, new FakeAgeKeySeam());

    const intent = readIntent(p);
    expect(intent?.mode).toBe("create");
    expect(intent?.team).toEqual({ slug: "acme", name: "Acme", remote: "https://github.com/acme/repo.git", others: true });
  });

  test("missing remote and --create-repo throws remote-required", async () => {
    const p = fakeProbes({ home: "/home/x" });
    await expect(createTeam(p, { name: "Acme", remote: null, others: false }, new FakeAgeKeySeam())).rejects.toMatchObject({
      code: "remote-required",
    });
    expect(p.calls.exec).toEqual([]);
  });

  test("--create-repo o creates o/mattstack-team-<slug> via gh and the printed URL becomes the remote", async () => {
    const p = fakeProbes({
      home: "/home/x",
      exec: (argv) => {
        if (argv[0] === "gh") return { code: 0, stdout: "https://github.com/o/mattstack-team-acme\n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const result = await createTeam(p, { name: "Acme", remote: null, createRepoOwner: "o", others: false }, new FakeAgeKeySeam());

    expect(p.calls.exec[0]).toEqual(["gh", "repo", "create", "o/mattstack-team-acme", "--private"]);
    expect(result.remote).toBe("https://github.com/o/mattstack-team-acme");
  });

  test("second call with the same remote is idempotent: created:false, zero git calls", async () => {
    const p = fakeProbesWithGitRemoteSideEffect("/home/x");
    await createTeam(p, { name: "Acme", remote: "https://github.com/acme/repo.git", others: false }, new FakeAgeKeySeam());
    p.calls.exec.length = 0;

    const result = await createTeam(p, { name: "Acme", remote: "https://github.com/acme/repo.git", others: false }, new FakeAgeKeySeam());

    expect(result.created).toBe(false);
    expect(p.calls.exec).toEqual([]);
  });

  test("existing dir with a different remote throws team-exists", async () => {
    const p = fakeProbesWithGitRemoteSideEffect("/home/x");
    await createTeam(p, { name: "Acme", remote: "https://github.com/acme/repo.git", others: false }, new FakeAgeKeySeam());

    await expect(
      createTeam(p, { name: "Acme", remote: "https://github.com/other/repo.git", others: false }, new FakeAgeKeySeam()),
    ).rejects.toMatchObject({ code: "team-exists" });
  });
});
