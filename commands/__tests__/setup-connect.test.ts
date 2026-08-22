import { describe, test, expect } from "bun:test";
import { integrationConnect, integrationStatus, setupGithubStatus, type ConnectDeps, type SecretWriter, type TeamSecrets } from "../setup.ts";
import { fakeProbes, ok } from "../../lib/setup/__tests__/fakes.ts";
import type { SecretPresence } from "../../lib/setup/validators/accounts.ts";
import type { Probes } from "../../lib/setup/probes.ts";

function neverCalled<T extends unknown[], R>(name: string) {
  return async (..._args: T): Promise<R> => {
    throw new Error(`unexpected call: ${name}`);
  };
}

function fakeSecrets(stored: Record<string, string> = {}): SecretPresence {
  return {
    async has(domain, key) {
      return stored[`${domain}.${key}`] ?? null;
    },
  };
}

function baseDeps(overrides: Partial<ConnectDeps> & { probes?: Probes } = {}): ConnectDeps & { lines: string[]; exitCodes: number[] } {
  const lines: string[] = [];
  const exitCodes: number[] = [];
  return {
    probes: fakeProbes(),
    secrets: fakeSecrets(),
    print: (s: string) => lines.push(s),
    exit: (code: number) => {
      exitCodes.push(code);
      throw new Error("exit sentinel");
    },
    stdin: async () => null,
    isTTY: () => false,
    promptField: neverCalled("promptField"),
    writer: { hasAgeKey: async () => true, write: neverCalled("writer.write") } satisfies SecretWriter,
    teamSecrets: { read: neverCalled("teamSecrets.read"), write: neverCalled("teamSecrets.write") } satisfies TeamSecrets,
    writeSetting: neverCalled("writeSetting"),
    listen: neverCalled("listen"),
    lines,
    exitCodes,
    ...overrides,
  };
}

async function expectExit(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    throw new Error("expected exit sentinel, function returned normally");
  } catch (err) {
    if (!(err instanceof Error) || err.message !== "exit sentinel") throw err;
  }
}

const gitlabUserOk: Probes["fetch"] = async (url) => {
  if (url.includes("/api/v4/user")) return { status: 200, body: "{}", headers: {} };
  if (url.includes("personal_access_tokens/self")) return { status: 404, body: "", headers: {} };
  return { status: 0, body: "", headers: {} };
};

const gitlabUserRejected: Probes["fetch"] = async (url) => {
  if (url.includes("/api/v4/user")) return { status: 401, body: "", headers: {} };
  return { status: 0, body: "", headers: {} };
};

describe("integrationConnect — gitlab (generic token flow)", () => {
  test("stdin token, ready, no age key -> ready envelope + staged secret", async () => {
    const probes = fakeProbes({ fetch: gitlabUserOk });
    const deps = baseDeps({
      probes,
      stdin: async () => ({ token: "glpat-x" }),
      writer: { hasAgeKey: async () => false, write: neverCalled("writer.write") },
    });

    await integrationConnect("gitlab", ["--json"], deps);

    expect(deps.lines).toHaveLength(1);
    const body = JSON.parse(deps.lines[0]!) as { integration: string; status: string };
    expect(body.integration).toBe("gitlab");
    expect(body.status).toBe("ready");

    const stagedKey = Object.keys(probes.calls.writes).find((k) => k.endsWith("rt/setup-staging/rt.json"));
    expect(stagedKey).toBeDefined();
    const staged = JSON.parse(probes.calls.writes[stagedKey!]!) as Record<string, string>;
    expect(staged.gitlabToken).toBe("glpat-x");
  });

  test("age key present -> writer.write called instead of staging", async () => {
    const writes: [string, string, string][] = [];
    const probes = fakeProbes({ fetch: gitlabUserOk });
    const deps = baseDeps({
      probes,
      stdin: async () => ({ token: "glpat-y" }),
      writer: {
        hasAgeKey: async () => true,
        write: async (domain, key, value) => {
          writes.push([domain, key, value]);
        },
      },
    });

    await integrationConnect("gitlab", ["--json"], deps);

    expect(writes).toEqual([["rt", "gitlabToken", "glpat-y"]]);
    expect(Object.keys(probes.calls.writes).some((k) => k.endsWith("rt/setup-staging/rt.json"))).toBe(false);
  });

  test("validate invalid -> exit 2, error.code invalid-credential", async () => {
    const deps = baseDeps({
      probes: fakeProbes({ fetch: gitlabUserRejected }),
      stdin: async () => ({ token: "bad-token" }),
    });

    await expectExit(() => integrationConnect("gitlab", ["--json"], deps));

    expect(deps.exitCodes).toEqual([2]);
    expect(deps.lines).toHaveLength(1);
    const payload = JSON.parse(deps.lines[0]!) as { error: { code: string } };
    expect(payload.error.code).toBe("invalid-credential");
  });

  test("sentinel token never appears in the printed envelope or exec argv (extends the validate-layer leak table to the connect verb)", async () => {
    const SENTINEL = "sk-sentinel-should-never-appear-anywhere";
    const probes = fakeProbes({ fetch: gitlabUserOk });
    const deps = baseDeps({
      probes,
      stdin: async () => ({ token: SENTINEL }),
      writer: { hasAgeKey: async () => false, write: neverCalled("writer.write") },
    });

    await integrationConnect("gitlab", ["--json"], deps);

    expect(deps.lines.join("\n")).not.toContain(SENTINEL);
    for (const argv of probes.calls.exec) expect(argv.join(" ")).not.toContain(SENTINEL);
  });
});

