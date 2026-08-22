import { describe, test, expect } from "bun:test";
import { fakeProbes, ok, missing } from "../../setup/__tests__/fakes.ts";
import { grantRead, revokeRead, forgeLogin } from "../forge.ts";
import type { ExecScript } from "../../setup/__tests__/fakes.ts";

const GITHUB_REMOTE = "git@github.com:acme/widgets.git";
const GITLAB_REMOTE = "https://gitlab.com/acme/widgets.git";
const SELF_HOSTED_GITLAB_REMOTE = "https://gitlab.acme.internal/acme/widgets.git";

describe("grantRead", () => {
  test("github: PUTs the collaborator with pull permission on success", async () => {
    const script: ExecScript = () => ok();
    const p = fakeProbes({ exec: script });

    const result = await grantRead(p, GITHUB_REMOTE, "octocat");

    expect(result).toEqual({ access: "granted", manualSteps: [] });
    expect(p.calls.exec).toEqual([["gh", "api", "-X", "PUT", "/repos/acme/widgets/collaborators/octocat", "-f", "permission=pull"]]);
  });

  test("github: gh missing (127) reports manual with the settings-access URL", async () => {
    const script: ExecScript = () => missing("gh");
    const p = fakeProbes({ exec: script });

    const result = await grantRead(p, GITHUB_REMOTE, "octocat");

    expect(result).toEqual({
      access: "manual",
      manualSteps: ["Open https://github.com/acme/widgets/settings/access", "Invite octocat with Read"],
    });
  });

  test("github: a non-zero exit also reports manual", async () => {
    const script: ExecScript = () => ({ code: 1, stdout: "", stderr: "not found" });
    const p = fakeProbes({ exec: script });

    const result = await grantRead(p, GITHUB_REMOTE, "octocat");

    expect(result.access).toBe("manual");
  });

  test("gitlab: looks up the user id, then POSTs a Reporter (access_level=20) membership", async () => {
    const script: ExecScript = (argv) => {
      if (argv[2] === "users?username=zaphod") return ok(JSON.stringify([{ id: 42 }]));
      return ok();
    };
    const p = fakeProbes({ exec: script });

    const result = await grantRead(p, GITLAB_REMOTE, "zaphod");

    expect(result).toEqual({ access: "granted", manualSteps: [] });
    expect(p.calls.exec).toEqual([
      ["glab", "api", "users?username=zaphod"],
      ["glab", "api", "-X", "POST", "projects/acme%2Fwidgets/members", "-f", "user_id=42", "-f", "access_level=20"],
    ]);
  });

  test("gitlab: an unresolvable username reports manual with the project-members URL", async () => {
    const script: ExecScript = (argv) => {
      if (argv[2]?.startsWith("users?")) return { code: 0, stdout: "[]", stderr: "" };
      return ok();
    };
    const p = fakeProbes({ exec: script });

    const result = await grantRead(p, GITLAB_REMOTE, "zaphod");

    expect(result).toEqual({
      access: "manual",
      manualSteps: ["Open https://gitlab.com/acme/widgets/-/project_members", "Invite zaphod with Reporter access"],
    });
  });

  test("gitlab: a failing members POST reports manual", async () => {
    const script: ExecScript = (argv) => {
      if (argv[2]?.startsWith("users?")) return ok(JSON.stringify([{ id: 42 }]));
      return { code: 1, stdout: "", stderr: "forbidden" };
    };
    const p = fakeProbes({ exec: script });

    const result = await grantRead(p, GITLAB_REMOTE, "zaphod");

    expect(result.access).toBe("manual");
  });

  test("gitlab: a self-hosted remote targets glab at that host via GITLAB_HOST", async () => {
    const calls: Array<{ argv: string[]; env?: Record<string, string> }> = [];
    const script: ExecScript = (argv, opts) => {
      calls.push({ argv, env: opts?.env });
      if (argv[2]?.startsWith("users?")) return ok(JSON.stringify([{ id: 7 }]));
      return ok();
    };
    const p = fakeProbes({ exec: script });

    await grantRead(p, SELF_HOSTED_GITLAB_REMOTE, "zaphod");

    for (const call of calls) {
      expect(call.env).toEqual({ GITLAB_HOST: "gitlab.acme.internal" });
    }
  });

  test("an unparsable remote is skipped, not manual", async () => {
    const p = fakeProbes();
    const result = await grantRead(p, "not-a-remote", "octocat");
    expect(result).toEqual({ access: "skipped", manualSteps: [] });
    expect(p.calls.exec).toEqual([]);
  });
});

describe("revokeRead", () => {
  test("github: DELETEs the collaborator", async () => {
    const script: ExecScript = () => ok();
    const p = fakeProbes({ exec: script });

    const result = await revokeRead(p, GITHUB_REMOTE, "octocat");

    expect(result).toEqual({ access: "granted", manualSteps: [] });
    expect(p.calls.exec).toEqual([["gh", "api", "-X", "DELETE", "/repos/acme/widgets/collaborators/octocat"]]);
  });

  test("gitlab: looks up the user id, then DELETEs the membership", async () => {
    const script: ExecScript = (argv) => {
      if (argv[2] === "users?username=zaphod") return ok(JSON.stringify([{ id: 42 }]));
      return ok();
    };
    const p = fakeProbes({ exec: script });

    const result = await revokeRead(p, GITLAB_REMOTE, "zaphod");

    expect(result).toEqual({ access: "granted", manualSteps: [] });
    expect(p.calls.exec).toEqual([
      ["glab", "api", "users?username=zaphod"],
      ["glab", "api", "-X", "DELETE", "projects/acme%2Fwidgets/members/42"],
    ]);
  });

  test("an unparsable remote is skipped", async () => {
    const p = fakeProbes();
    const result = await revokeRead(p, "not-a-remote", "octocat");
    expect(result).toEqual({ access: "skipped", manualSteps: [] });
  });
});

describe("forgeLogin", () => {
  test("github: reads gh api user's login", async () => {
    const script: ExecScript = () => ok(JSON.stringify({ login: "octocat" }));
    const p = fakeProbes({ exec: script });

    expect(await forgeLogin(p, "github", "github.com")).toBe("octocat");
    expect(p.calls.exec).toEqual([["gh", "api", "user"]]);
  });

  test("github: no gh session returns null", async () => {
    const script: ExecScript = () => missing("gh");
    const p = fakeProbes({ exec: script });
    expect(await forgeLogin(p, "github", "github.com")).toBeNull();
  });

  test("gitlab: reads glab api user's username", async () => {
    const script: ExecScript = () => ok(JSON.stringify({ username: "zaphod" }));
    const p = fakeProbes({ exec: script });

    expect(await forgeLogin(p, "gitlab", "gitlab.com")).toBe("zaphod");
    expect(p.calls.exec).toEqual([["glab", "api", "user"]]);
  });

  test("gitlab: a self-hosted host is passed via GITLAB_HOST", async () => {
    let seenEnv: Record<string, string> | undefined;
    const script: ExecScript = (_argv, opts) => {
      seenEnv = opts?.env;
      return ok(JSON.stringify({ username: "zaphod" }));
    };
    const p = fakeProbes({ exec: script });

    await forgeLogin(p, "gitlab", "gitlab.acme.internal");

    expect(seenEnv).toEqual({ GITLAB_HOST: "gitlab.acme.internal" });
  });

  test("a malformed JSON response returns null rather than throwing", async () => {
    const script: ExecScript = () => ok("not json");
    const p = fakeProbes({ exec: script });
    expect(await forgeLogin(p, "github", "github.com")).toBeNull();
  });
});
