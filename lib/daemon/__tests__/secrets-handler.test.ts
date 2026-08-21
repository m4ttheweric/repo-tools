/**
 * secrets:forge-token (MAT-33): the grant gate is the point of the verb, so
 * every test here is about who gets refused. The old world was gitq opening
 * ~/.mattstack/rt/secrets.json itself, where every caller got every token with no
 * grant check anywhere.
 */
import { describe, expect, test } from "bun:test";
import { createSecretsHandlers } from "../handlers/secrets.ts";

const fakeCtx = { log: { info: () => {}, debug: () => {} } } as any;

function handler(opts: {
  tracking?: Record<string, { mode: "live" | "poll"; caches: string[] }>;
  secrets?: { gitlabToken?: string; githubToken?: string };
}) {
  const h = createSecretsHandlers(fakeCtx, {
    tracking: () => (opts.tracking ?? {}) as any,
    secrets: () => opts.secrets ?? {},
  });
  return h["secrets:forge-token"];
}

describe("secrets:forge-token", () => {
  test("tracked repo with a stored token gets it", async () => {
    const res = await handler({
      tracking: { gitq: { mode: "live", caches: ["branches"] } },
      secrets: { gitlabToken: "glpat-abc" },
    })({ repoName: "gitq", forge: "gitlab" });
    expect(res).toEqual({ ok: true, data: { token: "glpat-abc" } });
  });

  test("untracked repo fails closed with the track command", async () => {
    const res = await handler({ secrets: { gitlabToken: "glpat-abc" } })({
      repoName: "gitq",
      forge: "gitlab",
    });
    if (res.ok) throw new Error("expected a refusal");
    expect(res.error).toContain("not tracked by rt");
    expect(res.error).toContain("rt daemon track gitq");
  });

  test("tracked repo with no stored token names the missing key", async () => {
    const res = await handler({
      tracking: { gitq: { mode: "poll", caches: [] } },
      secrets: { gitlabToken: "glpat-abc" },
    })({ repoName: "gitq", forge: "github" });
    if (res.ok) throw new Error("expected a refusal");
    expect(res.error).toContain("githubToken");
  });

  test("missing repoName and unknown forge are rejected before any read", async () => {
    const h = handler({ secrets: { gitlabToken: "glpat-abc" } });
    expect((await h({ repoName: "", forge: "gitlab" })).ok).toBe(false);
    expect((await h({ repoName: "gitq", forge: "bitbucket" as any })).ok).toBe(false);
  });
});

// secrets:read is deliberately token-gated (not grant-gated, unlike
// secrets:forge-token above): the api-token check happens IN THE HANDLER so
// it covers both the HTTP transport (api-server.ts forwards the verified
// X-RT-Token header into the payload) and the unix-socket transport (which
// has no auth of its own — the handler is the only gate there).
function readHandler(opts: {
  extensionSecrets?: () => Promise<{ linearApiKey?: string; gitlabToken?: string }>;
  apiToken?: string;
}) {
  const h = createSecretsHandlers(fakeCtx, {
    extensionSecrets: opts.extensionSecrets ?? (async () => ({})),
    apiToken: () => opts.apiToken ?? "test-token",
  });
  return h["secrets:read"];
}

describe("secrets:read", () => {
  test("returns exactly the whitelisted keys the extension reads — linearApiKey and gitlabToken", async () => {
    const h = readHandler({ extensionSecrets: async () => ({ linearApiKey: "lin_api_x", gitlabToken: "glpat-x" }) });

    const res = await h({ token: "test-token" });

    expect(res).toEqual({ ok: true, data: { linearApiKey: "lin_api_x", gitlabToken: "glpat-x" } });
  });

  test("omits a key entirely (never a blank string) when it isn't set", async () => {
    const h = readHandler({ extensionSecrets: async () => ({ linearApiKey: "lin_api_x" }) });

    const res = await h({ token: "test-token" });

    expect(res).toEqual({ ok: true, data: { linearApiKey: "lin_api_x" } });
    expect("gitlabToken" in (res as any).data).toBe(false);
  });

  test("carries no other Secrets field even if the loader returns one — e.g. sdmEmail never leaks", async () => {
    const h = readHandler({
      extensionSecrets: async () => ({ linearApiKey: "lin_api_x", gitlabToken: "glpat-x", sdmEmail: "me@example.test" } as any),
    });

    const res = await h({ token: "test-token" });

    expect(Object.keys((res as any).data).sort()).toEqual(["gitlabToken", "linearApiKey"]);
  });

  test("missing token -> ok:false 'missing-token', refused before any secrets read", async () => {
    let called = false;
    const h = readHandler({ extensionSecrets: async () => { called = true; return {}; } });

    const res = await h({});

    expect(res).toEqual({ ok: false, error: "missing-token" });
    expect(called).toBe(false);
  });

  test("wrong token -> ok:false 'bad-token', refused before any secrets read", async () => {
    let called = false;
    const h = readHandler({ extensionSecrets: async () => { called = true; return {}; } });

    const res = await h({ token: "wrong" });

    expect(res).toEqual({ ok: false, error: "bad-token" });
    expect(called).toBe(false);
  });

  test("the handler is transport-agnostic — a socket caller reading api-token itself and an HTTP-forwarded header both just succeed with the right token", async () => {
    const h = readHandler({ extensionSecrets: async () => ({ linearApiKey: "lin_api_x" }), apiToken: "shared-secret" });

    expect((await h({ token: "shared-secret" })).ok).toBe(true);
  });
});
