import { describe, test, expect, beforeEach } from "bun:test";
import { probeTeamRepoAccess } from "../repo-access.ts";
import { resetCltCacheForTests } from "../../setup/home-git.ts";
import { fakeProbes, ok } from "../../setup/__tests__/fakes.ts";
import type { ExecScript } from "../../setup/__tests__/fakes.ts";

const REMOTE = "https://github.com/acme/team.git";
const ABSENT = { kind: "absent" } as const;
const TOKEN = { kind: "token", token: "gho_x" } as const;
const git = (script: ExecScript): ExecScript => (argv, opts) => (argv[0] === "xcode-select" ? ok() : script(argv, opts));

describe("probeTeamRepoAccess", () => {
  beforeEach(() => resetCltCacheForTests());

  test("exit 0 is ok", async () => {
    const v = await probeTeamRepoAccess(fakeProbes({ exec: git(() => ok()) }), REMOTE, TOKEN);
    expect(v.kind).toBe("ok");
  });

  test("exit 2 is an empty repo, still ok", async () => {
    const v = await probeTeamRepoAccess(fakeProbes({ exec: git(() => ({ code: 2, stdout: "", stderr: "" })) }), REMOTE, TOKEN);
    expect(v).toEqual({ kind: "ok", detail: "empty repo (will be initialized)" });
  });

  test("no Command Line Tools: git is never run", async () => {
    const seen: string[][] = [];
    const exec: ExecScript = (argv) => {
      seen.push(argv);
      return argv[0] === "xcode-select" ? { code: 2, stdout: "", stderr: "unable to get active developer directory" } : ok();
    };
    const v = await probeTeamRepoAccess(fakeProbes({ exec }), REMOTE, TOKEN);
    expect(v.kind).toBe("no-clt");
    expect(seen.some((argv) => argv[0] === "git")).toBe(false);
  });

  test("no credential offered and rt holds no token is no-account", async () => {
    const exec = git(() => ({ code: 128, stdout: "", stderr: "fatal: could not read Username for 'https://github.com'" }));
    const v = await probeTeamRepoAccess(fakeProbes({ exec }), REMOTE, ABSENT);
    expect(v.kind).toBe("no-account");
  });

  test("no credential on a host rt does not recognize is indeterminate, names the host, and never asks for an account rt cannot connect", async () => {
    const exec = git(() => ({ code: 128, stdout: "", stderr: "fatal: could not read Username for 'https://git.acme.internal'" }));
    const v = await probeTeamRepoAccess(fakeProbes({ exec }), "https://git.acme.internal/team/repo.git", ABSENT);
    expect(v.kind).toBe("indeterminate");
    expect(v.detail).toContain("git.acme.internal");
    expect(v.detail).toContain("credential helper");
  });

  test("no credential offered while rt DID hold a token is indeterminate, never no-account", async () => {
    const exec = git(() => ({ code: 128, stdout: "", stderr: "fatal: could not read Username for 'https://github.com'" }));
    const v = await probeTeamRepoAccess(fakeProbes({ exec }), REMOTE, TOKEN);
    expect(v.kind).toBe("indeterminate");
  });

  test("an unreadable store is indeterminate and names the reason", async () => {
    const exec = git(() => ({ code: 128, stdout: "", stderr: "fatal: could not read Username for 'https://github.com'" }));
    const v = await probeTeamRepoAccess(fakeProbes({ exec }), REMOTE, { kind: "unreadable", reason: "sops exited 2" });
    expect(v.kind).toBe("indeterminate");
    expect(v.detail).toContain("sops exited 2");
  });

  test("a refusal is denied", async () => {
    const exec = git(() => ({ code: 128, stdout: "", stderr: "remote: Permission denied fatal: Authentication failed" }));
    const v = await probeTeamRepoAccess(fakeProbes({ exec }), REMOTE, TOKEN);
    expect(v.kind).toBe("denied");
  });

  test("a timeout is unreachable", async () => {
    const v = await probeTeamRepoAccess(fakeProbes({ exec: git(() => ({ code: 124, stdout: "", stderr: "" })) }), REMOTE, TOKEN);
    expect(v.kind).toBe("unreachable");
  });

  test("the token reaches git through the credential helper, never argv or the url", async () => {
    const seen: string[][] = [];
    const envs: Record<string, string>[] = [];
    const exec: ExecScript = (argv, opts) => {
      if (argv[0] === "xcode-select") return ok();
      seen.push(argv);
      envs.push((opts?.env ?? {}) as Record<string, string>);
      return ok();
    };
    await probeTeamRepoAccess(fakeProbes({ exec }), REMOTE, TOKEN);
    expect(seen[0]!.join(" ")).not.toContain("gho_x");
    expect(envs[0]!.RT_GIT_TOKEN).toBe("gho_x");
  });

  test("the probe runs with prompts off and no protocol the remote itself names", async () => {
    let env: Record<string, string> = {};
    const exec: ExecScript = (argv, opts) => {
      if (argv[0] === "xcode-select") return ok();
      env = (opts?.env ?? {}) as Record<string, string>;
      return ok();
    };
    await probeTeamRepoAccess(fakeProbes({ exec }), REMOTE, ABSENT);
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_PROTOCOL_FROM_USER).toBe("0");
  });
});

describe("probeTeamRepoAccess - a withheld token", () => {
  beforeEach(() => resetCltCacheForTests());

  test("never reads as no-account, and names the confirmation the user owes", async () => {
    const exec = git(() => ({ code: 128, stdout: "", stderr: "fatal: could not read Username for 'https://gitlab.evil.example'" }));
    const v = await probeTeamRepoAccess(fakeProbes({ exec }), "https://gitlab.evil.example/acme/team.git", { kind: "withheld", host: "gitlab.evil.example" });
    expect(v.kind).toBe("indeterminate");
    expect(v.detail).toContain("gitlab.evil.example");
    expect(v.detail).toContain("connect --host");
  });

  test("sends no token to the host it was withheld from", async () => {
    const envs: Record<string, string>[] = [];
    const exec = git((argv, opts) => {
      envs.push((opts?.env ?? {}) as Record<string, string>);
      return { code: 128, stdout: "", stderr: "fatal: could not read Username" };
    });
    await probeTeamRepoAccess(fakeProbes({ exec }), "https://gitlab.evil.example/acme/team.git", { kind: "withheld", host: "gitlab.evil.example" });
    expect(envs[0]!.RT_GIT_TOKEN).toBeUndefined();
  });
});
