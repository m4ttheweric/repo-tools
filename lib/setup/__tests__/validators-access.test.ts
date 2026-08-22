import { describe, test, expect } from "bun:test";
import { accessRows } from "../validators/access.ts";
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
const RECHECK_ACTION: Action = { type: "run", label: "Re-check", verb: ["setup", "status"] };

describe("accessRows — access.team-repo", () => {
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
    const exec: ExecScript = () => ({ code: 2, stdout: "", stderr: "" });
    const r = await pickRow(accessRows(fakeProbes({ exec }), team, null), "access.team-repo");
    expect(r.status).toBe("ready");
    expect(r.detail).toBe("empty repo (will be initialized)");
  });

  test("exit 128 with an auth-refusal stderr -> needs-you, detail never echoes the remote URL, carries a re-check action (finding 5)", async () => {
    const team = baseTeam({ remote: REMOTE });
    const exec: ExecScript = () => ({ code: 128, stdout: "", stderr: `remote: HTTP Basic: Access denied\nfatal: Authentication failed for '${REMOTE}/'` });
    const r = await pickRow(accessRows(fakeProbes({ exec }), team, null), "access.team-repo");
    expect(r.status).toBe("needs-you");
    expect(r.detail).not.toContain(REMOTE);
    expect(r.detail).toContain("ask the owner");
    expect(r.action).toEqual(RECHECK_ACTION);
    expect(r.recheck).toBe("on-activate");
  });

  test("exit 128 with 'could not read Username' (no credential at all) -> error, NOT a permissions verdict (finding 6)", async () => {
    const team = baseTeam({ remote: REMOTE });
    const exec: ExecScript = () => ({ code: 128, stdout: "", stderr: "fatal: could not read Username for 'https://gitlab.example.com': terminal prompts disabled" });
    const r = await pickRow(accessRows(fakeProbes({ exec }), team, null), "access.team-repo");
    expect(r.status).toBe("error");
    expect(r.detail).not.toContain("ask the owner");
    expect(r.action).toEqual(RECHECK_ACTION);
  });

  test("a credential-bearing remote's stderr never leaks the token into detail (finding 7)", async () => {
    const team = baseTeam({ remote: REMOTE });
    const exec: ExecScript = () => ({ code: 1, stdout: "", stderr: "fatal: unable to access 'https://user:sk-sentinel-token@gitlab.example.com/acme/mattstack.git/': The requested URL returned error: 403" });
    const r = await pickRow(accessRows(fakeProbes({ exec }), team, null), "access.team-repo");
    expect(r.detail).not.toContain("sk-sentinel-token");
  });

  test("a genuinely unreachable host (exit 1, no auth marker) -> error, never invalid, with a re-check action", async () => {
    const team = baseTeam({ remote: REMOTE });
    const exec: ExecScript = () => ({ code: 1, stdout: "", stderr: "fatal: could not resolve host" });
    const r = await pickRow(accessRows(fakeProbes({ exec }), team, null), "access.team-repo");
    expect(r.status).toBe("error");
    expect(r.detail).toBe("unreachable: fatal: could not resolve host");
    expect(r.action).toEqual(RECHECK_ACTION);
  });

  test("ls-remote times out -> error, never hangs the row on missing/needs-you", async () => {
    const team = baseTeam({ remote: REMOTE });
    const exec: ExecScript = () => ({ code: 124, stdout: "", stderr: "" });
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
});

describe("accessRows — access.forge", () => {
  test("host reachable (status > 0) -> ready, recheck on-activate", async () => {
    const team = baseTeam({ integrations: { forge: { host: "gitlab.example.com", provider: "gitlab" } } });
    const fetch = async () => ({ status: 200, body: "", headers: {} });
    const r = await pickRow(accessRows(fakeProbes({ fetch }), team, null), "access.forge");
    expect(r.status).toBe("ready");
    expect(r.recheck).toBe("on-activate");
  });

  test("no forge configured -> missing, action-less", async () => {
    const r = await pickRow(accessRows(fakeProbes(), baseTeam(), null), "access.forge");
    expect(r.status).toBe("missing");
    expect(r.action).toBeNull();
  });

  test("status 0 (unreachable) -> error, never invalid, with a re-check action (finding 5)", async () => {
    const team = baseTeam({ integrations: { forge: { host: "gitlab.example.com", provider: "gitlab" } } });
    const fetch = async () => ({ status: 0, body: "", headers: {} });
    const r = await pickRow(accessRows(fakeProbes({ fetch }), team, null), "access.forge");
    expect(r.status).toBe("error");
    expect(r.action).toEqual(RECHECK_ACTION);
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
    const exec: ExecScript = () => ({ code: 128, stdout: "", stderr: "fatal: Authentication failed" });
    const r = await pickRow(accessRows(fakeProbes({ exec }), team, null), "access.repo.github.com-acme-repo");
    expect(r.status).toBe("needs-you");
  });
});

describe("accessRows — access.switchboard", () => {
  test("no switchboard configured -> row absent entirely", async () => {
    const rows = await accessRows(fakeProbes(), baseTeam(), null);
    expect(rows.some((r) => r.id === "access.switchboard")).toBe(false);
  });

  test("configured, /health 200 -> ready, required false", async () => {
    const team = baseTeam({ integrations: { switchboard: { url: "https://sw.example.com" } } });
    const fetch = async (url: string) => (url === "https://sw.example.com/health" ? { status: 200, body: "", headers: {} } : { status: 0, body: "", headers: {} });
    const r = await pickRow(accessRows(fakeProbes({ fetch }), team, null), "access.switchboard");
    expect(r.status).toBe("ready");
    expect(r.required).toBe(false);
  });

  test("configured, /health status 0 (unreachable) -> error, distinct detail from a non-200 refusal", async () => {
    const team = baseTeam({ integrations: { switchboard: { url: "https://sw.example.com" } } });
    const fetch = async () => ({ status: 0, body: "", headers: {} });
    const r = await pickRow(accessRows(fakeProbes({ fetch }), team, null), "access.switchboard");
    expect(r.status).toBe("error");
    expect(r.detail).toContain("couldn't reach");
  });

  test("configured, /health non-200 -> error, distinct detail from the unreachable case", async () => {
    const team = baseTeam({ integrations: { switchboard: { url: "https://sw.example.com" } } });
    const fetch = async () => ({ status: 503, body: "", headers: {} });
    const r = await pickRow(accessRows(fakeProbes({ fetch }), team, null), "access.switchboard");
    expect(r.status).toBe("error");
    expect(r.detail).toBe("switchboard /health returned 503");
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
