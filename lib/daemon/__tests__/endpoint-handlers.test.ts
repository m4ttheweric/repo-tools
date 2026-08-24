import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { execSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import pino from "pino";
import { rtDir, teamSettingsPath } from "../../rt-paths.ts";
import { endpointsPath, loadClaims } from "../../endpoint/store.ts";
import { closeStateDb } from "../../state/index.ts";
import type { RepoIndex } from "../handlers/types.ts";
import { createEndpointHandlers, releaseEndpointsForWorktree } from "../handlers/endpoint.ts";
import type { HandlerContext } from "../handlers/types.ts";

/**
 * The daemon's repo index, as the handlers see it. Reset per test alongside
 * HOME (beforeEach): the name→path→identity hop is what makes the settings
 * stores' `repos.<identity>` sections reachable (RT-47).
 */
let repoIndex: RepoIndex = {};
let ctx: HandlerContext;
const fakeProbes = async () => ({ listeners: new Set<number>(), pidAlive: () => true, canBind: () => true });

const DEFAULT_ROLES = {
  backend: { pool: [{ from: 10400, to: 10402 }], env: { PORT: "${port}" } },
  portal: { pool: [4001, 5001], needs: ["backend"] },
};

/**
 * Registers a real git repo (with a fake-but-derivable remote) for `repoName`
 * and declares `roles` for it in the team store, keyed by the identity that
 * remote normalizes to — the only path a claim can reach a repo's roles
 * through now that the legacy per-repo config.json rung is gone.
 */
function declareRoles(repoName: string, roles: unknown = DEFAULT_ROLES): void {
  const repoPath = mkdtempSync(join(tmpdir(), `rt-endpoint-${repoName}-`));
  execSync("git init -q", { cwd: repoPath });
  execSync(`git remote add origin git@rttest:${repoName}.git`, { cwd: repoPath });
  repoIndex[repoName] = repoPath;

  const identity = `rttest/${repoName}`;
  const store = teamSettingsPath("acme");
  mkdirSync(dirname(store), { recursive: true });
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(readFileSync(store, "utf8"));
  } catch { /* absent or malformed — start fresh */ }
  const repos = { ...(existing.repos as Record<string, unknown> ?? {}), [identity]: { "rt.roles": roles } };
  writeFileSync(store, JSON.stringify({ ...existing, repos }));
}

describe("endpoint handlers", () => {
  const origHome = process.env.HOME;
  let home: string;
  let handlers: ReturnType<typeof createEndpointHandlers>;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-endpoint-handlers-")));
    process.env.HOME = home;
    closeStateDb();
    repoIndex = {};
    ctx = { log: pino({ level: "silent" }), repoIndex: () => repoIndex } as unknown as HandlerContext;
    handlers = createEndpointHandlers(ctx, { probes: fakeProbes });
  });

  afterEach(() => {
    process.env.HOME = origHome;
    closeStateDb();
    rmSync(home, { recursive: true, force: true });
  });

  test("claim allocates, lookup sees it, refs pull the needed role into existence", async () => {
    declareRoles("repoA");
    const r = await handlers["endpoint:claim"]({ repo: "repoA", worktree: "/wt/a", role: "portal", pid: 7 });
    expect(r.ok).toBe(true);
    expect(r.data.port).toBe(4001);
    expect(r.data.url).toBe("http://localhost:4001");
    expect(r.data.refs.backend.port).toBe(10400);
    const lk = await handlers["endpoint:lookup"]({ repo: "repoA", worktree: "/wt/a", role: "backend" });
    expect(lk.data).toMatchObject({ claimed: true, port: 10400 });
  });

  /**
   * A repo with no index entry derives a null identity, so its store section
   * (if any) is unreachable — the honest degrade for an unregistered repo.
   */
  test("claim resolves roles from a settings store section (repoIndex → identity → repos.<identity>)", async () => {
    declareRoles("repoStore", { web: { pool: [{ from: 10600, to: 10602 }], env: { PORT: "${port}" } } });

    const r = await handlers["endpoint:claim"]({ repo: "repoStore", worktree: "/wt/store", role: "web", pid: 11 });
    expect(r.ok).toBe(true);
    expect(r.data.port).toBe(10600);

    const lk = await handlers["endpoint:lookup"]({ repo: "repoStore", worktree: "/wt/store", role: "web" });
    expect(lk.data).toMatchObject({ claimed: true, port: 10600 });

    const other = await handlers["endpoint:claim"]({ repo: "repoUnindexed", worktree: "/wt/store", role: "web" });
    expect(other).toMatchObject({ ok: false, error: 'role "web" is not declared for repo "repoUnindexed"' });
  });

  test("unknown role and unknown repo fail with named errors", async () => {
    declareRoles("repoA");
    const r = await handlers["endpoint:claim"]({ repo: "repoA", worktree: "/wt/a", role: "nope" });
    expect(r).toMatchObject({ ok: false, error: 'role "nope" is not declared for repo "repoA"' });
  });

  test("release by worktree frees claims; releaseEndpointsForWorktree does the same (disposal path)", async () => {
    declareRoles("repoB");
    await handlers["endpoint:claim"]({ repo: "repoB", worktree: "/wt/x", role: "backend", pid: 1 });
    releaseEndpointsForWorktree(ctx, "repoB", "/wt/x");
    expect(loadClaims("repoB")).toEqual([]);
  });

  test("releasing a worktree with no claims writes nothing — no endpoints.json for a repo that never claimed", async () => {
    declareRoles("repoNoClaims");
    expect(existsSync(endpointsPath("repoNoClaims"))).toBe(false);
    expect(loadClaims("repoNoClaims")).toEqual([]);

    releaseEndpointsForWorktree(ctx, "repoNoClaims", "/wt/never-claimed");
    expect(existsSync(endpointsPath("repoNoClaims"))).toBe(false);
    expect(loadClaims("repoNoClaims")).toEqual([]);

    const r = await handlers["endpoint:release"]({ repo: "repoNoClaims", worktree: "/wt/never-claimed" });
    expect(r).toMatchObject({ ok: true, data: { released: 0 } });
    expect(existsSync(endpointsPath("repoNoClaims"))).toBe(false);
    expect(loadClaims("repoNoClaims")).toEqual([]);
  });

  test("releaseEndpointsForWorktree swallows a save failure instead of throwing", async () => {
    // root bypasses file permission bits entirely — chmod 0o444 would not
    // actually block the reopen, so the throw this test exercises can't occur.
    if (process.getuid?.() === 0) return;

    declareRoles("repoReadonly");
    await handlers["endpoint:claim"]({ repo: "repoReadonly", worktree: "/wt/z", role: "backend", pid: 1 });

    // An already-open fd tolerates a permission change (the OS only checks
    // at open()), so the singleton has to be forced to reopen against the
    // now-read-only file for this to fail at all. persistOrWarn only
    // swallows SQLITE_BUSY, so a genuine open failure still has to reach
    // releaseEndpointsForWorktree's own catch for this test to mean anything.
    closeStateDb();
    const dbPath = join(rtDir(), "state.db");
    chmodSync(dbPath, 0o444);
    try {
      expect(() => releaseEndpointsForWorktree(ctx, "repoReadonly", "/wt/z")).not.toThrow();
    } finally {
      chmodSync(dbPath, 0o644);
      closeStateDb();
    }
  });
});
