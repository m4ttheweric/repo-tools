/**
 * secrets:forge-token: the grant gate is the point of the verb, so every
 * test here is about who gets refused.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { createSecretsHandlers, loadBoardSecrets, type BoardSecretsData, type ReadSecretFn } from "../handlers/secrets.ts";
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

// Hard cutover: grants() and the payload gate both require a
// serialized identity, so every `repoName` fixture below is identity-shaped
// (`remote:...`), not a bare legacy name.
describe("secrets:forge-token", () => {
  test("tracked repo with a stored token gets it", async () => {
    const res = await handler({
      tracking: { "remote:gitq": { mode: "live", caches: ["branches"] } },
      secrets: { gitlabToken: "glpat-abc" },
    })({ repoName: "remote:gitq", forge: "gitlab" });
    expect(res).toEqual({ ok: true, data: { token: "glpat-abc" } });
  });

  test("untracked repo fails closed with the track command", async () => {
    const res = await handler({ secrets: { gitlabToken: "glpat-abc" } })({
      repoName: "remote:gitq",
      forge: "gitlab",
    });
    if (res.ok) throw new Error("expected a refusal");
    expect(res.error).toContain("not tracked by rt");
    expect(res.error).toContain("rt daemon track remote:gitq");
  });

  test("tracked repo with no stored token names the missing key", async () => {
    const res = await handler({
      tracking: { "remote:gitq": { mode: "poll", caches: [] } },
      secrets: { gitlabToken: "glpat-abc" },
    })({ repoName: "remote:gitq", forge: "github" });
    if (res.ok) throw new Error("expected a refusal");
    expect(res.error).toContain("githubToken");
  });

  test("missing repoName and unknown forge are rejected before any read", async () => {
    const h = handler({ secrets: { gitlabToken: "glpat-abc" } });
    expect((await h({ repoName: "", forge: "gitlab" })).ok).toBe(false);
    expect((await h({ repoName: "remote:gitq", forge: "bitbucket" as any })).ok).toBe(false);
  });

  test("a bare legacy repoName is refused before any tracking or secrets read, never a fallback token", async () => {
    let trackingCalled = false;
    let secretsCalled = false;
    const h = createSecretsHandlers(fakeCtx, {
      tracking: () => { trackingCalled = true; return { gitq: { mode: "live", caches: ["branches"] } } as any; },
      secrets: () => { secretsCalled = true; return { gitlabToken: "glpat-abc" }; },
    })["secrets:forge-token"];

    const res = await h({ repoName: "gitq", forge: "gitlab" });

    if (res.ok) throw new Error("expected a refusal");
    expect(res.error).toContain("not tracked by rt");
    expect(trackingCalled).toBe(false);
    expect(secretsCalled).toBe(false);
  });

  test("a secrets-reader throw (e.g. an unreadable encrypted store) surfaces as a rejected promise, never a fallback token", async () => {
    const h = createSecretsHandlers(fakeCtx, {
      tracking: () => ({ "remote:gitq": { mode: "live", caches: ["branches"] } }) as any,
      secrets: () => { throw new Error("decryption failed"); },
    })["secrets:forge-token"];

    await expect(h({ repoName: "remote:gitq", forge: "gitlab" })).rejects.toThrow("decryption failed");
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
    const identityMap = { "gitlab.com/acme/foo": "remote:foo" };

    // Positive control: the merged view really would consider "remote:foo" tracked.
    expect(loadRepoTracking({ identityMap })["remote:foo"]).toBeDefined();

    const h = createSecretsHandlers(fakeCtx, { secrets: () => ({ gitlabToken: "glpat-abc" }) });
    const res = await h["secrets:forge-token"]({ repoName: "remote:foo", forge: "gitlab" });

    if (res.ok) throw new Error("expected a refusal");
    expect(res.error).toContain("not tracked by rt");
  });

  test("a repo granted via the machine store is allowed", async () => {
    setSetting("rt.repoTracking", { "remote:foo": { mode: "live", caches: ["branches"] } }, "machine");

    const h = createSecretsHandlers(fakeCtx, { secrets: () => ({ gitlabToken: "glpat-abc" }) });
    const res = await h["secrets:forge-token"]({ repoName: "remote:foo", forge: "gitlab" });

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
  boardSecrets?: () => Promise<BoardSecretsData>;
  apiToken?: string;
}) {
  const h = createSecretsHandlers(fakeCtx, {
    extensionSecrets: opts.extensionSecrets ?? (async () => ({})),
    deckSecrets: opts.deckSecrets ?? (async () => ({})),
    boardSecrets: opts.boardSecrets ?? (async () => ({})),
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

  test("an extensionSecrets throw (e.g. an unreadable encrypted store) surfaces as a rejected promise, never a partial ok", async () => {
    const h = readHandler({ extensionSecrets: async () => { throw new Error("decryption failed"); } });

    await expect(h({ token: "test-token" })).rejects.toThrow("decryption failed");
  });
});

// scope: "deck" reads a wholly different encrypted domain (lib/secrets/
// store.ts readSecret("deck", ...)) — the whitelist and the domain are both
// per-scope, so an rt-domain value seeded for the extension scope must
// never leak into a deck-scope read, and vice versa.
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

  test("bad scope is refused before any reader runs", async () => {
    let extensionCalled = false;
    let deckCalled = false;
    let boardCalled = false;
    const h = readHandler({
      extensionSecrets: async () => { extensionCalled = true; return {}; },
      deckSecrets: async () => { deckCalled = true; return {}; },
      boardSecrets: async () => { boardCalled = true; return {}; },
    });

    const res = await h({ token: "test-token", scope: "bitbucket" as any });

    expect(res).toEqual({ ok: false, error: "bad-scope" });
    expect(extensionCalled).toBe(false);
    expect(deckCalled).toBe(false);
    expect(boardCalled).toBe(false);
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

  test("a case-variant scope (\"Deck\") is refused, not treated as \"deck\"", async () => {
    let deckCalled = false;
    const h = readHandler({ deckSecrets: async () => { deckCalled = true; return {}; } });

    const res = await h({ token: "test-token", scope: "Deck" as any });

    expect(res).toEqual({ ok: false, error: "bad-scope" });
    expect(deckCalled).toBe(false);
  });

  test("a case-variant scope (\"Board\") is refused, not treated as \"board\"", async () => {
    let boardCalled = false;
    const h = readHandler({ boardSecrets: async () => { boardCalled = true; return {}; } });

    const res = await h({ token: "test-token", scope: "Board" as any });

    expect(res).toEqual({ ok: false, error: "bad-scope" });
    expect(boardCalled).toBe(false);
  });

  test("a non-string scope (array) is refused, not coerced into a match", async () => {
    let extensionCalled = false;
    let deckCalled = false;
    let boardCalled = false;
    const h = readHandler({
      extensionSecrets: async () => { extensionCalled = true; return {}; },
      deckSecrets: async () => { deckCalled = true; return {}; },
      boardSecrets: async () => { boardCalled = true; return {}; },
    });

    const res = await h({ token: "test-token", scope: ["deck"] as any });

    expect(res).toEqual({ ok: false, error: "bad-scope" });
    expect(extensionCalled).toBe(false);
    expect(deckCalled).toBe(false);
    expect(boardCalled).toBe(false);
  });

  test("a deck-reader throw surfaces as a rejected promise (transport error), never a partial ok", async () => {
    const h = readHandler({ deckSecrets: async () => { throw new Error("sops -d exploded"); } });

    await expect(h({ token: "test-token", scope: "deck" })).rejects.toThrow("sops -d exploded");
  });
});

// scope: "board" is CROSS-DOMAIN — slackToken/slackClientSecret/
// slackSigningSecret come from the `board` domain, gitlabToken/
// switchboardToken/switchboardAdminToken from the `rt` domain. A value
// seeded for extension/deck must never leak into a board read, and a
// board-seeded value must never leak into extension/deck (gitlabToken
// appears in both extension's and board's whitelist, but each scope reads
// its OWN loader — this is what the isolation tests below pin down).
describe("secrets:read scope \"board\"", () => {
  test("returns exactly the six whitelisted keys when all are set", async () => {
    const h = readHandler({
      boardSecrets: async () => ({
        slackToken: "xoxb-1",
        slackClientSecret: "slack-cs",
        slackSigningSecret: "slack-ss",
        gitlabToken: "glpat-board",
        switchboardToken: "sb-tok",
        switchboardAdminToken: "sb-admin",
      }),
    });

    const res = await h({ token: "test-token", scope: "board" });

    expect(res).toEqual({
      ok: true,
      data: {
        slackToken: "xoxb-1",
        slackClientSecret: "slack-cs",
        slackSigningSecret: "slack-ss",
        gitlabToken: "glpat-board",
        switchboardToken: "sb-tok",
        switchboardAdminToken: "sb-admin",
      },
    });
  });

  test("omits keys entirely (never a blank string) when they aren't set", async () => {
    const h = readHandler({ boardSecrets: async () => ({ slackToken: "xoxb-1" }) });

    const res = await h({ token: "test-token", scope: "board" });

    expect(res).toEqual({ ok: true, data: { slackToken: "xoxb-1" } });
    expect("slackClientSecret" in (res as any).data).toBe(false);
    expect("gitlabToken" in (res as any).data).toBe(false);
  });

  test("carries no other field even if the loader returns one — e.g. linearApiKey never leaks into board", async () => {
    const h = readHandler({
      boardSecrets: async () => ({ slackToken: "xoxb-1", linearApiKey: "leak" } as any),
    });

    const res = await h({ token: "test-token", scope: "board" });

    expect(Object.keys((res as any).data)).toEqual(["slackToken"]);
  });

  test("board scope never leaks an rt-domain value seeded only for extension scope (e.g. linearApiKey, or a differently-sourced gitlabToken)", async () => {
    const h = readHandler({
      extensionSecrets: async () => ({ linearApiKey: "lin_api_x", gitlabToken: "glpat-extension" }),
      boardSecrets: async () => ({ slackToken: "xoxb-1" }),
    });

    const res = await h({ token: "test-token", scope: "board" });

    expect(res).toEqual({ ok: true, data: { slackToken: "xoxb-1" } });
    expect("linearApiKey" in (res as any).data).toBe(false);
    expect("gitlabToken" in (res as any).data).toBe(false);
  });

  test("board scope never leaks a deck-domain value", async () => {
    const h = readHandler({
      deckSecrets: async () => ({ cfApiToken: "cf-tok", cfZoneId: "zone-1" }),
      boardSecrets: async () => ({ slackToken: "xoxb-1" }),
    });

    const res = await h({ token: "test-token", scope: "board" });

    expect(res).toEqual({ ok: true, data: { slackToken: "xoxb-1" } });
    expect("cfApiToken" in (res as any).data).toBe(false);
    expect("cfZoneId" in (res as any).data).toBe(false);
  });

  test("extension and deck scopes never leak a board-seeded value (slack*/switchboard* stay out of both)", async () => {
    const boardSecrets = async () => ({
      slackToken: "xoxb-1",
      slackClientSecret: "slack-cs",
      slackSigningSecret: "slack-ss",
      gitlabToken: "glpat-board",
      switchboardToken: "sb-tok",
      switchboardAdminToken: "sb-admin",
    });

    const extensionRes = await readHandler({
      extensionSecrets: async () => ({ linearApiKey: "lin_api_x", gitlabToken: "glpat-extension" }),
      boardSecrets,
    })({ token: "test-token" });
    expect(extensionRes).toEqual({ ok: true, data: { linearApiKey: "lin_api_x", gitlabToken: "glpat-extension" } });
    expect("slackToken" in (extensionRes as any).data).toBe(false);
    expect("switchboardToken" in (extensionRes as any).data).toBe(false);

    const deckRes = await readHandler({
      deckSecrets: async () => ({ cfApiToken: "cf-tok", cfZoneId: "zone-1" }),
      boardSecrets,
    })({ token: "test-token", scope: "deck" });
    expect(deckRes).toEqual({ ok: true, data: { cfApiToken: "cf-tok", cfZoneId: "zone-1" } });
    expect("slackToken" in (deckRes as any).data).toBe(false);
    expect("switchboardAdminToken" in (deckRes as any).data).toBe(false);
  });

  test("the token gate applies to the board scope exactly as it does to extension/deck", async () => {
    let boardCalled = false;
    const h = readHandler({ boardSecrets: async () => { boardCalled = true; return {}; } });

    const missing = await h({ scope: "board" });
    expect(missing).toEqual({ ok: false, error: "missing-token" });

    const wrong = await h({ token: "wrong", scope: "board" });
    expect(wrong).toEqual({ ok: false, error: "bad-token" });

    expect(boardCalled).toBe(false);
  });

  test("a board-domain readSecret throw propagates as a rejected promise (transport error), never a partial ok", async () => {
    const h = readHandler({ boardSecrets: async () => { throw new Error("sops -d exploded"); } });

    await expect(h({ token: "test-token", scope: "board" })).rejects.toThrow("sops -d exploded");
  });
});

