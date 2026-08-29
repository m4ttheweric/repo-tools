import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { execSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import pino from "pino";
import { rtDir, teamSettingsPath } from "../../rt-paths.ts";
import { endpointsPath, loadClaims, rekeyEndpointClaimsTable } from "../../endpoint/store.ts";
import { closeStateDb, listEndpointClaims } from "../../state/index.ts";
import { serializeIdentity } from "../../settings/identity.ts";
import type { RepoIndex } from "../handlers/types.ts";
import { createEndpointHandlers, releaseEndpointsForWorktree } from "../handlers/endpoint.ts";
import type { HandlerContext } from "../handlers/types.ts";

/**
 * The daemon's repo index, as the handlers see it. Reset per test alongside
 * HOME (beforeEach): the name→path→identity hop is what makes the settings
 * stores' `repos.<identity>` sections reachable.
 */
let repoIndex: RepoIndex = {};
let ctx: HandlerContext;
const fakeProbes = async () => ({ listeners: new Set<number>(), pidAlive: () => true, pidStartTime: () => undefined, canBind: () => true });

const DEFAULT_ROLES = {
  backend: { pool: [{ from: 10400, to: 10402 }], env: { PORT: "${port}" } },
  portal: { pool: [4001, 5001], needs: ["backend"] },
};

/**
 * Hard cutover: `payload.repo` (and its matching `ctx.repoIndex()` key)
 * must be a serialized identity now, distinct from the RAW host/path form
 * `repos.<identity>` settings sections still key on (see the last test in
 * this file) — `declareRoles` below derives both from the same bare test
 * name, but only the serialized form ever reaches a handler payload.
 */
function idOf(repoName: string): string {
  return serializeIdentity({ kind: "remote", id: `rttest/${repoName}` });
}

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
  repoIndex[idOf(repoName)] = repoPath;

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
    const r = await handlers["endpoint:claim"]({ repo: idOf("repoA"), worktree: "/wt/a", role: "portal", pid: 7 });
    expect(r.ok).toBe(true);
    expect(r.data.port).toBe(4001);
    expect(r.data.url).toBe("http://localhost:4001");
    expect(r.data.refs.backend.port).toBe(10400);
    const lk = await handlers["endpoint:lookup"]({ repo: idOf("repoA"), worktree: "/wt/a", role: "backend" });
    expect(lk.data).toMatchObject({ claimed: true, port: 10400 });
  });

  /**
   * A repo with no index entry derives a null identity, so its store section
   * (if any) is unreachable — the honest degrade for an unregistered repo.
   */
  test("claim resolves roles from a settings store section (repoIndex → identity → repos.<identity>)", async () => {
    declareRoles("repoStore", { web: { pool: [{ from: 10600, to: 10602 }], env: { PORT: "${port}" } } });

    const r = await handlers["endpoint:claim"]({ repo: idOf("repoStore"), worktree: "/wt/store", role: "web", pid: 11 });
    expect(r.ok).toBe(true);
    expect(r.data.port).toBe(10600);

    const lk = await handlers["endpoint:lookup"]({ repo: idOf("repoStore"), worktree: "/wt/store", role: "web" });
    expect(lk.data).toMatchObject({ claimed: true, port: 10600 });

    const other = await handlers["endpoint:claim"]({ repo: idOf("repoUnindexed"), worktree: "/wt/store", role: "web" });
    expect(other).toMatchObject({ ok: false, error: `role "web" is not declared for repo "${idOf("repoUnindexed")}"` });
  });

  test("unknown role and unknown repo fail with named errors", async () => {
    declareRoles("repoA");
    const r = await handlers["endpoint:claim"]({ repo: idOf("repoA"), worktree: "/wt/a", role: "nope" });
    expect(r).toMatchObject({ ok: false, error: `role "nope" is not declared for repo "${idOf("repoA")}"` });
  });

  test("a bare legacy repo is refused before any role or config lookup", async () => {
    declareRoles("repoA");
    const r = await handlers["endpoint:claim"]({ repo: "repoA", worktree: "/wt/a", role: "backend" });
    expect(r).toEqual({ ok: false, error: "repo-unknown" });
    const lk = await handlers["endpoint:lookup"]({ repo: "repoA", worktree: "/wt/a", role: "backend" });
    expect(lk).toEqual({ ok: true, data: { claimed: false, port: null, url: null, running: false } });
    const rel = await handlers["endpoint:release"]({ repo: "repoA", worktree: "/wt/a" });
    expect(rel).toEqual({ ok: true, data: { released: 0 } });
    const status = await handlers["endpoint:status"]({ repo: "repoA" });
    expect(status).toEqual({ ok: true, data: { repos: {} } });
  });

  test("release by worktree frees claims; releaseEndpointsForWorktree does the same (disposal path)", async () => {
    declareRoles("repoB");
    await handlers["endpoint:claim"]({ repo: idOf("repoB"), worktree: "/wt/x", role: "backend", pid: 1 });
    releaseEndpointsForWorktree(ctx, idOf("repoB"), "/wt/x");
    expect(loadClaims(idOf("repoB"))).toEqual([]);
  });

  test("releasing a worktree with no claims writes nothing — no endpoints.json for a repo that never claimed", async () => {
    declareRoles("repoNoClaims");
    expect(existsSync(endpointsPath(idOf("repoNoClaims")))).toBe(false);
    expect(loadClaims(idOf("repoNoClaims"))).toEqual([]);

    releaseEndpointsForWorktree(ctx, idOf("repoNoClaims"), "/wt/never-claimed");
    expect(existsSync(endpointsPath(idOf("repoNoClaims")))).toBe(false);
    expect(loadClaims(idOf("repoNoClaims"))).toEqual([]);

    const r = await handlers["endpoint:release"]({ repo: idOf("repoNoClaims"), worktree: "/wt/never-claimed" });
    expect(r).toMatchObject({ ok: true, data: { released: 0 } });
    expect(existsSync(endpointsPath(idOf("repoNoClaims")))).toBe(false);
    expect(loadClaims(idOf("repoNoClaims"))).toEqual([]);
  });

  test("releaseEndpointsForWorktree swallows a save failure instead of throwing", async () => {
    // root bypasses file permission bits entirely — chmod 0o444 would not
    // actually block the reopen, so the throw this test exercises can't occur.
    if (process.getuid?.() === 0) return;

    declareRoles("repoReadonly");
    await handlers["endpoint:claim"]({ repo: idOf("repoReadonly"), worktree: "/wt/z", role: "backend", pid: 1 });

    // An already-open fd tolerates a permission change (the OS only checks
    // at open()), so the singleton has to be forced to reopen against the
    // now-read-only file for this to fail at all. persistOrWarn only
    // swallows SQLITE_BUSY, so a genuine open failure still has to reach
    // releaseEndpointsForWorktree's own catch for this test to mean anything.
    closeStateDb();
    const dbPath = join(rtDir(), "state.db");
    chmodSync(dbPath, 0o444);
    try {
      expect(() => releaseEndpointsForWorktree(ctx, idOf("repoReadonly"), "/wt/z")).not.toThrow();
    } finally {
      chmodSync(dbPath, 0o644);
      closeStateDb();
    }
  });

  /**
   * endpoint_claims.repo is the serialized identity (what commands/endpoint.ts
   * and buildInterceptRules now both send as `payload.repo`), while
   * repoIdentityFor's return value — the `repos.<identity>` settings-section
   * key `loadEndpointConfig` resolves roles against — stays the raw host/path
   * form. Collapsing the two would make every settings-backed role lookup
   * miss (settings sections are keyed by the raw form, not the wire form).
   */
  test("endpoint_claims tables on the serialized identity while settings resolution still keys on the raw host/path", async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "rt-endpoint-idkey-"));
    execSync("git init -q", { cwd: repoPath });
    execSync("git remote add origin git@rttest:acme/idkey.git", { cwd: repoPath });

    const rawId = "rttest/acme/idkey";
    const serialized = serializeIdentity({ kind: "remote", id: rawId });
    repoIndex[serialized] = repoPath;

    const store = teamSettingsPath("acme");
    mkdirSync(dirname(store), { recursive: true });
    writeFileSync(store, JSON.stringify({ repos: { [rawId]: { "rt.roles": DEFAULT_ROLES } } }));

    const r = await handlers["endpoint:claim"]({ repo: serialized, worktree: "/wt/idkey", role: "backend", pid: 1 });
    expect(r.ok).toBe(true); // resolved roles via the RAW host/path settings key

    expect(listEndpointClaims(serialized)).toHaveLength(1); // table keys on the SERIALIZED identity
    expect(listEndpointClaims(rawId)).toEqual([]);

    const rekeyReport = await rekeyEndpointClaimsTable();
    expect(rekeyReport.migrated).toEqual([]); // already identity-keyed — nothing to do
    expect(listEndpointClaims(serialized)).toHaveLength(1);
  });
});
