import { describe, test, expect } from "bun:test";
import { fakeProbes } from "./fakes.ts";
import { INTEGRATIONS, integrationDef, type ValidateCtx } from "../integrations.ts";
import { UserActionableError } from "../errors.ts";

const noHost: ValidateCtx = { host: null, team: { slug: "claimview", remote: null } };

describe("integrationDef", () => {
  test("resolves a known id", () => {
    expect(integrationDef("github")).toBe(INTEGRATIONS.github);
  });

  test("throws UserActionableError('unknown-integration') for a bad id", () => {
    expect(() => integrationDef("bogus")).toThrow(UserActionableError);
    try {
      integrationDef("bogus");
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as UserActionableError).code).toBe("unknown-integration");
    }
  });
});

describe("every integration def", () => {
  for (const def of Object.values(INTEGRATIONS)) {
    test(`${def.id} has a non-empty why(null)`, () => {
      expect(def.why(null).length).toBeGreaterThan(0);
    });
  }
});

describe("gitlab validate", () => {
  test("project 404 after valid user/scopes → invalid, can't-see detail, scopes carried through", async () => {
    const p = fakeProbes({
      fetch: async (url) => {
        if (url.endsWith("/api/v4/user")) return { status: 200, body: "{}", headers: {} };
        if (url.endsWith("/personal_access_tokens/self")) return { status: 200, body: JSON.stringify({ scopes: ["read_api"] }), headers: {} };
        if (url.includes("/api/v4/projects/")) return { status: 404, body: "", headers: {} };
        return { status: 0, body: "", headers: {} };
      },
    });

    const result = await INTEGRATIONS.gitlab.validate(p, "glpat-token", { host: "gitlab.example.com", team: { slug: "claimview", remote: "https://gitlab.example.com/mattstack/claimview.git" } });

    expect(result.status).toBe("invalid");
    expect(result.detail).toContain("can't see");
    expect(result.scopesSeen).toEqual(["read_api"]);
  });

  test("project 200 → ready", async () => {
    const p = fakeProbes({
      fetch: async (url) => {
        if (url.endsWith("/api/v4/user")) return { status: 200, body: "{}", headers: {} };
        if (url.endsWith("/personal_access_tokens/self")) return { status: 200, body: JSON.stringify({ scopes: ["read_api"] }), headers: {} };
        if (url.includes("/api/v4/projects/")) return { status: 200, body: "{}", headers: {} };
        return { status: 0, body: "", headers: {} };
      },
    });

    const result = await INTEGRATIONS.gitlab.validate(p, "glpat-token", { host: "gitlab.example.com", team: { slug: "claimview", remote: "https://gitlab.example.com/mattstack/claimview.git" } });
    expect(result.status).toBe("ready");
  });

  test("project 500 (a real response, not can't-see) → error, status named in detail", async () => {
    const p = fakeProbes({
      fetch: async (url) => {
        if (url.endsWith("/api/v4/user")) return { status: 200, body: "{}", headers: {} };
        if (url.endsWith("/personal_access_tokens/self")) return { status: 200, body: "{}", headers: {} };
        if (url.includes("/api/v4/projects/")) return { status: 500, body: "", headers: {} };
        return { status: 0, body: "", headers: {} };
      },
    });

    const result = await INTEGRATIONS.gitlab.validate(p, "glpat-token", { host: "gitlab.example.com", team: { slug: "claimview", remote: "https://gitlab.example.com/mattstack/claimview.git" } });
    expect(result.status).toBe("error");
    expect(result.detail).toContain("500");
  });

  test("/user status 0 (network down) → error, never invalid", async () => {
    const p = fakeProbes({ fetch: async () => ({ status: 0, body: "", headers: {} }) });
    const result = await INTEGRATIONS.gitlab.validate(p, "glpat-token", { host: "gitlab.example.com", team: { slug: "claimview", remote: null } });
    expect(result.status).toBe("error");
    expect(result.detail).toContain("gitlab.example.com");
    expect(result.detail.toLowerCase()).not.toContain("invalid");
  });

  test("/user non-200, non-401/403 (e.g. 502) → error, not invalid", async () => {
    const p = fakeProbes({ fetch: async () => ({ status: 502, body: "", headers: {} }) });
    const result = await INTEGRATIONS.gitlab.validate(p, "glpat-token", { host: "gitlab.example.com", team: { slug: "claimview", remote: null } });
    expect(result.status).toBe("error");
    expect(result.detail).toContain("502");
  });

  test("a trailing slash on ctx.host is stripped before composing URLs", async () => {
    const calledUrls: string[] = [];
    const p = fakeProbes({
      fetch: async (url) => {
        calledUrls.push(url);
        return { status: 200, body: "{}", headers: {} };
      },
    });
    await INTEGRATIONS.gitlab.validate(p, "glpat-token", { host: "gitlab.example.com/", team: { slug: "claimview", remote: null } });
    expect(calledUrls.every((u) => !u.includes("//api"))).toBe(true);
  });
});

