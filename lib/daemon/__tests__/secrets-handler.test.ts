/**
 * secrets:forge-token (MAT-33): the grant gate is the point of the verb, so
 * every test here is about who gets refused. The old world was gitq opening
 * ~/.mattstack/rt/secrets.json itself, where every caller got every token with no
 * grant check anywhere.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { createSecretsHandlers } from "../handlers/secrets.ts";
import { teamSettingsPath } from "../../rt-paths.ts";
import { setSetting } from "../../settings/write.ts";
import { loadRepoTracking } from "../../repo-tracking.ts";

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

/**
 * The default tracking reader (no `overrides.tracking`) is
 * `loadMachineRepoTracking` — machine-only, no team merge. A team file
 * (mattstack.tracking) is shared and must never be enough on its own to
 * unlock a forge token; only a local machine grant counts.
 */
describe("secrets:forge-token default tracking reader is machine-only", () => {
  const origHome = process.env.HOME;
  let home: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-secrets-tracking-")));
    process.env.HOME = home;
    const teamPath = teamSettingsPath("acme");
    mkdirSync(dirname(teamPath), { recursive: true });
    writeFileSync(teamPath, "// team store\n{}\n");
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(home, { recursive: true, force: true });
  });

  test("a repo declared ONLY via team intent is refused, even though the merged view would allow it", async () => {
    setSetting("mattstack.tracking", {
      repos: { "gitlab.com/acme/foo": { caches: ["branches"] } },
    }, "team", { team: "acme" });
    const identityMap = { "gitlab.com/acme/foo": "foo" };

    // Positive control: the merged view really would consider "foo" tracked.
    expect(loadRepoTracking({ identityMap }).foo).toBeDefined();

    const h = createSecretsHandlers(fakeCtx, { secrets: () => ({ gitlabToken: "glpat-abc" }) });
    const res = await h["secrets:forge-token"]({ repoName: "foo", forge: "gitlab" });

    if (res.ok) throw new Error("expected a refusal");
    expect(res.error).toContain("not tracked by rt");
  });

  test("a repo granted via the machine store is allowed", async () => {
    setSetting("rt.repoTracking", { foo: { mode: "live", caches: ["branches"] } }, "machine");

    const h = createSecretsHandlers(fakeCtx, { secrets: () => ({ gitlabToken: "glpat-abc" }) });
    const res = await h["secrets:forge-token"]({ repoName: "foo", forge: "gitlab" });

    expect(res).toEqual({ ok: true, data: { token: "glpat-abc" } });
  });
});

// secrets:read is deliberately token-gated (not grant-gated, unlike
// secrets:forge-token above): the api-token check happens IN THE HANDLER so
// it covers both the HTTP transport (api-server.ts forwards the verified
// X-RT-Token header into the payload) and the unix-socket transport (which
// has no auth of its own — the handler is the only gate there).
function readHandler(opts: {
  extensionSecrets?: () => Promise<{ linearApiKey?: string; gitlabToken?: string }>;
  deckSecrets?: () => Promise<{ cfApiToken?: string; cfZoneId?: string }>;
  apiToken?: string;
}) {
  const h = createSecretsHandlers(fakeCtx, {
    extensionSecrets: opts.extensionSecrets ?? (async () => ({})),
    deckSecrets: opts.deckSecrets ?? (async () => ({})),
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

  test("omitted scope defaults to extension and never touches the deck reader", async () => {
    let deckCalled = false;
    const h = readHandler({
      extensionSecrets: async () => ({ linearApiKey: "lin_api_x" }),
      deckSecrets: async () => { deckCalled = true; return { cfApiToken: "cf-tok" }; },
    });

    const res = await h({ token: "test-token" });

    expect(res).toEqual({ ok: true, data: { linearApiKey: "lin_api_x" } });
    expect(deckCalled).toBe(false);
  });
});

// scope: "deck" (Task 3) reads a wholly different encrypted domain
// (lib/secrets/store.ts readSecret("deck", ...)) — the whitelist and the
// domain are both per-scope, so an rt-domain value seeded for the extension
// scope must never leak into a deck-scope read, and vice versa.
describe("secrets:read scope", () => {
  test("deck scope returns only cfApiToken/cfZoneId, never an rt-domain key seeded for extension scope", async () => {
    const h = readHandler({
      extensionSecrets: async () => ({ linearApiKey: "lin_api_x", gitlabToken: "glpat-x" }),
      deckSecrets: async () => ({ cfApiToken: "cf-tok", cfZoneId: "zone-1" }),
    });

    const res = await h({ token: "test-token", scope: "deck" });

    expect(res).toEqual({ ok: true, data: { cfApiToken: "cf-tok", cfZoneId: "zone-1" } });
    expect("linearApiKey" in (res as any).data).toBe(false);
  });

  test("deck scope omits a key entirely when it isn't set", async () => {
    const h = readHandler({ deckSecrets: async () => ({ cfApiToken: "cf-tok" }) });

    const res = await h({ token: "test-token", scope: "deck" });

    expect(res).toEqual({ ok: true, data: { cfApiToken: "cf-tok" } });
    expect("cfZoneId" in (res as any).data).toBe(false);
  });

  test("extension scope is unchanged when named explicitly", async () => {
    const h = readHandler({ extensionSecrets: async () => ({ linearApiKey: "lin_api_x", gitlabToken: "glpat-x" }) });

    const res = await h({ token: "test-token", scope: "extension" });

    expect(res).toEqual({ ok: true, data: { linearApiKey: "lin_api_x", gitlabToken: "glpat-x" } });
  });

  test("bad scope is refused before either reader runs", async () => {
    let extensionCalled = false;
    let deckCalled = false;
    const h = readHandler({
      extensionSecrets: async () => { extensionCalled = true; return {}; },
      deckSecrets: async () => { deckCalled = true; return {}; },
    });

    const res = await h({ token: "test-token", scope: "bitbucket" as any });

    expect(res).toEqual({ ok: false, error: "bad-scope" });
    expect(extensionCalled).toBe(false);
    expect(deckCalled).toBe(false);
  });

  test("the token gate applies to the deck scope exactly as it does to extension", async () => {
    let deckCalled = false;
    const h = readHandler({ deckSecrets: async () => { deckCalled = true; return {}; } });

    const missing = await h({ scope: "deck" });
    expect(missing).toEqual({ ok: false, error: "missing-token" });

    const wrong = await h({ token: "wrong", scope: "deck" });
    expect(wrong).toEqual({ ok: false, error: "bad-token" });

    expect(deckCalled).toBe(false);
  });
});
