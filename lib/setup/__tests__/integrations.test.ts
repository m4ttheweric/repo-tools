import { describe, test, expect } from "bun:test";
import { fakeProbes } from "./fakes.ts";
import { INTEGRATIONS, integrationDef } from "../integrations.ts";
import { UserActionableError } from "../errors.ts";

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
});

describe("network-free integrations only ever call through probes", () => {
  test("sdm status 127 → invalid 'not installed'", async () => {
    const p = fakeProbes({ exec: async () => ({ code: 127, stdout: "", stderr: "ENOENT: sdm" }) });
    const result = await INTEGRATIONS.sdm.validate(p, "me@example.com", { host: null, team: { slug: "claimview", remote: null } });
    expect(result).toEqual({ status: "invalid", detail: "sdm not installed", scopesSeen: [] });
  });

  test("sdm status 0 with the email in stdout → ready", async () => {
    const p = fakeProbes({ exec: async () => ({ code: 0, stdout: "logged in as me@example.com", stderr: "" }) });
    const result = await INTEGRATIONS.sdm.validate(p, "me@example.com", { host: null, team: { slug: "claimview", remote: null } });
    expect(result.status).toBe("ready");
  });

  test("doppler me --json 0 → ready", async () => {
    const p = fakeProbes({ exec: async () => ({ code: 0, stdout: "{}", stderr: "" }) });
    const result = await INTEGRATIONS.doppler.validate(p, "", { host: null, team: { slug: "claimview", remote: null } });
    expect(result.status).toBe("ready");
    expect(p.calls.exec).toEqual([["doppler", "me", "--json"]]);
  });

  test("ldcli config --list 0 → ready", async () => {
    const p = fakeProbes({ exec: async () => ({ code: 0, stdout: "", stderr: "" }) });
    const result = await INTEGRATIONS.ldcli.validate(p, "", { host: null, team: { slug: "claimview", remote: null } });
    expect(result.status).toBe("ready");
    expect(p.calls.exec).toEqual([["ldcli", "config", "--list"]]);
  });
});

describe("slack validate", () => {
  test("auth.test ok:true → ready with team in detail", async () => {
    const p = fakeProbes({ fetch: async () => ({ status: 200, body: JSON.stringify({ ok: true, team: "Mattstack" }), headers: {} }) });
    const result = await INTEGRATIONS.slack.validate(p, "xoxp-token", { host: null, team: { slug: "claimview", remote: null } });
    expect(result.status).toBe("ready");
    expect(result.detail).toContain("Mattstack");
  });

  test("auth.test ok:false → invalid", async () => {
    const p = fakeProbes({ fetch: async () => ({ status: 200, body: JSON.stringify({ ok: false, error: "invalid_auth" }), headers: {} }) });
    const result = await INTEGRATIONS.slack.validate(p, "xoxp-token", { host: null, team: { slug: "claimview", remote: null } });
    expect(result.status).toBe("invalid");
  });
});

describe("switchboard validate", () => {
  test("no host configured → invalid without a network call", async () => {
    const p = fakeProbes();
    const result = await INTEGRATIONS.switchboard.validate(p, "token", { host: null, team: { slug: "claimview", remote: null } });
    expect(result.status).toBe("invalid");
    expect(p.calls.fetch).toEqual([]);
  });

  test("/health 200 → ready", async () => {
    const p = fakeProbes({ fetch: async () => ({ status: 200, body: "", headers: {} }) });
    const result = await INTEGRATIONS.switchboard.validate(p, "token", { host: "https://switchboard.example.com", team: { slug: "claimview", remote: null } });
    expect(result.status).toBe("ready");
  });
});