// Exercises the real `loadBoardSecrets` (not the handler's `boardSecrets`
// override) with an injected `ReadSecretFn`, so a future whitelist edit or
// domain typo in BOARD_SECRET_ENTRIES fails this suite even though the
// handler-level tests above only stub the loader's return shape.
describe("loadBoardSecrets", () => {
  test("reads exactly the six (domain, key) entries, in order", async () => {
    const calls: Array<[string, string]> = [];
    const fake: ReadSecretFn = async (domain, key) => {
      calls.push([domain, key]);
      return `${domain}:${key}`;
    };

    const data = await loadBoardSecrets(fake);

    expect(calls).toEqual([
      ["board", "slackToken"],
      ["board", "slackClientSecret"],
      ["board", "slackSigningSecret"],
      ["rt", "gitlabToken"],
      ["rt", "switchboardToken"],
      ["rt", "switchboardAdminToken"],
    ]);
    const expected: BoardSecretsData = {
      slackToken: "board:slackToken",
      slackClientSecret: "board:slackClientSecret",
      slackSigningSecret: "board:slackSigningSecret",
      gitlabToken: "rt:gitlabToken",
      switchboardToken: "rt:switchboardToken",
      switchboardAdminToken: "rt:switchboardAdminToken",
    };
    expect(data).toEqual(expected);
  });

  test("omits an entry whose read returns null", async () => {
    const fake: ReadSecretFn = async (domain, key) =>
      domain === "board" && key === "slackClientSecret" ? null : `${domain}:${key}`;

    const data = await loadBoardSecrets(fake);

    expect("slackClientSecret" in data).toBe(false);
    expect(data.slackToken).toBe("board:slackToken");
  });

  test("a throw on the first rt-domain read (after all three board-domain reads succeed) rejects the whole call — nothing partial, and later entries are never attempted", async () => {
    const calls: Array<[string, string]> = [];
    const fake: ReadSecretFn = async (domain, key) => {
      calls.push([domain, key]);
      if (domain === "rt") throw new Error("sops -d exploded");
      return `${domain}:${key}`;
    };

    await expect(loadBoardSecrets(fake)).rejects.toThrow("sops -d exploded");
    expect(calls).toEqual([
      ["board", "slackToken"],
      ["board", "slackClientSecret"],
      ["board", "slackSigningSecret"],
      ["rt", "gitlabToken"],
    ]);
  });
});
