import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  pickStartedState, fetchMyTodoTickets, searchTickets,
  loadSecrets, saveSecret, saveTeamConfig, getTeamConfig,
} from "../linear.ts";
import { secretsFilePath, resetSecretsMemo, type SecretsExecResult, type SecretsExecSeam, type SecretsSeams } from "../secrets/store.ts";
import type { AgeExecResult, AgeKeySeam } from "../home/age-key.ts";

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
});

// ─── Fake secrets seams (encrypted-store stand-in for loadSecrets/saveSecret tests) ──

function fakeAgeKeySeam(key = "AGE-SECRET-KEY-1TEST"): AgeKeySeam {
  return {
    async run(cmd): Promise<AgeExecResult> {
      if (cmd[0] === "security" && cmd[1] === "find-generic-password") {
        return { code: 0, stdout: `${key}\n`, stderr: "" };
      }
      throw new Error(`fakeAgeKeySeam: unexpected call ${cmd.join(" ")}`);
    },
  };
}

/**
 * domain -> basename ("rt.json" -> "rt"), works for both real paths and
 * --filename-override values, and for the pid-qualified `<domain>.json.<pid>.tmp`
 * post-encrypt readback path store.ts decrypts before renaming.
 */
function domainFromPath(p: string): string {
  return p
    .split("/")
    .pop()!
    .replace(/\.\d+\.tmp$/, "")
    .replace(/\.json$/, "");
}

/**
 * In-memory sops stand-in: `domains` holds each domain's decrypted payload
 * directly (this fake never models real ciphertext bytes), `files` models the
 * fs surface (fileExists/readFile/staging) that store.ts's encrypt/decrypt
 * flow round-trips through.
 */
function fakeSecretsSeams(seedDomains: Record<string, Record<string, string>> = {}): SecretsSeams {
  const domains = new Map<string, Record<string, string>>(Object.entries(seedDomains));
  const files = new Map<string, string>();
  const stats = new Map<string, { mtimeMs: number; size: number }>();
  let mtimeCounter = 0;
  const touch = (p: string) => {
    mtimeCounter += 1;
    stats.set(p, { mtimeMs: mtimeCounter, size: files.get(p)?.length ?? 0 });
  };
  for (const domain of domains.keys()) {
    const p = secretsFilePath(domain);
    files.set(p, JSON.stringify({ sops: {}, data: "seed" }));
    touch(p);
  }

  const execSeam: SecretsExecSeam = {
    fileExists: (p) => files.has(p),
    statFile: (p) => stats.get(p) ?? null,
    readFile: (p) => {
      const v = files.get(p);
      if (v === undefined) throw new Error(`fakeSecretsSeams: readFile of missing path ${p}`);
      return v;
    },
    writeFile: (p, content) => { files.set(p, content); touch(p); },
    ensureDir: () => {},
    chmod: () => {},
    fsyncAndRename: (from, to) => {
      const content = files.get(from);
      if (content !== undefined) { files.set(to, content); files.delete(from); stats.delete(from); touch(to); }
    },
    removeFile: (p) => { files.delete(p); stats.delete(p); },
    async run(cmd): Promise<SecretsExecResult> {
      if (cmd[0] === "sops" && cmd[1] === "-d") {
        const domain = domainFromPath(cmd[cmd.length - 1]!);
        return { code: 0, stdout: JSON.stringify(domains.get(domain) ?? {}), stderr: "" };
      }
      if (cmd[0] === "sops" && cmd[1] === "-e") {
        const domain = domainFromPath(cmd[cmd.indexOf("--filename-override") + 1]!);
        const outputPath = cmd[cmd.indexOf("--output") + 1]!;
        const stagingPath = cmd[cmd.length - 1]!;
        const staged = files.get(stagingPath);
        if (staged === undefined) throw new Error("fakeSecretsSeams: no staged plaintext for encrypt");
        domains.set(domain, JSON.parse(staged));
        files.set(outputPath, JSON.stringify({ sops: {}, data: "opaque" }));
        touch(outputPath);
        return { code: 0, stdout: "", stderr: "" };
      }
      throw new Error(`fakeSecretsSeams: unexpected call ${cmd.join(" ")}`);
    },
  };

  return { ageKeySeam: fakeAgeKeySeam(), execSeam };
}

