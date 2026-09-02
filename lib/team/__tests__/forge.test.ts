import { describe, test, expect } from "bun:test";
import { fakeProbes, ok, missing } from "../../setup/__tests__/fakes.ts";
import { grantRead, revokeRead, forgeLogin, forgeArgv } from "../forge.ts";
import type { ExecScript } from "../../setup/__tests__/fakes.ts";

const GITHUB_REMOTE = "git@github.com:acme/widgets.git";
const GITLAB_REMOTE = "https://gitlab.com/acme/widgets.git";
const SELF_HOSTED_GITLAB_REMOTE = "https://gitlab.acme.internal/acme/widgets.git";

describe("grantRead", () => {
  test("github: a 204 (empty body — access already effective) PUT grants", async () => {
    const script: ExecScript = () => ok();
    const p = fakeProbes({ exec: script });

    const result = await grantRead(p, GITHUB_REMOTE, "octocat");

    expect(result).toEqual({ access: "granted", manualSteps: [] });
    expect(p.calls.exec).toEqual([["gh", "api", "-X", "PUT", "/repos/acme/widgets/collaborators/octocat", "-f", "permission=pull"]]);
  });

  test("github: a 201 (invitation body — pending acceptance) PUT is manual, not granted", async () => {
    const script: ExecScript = () => ok(JSON.stringify({ id: 1, invitee: { login: "octocat" } }));
    const p = fakeProbes({ exec: script });

    const result = await grantRead(p, GITHUB_REMOTE, "octocat");

    expect(result.access).toBe("manual");
    expect(result.manualSteps).toHaveLength(1);
    expect(result.manualSteps[0]).toContain("must accept the pending GitHub collaboration invite");
  });

  test("github: gh missing (127) reports manual with an install step ahead of the settings-access steps", async () => {
    const script: ExecScript = () => missing("gh");
    const p = fakeProbes({ exec: script });

    const result = await grantRead(p, GITHUB_REMOTE, "octocat");

    expect(result).toEqual({
      access: "manual",
      manualSteps: [
        "Install the GitHub CLI (`gh`), then run `gh auth login`",
        "Open https://github.com/acme/widgets/settings/access",
        "Invite octocat with Read",
      ],
    });
  });

  test("github: unauthenticated stderr reports manual with a login step", async () => {
    const script: ExecScript = () => ({ code: 1, stdout: "", stderr: "gh: not logged in to any GitHub hosts" });
    const p = fakeProbes({ exec: script });

    const result = await grantRead(p, GITHUB_REMOTE, "octocat");

    expect(result.manualSteps[0]).toBe("Run `gh auth login`, then retry `rt team invite`");
  });

  test("github: an org SAML/SSO denial reports manual with an authorize-SSO step", async () => {
    const script: ExecScript = () => ({ code: 1, stdout: "", stderr: "gh: Resource protected by organization SAML enforcement." });
    const p = fakeProbes({ exec: script });

    const result = await grantRead(p, GITHUB_REMOTE, "octocat");

    expect(result.manualSteps[0]).toContain("SAML/SSO enforcement");
  });

  test("github: a 404 (unknown handle) reports manual naming the handle as not found", async () => {
    const script: ExecScript = () => ({ code: 1, stdout: "", stderr: "gh: HTTP 404: Not Found" });
    const p = fakeProbes({ exec: script });

    const result = await grantRead(p, GITHUB_REMOTE, "octocat");

    expect(result.manualSteps[0]).toContain('"octocat" is a real GitHub username');
  });

  test("github: a 403 (insufficient token scope) reports manual naming the permission gap", async () => {
    const script: ExecScript = () => ({ code: 1, stdout: "", stderr: "gh: HTTP 403: Forbidden" });
    const p = fakeProbes({ exec: script });

    const result = await grantRead(p, GITHUB_REMOTE, "octocat");

    expect(result.manualSteps[0]).toContain("token lacks permission");
  });

  test("github: an unclassified failure still reports manual with just the base steps", async () => {
    const script: ExecScript = () => ({ code: 1, stdout: "", stderr: "boom" });
    const p = fakeProbes({ exec: script });

    const result = await grantRead(p, GITHUB_REMOTE, "octocat");

    expect(result).toEqual({
      access: "manual",
      manualSteps: ["Open https://github.com/acme/widgets/settings/access", "Invite octocat with Read"],
    });
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

  test("gitlab: an unresolvable username reports manual with a not-found lead step", async () => {
    const script: ExecScript = (argv) => {
      if (argv[2]?.startsWith("users?")) return { code: 0, stdout: "[]", stderr: "" };
      return ok();
    };
    const p = fakeProbes({ exec: script });

    const result = await grantRead(p, GITLAB_REMOTE, "zaphod");

    expect(result).toEqual({
      access: "manual",
      manualSteps: [
        'Check that "zaphod" is a real GitLab username — it was not found',
        "Open https://gitlab.com/acme/widgets/-/project_members",
        "Invite zaphod with Reporter access",
      ],
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

  test("handle is URL-encoded on both the github path segment and the gitlab query string", async () => {
    const script: ExecScript = () => ok();
    const p = fakeProbes({ exec: script });

    await grantRead(p, GITHUB_REMOTE, "weird/handle");
    expect(p.calls.exec[0]).toEqual(["gh", "api", "-X", "PUT", "/repos/acme/widgets/collaborators/weird%2Fhandle", "-f", "permission=pull"]);

    const p2 = fakeProbes({ exec: script });
    await grantRead(p2, GITLAB_REMOTE, "weird handle");
    expect(p2.calls.exec[0]).toEqual(["glab", "api", "users?username=weird%20handle"]);
  });

  test("an unparsable remote is skipped, not manual", async () => {
    const p = fakeProbes();
    const result = await grantRead(p, "not-a-remote", "octocat");
    expect(result).toEqual({ access: "skipped", manualSteps: [] });
    expect(p.calls.exec).toEqual([]);
  });
});

describe("forgeArgv", () => {
  test("runs the bundled gh/glab when the app ships one (they are never on PATH: exposeByDefault is false), else the bare name", () => {
    const p = fakeProbes({});
    expect(forgeArgv(p, "glab", () => ["/Applications/mattstack.app/Contents/Helpers/glab"])).toEqual(["/Applications/mattstack.app/Contents/Helpers/glab"]);
    expect(forgeArgv(p, "gh", () => null)).toEqual(["gh"]);
  });
});

describe("forge token env", () => {
  test("grantRead and revokeRead hand a token rt holds to gh/glab through the env, never argv", async () => {
    const seen: (Record<string, string> | undefined)[] = [];
    const script: ExecScript = (argv, opts) => {
      seen.push(opts?.env);
      return argv[0] === "glab" && argv[2]?.startsWith("users?") ? ok(JSON.stringify([{ id: 42 }])) : ok();
    };
    const p = fakeProbes({ exec: script });

    await grantRead(p, GITHUB_REMOTE, "octocat", "ghp-secret");
    await grantRead(p, GITLAB_REMOTE, "zaphod", "glpat-secret");
    await revokeRead(p, GITLAB_REMOTE, "zaphod", "glpat-secret");

    expect(seen).toEqual([{ GH_TOKEN: "ghp-secret" }, { GITLAB_TOKEN: "glpat-secret" }, { GITLAB_TOKEN: "glpat-secret" }, { GITLAB_TOKEN: "glpat-secret" }, { GITLAB_TOKEN: "glpat-secret" }]);
    expect(p.calls.exec.flat().join(" ")).not.toContain("secret");
  });
});

describe("revokeRead", () => {
  test("github: DELETEs the collaborator", async () => {
    const script: ExecScript = () => ok();
    const p = fakeProbes({ exec: script });

    const result = await revokeRead(p, GITHUB_REMOTE, "octocat");

    expect(result).toEqual({ access: "revoked", manualSteps: [] });
    expect(p.calls.exec).toEqual([["gh", "api", "-X", "DELETE", "/repos/acme/widgets/collaborators/octocat"]]);
  });

  test("github: a failure reports manual", async () => {
    const script: ExecScript = () => ({ code: 1, stdout: "", stderr: "boom" });
    const p = fakeProbes({ exec: script });

    const result = await revokeRead(p, GITHUB_REMOTE, "octocat");

    expect(result.access).toBe("manual");
  });

  test("gitlab: looks up the user id, then DELETEs the membership", async () => {
    const script: ExecScript = (argv) => {
      if (argv[2] === "users?username=zaphod") return ok(JSON.stringify([{ id: 42 }]));
      return ok();
    };
    const p = fakeProbes({ exec: script });

    const result = await revokeRead(p, GITLAB_REMOTE, "zaphod");

    expect(result).toEqual({ access: "revoked", manualSteps: [] });
    expect(p.calls.exec).toEqual([
      ["glab", "api", "users?username=zaphod"],
      ["glab", "api", "-X", "DELETE", "projects/acme%2Fwidgets/members/42"],
    ]);
  });

  test("gitlab: a 404 on the DELETE (already not a member) is idempotent success, matching github's parity", async () => {
    const script: ExecScript = (argv) => {
      if (argv[2] === "users?username=zaphod") return ok(JSON.stringify([{ id: 42 }]));
      return { code: 1, stdout: "", stderr: "glab: HTTP 404: Not Found" };
    };
    const p = fakeProbes({ exec: script });

    const result = await revokeRead(p, GITLAB_REMOTE, "zaphod");

    expect(result).toEqual({ access: "revoked", manualSteps: [] });
  });

  test("gitlab: an unresolvable username (no such account) is also idempotent success — it cannot be a member", async () => {
    const script: ExecScript = (argv) => {
      if (argv[2]?.startsWith("users?")) return { code: 0, stdout: "[]", stderr: "" };
      return ok();
    };
    const p = fakeProbes({ exec: script });

    const result = await revokeRead(p, GITLAB_REMOTE, "zaphod");

    expect(result).toEqual({ access: "revoked", manualSteps: [] });
  });

  test("gitlab: a lookup failure for another reason (not just 'not found') still reports manual", async () => {
    const script: ExecScript = () => missing("glab");
    const p = fakeProbes({ exec: script });

    const result = await revokeRead(p, GITLAB_REMOTE, "zaphod");

    expect(result.access).toBe("manual");
    expect(result.manualSteps[0]).toContain("Install the GitLab CLI");
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

  test("a token rt holds reaches the CLI through its own env var, so a never-logged-in gh/glab still answers", async () => {
    const seen: (Record<string, string> | undefined)[] = [];
    const script: ExecScript = (_argv, opts) => {
      seen.push(opts?.env);
      return ok(JSON.stringify({ login: "octocat", username: "zaphod" }));
    };
    const p = fakeProbes({ exec: script });

    expect(await forgeLogin(p, "github", "github.com", "ghp-secret")).toBe("octocat");
    expect(await forgeLogin(p, "gitlab", "gitlab.acme.internal", "glpat-secret")).toBe("zaphod");
    expect(await forgeLogin(p, "gitlab", "gitlab.com", null)).toBe("zaphod");

    expect(seen).toEqual([{ GH_TOKEN: "ghp-secret" }, { GITLAB_HOST: "gitlab.acme.internal", GITLAB_TOKEN: "glpat-secret" }, undefined]);
    expect(p.calls.exec.flat().join(" ")).not.toContain("secret");
  });

  test("a malformed JSON response returns null rather than throwing", async () => {
    const script: ExecScript = () => ok("not json");
    const p = fakeProbes({ exec: script });
    expect(await forgeLogin(p, "github", "github.com")).toBeNull();
  });
});
