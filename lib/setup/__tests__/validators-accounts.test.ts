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

const CREATE_INTENT: SetupIntent = { v: 1, at: "2026-08-21T00:00:00.000Z", mode: "create", team: { slug: "acme", name: "Acme", remote: "https://x/acme.git", others: false } };
const JOIN_INTENT: SetupIntent = {
  v: 1,
  at: "2026-08-21T00:00:00.000Z",
  mode: "join",
  join: { id: "inv1", keyB64: "abc", pointer: { v: 1, team: "acme", name: "Acme", remote: "https://gitlab.example.com/acme/mattstack.git", owner: "owner1", forge: "gitlab.example.com", createdAt: "2026-08-01T00:00:00.000Z" } },
};
const RESTORE_INTENT: SetupIntent = { v: 1, at: "2026-08-21T00:00:00.000Z", mode: "restore", restore: { homeRepo: "/x" } };

describe("accountRows — account.gitlab", () => {
  test("declared via forge, no secret -> missing, full row pinned (fields, recheck, optionalNote, required)", async () => {
    const team = baseTeam({ integrations: { forge: { host: "gitlab.example.com", provider: "gitlab" } } });
    const r = await pickRow(accountRows(fakeProbes(), team, [], fakeSecrets(), null), "account.gitlab");
    expect(r).toEqual({
      id: "account.gitlab",
      kind: "account",
      title: "GitLab",
      why: "Lets rt open MRs, check pipelines, and read project metadata on gitlab.example.com.",
      required: true,
      optionalNote: null,
      status: "missing",
      detail: "no GitLab account connected",
      action: { type: "connect", label: "Connect", integration: "gitlab", fields: [{ name: "token", label: "GitLab token", secret: true, hint: "read_api, read_user" }] },
      recheck: "on-change",
    });
  });

  test("secret present, host user-confirmed, validate 200s -> ready", async () => {
    const team = baseTeam({ integrations: { forge: { host: "gitlab.example.com", provider: "gitlab" } } });
    const fetch = async (url: string) => {
      if (url.includes("/api/v4/user")) return { status: 200, body: "{}", headers: {} };
      if (url.includes("personal_access_tokens/self")) return { status: 200, body: JSON.stringify({ scopes: ["read_api"] }), headers: {} };
      return { status: 200, body: "{}", headers: {} };
    };
    const r = await pickRow(
      accountRows(fakeProbes({ fetch }), team, [], fakeSecrets({ "rt.gitlabToken": "tok123" }), null, { forgeHost: "gitlab.example.com" }),
      "account.gitlab",
    );
    expect(r.status).toBe("ready");
    expect(r.detail).toBe("gitlab token valid");
  });

  test("secret present, host user-confirmed, validate rejects (401) -> invalid, WITH a connect action so a revoked token is replaceable (H2)", async () => {
    const team = baseTeam({ integrations: { forge: { host: "gitlab.example.com", provider: "gitlab" } } });
    const fetch = async () => ({ status: 401, body: "", headers: {} });
    const r = await pickRow(
      accountRows(fakeProbes({ fetch }), team, [], fakeSecrets({ "rt.gitlabToken": "tok123" }), null, { forgeHost: "gitlab.example.com" }),
      "account.gitlab",
    );
    expect(r.status).toBe("invalid");
    expect(r.action).toEqual({ type: "connect", label: "Connect", integration: "gitlab", fields: [{ name: "token", label: "GitLab token", secret: true, hint: "read_api, read_user" }] });
  });

  test("secret present, host NOT user-confirmed -> error, and the token is never sent (R-F2)", async () => {
    const team = baseTeam({ integrations: { forge: { host: "gitlab.example.com", provider: "gitlab" } } });
    const p = fakeProbes();
    const r = await pickRow(accountRows(p, team, [], fakeSecrets({ "rt.gitlabToken": "tok123" }), null), "account.gitlab");
    expect(r.status).toBe("error");
    expect(p.calls.fetch).toEqual([]);
  });

  test("secret present, validate's network call is unreachable -> error, never invalid (R-T4b), still carries an action (H2)", async () => {
    const team = baseTeam({ integrations: { forge: { host: "gitlab.example.com", provider: "gitlab" } } });
    const fetch = async () => ({ status: 0, body: "", headers: {} });
    const r = await pickRow(accountRows(fakeProbes({ fetch }), team, [], fakeSecrets({ "rt.gitlabToken": "tok123" }), null), "account.gitlab");
    expect(r.status).toBe("error");
    expect(r.action?.type).toBe("connect");
  });

  test("why() never borrows the forge host when this row isn't the declared forge (finding 13)", async () => {
    const team = baseTeam({ integrations: { forge: { host: "github.com", provider: "github" } } });
    const reqs: PackRequirements[] = [{ pack: "somepack", integrations: ["gitlab"], tools: [] }];
    const r = await pickRow(accountRows(fakeProbes(), team, reqs, fakeSecrets(), null), "account.gitlab");
    expect(r.why).not.toContain("github.com");
    expect(r.why).toBe("Lets rt open MRs, check pipelines, and read project metadata on GitLab.");
  });

  test("dedupe: forge declares gitlab AND a pack also names it directly -> one row only", async () => {
    const team = baseTeam({ integrations: { forge: { host: "gitlab.example.com", provider: "gitlab" } } });
    const reqs: PackRequirements[] = [{ pack: "somepack", integrations: ["gitlab"], tools: [] }];
    const rows = await accountRows(fakeProbes(), team, reqs, fakeSecrets(), null);
    expect(rows.filter((r) => r.id === "account.gitlab")).toHaveLength(1);
  });
});

