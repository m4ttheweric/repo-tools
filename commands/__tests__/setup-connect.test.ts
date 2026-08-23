import { describe, test, expect } from "bun:test";
import { integrationConnect, integrationStatus, realOAuthListen, setupGithubStatus, type ConnectDeps, type SecretWriter, type TeamSecrets } from "../setup.ts";
import { fakeProbes, ok } from "../../lib/setup/__tests__/fakes.ts";
import type { SecretPresence } from "../../lib/setup/validators/accounts.ts";
import type { Probes } from "../../lib/setup/probes.ts";
import type { TeamSnapshot } from "../../lib/setup/team-settings.ts";
import { DEFAULT_SCOPE_NEEDS } from "../../lib/setup/slack-app.ts";

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
    randomState: () => "fixed-state-for-tests",
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

  test("validate invalid -> exit 0, {status:'invalid'} envelope (contract's connect shape, not an exit-2 error)", async () => {
    const deps = baseDeps({
      probes: fakeProbes({ fetch: gitlabUserRejected }),
      stdin: async () => ({ token: "bad-token" }),
    });

    await integrationConnect("gitlab", ["--json"], deps);

    expect(deps.exitCodes).toEqual([]);
    expect(deps.lines).toHaveLength(1);
    const body = JSON.parse(deps.lines[0]!) as { integration: string; status: string; detail: string };
    expect(body.integration).toBe("gitlab");
    expect(body.status).toBe("invalid");
    expect(body.detail).toContain("401");
  });

  test("stdin unreachable (status 0) -> exit 2, error.code unreachable", async () => {
    const deps = baseDeps({
      probes: fakeProbes({ fetch: async () => ({ status: 0, body: "", headers: {} }) }),
      stdin: async () => ({ token: "some-token" }),
    });

    await expectExit(() => integrationConnect("gitlab", ["--json"], deps));

    expect(deps.exitCodes).toEqual([2]);
    const payload = JSON.parse(deps.lines[0]!) as { error: { code: string } };
    expect(payload.error.code).toBe("unreachable");
  });

  test("isTTY() is checked before stdin is read — interactive connect prompts instead of reading stdin", async () => {
    const probes = fakeProbes({ fetch: gitlabUserOk });
    const deps = baseDeps({
      probes,
      isTTY: () => true,
      stdin: neverCalled("stdin"),
      promptField: async (field) => {
        expect(field.name).toBe("token");
        return "glpat-from-prompt";
      },
      writer: { hasAgeKey: async () => true, write: async () => {} },
    });

    await integrationConnect("gitlab", ["--json"], deps);

    const body = JSON.parse(deps.lines[0]!) as { status: string };
    expect(body.status).toBe("ready");
  });

  test("a trailing newline in the stdin JSON value is trimmed before validate and before storage", async () => {
    let validatedWith: string | undefined;
    const probes = fakeProbes({
      fetch: async (url, init) => {
        validatedWith = (init?.headers as Record<string, string> | undefined)?.["PRIVATE-TOKEN"];
        return gitlabUserOk(url, init);
      },
    });
    const writes: [string, string, string][] = [];
    const deps = baseDeps({
      probes,
      stdin: async () => ({ token: "glpat-z\n" }),
      writer: {
        hasAgeKey: async () => true,
        write: async (domain, key, value) => {
          writes.push([domain, key, value]);
        },
      },
    });

    await integrationConnect("gitlab", ["--json"], deps);

    expect(validatedWith).toBe("glpat-z");
    expect(writes).toEqual([["rt", "gitlabToken", "glpat-z"]]);
  });

  test("sentinel token never appears in the printed envelope or exec argv, on both the ready and invalid paths", async () => {
    const SENTINEL = "sk-sentinel-should-never-appear-anywhere";

    const readyProbes = fakeProbes({ fetch: gitlabUserOk });
    const readyDeps = baseDeps({
      probes: readyProbes,
      stdin: async () => ({ token: SENTINEL }),
      writer: { hasAgeKey: async () => false, write: neverCalled("writer.write") },
    });
    await integrationConnect("gitlab", ["--json"], readyDeps);
    expect(readyDeps.lines.join("\n")).not.toContain(SENTINEL);
    for (const argv of readyProbes.calls.exec) expect(argv.join(" ")).not.toContain(SENTINEL);

    const invalidProbes = fakeProbes({ fetch: gitlabUserRejected });
    const invalidDeps = baseDeps({ probes: invalidProbes, stdin: async () => ({ token: SENTINEL }) });
    await integrationConnect("gitlab", ["--json"], invalidDeps);
    expect(invalidDeps.lines.join("\n")).not.toContain(SENTINEL);
    for (const argv of invalidProbes.calls.exec) expect(argv.join(" ")).not.toContain(SENTINEL);
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

describe("integrationConnect — doppler/ldcli (CLI-session flow)", () => {
  test("doppler: login runs with inherit:true; a successful re-validate reports ready", async () => {
    const exec: Probes["exec"] = async (argv, opts) => {
      if (argv.join(" ") === "doppler login") {
        expect(opts?.inherit).toBe(true);
        return ok();
      }
      if (argv.join(" ") === "doppler me --json") return ok();
      return ok();
    };
    const deps = baseDeps({ probes: fakeProbes({ exec }) });

    await integrationConnect("doppler", ["--json"], deps);

    expect(deps.exitCodes).toEqual([]);
    const body = JSON.parse(deps.lines[0]!) as { status: string; integration: string };
    expect(body.integration).toBe("doppler");
    expect(body.status).toBe("ready");
  });

  test("ldcli: a failed re-validate maps to exit 0, {status:'invalid'} (not exit 2)", async () => {
    const exec: Probes["exec"] = async (argv, opts) => {
      if (argv.join(" ") === "ldcli login") {
        expect(opts?.inherit).toBe(true);
        return ok();
      }
      if (argv.join(" ") === "ldcli config --list") return { code: 1, stdout: "", stderr: "not logged in" };
      return ok();
    };
    const deps = baseDeps({ probes: fakeProbes({ exec }) });

    await integrationConnect("ldcli", ["--json"], deps);

    expect(deps.exitCodes).toEqual([]);
    const body = JSON.parse(deps.lines[0]!) as { status: string };
    expect(body.status).toBe("invalid");
  });
});

function slackTeamSnapshot(overrides: { clientId?: string; callbackPort?: number } = {}): TeamSnapshot {
  return {
    slug: "acme",
    integrations: { slack: { clientId: overrides.clientId ?? "client-abc", callbackPort: overrides.callbackPort ?? 22222 } },
    trackingIdentities: [],
    marketplaces: [],
    plugins: [],
    remote: null,
  };
}

const NO_SLACK_APP_SNAPSHOT: TeamSnapshot = { slug: "acme", integrations: {}, trackingIdentities: [], marketplaces: [], plugins: [], remote: null };

describe("integrationConnect — slack (OAuth flow)", () => {
  test("no clientId on the team -> exit 2 slack-app-missing, never opens a browser or listens", async () => {
    const probes = fakeProbes();
    const deps = baseDeps({ probes, teamSnapshot: () => NO_SLACK_APP_SNAPSHOT });

    await expectExit(() => integrationConnect("slack", ["--json"], deps));

    expect(deps.exitCodes).toEqual([2]);
    const payload = JSON.parse(deps.lines[0]!) as { error: { code: string } };
    expect(payload.error.code).toBe("slack-app-missing");
    expect(probes.calls.exec).toEqual([]);
  });

  test("clientId present but no readable client secret -> exit 2 slack-app-missing, honest detail (never 'recreate the app')", async () => {
    const probes = fakeProbes({ exec: async () => ok() });
    const deps = baseDeps({
      probes,
      teamSnapshot: () => slackTeamSnapshot(),
      randomState: () => "state-abc",
      listen: async (port, state) => {
        expect(port).toBe(22222);
        expect(state).toBe("state-abc");
        return "auth-code";
      },
      teamSecrets: { read: async () => null, write: neverCalled("teamSecrets.write") },
    });

    await expectExit(() => integrationConnect("slack", ["--json"], deps));

    expect(deps.exitCodes).toEqual([2]);
    const payload = JSON.parse(deps.lines[0]!) as { error: { code: string; message: string } };
    expect(payload.error.code).toBe("slack-app-missing");
    expect(payload.error.message.toLowerCase()).not.toContain("recreate");
  });

  test("a listen() rejection (state mismatch, timeout, busy port) maps to exit 2, never an unhandled rejection", async () => {
    const deps = baseDeps({
      teamSnapshot: () => slackTeamSnapshot(),
      listen: async () => {
        throw new Error("slack callback state did not match — rejecting a possibly forged authorization code");
      },
    });

    await expectExit(() => integrationConnect("slack", ["--json"], deps));

    expect(deps.exitCodes).toEqual([2]);
    const payload = JSON.parse(deps.lines[0]!) as { error: { code: string; message: string } };
    expect(payload.error.code).toBe("slack-oauth-failed");
    expect(payload.error.message).toContain("state did not match");
  });

  test("authorize URL carries the team's clientId, the manifest's user scopes, and the callback port + a state param; exchange POSTs client_secret+code and stores board/slackUserToken only after success", async () => {
    const teamSecretWrites: unknown[] = [];
    const writerWrites: [string, string, string][] = [];
    let openedUrl: string | undefined;
    let exchangeBody: string | undefined;

    const exec: Probes["exec"] = async (argv) => {
      if (argv[0] === "open") openedUrl = argv[1];
      return ok();
    };
    const fetch: Probes["fetch"] = async (url, init) => {
      if (url === "https://slack.com/api/oauth.v2.access") {
        exchangeBody = init?.body as string;
        return { status: 200, body: JSON.stringify({ ok: true, authed_user: { access_token: "xoxp-user-token" } }), headers: {} };
      }
      return { status: 0, body: "", headers: {} };
    };
    const probes = fakeProbes({ exec, fetch });
    const deps = baseDeps({
      probes,
      teamSnapshot: () => slackTeamSnapshot({ clientId: "client-abc", callbackPort: 22222 }),
      randomState: () => "state-xyz",
      teamSecrets: {
        read: async () => "client-secret-value",
        write: async (...args) => {
          teamSecretWrites.push(args);
          return { staged: false };
        },
      },
      listen: async (port, state) => {
        expect(port).toBe(22222);
        expect(state).toBe("state-xyz");
        return "auth-code-123";
      },
      writer: {
        hasAgeKey: async () => true,
        write: async (domain, key, value) => {
          writerWrites.push([domain, key, value]);
        },
      },
    });

    await integrationConnect("slack", ["--json"], deps);

    expect(openedUrl).toContain("client_id=client-abc");
    expect(openedUrl).toContain(`state=state-xyz`);
    expect(openedUrl).toContain(encodeURIComponent(DEFAULT_SCOPE_NEEDS.user.join(",")));
    expect(openedUrl).toContain(encodeURIComponent("http://localhost:22222/callback"));

    expect(exchangeBody).toContain("client_secret=client-secret-value");
    expect(exchangeBody).toContain("code=auth-code-123");

    expect(writerWrites).toEqual([["board", "slackUserToken", "xoxp-user-token"]]);
    expect(teamSecretWrites).toEqual([]);

    const body = JSON.parse(deps.lines[0]!) as { status: string; integration: string };
    expect(body.integration).toBe("slack");
    expect(body.status).toBe("ready");
  });

  test("a rejected exchange (ok:false) reports {status:'invalid'} at exit 0, and never stores a token", async () => {
    const writerWrites: unknown[] = [];
    const fetch: Probes["fetch"] = async (url) => {
      if (url === "https://slack.com/api/oauth.v2.access") return { status: 200, body: JSON.stringify({ ok: false, error: "invalid_code" }), headers: {} };
      return { status: 0, body: "", headers: {} };
    };
    const deps = baseDeps({
      probes: fakeProbes({ fetch }),
      teamSnapshot: () => slackTeamSnapshot(),
      teamSecrets: { read: async () => "client-secret-value", write: neverCalled("teamSecrets.write") },
      listen: async () => "auth-code",
      writer: { hasAgeKey: async () => true, write: async (...a: [string, string, string]) => void writerWrites.push(a) },
    });

    await integrationConnect("slack", ["--json"], deps);

    expect(deps.exitCodes).toEqual([]);
    expect(writerWrites).toEqual([]);
    const body = JSON.parse(deps.lines[0]!) as { status: string; detail: string };
    expect(body.status).toBe("invalid");
    expect(body.detail).toContain("invalid_code");
  });

  test("sentinel: neither the client secret nor the user token reaches the printed envelope", async () => {
    const CLIENT_SECRET_SENTINEL = "sk-client-secret-sentinel";
    const USER_TOKEN_SENTINEL = "sk-user-token-sentinel";
    const fetch: Probes["fetch"] = async (url) => {
      if (url === "https://slack.com/api/oauth.v2.access") return { status: 200, body: JSON.stringify({ ok: true, authed_user: { access_token: USER_TOKEN_SENTINEL } }), headers: {} };
      return { status: 0, body: "", headers: {} };
    };
    const probes = fakeProbes({ fetch });
    const deps = baseDeps({
      probes,
      teamSnapshot: () => slackTeamSnapshot(),
      teamSecrets: { read: async () => CLIENT_SECRET_SENTINEL, write: neverCalled("teamSecrets.write") },
      listen: async () => "auth-code",
      writer: { hasAgeKey: async () => true, write: async () => {} },
    });

    await integrationConnect("slack", ["--json"], deps);

    expect(deps.lines.join("\n")).not.toContain(CLIENT_SECRET_SENTINEL);
    expect(deps.lines.join("\n")).not.toContain(USER_TOKEN_SENTINEL);
    for (const argv of probes.calls.exec) expect(argv.join(" ")).not.toContain(USER_TOKEN_SENTINEL);
  });
});

describe("realOAuthListen (real Bun.serve, no fakes — this is the seam being pinned)", () => {
  test("a mismatched state rejects instead of resolving with the code", async () => {
    const port = 18765;
    const promise = realOAuthListen(port, "expected-state");
    const res = await fetch(`http://127.0.0.1:${port}/callback?code=abc&state=WRONG`);
    expect(res.status).toBe(200);
    // Plain try/catch, not `expect(promise).rejects` — under bun:test, that matcher combined with an
    // awaited round-trip to an in-process Bun.serve handler reports the rejection as a hard test
    // failure regardless of whether it's later caught, rather than as a normal assertion.
    let caught: unknown;
    try {
      await promise;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/state/i);
  });

  test("a matching state resolves with the code", async () => {
    const port = 18766;
    const promise = realOAuthListen(port, "match-me");
    await fetch(`http://127.0.0.1:${port}/callback?code=the-real-code&state=match-me`);
    await expect(promise).resolves.toBe("the-real-code");
  });

  test("a port already in use rejects rather than hanging or throwing an unhandled rejection", async () => {
    // No explicit hostname, matching realOAuthListen's own Bun.serve call exactly — a 127.0.0.1-only
    // bind here would NOT reliably conflict with realOAuthListen's default (0.0.0.0) bind on some
    // platforms, letting the second server start clean and the test hang for no real reason.
    const busy = Bun.serve({ port: 0, fetch: () => new Response("x") });
    const port = busy.port;
    if (port === undefined) throw new Error("Bun.serve did not report a port");
    let caught: unknown;
    try {
      await realOAuthListen(port, "state");
    } catch (err) {
      caught = err;
    } finally {
      busy.stop(true);
    }
    expect(caught).toBeInstanceOf(Error);
  });
});
