import { describe, test, expect, beforeEach } from "bun:test";
import { accessRows } from "../validators/access.ts";
import { resetCltCacheForTests } from "../home-git.ts";
import { fakeProbes, ok } from "./fakes.ts";
import type { ExecScript } from "./fakes.ts";
import type { TeamSnapshot } from "../team-settings.ts";
import type { SetupIntent } from "../intent.ts";
import type { Action } from "../contract.ts";

function baseTeam(overrides: Partial<TeamSnapshot> = {}): TeamSnapshot {
  return { slug: "acme", integrations: {}, trackingIdentities: [], marketplaces: [], plugins: [], remote: null, ...overrides };
}

async function pickRow(rowsP: ReturnType<typeof accessRows>, id: string) {
  const rows = await rowsP;
  const r = rows.find((row) => row.id === id);
  if (!r) throw new Error(`no row ${id}; got ids: ${rows.map((row) => row.id).join(", ")}`);
  return r;
}

const REMOTE = "https://gitlab.example.com/acme/mattstack.git";

/** A script for git's answer alone: the CLT guard (`xcode-select -p`) that precedes every git call answers ok. */
function gitAnswers(script: ExecScript): ExecScript {
  return (argv, opts) => (argv[0] === "xcode-select" ? ok() : script(argv, opts));
}
const RECHECK_ACTION: Action = { type: "run", label: "Re-check", verb: ["setup", "status"] };

function joinIntent(owner: string): SetupIntent {
  return {
    v: 1,
    at: "2026-08-21T00:00:00.000Z",
    mode: "join",
    join: { id: "inv1", keyB64: "abc", pointer: { v: 1, team: "acme", name: "Acme", remote: REMOTE, owner, forge: "gitlab.example.com", createdAt: "2026-08-01T00:00:00.000Z" } },
  };
}