describe("accountRows — account.github", () => {
  function githubTeam(): TeamSnapshot {
    return baseTeam({ integrations: { forge: { host: "github.com", provider: "github" } } });
  }

  test("no token, gh authenticated -> ready 'via gh (<user>)'", async () => {
    const exec: ExecScript = (argv) =>
      argv[0] === "gh" && argv[1] === "auth" && argv[2] === "status" ? ok("✓ Logged in to github.com account octocat (keyring)\n") : ok();
    const r = await pickRow(accountRows(fakeProbes({ exec }), githubTeam(), [], fakeSecrets(), null), "account.github");
    expect(r.status).toBe("ready");
    expect(r.detail).toBe("via gh (octocat)");
    expect(r.why).toBe("Lets rt open PRs, check CI, and read repo metadata on github.com.");
  });

  test("no token, gh output doesn't match the known 'as'/'account' shapes -> ready 'via gh' with no user suffix", async () => {
    const exec: ExecScript = (argv) => (argv[0] === "gh" ? ok("gh: you are authenticated\n") : ok());
    const r = await pickRow(accountRows(fakeProbes({ exec }), githubTeam(), [], fakeSecrets(), null), "account.github");
    expect(r.status).toBe("ready");
    expect(r.detail).toBe("via gh");
  });

  test("no token, gh not authenticated -> missing, connect action WITHOUT alternatives (H1 fix: no session to fall back to)", async () => {
    const exec: ExecScript = (argv) => (argv[0] === "gh" && argv[1] === "auth" ? { code: 1, stdout: "", stderr: "not logged in" } : ok());
    const r = await pickRow(accountRows(fakeProbes({ exec }), githubTeam(), [], fakeSecrets(), null), "account.github");
    expect(r.status).toBe("missing");
    expect(r.action).toEqual({ type: "connect", label: "Connect", integration: "github", fields: [{ name: "token", label: "GitHub token", secret: true, hint: "repo, read:org" }] });
  });

  test("gh CLI not installed (127) -> missing, detail names it, no alternatives", async () => {
    const exec: ExecScript = (argv) => (argv[0] === "gh" ? { code: 127, stdout: "", stderr: "ENOENT: gh" } : ok());
    const r = await pickRow(accountRows(fakeProbes({ exec }), githubTeam(), [], fakeSecrets(), null), "account.github");
    expect(r.status).toBe("missing");
    expect(r.detail).toContain("not installed");
    expect(r.action).toMatchObject({ type: "connect" });
    expect((r.action as { alternatives?: unknown }).alternatives).toBeUndefined();
  });

  test("token present, validate ready -> ready, gh is never probed", async () => {
    const fetch = async () => ({ status: 200, body: "{}", headers: {} });
    const p = fakeProbes({ fetch });
    const r = await pickRow(accountRows(p, githubTeam(), [], fakeSecrets({ "rt.githubToken": "gh_tok" }), null), "account.github");
    expect(r.status).toBe("ready");
    expect(p.calls.exec).not.toContainEqual(["gh", "auth", "status"]);
  });

  test("token present, validate invalid + gh authenticated -> invalid WITH alternatives (H1 fixed direction)", async () => {
    const exec: ExecScript = (argv) => (argv[0] === "gh" ? ok("Logged in to github.com account octocat (keyring)\n") : ok());
    const fetch = async () => ({ status: 401, body: "", headers: {} });
    const r = await pickRow(accountRows(fakeProbes({ exec, fetch }), githubTeam(), [], fakeSecrets({ "rt.githubToken": "gh_tok" }), null), "account.github");
    expect(r.status).toBe("invalid");
    expect(r.action).toEqual({
      type: "connect",
      label: "Connect",
      integration: "github",
      fields: [{ name: "token", label: "GitHub token", secret: true, hint: "repo, read:org" }],
      alternatives: [{ id: "use-gh", label: "Use your existing gh CLI session instead" }],
    });
  });

  test("token present, validate invalid + gh NOT authenticated -> invalid WITHOUT alternatives (nothing to fall back to)", async () => {
    const exec: ExecScript = (argv) => (argv[0] === "gh" ? { code: 1, stdout: "", stderr: "" } : ok());
    const fetch = async () => ({ status: 401, body: "", headers: {} });
    const r = await pickRow(accountRows(fakeProbes({ exec, fetch }), githubTeam(), [], fakeSecrets({ "rt.githubToken": "gh_tok" }), null), "account.github");
    expect(r.status).toBe("invalid");
    expect((r.action as { alternatives?: unknown })?.alternatives).toBeUndefined();
  });
});