describe("integrationConnect — github --use-gh", () => {
  test("exec's gh auth token and stores the result", async () => {
    const writes: [string, string, string][] = [];
    const exec: Probes["exec"] = async (argv) => {
      if (argv[0] === "gh" && argv[1] === "auth" && argv[2] === "token") return ok("ghp_from_gh\n");
      return ok();
    };
    const fetch: Probes["fetch"] = async (url) => {
      if (url.includes("api.github.com/user")) return { status: 200, body: "{}", headers: {} };
      return { status: 0, body: "", headers: {} };
    };
    const probes = fakeProbes({ exec, fetch });
    const deps = baseDeps({
      probes,
      writer: {
        hasAgeKey: async () => true,
        write: async (domain, key, value) => {
          writes.push([domain, key, value]);
        },
      },
    });

    await integrationConnect("github", ["--use-gh", "--json"], deps);

    expect(probes.calls.exec).toContainEqual(["gh", "auth", "token"]);
    expect(writes).toEqual([["rt", "githubToken", "ghp_from_gh"]]);
    const body = JSON.parse(deps.lines[0]!) as { status: string };
    expect(body.status).toBe("ready");
  });
});

describe("integrationStatus — github handle/owners", () => {
  test("gh authenticated -> handle + owners present", async () => {
    const exec: Probes["exec"] = async (argv) => {
      if (argv.join(" ") === "gh auth status") return ok();
      if (argv.join(" ") === "gh api user") return ok(JSON.stringify({ login: "matt" }));
      if (argv.join(" ") === "gh api user/orgs") return ok(JSON.stringify([{ login: "m4ttstack" }]));
      return ok();
    };
    const deps = baseDeps({ probes: fakeProbes({ exec }) });

    await integrationStatus("github", ["--json"], deps);

    const body = JSON.parse(deps.lines[0]!) as { handle?: string; owners?: string[] };
    expect(body.handle).toBe("matt");
    expect(body.owners).toEqual(["matt", "m4ttstack"]);
  });

  test("gh unauthenticated -> no handle/owners keys", async () => {
    const exec: Probes["exec"] = async (argv) => {
      if (argv.join(" ") === "gh auth status") return { code: 1, stdout: "", stderr: "not logged in" };
      return ok();
    };
    const deps = baseDeps({ probes: fakeProbes({ exec }) });

    await setupGithubStatus(["--json"], {}, deps);

    const body = JSON.parse(deps.lines[0]!) as Record<string, unknown>;
    expect("handle" in body).toBe(false);
    expect("owners" in body).toBe(false);
  });
});