describe("github validate", () => {
  test("user 200, repo 200 → ready", async () => {
    const p = fakeProbes({
      fetch: async (url) => {
        if (url === "https://api.github.com/user") return { status: 200, body: "{}", headers: { "x-oauth-scopes": "repo, read:org" } as Record<string, string> };
        if (url === "https://api.github.com/repos/mattstack/claimview") return { status: 200, body: "{}", headers: {} as Record<string, string> };
        return { status: 0, body: "", headers: {} as Record<string, string> };
      },
    });

    const result = await INTEGRATIONS.github.validate(p, "ghp-token", { host: null, team: { slug: "claimview", remote: "https://github.com/mattstack/claimview.git" } });

    expect(result.status).toBe("ready");
    expect(result.scopesSeen).toEqual(["repo", "read:org"]);
  });

  test("repo 404 → invalid, can't-see detail", async () => {
    const p = fakeProbes({
      fetch: async (url) => {
        if (url === "https://api.github.com/user") return { status: 200, body: "{}", headers: {} };
        if (url === "https://api.github.com/repos/mattstack/claimview") return { status: 404, body: "", headers: {} };
        return { status: 0, body: "", headers: {} };
      },
    });

    const result = await INTEGRATIONS.github.validate(p, "ghp-token", { host: null, team: { slug: "claimview", remote: "https://github.com/mattstack/claimview.git" } });
    expect(result.status).toBe("invalid");
    expect(result.detail).toContain("can't see");
  });

  test("/user status 0 (network down) → error naming api.github.com, never invalid", async () => {
    const p = fakeProbes({ fetch: async () => ({ status: 0, body: "", headers: {} }) });
    const result = await INTEGRATIONS.github.validate(p, "ghp-token", noHost);
    expect(result.status).toBe("error");
    expect(result.detail).toContain("api.github.com");
    expect(result.detail.toLowerCase()).not.toContain("invalid");
  });

  test("/user 401 (real rejection) → invalid", async () => {
    const p = fakeProbes({ fetch: async () => ({ status: 401, body: "", headers: {} }) });
    const result = await INTEGRATIONS.github.validate(p, "ghp-token", noHost);
    expect(result.status).toBe("invalid");
  });

  test("/user 500 (server error, not a credential signal) → error", async () => {
    const p = fakeProbes({ fetch: async () => ({ status: 500, body: "", headers: {} }) });
    const result = await INTEGRATIONS.github.validate(p, "ghp-token", noHost);
    expect(result.status).toBe("error");
  });

  test("sends Accept and User-Agent headers", async () => {
    let seenHeaders: Record<string, string> = {};
    const p = fakeProbes({
      fetch: async (_url, init) => {
        seenHeaders = init?.headers ?? {};
        return { status: 200, body: "{}", headers: {} };
      },
    });
    await INTEGRATIONS.github.validate(p, "ghp-token", noHost);
    expect(seenHeaders.Accept).toBeTruthy();
    expect(seenHeaders["User-Agent"]).toBeTruthy();
  });
});