describe("accountRows — account.slack + account.slack-app", () => {
  const SLACK_REQS: PackRequirements[] = [{ pack: "somepack", integrations: ["slack"], tools: [] }];

  test("create intent -> owner-once row required:true, no optionalNote, precedes account.slack", async () => {
    const rows = await accountRows(fakeProbes(), baseTeam(), SLACK_REQS, fakeSecrets(), CREATE_INTENT);
    const appIdx = rows.findIndex((r) => r.id === "account.slack-app");
    const slackIdx = rows.findIndex((r) => r.id === "account.slack");
    expect(appIdx).toBeGreaterThanOrEqual(0);
    expect(slackIdx).toBeGreaterThan(appIdx);
    const app = rows[appIdx]!;
    expect(app.required).toBe(true);
    expect(app.optionalNote).toBeNull();
    expect(app.status).toBe("missing");
    expect(app.action).toEqual({ type: "owner-once", label: "Create the team's Slack app…", integration: "slack", fields: [{ name: "configToken", label: "App configuration token", secret: true }] });
  });

  test("no intent -> owner-once row present but required:false with an optionalNote naming the owner path (R-T9-a)", async () => {
    const rows = await accountRows(fakeProbes(), baseTeam(), SLACK_REQS, fakeSecrets(), null);
    const app = rows.find((r) => r.id === "account.slack-app")!;
    expect(app).toBeDefined();
    expect(app.required).toBe(false);
    expect(app.optionalNote).toContain("owner");
  });

  test("join intent -> owner-once row present, required:false (a joining member is never the owner)", async () => {
    const rows = await accountRows(fakeProbes(), baseTeam(), SLACK_REQS, fakeSecrets(), JOIN_INTENT);
    const app = rows.find((r) => r.id === "account.slack-app");
    expect(app).toBeDefined();
    expect(app?.required).toBe(false);
  });

  test("restore intent -> owner-once row present, required:false", async () => {
    const rows = await accountRows(fakeProbes(), baseTeam(), SLACK_REQS, fakeSecrets(), RESTORE_INTENT);
    const app = rows.find((r) => r.id === "account.slack-app");
    expect(app).toBeDefined();
    expect(app?.required).toBe(false);
  });

  test("team already has a clientId -> no owner-once row regardless of intent", async () => {
    const team = baseTeam({ integrations: { slack: { clientId: "abc" } } });
    const rows = await accountRows(fakeProbes(), team, SLACK_REQS, fakeSecrets(), CREATE_INTENT);
    expect(rows.some((r) => r.id === "account.slack-app")).toBe(false);
  });

  test("slack named only via a tool connect field (not reqs.integrations) still triggers the owner-once row (finding 14/L5)", async () => {
    const reqs: PackRequirements[] = [{ pack: "somepack", integrations: [], tools: [{ name: "slack-cli", why: "posts standups", connect: { integration: "slack" } }] }];
    const rows = await accountRows(fakeProbes(), baseTeam(), reqs, fakeSecrets(), CREATE_INTENT);
    expect(rows.some((r) => r.id === "account.slack-app")).toBe(true);
  });

  test("account.slack: no app yet -> missing, explains the dependency, no oauth action (finding 15/L6)", async () => {
    const r = await pickRow(accountRows(fakeProbes(), baseTeam(), SLACK_REQS, fakeSecrets(), CREATE_INTENT), "account.slack");
    expect(r.status).toBe("missing");
    expect(r.detail).toContain("account.slack-app");
    expect(r.action).toBeNull();
  });

  test("account.slack: app exists, no token -> missing with the oauth connect action", async () => {
    const team = baseTeam({ integrations: { slack: { clientId: "abc" } } });
    const r = await pickRow(accountRows(fakeProbes(), team, SLACK_REQS, fakeSecrets(), null), "account.slack");
    expect(r.status).toBe("missing");
    expect(r.action).toEqual({ type: "oauth", label: "Connect", integration: "slack", verb: ["setup", "slack", "connect"] });
  });

  test("account.slack: app exists, token invalid -> invalid, oauth action still present (H2)", async () => {
    const team = baseTeam({ integrations: { slack: { clientId: "abc" } } });
    const fetch = async () => ({ status: 200, body: JSON.stringify({ ok: false, error: "invalid_auth" }), headers: {} });
    const r = await pickRow(accountRows(fakeProbes({ fetch }), team, SLACK_REQS, fakeSecrets({ "board.slackToken": "tok" }), null), "account.slack");
    expect(r.status).toBe("invalid");
    expect(r.action).toEqual({ type: "oauth", label: "Connect", integration: "slack", verb: ["setup", "slack", "connect"] });
  });
});

