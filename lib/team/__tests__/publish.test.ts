import { describe, test, expect } from "bun:test";
import { fakeProbes } from "../../setup/__tests__/fakes.ts";
import { publishTeam } from "../publish.ts";
import { UserActionableError } from "../../setup/errors.ts";

describe("publishTeam", () => {
  test("set-url then push -u origin main", async () => {
    const p = fakeProbes({ home: "/home/x" });
    const result = await publishTeam(p, "acme", "https://github.com/acme/repo.git");

    expect(p.calls.exec).toEqual([
      ["git", "remote", "set-url", "origin", "https://github.com/acme/repo.git"],
      ["git", "push", "-u", "origin", "main"],
    ]);
    expect(result).toEqual({ remote: "https://github.com/acme/repo.git", pushed: true, detail: "pushed to https://github.com/acme/repo.git" });
  });

  test("falls back to remote add when set-url fails (no origin yet)", async () => {
    const p = fakeProbes({
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
    const p = fakeProbes({
      home: "/home/x",
      files: { "/home/x/.mattstack/teams/acme/.git/config": '[remote "origin"]\n\turl = https://github.com/acme/repo.git\n' },
    });
    const result = await publishTeam(p, "acme", null);

    expect(p.calls.exec).toEqual([["git", "push", "-u", "origin", "main"]]);
    expect(result.remote).toBe("https://github.com/acme/repo.git");
  });

  test("auth failure (exit 128) throws push-denied with the credential-bearing URL stripped", async () => {
    const remote = "https://x-access-token:SECRET@github.com/acme/repo.git";
    const p = fakeProbes({
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

  test("non-auth push failure is not push-denied — it propagates as a real error", async () => {
    const p = fakeProbes({
      home: "/home/x",
      exec: (argv) =>
        argv[0] === "git" && argv[1] === "push" ? { code: 1, stdout: "", stderr: "fatal: the remote end hung up unexpectedly" } : { code: 0, stdout: "", stderr: "" },
    });

    let thrown: unknown;
    try {
      await publishTeam(p, "acme", "https://github.com/acme/repo.git");
    } catch (err) {
      thrown = err;
    }

    expect(thrown).not.toBeInstanceOf(UserActionableError);
    expect(thrown).toBeInstanceOf(Error);
  });
});