describe("accessRows — access.team-repo", () => {
  beforeEach(() => resetCltCacheForTests());

  test("no Command Line Tools yet -> the row waits on tool.clt and never runs git (the xcode-select shim would raise Apple's install dialog)", async () => {
    const team = baseTeam({ remote: REMOTE });
    const seen: string[][] = [];
    const exec: ExecScript = (argv) => {
      seen.push(argv);
      return argv[0] === "xcode-select" ? { code: 2, stdout: "", stderr: "xcode-select: error: unable to get active developer directory" } : ok();
    };
    const r = await pickRow(accessRows(fakeProbes({ exec }), team, null), "access.team-repo");
    expect(r.status).toBe("missing");
    expect(r.detail).toContain("Command Line Tools");
    expect(r.action).toEqual(RECHECK_ACTION);
    expect(seen.some((argv) => argv[0] === "git")).toBe(false);
  });

  test("ls-remote exit 0 -> ready, full row pinned (recheck on-activate, action null)", async () => {
    const team = baseTeam({ remote: REMOTE });
    const exec: ExecScript = () => ok();
    const r = await pickRow(accessRows(fakeProbes({ exec }), team, null), "access.team-repo");
    expect(r).toEqual({
      id: "access.team-repo",
      kind: "access",
      title: "Team repo",
      why: "rt needs read/write access to your team's home repo to sync settings and packs.",
      required: true,
      optionalNote: null,
      status: "ready",
      detail: "reachable",
      action: null,
      recheck: "on-activate",
    });
  });

  test("exit 2 -> ready, empty repo will be initialized", async () => {
    const team = baseTeam({ remote: REMOTE });
    const exec: ExecScript = gitAnswers(() => ({ code: 2, stdout: "", stderr: "" }));
    const r = await pickRow(accessRows(fakeProbes({ exec }), team, null), "access.team-repo");
    expect(r.status).toBe("ready");
    expect(r.detail).toBe("empty repo (will be initialized)");
  });

  test("exit 128 with an auth-refusal stderr -> needs-you, detail never echoes the remote URL, carries a re-check action (finding 5)", async () => {
    const team = baseTeam({ remote: REMOTE });
    const exec: ExecScript = gitAnswers(() => ({ code: 128, stdout: "", stderr: `remote: HTTP Basic: Access denied\nfatal: Authentication failed for '${REMOTE}/'` }));
    const r = await pickRow(accessRows(fakeProbes({ exec }), team, null), "access.team-repo");
    expect(r.status).toBe("needs-you");
    expect(r.detail).not.toContain(REMOTE);
    expect(r.detail).toContain("repo's owner");
    expect(r.action).toEqual(RECHECK_ACTION);
    expect(r.recheck).toBe("on-activate");
  });

  test("exit 128 with 'could not read Username' (no credential at all) -> needs-you with Connect, still never a refusal", async () => {
    const team = baseTeam({ remote: REMOTE });
    const exec: ExecScript = gitAnswers(() => ({ code: 128, stdout: "", stderr: "fatal: could not read Username for 'https://gitlab.example.com': terminal prompts disabled" }));
    const r = await pickRow(accessRows(fakeProbes({ exec }), team, null, {}, { has: async () => null }), "access.team-repo");
    expect(r.status).toBe("needs-you");
    expect(r.detail).not.toContain("ask the owner");
    expect(r.detail).toContain("Connect your GitLab account");
    expect(r.action?.type).toBe("connect");
  });

  test("a credential-bearing remote's stderr never leaks the token into detail (finding 7)", async () => {
    const team = baseTeam({ remote: REMOTE });
    const exec: ExecScript = gitAnswers(() => ({ code: 1, stdout: "", stderr: "fatal: unable to access 'https://user:sk-sentinel-token@gitlab.example.com/acme/mattstack.git/': The requested URL returned error: 403" }));
    const r = await pickRow(accessRows(fakeProbes({ exec }), team, null), "access.team-repo");
    expect(r.detail).not.toContain("sk-sentinel-token");
  });

  test("a genuinely unreachable host (exit 1, no auth marker) -> error, never invalid, with a re-check action", async () => {
    const team = baseTeam({ remote: REMOTE });
    const exec: ExecScript = gitAnswers(() => ({ code: 1, stdout: "", stderr: "fatal: could not resolve host" }));
    const r = await pickRow(accessRows(fakeProbes({ exec }), team, null), "access.team-repo");
    expect(r.status).toBe("error");
    expect(r.detail).toBe("unreachable: fatal: could not resolve host");
    expect(r.action).toEqual(RECHECK_ACTION);
  });

  test("ls-remote times out -> error, never hangs the row on missing/needs-you", async () => {
    const team = baseTeam({ remote: REMOTE });
    const exec: ExecScript = gitAnswers(() => ({ code: 124, stdout: "", stderr: "" }));
    const r = await pickRow(accessRows(fakeProbes({ exec }), team, null), "access.team-repo");
    expect(r.status).toBe("error");
    expect(r.detail).toContain("timed out");
  });

  test("no remote anywhere -> missing, action-less (screen 2 recomputes in-band)", async () => {
    const r = await pickRow(accessRows(fakeProbes(), baseTeam(), null), "access.team-repo");
    expect(r.status).toBe("missing");
    expect(r.detail).toBe("no team remote yet (screen 2)");
    expect(r.action).toBeNull();
  });

  test("intent.team.remote wins over team.remote", async () => {
    const team = baseTeam({ remote: "https://gitlab.example.com/other/repo.git" });
    const intent: SetupIntent = { v: 1, at: "2026-08-21T00:00:00.000Z", mode: "create", team: { slug: "acme", name: "Acme", remote: REMOTE, others: false } };
    let seenRemote: string | undefined;
    const exec: ExecScript = (argv) => {
      seenRemote = argv[3];
      return ok();
    };
    await pickRow(accessRows(fakeProbes({ exec }), team, intent), "access.team-repo");
    expect(seenRemote).toBe(REMOTE);
  });

  // rt keeps the forge token in its own store (or the setup stage), not in
  // git's credential helper, so a clean machine's probe found no credential
  // and the required row could never clear before Install.
  test("a connected forge token is offered to ls-remote through an inline helper, never in argv or the URL", async () => {
    const team = baseTeam({ remote: "https://github.com/acme/repo.git", integrations: { forge: { host: "github.com", provider: "github" } } });
    let seen: { argv: string[]; env?: Record<string, string> } | undefined;
    const exec: ExecScript = (argv, opts) => {
      seen = { argv, env: opts?.env };
      return ok();
    };
    const secrets = { has: async (domain: string, key: string) => (domain === "rt" && key === "githubToken" ? "ghp_secret" : null) };
    const r = await pickRow(accessRows(fakeProbes({ exec }), team, null, {}, secrets), "access.team-repo");
    expect(r.status).toBe("ready");
    expect(seen!.argv.join(" ")).not.toContain("ghp_secret");
    expect(seen!.argv.join(" ")).toContain("credential.helper=");
    expect(seen!.env?.RT_GIT_TOKEN).toBe("ghp_secret");
    expect(seen!.env?.GIT_TERMINAL_PROMPT).toBe("0");
  });

  test("with no token for the remote's forge the probe runs bare, as before", async () => {
    const team = baseTeam({ remote: "https://gitlab.example.com/acme/repo.git", integrations: { forge: { host: "gitlab.example.com", provider: "gitlab" } } });
    let seen: string[] = [];
    const exec: ExecScript = (argv) => { seen = argv; return ok(); };
    const secrets = { has: async () => null };
    await pickRow(accessRows(fakeProbes({ exec }), team, null, {}, secrets), "access.team-repo");
    expect(seen.join(" ")).not.toContain("credential.helper");
  });

  test("intent.join.pointer.remote is used when there's no intent.team", async () => {
    const intent: SetupIntent = {
      v: 1,
      at: "2026-08-21T00:00:00.000Z",
      mode: "join",
      join: { id: "inv1", keyB64: "abc", pointer: { v: 1, team: "acme", name: "Acme", remote: REMOTE, owner: "owner1", forge: "gitlab.example.com", createdAt: "2026-08-01T00:00:00.000Z" } },
    };
    let seenRemote: string | undefined;
    const exec: ExecScript = (argv) => {
      seenRemote = argv[3];
      return ok();
    };
    await pickRow(accessRows(fakeProbes({ exec }), baseTeam(), intent), "access.team-repo");
    expect(seenRemote).toBe(REMOTE);
  });

  test("no forge account connected -> needs-you with a Connect action, not an error nobody can act on", async () => {
    const team = baseTeam({ remote: REMOTE });
    const exec = gitAnswers(() => ({ code: 128, stdout: "", stderr: "fatal: could not read Username for 'https://gitlab.example.com'" }));
    const r = await pickRow(accessRows(fakeProbes({ exec }), team, null, {}, { has: async () => null }), "access.team-repo");
    expect(r.status).toBe("needs-you");
    expect(r.detail).toContain("Connect your GitLab account");
    expect(r.action?.type).toBe("connect");
  });

  test("a refusal names who grants access and never promises rt will", async () => {
    const team = baseTeam({ remote: REMOTE });
    const exec = gitAnswers(() => ({ code: 128, stdout: "", stderr: "remote: Permission denied" }));
    const r = await pickRow(accessRows(fakeProbes({ exec }), team, joinIntent("matt"), {}, { has: async () => "glpat_x" }), "access.team-repo");
    expect(r.status).toBe("needs-you");
    expect(r.detail).toContain("ask matt");
    expect(r.detail).toContain("org admin");
    expect(r.detail).not.toContain("rt will");
  });

  test("rt held a token and git still had none: still an error, not a bogus no-account", async () => {
    const team = baseTeam({ remote: REMOTE });
    const exec = gitAnswers(() => ({ code: 128, stdout: "", stderr: "fatal: could not read Username for 'https://gitlab.example.com'" }));
    const r = await pickRow(accessRows(fakeProbes({ exec }), team, null, {}, { has: async () => "glpat_x" }), "access.team-repo");
    expect(r.status).toBe("error");
    expect(r.detail).toContain("couldn't determine");
  });
});