describe("accountRows — account.linear declared / not declared", () => {
  test("team.integrations.linear present -> row present, required, no optionalNote", async () => {
    const team = baseTeam({ integrations: { linear: { teamKey: "RT" } } });
    const r = await pickRow(accountRows(fakeProbes(), team, [], fakeSecrets(), null), "account.linear");
    expect(r.required).toBe(true);
    expect(r.optionalNote).toBeNull();
  });

  test("not declared anywhere -> absent", async () => {
    const rows = await accountRows(fakeProbes(), baseTeam(), [], fakeSecrets(), null);
    expect(rows.some((r) => r.id === "account.linear")).toBe(false);
  });
});

describe("accountRows — account.switchboard", () => {
  test("join intent + secret present, host NOT user-confirmed -> still re-validates (no free pass); a revoked/stale token never reads as ready on the strength of an intent file", async () => {
    const team = baseTeam({ integrations: { switchboard: { url: "https://sw.example.com" } } });
    const p = fakeProbes();
    const r = await pickRow(accountRows(p, team, [], fakeSecrets({ "rt.switchboardToken": "tok" }), JOIN_INTENT), "account.switchboard");
    expect(r.status).toBe("error");
    expect(p.calls.fetch).toEqual([]); // never sent the token to a team-declared, unconfirmed host
  });

  test("join intent + secret present + the user has confirmed this host -> ready, decorated as verified", async () => {
    const team = baseTeam({ integrations: { switchboard: { url: "https://sw.example.com" } } });
    const fetch = async (url: string) => (url.includes("/health") ? { status: 200, body: "", headers: {} } : { status: 0, body: "", headers: {} });
    const r = await pickRow(
      accountRows(fakeProbes({ fetch }), team, [], fakeSecrets({ "rt.switchboardToken": "tok" }), JOIN_INTENT, { switchboardUrl: "https://sw.example.com" }),
      "account.switchboard",
    );
    expect(r.status).toBe("ready");
    expect(r.detail).toBe("redeemed during Join, verified");
  });

  test("join intent + secret ABSENT -> still missing with a connect action", async () => {
    const team = baseTeam({ integrations: { switchboard: { url: "https://sw.example.com" } } });
    const r = await pickRow(accountRows(fakeProbes(), team, [], fakeSecrets(), JOIN_INTENT), "account.switchboard");
    expect(r.status).toBe("missing");
    expect(r.action?.type).toBe("connect");
  });

  test("create intent + secret present + confirmed host -> falls through to validate()'s own health probe", async () => {
    const team = baseTeam({ integrations: { switchboard: { url: "https://sw.example.com" } } });
    const fetch = async (url: string) => (url.includes("/health") ? { status: 200, body: "", headers: {} } : { status: 0, body: "", headers: {} });
    const r = await pickRow(
      accountRows(fakeProbes({ fetch }), team, [], fakeSecrets({ "rt.switchboardToken": "tok" }), null, { switchboardUrl: "https://sw.example.com" }),
      "account.switchboard",
    );
    expect(r.status).toBe("ready");
    expect(r.detail).toBe("switchboard reachable");
  });

  test("secret present, health probe unhealthy -> error, WITH a connect action (H2)", async () => {
    const team = baseTeam({ integrations: { switchboard: { url: "https://sw.example.com" } } });
    const fetch = async () => ({ status: 0, body: "", headers: {} });
    const r = await pickRow(accountRows(fakeProbes({ fetch }), team, [], fakeSecrets({ "rt.switchboardToken": "tok" }), null), "account.switchboard");
    expect(r.status).toBe("error");
    expect(r.action?.type).toBe("connect");
  });

  test("no secret -> missing with a connect action", async () => {
    const team = baseTeam({ integrations: { switchboard: { url: "https://sw.example.com" } } });
    const r = await pickRow(accountRows(fakeProbes(), team, [], fakeSecrets(), null), "account.switchboard");
    expect(r.status).toBe("missing");
    expect(r.action?.type).toBe("connect");
  });
});