describe("loadSecrets / saveSecret / saveTeamConfig / getTeamConfig — encrypted store", () => {
  const origHome = process.env.HOME;
  let home: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-linear-secrets-")));
    process.env.HOME = home;
    resetSecretsMemo(); // module-level memo persists across tests in one bun test process
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(home, { recursive: true, force: true });
  });

  test("returns {} when the store has nothing", async () => {
    expect(await loadSecrets(fakeSecretsSeams())).toEqual({});
  });

  test("saveSecret writes to the encrypted store", async () => {
    const seams = fakeSecretsSeams();

    await saveSecret("linearApiKey", "new-key", seams);

    expect((await loadSecrets(seams)).linearApiKey).toBe("new-key");
  });

  test("saveTeamConfig writes both linearTeamId and linearTeamKey to the encrypted store", async () => {
    const seams = fakeSecretsSeams();

    await saveTeamConfig("team-123", "CV", seams);

    const secrets = await loadSecrets(seams);
    expect(secrets.linearTeamId).toBe("team-123");
    expect(secrets.linearTeamKey).toBe("CV");
  });

  test("getTeamConfig is null until both id and key are set, then returns the pair", async () => {
    const seams = fakeSecretsSeams();
    expect(await getTeamConfig(seams)).toBeNull();

    await saveTeamConfig("team-456", "EM", seams);
    expect(await getTeamConfig(seams)).toEqual({ teamId: "team-456", teamKey: "EM" });
  });

  function brokenExecSeam(): SecretsExecSeam {
    return {
      fileExists: () => true,
      statFile: () => null,
      readFile: () => { throw new Error("should not be called"); },
      writeFile: () => {},
      ensureDir: () => {},
      chmod: () => {},
      fsyncAndRename: () => {},
      removeFile: () => {},
      async run(cmd): Promise<SecretsExecResult> {
        if (cmd[0] === "sops" && cmd[1] === "-d") return { code: 1, stdout: "", stderr: "gpg: decryption failed" };
        throw new Error(`unexpected ${cmd.join(" ")}`);
      },
    };
  }

  test("an encrypted-store read failure propagates — never silently returns {}", async () => {
    const seams: SecretsSeams = { ageKeySeam: fakeAgeKeySeam(), execSeam: brokenExecSeam() };

    await expect(loadSecrets(seams)).rejects.toThrow(/decryption failed/);
  });
});

/** Stub global.fetch to return canned GraphQL data and capture the request body. */
function mockGraphql(data: unknown): { body: () => { query: string; variables: Record<string, unknown> } } {
  let captured: { query: string; variables: Record<string, unknown> } | null = null;
  global.fetch = (async (_url: string, init: { body: string }) => {
    captured = JSON.parse(init.body);
    return { ok: true, json: async () => ({ data }) } as unknown as Response;
  }) as unknown as typeof fetch;
  return { body: () => captured! };
}

const node = (identifier: string, stateName: string | null = "Todo") => ({
  id: identifier.toLowerCase(),
  identifier,
  title: `${identifier} title`,
  description: null,
  url: `https://linear.app/issue/${identifier}`,
  branchName: null,
  state: stateName ? { name: stateName, color: "#fff" } : null,
});

describe("pickStartedState", () => {
  // Reproduces the ClaimView (Derpy) team: many `started`-type states, where the
  // API returns "Ready for Merge" first but "In Progress" (position 0) is the
  // real entry point into the started group.
  const claimViewStates = [
    { id: "merge", type: "started", position: 4000 },
    { id: "stale", type: "canceled", position: 0 },
    { id: "ready-testing", type: "started", position: 2000 },
    { id: "code-review", type: "started", position: 1000 },
    { id: "in-progress", type: "started", position: 0 },
    { id: "todo", type: "unstarted", position: 0 },
    { id: "done", type: "completed", position: 0 },
  ];

  test("picks the lowest-position started state, not the first in the array", () => {
    expect(pickStartedState(claimViewStates)?.id).toBe("in-progress");
  });

  test("returns null when there is no started state", () => {
    expect(
      pickStartedState([
        { id: "todo", type: "unstarted", position: 0 },
        { id: "done", type: "completed", position: 1000 },
      ]),
    ).toBeNull();
  });

  test("falls back to the single started state when only one exists", () => {
    expect(
      pickStartedState([
        { id: "backlog", type: "backlog", position: 0 },
        { id: "doing", type: "started", position: 500 },
      ])?.id,
    ).toBe("doing");
  });
});

describe("fetchMyTodoTickets", () => {
  // Regression: the branch picker once fetched the whole team's active backlog
  // capped at 50 (no assignee filter), so a user's own older ticket (e.g.
  // CV-2256, last touched a day ago) fell off behind the team's churn. The
  // query must scope to the viewer's own assigned tickets.
  test("scopes to the viewer's own assigned tickets, not the whole team backlog", async () => {
    const m = mockGraphql({ team: { issues: { nodes: [node("CV-2256")] } } });

    const tickets = await fetchMyTodoTickets("key", "team-123");

    const sent = m.body();
    expect(sent.query).toContain("assignee");
    expect(sent.query).toContain("isMe");
    expect(sent.variables.teamId).toBe("team-123");
    expect(tickets).toHaveLength(1);
    expect(tickets[0]!.identifier).toBe("CV-2256");
  });

  test("returns [] when the API errors", async () => {
    global.fetch = (async () => ({ ok: false, status: 500 }) as unknown as Response) as unknown as typeof fetch;
    expect(await fetchMyTodoTickets("key", "team-123")).toEqual([]);
  });
});

describe("searchTickets", () => {
  test("maps searchIssues results, preserving order", async () => {
    const m = mockGraphql({ searchIssues: { nodes: [node("CV-2256"), node("EM-2256", null)] } });

    const tickets = await searchTickets("key", "2256");

    expect(m.body().variables.term).toBe("2256");
    expect(tickets.map((t) => t.identifier)).toEqual(["CV-2256", "EM-2256"]);
    expect(tickets[1]!.stateName).toBeNull();
  });

  test("returns [] without hitting the network for blank terms", async () => {
    let called = false;
    global.fetch = (async () => {
      called = true;
      return { ok: true, json: async () => ({ data: {} }) } as unknown as Response;
    }) as unknown as typeof fetch;

    expect(await searchTickets("key", "   ")).toEqual([]);
    expect(called).toBe(false);
  });
});
