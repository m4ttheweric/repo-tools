import { describe, test, expect } from "bun:test";
import { accountRows, type SecretPresence } from "../validators/accounts.ts";
import { fakeProbes, ok } from "./fakes.ts";
import type { ExecScript } from "./fakes.ts";
import type { TeamSnapshot } from "../team-settings.ts";
import type { PackRequirements } from "../requirements.ts";
import type { SetupIntent } from "../intent.ts";
import type { Integration } from "../contract.ts";

function baseTeam(overrides: Partial<TeamSnapshot> = {}): TeamSnapshot {
  return { slug: "acme", integrations: {}, trackingIdentities: [], marketplaces: [], plugins: [], remote: null, ...overrides };
}

/** Keys are "<domain>.<key>" — mirrors the real store's (domain, key) addressing without touching sops/age. */
function fakeSecrets(stored: Record<string, string> = {}): SecretPresence {
  return {
    async has(domain, key) {
      return stored[`${domain}.${key}`] ?? null;
    },
  };
}

async function pickRow(rowsP: ReturnType<typeof accountRows>, id: string) {
  const rows = await rowsP;
  const r = rows.find((row) => row.id === id);
  if (!r) throw new Error(`no row ${id}; got ids: ${rows.map((row) => row.id).join(", ")}`);
  return r;
}

const JOIN_INTENT: SetupIntent = {
  v: 1,
  at: "2026-08-21T00:00:00.000Z",
  mode: "join",
  join: { id: "inv1", keyB64: "abc", pointer: { v: 1, team: "acme", name: "Acme", remote: "https://gitlab.example.com/acme/mattstack.git", owner: "owner1", forge: "gitlab.example.com", createdAt: "2026-08-01T00:00:00.000Z" } },
};

describe("accountRows — account.gitlab", () => {
  test("declared via forge, no secret -> missing with a connect action carrying the gitlab token field", async () => {
    const team = baseTeam({ integrations: { forge: { host: "gitlab.example.com", provider: "gitlab" } } });
    const r = await pickRow(accountRows(fakeProbes(), team, [], fakeSecrets(), null), "account.gitlab");
    expect(r.status).toBe("missing");
    expect(r.required).toBe(true);
    expect(r.action).toEqual({ type: "connect", label: "Connect", integration: "gitlab", fields: [{ name: "token", label: "GitLab token", secret: true, hint: "read_api, read_user" }] });
  });

  test("secret present, validate 200s -> ready (passes the validator's own detail through untouched)", async () => {
    const team = baseTeam({ integrations: { forge: { host: "gitlab.example.com", provider: "gitlab" } } });
    const fetch = async (url: string) => {
      if (url.includes("/api/v4/user")) return { status: 200, body: "{}", headers: {} };
      if (url.includes("personal_access_tokens/self")) return { status: 200, body: JSON.stringify({ scopes: ["read_api"] }), headers: {} };
      return { status: 200, body: "{}", headers: {} };
    };
    const p = fakeProbes({ fetch });
    const r = await pickRow(accountRows(p, team, [], fakeSecrets({ "rt.gitlabToken": "tok123" }), null), "account.gitlab");
    expect(r.status).toBe("ready");
    expect(r.detail).toBe("gitlab token valid");
  });

  test("secret present, validate's network call is unreachable -> row status error, never invalid (R-T4b)", async () => {
    const team = baseTeam({ integrations: { forge: { host: "gitlab.example.com", provider: "gitlab" } } });
    const fetch = async () => ({ status: 0, body: "", headers: {} });
    const r = await pickRow(accountRows(fakeProbes({ fetch }), team, [], fakeSecrets({ "rt.gitlabToken": "tok123" }), null), "account.gitlab");
    expect(r.status).toBe("error");
  });
});