describe("accessRows — access.forge", () => {
  // Create mode: the user typed the remote themselves, so its host is not an
  // inviter's claim to be confirmed — it is confirmed by construction.
  test("create intent whose remote lives on the declared host -> probed without an override", async () => {
    const team = baseTeam({ integrations: { forge: { host: "github.com", provider: "github" } } });
    const intent: SetupIntent = { v: 1, at: "2026-08-21T00:00:00.000Z", mode: "create", team: { slug: "acme", name: "Acme", remote: "https://github.com/acme/mattstack-team-acme.git", others: false } };
    const p = fakeProbes({ fetch: async () => ({ status: 200, body: "", headers: {} }) });
    const r = await pickRow(accessRows(p, team, intent), "access.forge");
    expect(r.status).toBe("ready");
    expect(p.calls.fetch.length).toBe(1);
  });

  test("create intent whose remote is on a DIFFERENT host than the declared forge still needs confirmation", async () => {
    const team = baseTeam({ integrations: { forge: { host: "gitlab.example.com", provider: "gitlab" } } });
    const intent: SetupIntent = { v: 1, at: "2026-08-21T00:00:00.000Z", mode: "create", team: { slug: "acme", name: "Acme", remote: "https://github.com/acme/repo.git", others: false } };
    const p = fakeProbes();
    const r = await pickRow(accessRows(p, team, intent), "access.forge");
    expect(r.status).toBe("needs-you");
    expect(p.calls.fetch).toEqual([]);
  });

  test("the confirmation steps name the declared forge's own connect verb", async () => {
    const gh = baseTeam({ integrations: { forge: { host: "github.com", provider: "github" } } });
    const r = await pickRow(accessRows(fakeProbes(), gh, null), "access.forge");
    expect(JSON.stringify(r.action)).toContain("rt setup github connect --host github.com");
    const gl = baseTeam({ integrations: { forge: { host: "gitlab.example.com", provider: "gitlab" } } });
    const r2 = await pickRow(accessRows(fakeProbes(), gl, null), "access.forge");
    expect(JSON.stringify(r2.action)).toContain("rt setup gitlab connect --host gitlab.example.com");
  });

  test("host reachable (status > 0), user-confirmed -> ready, recheck on-activate", async () => {
    const team = baseTeam({ integrations: { forge: { host: "gitlab.example.com", provider: "gitlab" } } });
    const fetch = async () => ({ status: 200, body: "", headers: {} });
    const r = await pickRow(accessRows(fakeProbes({ fetch }), team, null, { forgeHost: "gitlab.example.com" }), "access.forge");
    expect(r.status).toBe("ready");
    expect(r.recheck).toBe("on-activate");
  });

  test("no forge configured -> missing, action-less", async () => {
    const r = await pickRow(accessRows(fakeProbes(), baseTeam(), null), "access.forge");
    expect(r.status).toBe("missing");
    expect(r.action).toBeNull();
  });

  test("status 0 (unreachable), user-confirmed -> error, never invalid, with a re-check action (finding 5)", async () => {
    const team = baseTeam({ integrations: { forge: { host: "gitlab.example.com", provider: "gitlab" } } });
    const fetch = async () => ({ status: 0, body: "", headers: {} });
    const r = await pickRow(accessRows(fakeProbes({ fetch }), team, null, { forgeHost: "gitlab.example.com" }), "access.forge");
    expect(r.status).toBe("error");
    expect(r.action).toEqual(RECHECK_ACTION);
  });

  test("team-declared host, NOT user-confirmed -> needs-you, never fetched (R-F2)", async () => {
    const team = baseTeam({ integrations: { forge: { host: "gitlab.example.com", provider: "gitlab" } } });
    const p = fakeProbes();
    const r = await pickRow(accessRows(p, team, null), "access.forge");
    expect(r.status).toBe("needs-you");
    expect(r.detail).toContain("unverified");
    expect(p.calls.fetch).toEqual([]);
  });
});