describe("linear validate", () => {
  test("declared teamKey not among viewer's teams → invalid", async () => {
    const p = fakeProbes({
      fetch: async () => ({ status: 200, body: JSON.stringify({ data: { viewer: { id: "u1" }, teams: { nodes: [{ key: "ENG" }] } } }), headers: {} }),
    });

    const result = await INTEGRATIONS.linear.validate(p, "lin_api_x", { host: null, team: { slug: "claimview", remote: null }, linearTeamKey: "CV" });
    expect(result.status).toBe("invalid");
  });

  test("no declared teamKey → ready", async () => {
    const p = fakeProbes({
      fetch: async () => ({ status: 200, body: JSON.stringify({ data: { viewer: { id: "u1" }, teams: { nodes: [{ key: "ENG" }] } } }), headers: {} }),
    });

    const result = await INTEGRATIONS.linear.validate(p, "lin_api_x", { host: null, team: { slug: "claimview", remote: null } });
    expect(result.status).toBe("ready");
    expect(result.detail).toBe("viewer ok");
  });

  test("declared teamKey found among viewer's teams → ready", async () => {
    const p = fakeProbes({
      fetch: async () => ({ status: 200, body: JSON.stringify({ data: { viewer: { id: "u1" }, teams: { nodes: [{ key: "CV" }] } } }), headers: {} }),
    });

    const result = await INTEGRATIONS.linear.validate(p, "lin_api_x", { host: null, team: { slug: "claimview", remote: null }, linearTeamKey: "CV" });
    expect(result.status).toBe("ready");
  });

  test("status 0 (network down) → error, never invalid", async () => {
    const p = fakeProbes({ fetch: async () => ({ status: 0, body: "", headers: {} }) });
    const result = await INTEGRATIONS.linear.validate(p, "lin_api_x", noHost);
    expect(result.status).toBe("error");
    expect(result.detail.toLowerCase()).not.toContain("invalid");
  });
});

describe("network-free integrations only ever call through probes", () => {
  test("sdm status 127 → invalid 'not installed'", async () => {
    const p = fakeProbes({ exec: async () => ({ code: 127, stdout: "", stderr: "ENOENT: sdm" }) });
    const result = await INTEGRATIONS.sdm.validate(p, "me@example.com", noHost);
    expect(result).toEqual({ status: "invalid", detail: "sdm not installed", scopesSeen: [] });
  });

  test("sdm status 0 with the email in stdout → ready", async () => {
    const p = fakeProbes({ exec: async () => ({ code: 0, stdout: "logged in as me@example.com", stderr: "" }) });
    const result = await INTEGRATIONS.sdm.validate(p, "me@example.com", noHost);
    expect(result.status).toBe("ready");
  });

  test("sdm called with an empty email is never vacuously ready", async () => {
    const p = fakeProbes({ exec: async () => ({ code: 0, stdout: "logged in as somebody", stderr: "" }) });
    const result = await INTEGRATIONS.sdm.validate(p, "", noHost);
    expect(result).toEqual({ status: "invalid", detail: "no email configured", scopesSeen: [] });
    expect(p.calls.exec).toEqual([]);
  });

  test("sdm called with a whitespace-only email is never vacuously ready", async () => {
    const p = fakeProbes({ exec: async () => ({ code: 0, stdout: "anything", stderr: "" }) });
    const result = await INTEGRATIONS.sdm.validate(p, "   ", noHost);
    expect(result.status).toBe("invalid");
  });

  test("sdm exec timeout (124) → error, distinct from 'no session'", async () => {
    const p = fakeProbes({ exec: async () => ({ code: 124, stdout: "", stderr: "" }) });
    const result = await INTEGRATIONS.sdm.validate(p, "me@example.com", noHost);
    expect(result.status).toBe("error");
    expect(result.detail).toContain("timed out");
  });

  test("doppler me --json 0 → ready", async () => {
    const p = fakeProbes({ exec: async () => ({ code: 0, stdout: "{}", stderr: "" }) });
    const result = await INTEGRATIONS.doppler.validate(p, "", noHost);
    expect(result.status).toBe("ready");
    expect(p.calls.exec).toEqual([["doppler", "me", "--json"]]);
  });

  test("doppler exec timeout (124) → error", async () => {
    const p = fakeProbes({ exec: async () => ({ code: 124, stdout: "", stderr: "" }) });
    const result = await INTEGRATIONS.doppler.validate(p, "", noHost);
    expect(result.status).toBe("error");
    expect(result.detail).toContain("timed out");
  });

  test("ldcli config --list 0 → ready", async () => {
    const p = fakeProbes({ exec: async () => ({ code: 0, stdout: "", stderr: "" }) });
    const result = await INTEGRATIONS.ldcli.validate(p, "", noHost);
    expect(result.status).toBe("ready");
    expect(p.calls.exec).toEqual([["ldcli", "config", "--list"]]);
  });
});