describe("accountRows — account.github", () => {
  test("no token, gh authenticated -> ready 'via gh (<user>)'", async () => {
    const team = baseTeam({ integrations: { forge: { host: "github.com", provider: "github" } } });
    const exec: ExecScript = (argv) =>
      argv[0] === "gh" && argv[1] === "auth" && argv[2] === "status" ? ok("✓ Logged in to github.com account octocat (keyring)\n") : ok();
    const r = await pickRow(accountRows(fakeProbes({ exec }), team, [], fakeSecrets(), null), "account.github");
    expect(r.status).toBe("ready");
    expect(r.detail).toBe("via gh (octocat)");
  });

  test("no token, gh not authenticated -> missing, connect action carries github's alternatives", async () => {
    const team = baseTeam({ integrations: { forge: { host: "github.com", provider: "github" } } });
    const exec: ExecScript = (argv) => (argv[0] === "gh" && argv[1] === "auth" ? { code: 1, stdout: "", stderr: "not logged in" } : ok());
    const r = await pickRow(accountRows(fakeProbes({ exec }), team, [], fakeSecrets(), null), "account.github");
    expect(r.status).toBe("missing");
    expect(r.action).toMatchObject({ type: "connect", integration: "github", alternatives: [{ id: "use-gh", label: "Use your existing gh CLI session instead" }] });
  });

  test("token present -> validate() drives the row, gh is never probed", async () => {
    const team = baseTeam({ integrations: { forge: { host: "github.com", provider: "github" } } });
    const fetch = async () => ({ status: 200, body: "{}", headers: {} });
    const p = fakeProbes({ fetch });
    const r = await pickRow(accountRows(p, team, [], fakeSecrets({ "rt.githubToken": "gh_tok" }), null), "account.github");
    expect(r.status).toBe("ready");
    expect(p.calls.exec).not.toContainEqual(["gh", "auth", "status"]);
  });
});

describe("accountRows — account.slack + account.slack-app", () => {
  test("a pack wants slack, create intent, no clientId -> slack-app precedes slack, owner-once + required", async () => {
    const reqs: PackRequirements[] = [{ pack: "somepack", integrations: ["slack"], tools: [] }];
    const rows = await accountRows(fakeProbes(), baseTeam(), reqs, fakeSecrets(), { v: 1, at: "2026-08-21T00:00:00.000Z", mode: "create", team: { slug: "acme", name: "Acme", remote: "https://x/acme.git", others: false } });
    const appIdx = rows.findIndex((r) => r.id === "account.slack-app");
    const slackIdx = rows.findIndex((r) => r.id === "account.slack");
    expect(appIdx).toBeGreaterThanOrEqual(0);
    expect(slackIdx).toBeGreaterThan(appIdx);
    const app = rows[appIdx]!;
    expect(app.required).toBe(true);
    expect(app.status).toBe("missing");
    expect(app.action).toEqual({ type: "owner-once", label: "Create the team's Slack app…", integration: "slack", fields: [{ name: "configToken", label: "App configuration token", secret: true }] });
  });

  test("no intent (none) also qualifies for the owner-once row (keep-simple rule)", async () => {
    const reqs: PackRequirements[] = [{ pack: "somepack", integrations: ["slack"], tools: [] }];
    const rows = await accountRows(fakeProbes(), baseTeam(), reqs, fakeSecrets(), null);
    expect(rows.some((r) => r.id === "account.slack-app")).toBe(true);
  });

  test("join intent does not qualify for the owner-once row", async () => {
    const reqs: PackRequirements[] = [{ pack: "somepack", integrations: ["slack"], tools: [] }];
    const rows = await accountRows(fakeProbes(), baseTeam(), reqs, fakeSecrets(), JOIN_INTENT);
    expect(rows.some((r) => r.id === "account.slack-app")).toBe(false);
  });

  test("team already has a clientId -> no owner-once row even under create intent", async () => {
    const reqs: PackRequirements[] = [{ pack: "somepack", integrations: ["slack"], tools: [] }];
    const team = baseTeam({ integrations: { slack: { clientId: "abc" } } });
    const rows = await accountRows(fakeProbes(), team, reqs, fakeSecrets(), { v: 1, at: "2026-08-21T00:00:00.000Z", mode: "create", team: { slug: "acme", name: "Acme", remote: "https://x/acme.git", others: false } });
    expect(rows.some((r) => r.id === "account.slack-app")).toBe(false);
  });

  test("slack row itself: no token -> missing with the oauth connect action", async () => {
    const reqs: PackRequirements[] = [{ pack: "somepack", integrations: ["slack"], tools: [] }];
    const r = await pickRow(accountRows(fakeProbes(), baseTeam(), reqs, fakeSecrets(), null), "account.slack");
    expect(r.status).toBe("missing");
    expect(r.action).toEqual({ type: "oauth", label: "Connect", integration: "slack", verb: ["setup", "slack", "connect"] });
  });
});