describe("accountRows — required-ness derives from the declaring source (R-T9-b)", () => {
  test("an integration named only by an optional:true tool connect -> required:false, optionalNote mirrors the tool's own why", async () => {
    const reqs: PackRequirements[] = [{ pack: "somepack", integrations: [], tools: [{ name: "sdm-cli", why: "db tunnels", optional: true, connect: { integration: "sdm" } }] }];
    const exec: ExecScript = () => ok("session active for a@b.com");
    const r = await pickRow(accountRows(fakeProbes({ exec }), baseTeam(), reqs, fakeSecrets({ "rt.sdmEmail": "a@b.com" }), null), "account.sdm");
    expect(r.required).toBe(false);
    expect(r.optionalNote).toBe("Works without this. db tunnels");
  });

  test("the same integration named by BOTH an optional tool and reqs.integrations -> a required source always wins", async () => {
    const reqs: PackRequirements[] = [{ pack: "somepack", integrations: ["sdm"], tools: [{ name: "sdm-cli", why: "db tunnels", optional: true, connect: { integration: "sdm" } }] }];
    const exec: ExecScript = () => ok("session active for a@b.com");
    const r = await pickRow(accountRows(fakeProbes({ exec }), baseTeam(), reqs, fakeSecrets({ "rt.sdmEmail": "a@b.com" }), null), "account.sdm");
    expect(r.required).toBe(true);
    expect(r.optionalNote).toBeNull();
  });
});