describe("slack validate", () => {
  test("auth.test ok:true → ready with team in detail", async () => {
    const p = fakeProbes({ fetch: async () => ({ status: 200, body: JSON.stringify({ ok: true, team: "Mattstack" }), headers: {} }) });
    const result = await INTEGRATIONS.slack.validate(p, "xoxp-token", noHost);
    expect(result.status).toBe("ready");
    expect(result.detail).toContain("Mattstack");
  });

  test("auth.test ok:false → invalid", async () => {
    const p = fakeProbes({ fetch: async () => ({ status: 200, body: JSON.stringify({ ok: false, error: "invalid_auth" }), headers: {} }) });
    const result = await INTEGRATIONS.slack.validate(p, "xoxp-token", noHost);
    expect(result.status).toBe("invalid");
  });

  test("status 0 (network down) → error, never invalid", async () => {
    const p = fakeProbes({ fetch: async () => ({ status: 0, body: "", headers: {} }) });
    const result = await INTEGRATIONS.slack.validate(p, "xoxp-token", noHost);
    expect(result.status).toBe("error");
    expect(result.detail.toLowerCase()).not.toContain("invalid");
  });

  test("sends a form Content-Type", async () => {
    let seenHeaders: Record<string, string> = {};
    const p = fakeProbes({
      fetch: async (_url, init) => {
        seenHeaders = init?.headers ?? {};
        return { status: 200, body: JSON.stringify({ ok: true }), headers: {} };
      },
    });
    await INTEGRATIONS.slack.validate(p, "xoxp-token", noHost);
    expect(seenHeaders["Content-Type"]).toBeTruthy();
  });
});

describe("switchboard validate", () => {
  test("no host configured → invalid without a network call", async () => {
    const p = fakeProbes();
    const result = await INTEGRATIONS.switchboard.validate(p, "token", noHost);
    expect(result.status).toBe("invalid");
    expect(p.calls.fetch).toEqual([]);
  });

  test("/health 200 → ready", async () => {
    const p = fakeProbes({ fetch: async () => ({ status: 200, body: "", headers: {} }) });
    const result = await INTEGRATIONS.switchboard.validate(p, "token", { host: "https://switchboard.example.com", team: { slug: "claimview", remote: null } });
    expect(result.status).toBe("ready");
  });

  test("a trailing slash on ctx.host is stripped, no double slash before /health", async () => {
    const calledUrls: string[] = [];
    const p = fakeProbes({
      fetch: async (url) => {
        calledUrls.push(url);
        return { status: 200, body: "", headers: {} };
      },
    });
    await INTEGRATIONS.switchboard.validate(p, "token", { host: "https://switchboard.example.com/", team: { slug: "claimview", remote: null } });
    expect(calledUrls).toEqual(["https://switchboard.example.com/health"]);
  });

  test("status 0 (network down) → error, never invalid", async () => {
    const p = fakeProbes({ fetch: async () => ({ status: 0, body: "", headers: {} }) });
    const result = await INTEGRATIONS.switchboard.validate(p, "token", { host: "https://switchboard.example.com", team: { slug: "claimview", remote: null } });
    expect(result.status).toBe("error");
    expect(result.detail.toLowerCase()).not.toContain("invalid");
  });
});

describe("secrets never leak into results or argv", () => {
  const SENTINEL = "sk-sentinel-should-never-appear-anywhere";

  const cases: { id: keyof typeof INTEGRATIONS; ctx: ValidateCtx; opts: Parameters<typeof fakeProbes>[0] }[] = [
    { id: "github", ctx: noHost, opts: { fetch: async () => ({ status: 200, body: "{}", headers: {} }) } },
    { id: "gitlab", ctx: { host: "gitlab.example.com", team: { slug: "claimview", remote: null } }, opts: { fetch: async () => ({ status: 200, body: "{}", headers: {} }) } },
    { id: "linear", ctx: noHost, opts: { fetch: async () => ({ status: 200, body: JSON.stringify({ data: { viewer: { id: "u1" }, teams: { nodes: [] } } }), headers: {} }) } },
    { id: "slack", ctx: noHost, opts: { fetch: async () => ({ status: 200, body: JSON.stringify({ ok: true, team: "Mattstack" }), headers: {} }) } },
    { id: "switchboard", ctx: { host: "https://switchboard.example.com", team: { slug: "claimview", remote: null } }, opts: { fetch: async () => ({ status: 200, body: "", headers: {} }) } },
  ];

  for (const { id, ctx, opts } of cases) {
    test(`${id}: sentinel token never appears in detail, scopesSeen, or exec argv`, async () => {
      const p = fakeProbes(opts);
      const result = await INTEGRATIONS[id].validate(p, SENTINEL, ctx);
      expect(result.detail).not.toContain(SENTINEL);
      expect(result.scopesSeen.join(",")).not.toContain(SENTINEL);
      for (const argv of p.calls.exec) expect(argv.join(" ")).not.toContain(SENTINEL);
    });
  }
});
