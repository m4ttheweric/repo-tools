import { describe, test, expect } from "bun:test";
import { accessRows } from "../validators/access.ts";
import { fakeProbes, ok } from "./fakes.ts";
import type { ExecScript } from "./fakes.ts";
import type { TeamSnapshot } from "../team-settings.ts";
import type { SetupIntent } from "../intent.ts";

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

describe("accessRows — access.team-repo", () => {
  test("ls-remote exit 0 -> ready, reachable", async () => {
    const team = baseTeam({ remote: REMOTE });
    const exec: ExecScript = (argv) => (argv[1] === "ls-remote" ? ok() : ok());
    const r = await pickRow(accessRows(fakeProbes({ exec }), team, null), "access.team-repo");
    expect(r.status).toBe("ready");
    expect(r.detail).toBe("reachable");
    expect(r.required).toBe(true);
  });

  test("exit 2 -> ready, empty repo will be initialized", async () => {
    const team = baseTeam({ remote: REMOTE });
    const exec: ExecScript = () => ({ code: 2, stdout: "", stderr: "" });
    const r = await pickRow(accessRows(fakeProbes({ exec }), team, null), "access.team-repo");
    expect(r.status).toBe("ready");
    expect(r.detail).toBe("empty repo (will be initialized)");
  });

  test("exit 128 with an auth-failure stderr -> needs-you, detail never echoes the remote URL", async () => {
    const team = baseTeam({ remote: REMOTE });
    const exec: ExecScript = () => ({ code: 128, stdout: "", stderr: `remote: HTTP Basic: Access denied\nfatal: Authentication failed for '${REMOTE}/'` });
    const r = await pickRow(accessRows(fakeProbes({ exec }), team, null), "access.team-repo");
    expect(r.status).toBe("needs-you");
    expect(r.detail).not.toContain(REMOTE);
    expect(r.detail).toContain("ask the owner");
  });

  test("a genuinely unreachable host (exit 1, no auth marker) -> error, never invalid", async () => {
    const team = baseTeam({ remote: REMOTE });
    const exec: ExecScript = () => ({ code: 1, stdout: "", stderr: "fatal: could not resolve host" });
    const r = await pickRow(accessRows(fakeProbes({ exec }), team, null), "access.team-repo");
    expect(r.status).toBe("error");
    expect(r.detail).toBe("unreachable: fatal: could not resolve host");
  });

  test("ls-remote times out -> error, never hangs the row on missing/needs-you", async () => {
    const team = baseTeam({ remote: REMOTE });
    const exec: ExecScript = () => ({ code: 124, stdout: "", stderr: "" });
    const r = await pickRow(accessRows(fakeProbes({ exec }), team, null), "access.team-repo");
    expect(r.status).toBe("error");
    expect(r.detail).toContain("timed out");
  });

  test("no remote anywhere -> missing", async () => {
    const r = await pickRow(accessRows(fakeProbes(), baseTeam(), null), "access.team-repo");
    expect(r.status).toBe("missing");
    expect(r.detail).toBe("no team remote yet (screen 2)");
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
  test("host reachable (status > 0) -> ready", async () => {
    const team = baseTeam({ integrations: { forge: { host: "gitlab.example.com", provider: "gitlab" } } });
    const fetch = async () => ({ status: 200, body: "", headers: {} });
    const r = await pickRow(accessRows(fakeProbes({ fetch }), team, null), "access.forge");
    expect(r.status).toBe("ready");
  });

  test("no forge configured -> missing", async () => {
    const r = await pickRow(accessRows(fakeProbes(), baseTeam(), null), "access.forge");
    expect(r.status).toBe("missing");
  });

  test("status 0 (unreachable) -> error, never invalid", async () => {
    const team = baseTeam({ integrations: { forge: { host: "gitlab.example.com", provider: "gitlab" } } });
    const fetch = async () => ({ status: 0, body: "", headers: {} });
    const r = await pickRow(accessRows(fakeProbes({ fetch }), team, null), "access.forge");
    expect(r.status).toBe("error");
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

  test("configured, /health non-200 -> error", async () => {
    const team = baseTeam({ integrations: { switchboard: { url: "https://sw.example.com" } } });
    const fetch = async () => ({ status: 503, body: "", headers: {} });
    const r = await pickRow(accessRows(fakeProbes({ fetch }), team, null), "access.switchboard");
    expect(r.status).toBe("error");
  });
});