describe("accessRows — access.repo.<slug>", () => {
  test("one row per tracking identity, slug derived by replacing / with -", async () => {
    const team = baseTeam({ trackingIdentities: ["github.com/acme/repo", "gitlab.example.com/acme/other"] });
    const rows = await accessRows(fakeProbes({ exec: () => ok() }), team, null);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain("access.repo.github.com-acme-repo");
    expect(ids).toContain("access.repo.gitlab.example.com-acme-other");
  });

  test("required false with a real optionalNote", async () => {
    const team = baseTeam({ trackingIdentities: ["github.com/acme/repo"] });
    const r = await pickRow(accessRows(fakeProbes({ exec: () => ok() }), team, null), "access.repo.github.com-acme-repo");
    expect(r.required).toBe(false);
    expect(r.optionalNote).toContain("board won't show this repo");
  });

  test("an auth failure on one repo -> needs-you for that row only", async () => {
    const team = baseTeam({ trackingIdentities: ["github.com/acme/repo"] });
    const exec: ExecScript = gitAnswers(() => ({ code: 128, stdout: "", stderr: "fatal: Authentication failed" }));
    const r = await pickRow(accessRows(fakeProbes({ exec }), team, null), "access.repo.github.com-acme-repo");
    expect(r.status).toBe("needs-you");
  });

  test("a tracked repo's row names that repo's admin, not the team owner", async () => {
    const team = baseTeam({ remote: REMOTE, trackingIdentities: ["github.com/acme/repo"] });
    const exec = gitAnswers(() => ({ code: 128, stdout: "", stderr: "remote: Permission denied" }));
    const r = await pickRow(accessRows(fakeProbes({ exec }), team, joinIntent("matt"), {}, { has: async () => "glpat_x" }), "access.repo.github.com-acme-repo");
    expect(r.required).toBe(false);
    expect(r.detail).toContain("that repo's admin");
    expect(r.detail).not.toContain("matt");
  });
});