describe("accountRows — account.linear declared / not declared", () => {
  test("team.integrations.linear present -> row present", async () => {
    const team = baseTeam({ integrations: { linear: { teamKey: "RT" } } });
    const rows = await accountRows(fakeProbes(), team, [], fakeSecrets(), null);
    expect(rows.some((r) => r.id === "account.linear")).toBe(true);
  });

  test("not declared anywhere -> absent", async () => {
    const rows = await accountRows(fakeProbes(), baseTeam(), [], fakeSecrets(), null);
    expect(rows.some((r) => r.id === "account.linear")).toBe(false);
  });
});

describe("accountRows — account.switchboard", () => {
  test("join intent + secret present -> ready 'redeemed during Join', no network probe", async () => {
    const team = baseTeam({ integrations: { switchboard: { url: "https://sw.example.com" } } });
    const p = fakeProbes();
    const r = await pickRow(accountRows(p, team, [], fakeSecrets({ "rt.switchboardToken": "tok" }), JOIN_INTENT), "account.switchboard");
    expect(r.status).toBe("ready");
    expect(r.detail).toBe("redeemed during Join");
    expect(p.calls.fetch).toEqual([]);
  });

  test("create intent + secret present -> falls through to validate()'s own health probe", async () => {
    const team = baseTeam({ integrations: { switchboard: { url: "https://sw.example.com" } } });
    const fetch = async (url: string) => (url.includes("/health") ? { status: 200, body: "", headers: {} } : { status: 0, body: "", headers: {} });
    const r = await pickRow(accountRows(fakeProbes({ fetch }), team, [], fakeSecrets({ "rt.switchboardToken": "tok" }), null), "account.switchboard");
    expect(r.status).toBe("ready");
    expect(r.detail).toBe("switchboard reachable");
  });

  test("no secret -> missing with a connect action", async () => {
    const team = baseTeam({ integrations: { switchboard: { url: "https://sw.example.com" } } });
    const r = await pickRow(accountRows(fakeProbes(), team, [], fakeSecrets(), null), "account.switchboard");
    expect(r.status).toBe("missing");
    expect(r.action?.type).toBe("connect");
  });
});

describe("accountRows — CLI-owned integrations (no stored secret)", () => {
  test("doppler declared via a pack tool's connect field -> validate() runs directly, no presence check", async () => {
    const reqs: PackRequirements[] = [{ pack: "somepack", integrations: [], tools: [{ name: "doppler", why: "reads team secrets", connect: { integration: "doppler" } }] }];
    const exec: ExecScript = (argv) => (argv[0] === "doppler" && argv[1] === "me" ? ok(JSON.stringify({ ok: true })) : ok());
    const r = await pickRow(accountRows(fakeProbes({ exec }), baseTeam(), reqs, fakeSecrets(), null), "account.doppler");
    expect(r.status).toBe("ready");
  });
});

describe("accountRows — unknown integration id", () => {
  test("an id outside INTEGRATIONS surfaces as an honest error row, never a throw", async () => {
    const badId = "totally-unknown" as unknown as Integration;
    const reqs: PackRequirements[] = [{ pack: "somepack", integrations: [badId], tools: [] }];
    const r = await pickRow(accountRows(fakeProbes(), baseTeam(), reqs, fakeSecrets(), null), "account.totally-unknown");
    expect(r.status).toBe("error");
  });
});
