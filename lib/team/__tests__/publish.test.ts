import { describe, test, expect } from "bun:test";
import { fakeProbes } from "../../setup/__tests__/fakes.ts";
import { publishTeam } from "../publish.ts";
import { teamLocalPath } from "../team-local.ts";
import { UserActionableError } from "../../setup/errors.ts";

const DIR = "/home/x/.mattstack/teams/acme";

/** publishTeam prechecks the zone exists (finding 7) — every test that means to reach the git steps must seed the dir. */
function probesWithZone(overrides: Parameters<typeof fakeProbes>[0] = {}) {
  return fakeProbes({ dirs: { [DIR]: [] }, ...overrides });
}

describe("publishTeam", () => {
  test("set-url then push -u origin main", async () => {
    const p = probesWithZone({ home: "/home/x" });
    const result = await publishTeam(p, "acme", "https://github.com/acme/repo.git");

    expect(p.calls.exec).toEqual([
      ["git", "remote", "set-url", "origin", "https://github.com/acme/repo.git"],
      ["git", "push", "-u", "origin", "main"],
    ]);
    expect(result).toEqual({ remote: "https://github.com/acme/repo.git", pushed: true, detail: "pushed to https://github.com/acme/repo.git" });
  });

  // Install pushes before git has any credential of its own on a fresh
  // machine; the token rt holds rides in the environment, never argv.
  test("with a token: push goes through an inline credential helper, token only in env", async () => {
    const p = probesWithZone({ home: "/home/x" });
    const seen: { argv: string[]; env?: Record<string, string> }[] = [];
    p.exec = async (argv, opts) => {
      seen.push({ argv, env: opts?.env });
      return { code: 0, stdout: "", stderr: "" };
    };
    const result = await publishTeam(p, "acme", "https://github.com/acme/repo.git", { token: "ghp_secret" });
    const push = seen.find((c) => c.argv.includes("push"))!;
    expect(push.argv.join(" ")).toContain("credential.helper=");
    expect(push.argv.join(" ")).not.toContain("ghp_secret");
    expect(push.env?.RT_GIT_TOKEN).toBe("ghp_secret");
    expect(result.pushed).toBe(true);
  });

  test("falls back to remote add when set-url fails (no origin yet)", async () => {
    const p = probesWithZone({
      home: "/home/x",
      exec: (argv) => (argv[2] === "set-url" ? { code: 2, stdout: "", stderr: "error: No such remote 'origin'" } : { code: 0, stdout: "", stderr: "" }),
    });
    await publishTeam(p, "acme", "https://github.com/acme/repo.git");

    expect(p.calls.exec).toEqual([
      ["git", "remote", "set-url", "origin", "https://github.com/acme/repo.git"],
      ["git", "remote", "add", "origin", "https://github.com/acme/repo.git"],
      ["git", "push", "-u", "origin", "main"],
    ]);
  });

  test("no explicit remote: pushes with the existing origin, no remote-changing calls", async () => {
    const p = probesWithZone({
      home: "/home/x",
      files: { [`${DIR}/.git/config`]: '[remote "origin"]\n\turl = https://github.com/acme/repo.git\n' },
    });
    const result = await publishTeam(p, "acme", null);

    expect(p.calls.exec).toEqual([["git", "push", "-u", "origin", "main"]]);
    expect(result.remote).toBe("https://github.com/acme/repo.git");
  });

  test("no zone for the slug: typed no-team-zone error, no exec calls at all", async () => {
    const p = fakeProbes({ home: "/home/x" }); // DIR deliberately not seeded

    let thrown: unknown;
    try {
      await publishTeam(p, "acme", "https://github.com/acme/repo.git");
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(UserActionableError);
    expect((thrown as UserActionableError).code).toBe("no-team-zone");
    expect(p.calls.exec).toEqual([]);
  });

  test("publish refuses on a joined clone", async () => {
    const p = probesWithZone({
      home: "/home/x",
      files: { [teamLocalPath("/home/x", "acme")]: JSON.stringify({ createdByRt: false, joinedByRt: true, rtMayManageMembership: false }) },
    });

    let thrown: unknown;
    try {
      await publishTeam(p, "acme", null);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(UserActionableError);
    expect((thrown as UserActionableError).code).toBe("team-pull-only");
    expect((thrown as UserActionableError).message).toMatch(/pull-only/);
    expect(p.calls.exec).toEqual([]);
  });

  test("an unvalidated --team never resolves outside teamsDir()", async () => {
    const p = fakeProbes({ home: "/home/x", dirs: { "/some/other-repo": [] } });

    let thrown: unknown;
    try {
      await publishTeam(p, "../../some-repo", "https://github.com/acme/repo.git");
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(UserActionableError);
    expect((thrown as UserActionableError).code).toBe("invalid-team-slug");
    expect(p.calls.exec).toEqual([]);
  });

  test("auth failure (exit 128) throws push-denied with the credential-bearing URL stripped", async () => {
    const remote = "https://x-access-token:SECRET@github.com/acme/repo.git";
    const p = probesWithZone({
      home: "/home/x",
      exec: (argv) =>
        argv[0] === "git" && argv[1] === "push"
          ? { code: 128, stdout: "", stderr: `fatal: Authentication failed for '${remote}'` }
          : { code: 0, stdout: "", stderr: "" },
    });

    let thrown: unknown;
    try {
      await publishTeam(p, "acme", remote);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(UserActionableError);
    const err = thrown as UserActionableError;
    expect(err.code).toBe("push-denied");
    expect(err.message).not.toContain("SECRET");
    expect(err.message).not.toContain("https://");
  });

  test("non-fast-forward rejection (existing EMPTY-repo contract violated) is a typed remote-not-empty error", async () => {
    const p = probesWithZone({
      home: "/home/x",
      exec: (argv) =>
        argv[0] === "git" && argv[1] === "push"
          ? { code: 1, stdout: "", stderr: "! [rejected]        main -> main (fetch first)\nerror: failed to push some refs" }
          : { code: 0, stdout: "", stderr: "" },
    });

    let thrown: unknown;
    try {
      await publishTeam(p, "acme", "https://github.com/acme/repo.git");
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(UserActionableError);
    const err = thrown as UserActionableError;
    expect(err.code).toBe("remote-not-empty");
    expect(err.message).toContain("EMPTY");
  });

  test("every other push failure is still a typed, redacted error — never a plain Error crash", async () => {
    const remote = "https://x-access-token:SECRET@github.com/acme/repo.git";
    const p = probesWithZone({
      home: "/home/x",
      exec: (argv) =>
        argv[0] === "git" && argv[1] === "push"
          ? { code: 1, stdout: "", stderr: `fatal: unable to access '${remote}': Could not resolve host` }
          : { code: 0, stdout: "", stderr: "" },
    });

    let thrown: unknown;
    try {
      await publishTeam(p, "acme", remote);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(UserActionableError);
    const err = thrown as UserActionableError;
    expect(err.code).toBe("push-failed");
    expect(err.message).not.toContain("SECRET");
  });

  test("a failed remote add is also a typed, redacted error", async () => {
    const remote = "https://x-access-token:SECRET@github.com/acme/repo.git";
    const p = probesWithZone({
      home: "/home/x",
      exec: (argv) => (argv[0] === "git" && argv[1] === "remote" ? { code: 1, stdout: "", stderr: `fatal: bad remote ${remote}` } : { code: 0, stdout: "", stderr: "" }),
    });

    let thrown: unknown;
    try {
      await publishTeam(p, "acme", remote);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(UserActionableError);
    const err = thrown as UserActionableError;
    expect(err.code).toBe("git-remote-failed");
    expect(err.message).not.toContain("SECRET");
  });

  test("a credential-bearing remote is stripped of userinfo before it reaches the returned result (the JSON envelope's source)", async () => {
    const p = probesWithZone({ home: "/home/x" });
    const result = await publishTeam(p, "acme", "https://x-access-token:SECRET@github.com/acme/repo.git");

    expect(result.remote).toBe("https://github.com/acme/repo.git");
    expect(result.detail).not.toContain("SECRET");
  });
});