describe("accessRows — access.switchboard", () => {
  test("no switchboard configured -> row absent entirely", async () => {
    const rows = await accessRows(fakeProbes(), baseTeam(), null);
    expect(rows.some((r) => r.id === "access.switchboard")).toBe(false);
  });

  test("configured, user-confirmed, /health 200 -> ready, required false", async () => {
    const team = baseTeam({ integrations: { switchboard: { url: "https://sw.example.com" } } });
    const fetch = async (url: string) => (url === "https://sw.example.com/health" ? { status: 200, body: "", headers: {} } : { status: 0, body: "", headers: {} });
    const r = await pickRow(accessRows(fakeProbes({ fetch }), team, null, { switchboardUrl: "https://sw.example.com" }), "access.switchboard");
    expect(r.status).toBe("ready");
    expect(r.required).toBe(false);
  });

  test("configured, user-confirmed, /health status 0 (unreachable) -> error, distinct detail from a non-200 refusal", async () => {
    const team = baseTeam({ integrations: { switchboard: { url: "https://sw.example.com" } } });
    const fetch = async () => ({ status: 0, body: "", headers: {} });
    const r = await pickRow(accessRows(fakeProbes({ fetch }), team, null, { switchboardUrl: "https://sw.example.com" }), "access.switchboard");
    expect(r.status).toBe("error");
    expect(r.detail).toContain("couldn't reach");
  });

  test("configured, user-confirmed, /health non-200 -> error, distinct detail from the unreachable case", async () => {
    const team = baseTeam({ integrations: { switchboard: { url: "https://sw.example.com" } } });
    const fetch = async () => ({ status: 503, body: "", headers: {} });
    const r = await pickRow(accessRows(fakeProbes({ fetch }), team, null, { switchboardUrl: "https://sw.example.com" }), "access.switchboard");
    expect(r.status).toBe("error");
    expect(r.detail).toBe("switchboard /health returned 503");
  });

  test("team-declared switchboard, NOT user-confirmed -> needs-you, never fetched (R-F2)", async () => {
    const team = baseTeam({ integrations: { switchboard: { url: "https://sw.example.com" } } });
    const p = fakeProbes();
    const r = await pickRow(accessRows(p, team, null), "access.switchboard");
    expect(r.status).toBe("needs-you");
    expect(r.detail).toContain("unverified");
    expect(p.calls.fetch).toEqual([]);
  });
});

describe("accessRows — independent probes run concurrently (R-T9-e)", () => {
  test("row order is deterministic (team-repo, forge, repo.*, switchboard) regardless of which probe resolves first", async () => {
    const team = baseTeam({
      remote: REMOTE,
      integrations: { forge: { host: "gitlab.example.com", provider: "gitlab" }, switchboard: { url: "https://sw.example.com" } },
      trackingIdentities: ["github.com/acme/repo"],
    });
    // team-repo's exec resolves slower than the repo.* row's exec — Promise.all must still land them in declaration order, not resolution order.
    const exec: ExecScript = async (argv) => {
      if (argv[3] === REMOTE) await new Promise((resolve) => setTimeout(resolve, 5));
      return ok();
    };
    const fetch = async () => ({ status: 200, body: "", headers: {} });
    const rows = await accessRows(fakeProbes({ exec, fetch }), team, null);
    expect(rows.map((r) => r.id)).toEqual(["access.team-repo", "access.forge", "access.repo.github.com-acme-repo", "access.switchboard"]);
  });
});