describe("accountRows — CLI-owned integrations (no stored secret)", () => {
  test("doppler declared via a pack tool's connect field -> validate() runs directly, required:false (blocker lives in the Tools group)", async () => {
    const reqs: PackRequirements[] = [{ pack: "somepack", integrations: [], tools: [{ name: "doppler", why: "reads team secrets", connect: { integration: "doppler" } }] }];
    const exec: ExecScript = (argv) => (argv[0] === "doppler" && argv[1] === "me" ? ok(JSON.stringify({ ok: true })) : ok());
    const r = await pickRow(accountRows(fakeProbes({ exec }), baseTeam(), reqs, fakeSecrets(), null), "account.doppler");
    expect(r.status).toBe("ready");
    expect(r.required).toBe(false);
    expect(r.optionalNote).toContain("Tools group");
    expect(r.action).toBeNull();
  });

  test("doppler declared via reqs.integrations directly -> still required:false (the CLI-owned override always wins)", async () => {
    const reqs: PackRequirements[] = [{ pack: "somepack", integrations: ["doppler"], tools: [] }];
    const exec: ExecScript = () => ({ code: 1, stdout: "", stderr: "not logged in" });
    const r = await pickRow(accountRows(fakeProbes({ exec }), baseTeam(), reqs, fakeSecrets(), null), "account.doppler");
    expect(r.required).toBe(false);
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

describe("accountRows — secrets never leak", () => {
  const SENTINEL = "sk-sentinel-should-never-appear-anywhere";

  test("a stored sentinel token never appears in any row's JSON, or in exec argv (Task 4's leak-table pattern)", async () => {
    const team = baseTeam({
      integrations: {
        forge: { host: "gitlab.example.com", provider: "gitlab" },
        linear: { teamKey: "RT" },
        switchboard: { url: "https://sw.example.com" },
        slack: { clientId: "abc" },
      },
    });
    const reqs: PackRequirements[] = [{ pack: "somepack", integrations: ["github"], tools: [] }];
    const exec: ExecScript = (argv) => (argv[0] === "gh" ? { code: 1, stdout: "", stderr: "" } : ok());
    const fetch = async () => ({ status: 401, body: JSON.stringify({ ok: false, error: "invalid_auth" }), headers: {} });
    const secrets = fakeSecrets({
      "rt.gitlabToken": SENTINEL,
      "rt.linearApiKey": SENTINEL,
      "rt.switchboardToken": SENTINEL,
      "board.slackToken": SENTINEL,
      "rt.githubToken": SENTINEL,
    });

    const p = fakeProbes({ exec, fetch });
    const rows = await accountRows(p, team, reqs, secrets, null);

    for (const r of rows) expect(JSON.stringify(r)).not.toContain(SENTINEL);
    for (const argv of p.calls.exec) expect(argv.join(" ")).not.toContain(SENTINEL);
  });
});

describe("accountRows — per-entry isolation", () => {
  test("one integration's secrets.has() throwing degrades to that entry's own error row; every other declared integration's row is untouched", async () => {
    const team = baseTeam({
      integrations: {
        forge: { host: "gitlab.example.com", provider: "gitlab" },
        linear: { teamKey: "RT" },
      },
    });
    const secrets: SecretPresence = {
      async has(domain, key) {
        if (domain === "rt" && key === "gitlabToken") throw new Error("sops -d exited 1: wrong recipient");
        return null;
      },
    };
    const exec: ExecScript = () => ok();

    const rows = await accountRows(fakeProbes({ exec }), team, [], secrets, null);

    const gitlab = rows.find((r) => r.id === "account.gitlab")!;
    expect(gitlab.status).toBe("error");
    expect(gitlab.required).toBe(true);
    expect(gitlab.detail).toContain("wrong recipient");
    expect(gitlab.action).toEqual({ type: "run", label: "Re-check", verb: ["setup", "status"] });

    // linear's own secrets.has() call never threw — its row must read exactly
    // as if gitlab's entry did not exist at all.
    const linear = rows.find((r) => r.id === "account.linear")!;
    expect(linear.status).toBe("missing");
  });
});
