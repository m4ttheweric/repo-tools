import { describe, expect, test, beforeEach } from "bun:test";
import { execSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import pino from "pino";
import { repoDataDir, teamSettingsPath } from "../../rt-paths.ts";
import { endpointsPath, loadClaims } from "../../endpoint/store.ts";
import type { RepoIndex } from "../handlers/types.ts";
import { createEndpointHandlers, releaseEndpointsForWorktree } from "../handlers/endpoint.ts";
import type { HandlerContext } from "../handlers/types.ts";

/**
 * The daemon's repo index, as the handlers see it. Mutable so a test can
 * register a repo path before claiming: the name→path→identity hop is what
 * makes the settings stores' `repos.<identity>` sections reachable (RT-47).
 * A repo absent from here derives a null identity, which is the legacy-only
 * path every other test in this file rides.
 */
const repoIndex: RepoIndex = {};
const ctx = { log: pino({ level: "silent" }), repoIndex: () => repoIndex } as unknown as HandlerContext;
const fakeProbes = async () => ({ listeners: new Set<number>(), pidAlive: () => true, canBind: () => true });

function declareRoles(repo: string): void {
  mkdirSync(repoDataDir(repo), { recursive: true });
  writeFileSync(join(repoDataDir(repo), "config.json"), JSON.stringify({
    roles: {
      backend: { pool: [{ from: 10400, to: 10402 }], env: { PORT: "${port}" } },
      portal: { pool: [4001, 5001], needs: ["backend"] },
    },
  }));
}

describe("endpoint handlers", () => {
  let handlers: ReturnType<typeof createEndpointHandlers>;
  beforeEach(() => { handlers = createEndpointHandlers(ctx, { probes: fakeProbes }); });

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
   * The path that breaks `pnpm start` if it regresses: roles declared ONLY in
   * a settings store, reached through the repo index → `deriveRepoIdentity` →
   * `repos.<identity>` chain. Every other claim test here rides the legacy
   * per-repo config.json, so without this one the whole store side of the
   * daemon claim handler is untested.
   *
   * A real `git init` + remote, not a stubbed derivation: the identity hop is
   * an actual `git config --get remote.origin.url` capture, and faking it
   * would skip exactly the normalization this test is here to prove.
   *
   * This is the ONE test in the file that writes a settings STORE, so it runs
   * under its own HOME (and drops its repo-index entry afterwards). The
   * bunfig preload gives the whole run a single shared temp HOME; a team store
   * written into that shared tree would make `listTeams()` non-empty for every
   * later suite in the process, which is exactly the cross-suite leak the
   * per-test-HOME rule exists to prevent.
   */
  test("claim resolves roles from a settings store section (repoIndex → identity → repos.<identity>)", async () => {
    const priorHome = process.env.HOME;
    process.env.HOME = mkdtempSync(join(tmpdir(), "rt-endpoint-store-home-"));
    try {
      const repoPath = mkdtempSync(join(tmpdir(), "rt-endpoint-store-repo-"));
      execSync("git init -q", { cwd: repoPath });
      execSync("git remote add origin git@gitlab.com:fake/store-claim-repo.git", { cwd: repoPath });
      repoIndex["repoStore"] = repoPath;

      // No repos/repoStore/config.json anywhere — the legacy rung is empty, so
      // a port can only come from the store.
      const store = teamSettingsPath("acme");
      mkdirSync(dirname(store), { recursive: true });
      writeFileSync(store, JSON.stringify({
        repos: {
          "gitlab.com/fake/store-claim-repo": {
            "rt.roles": { web: { pool: [{ from: 10600, to: 10602 }], env: { PORT: "${port}" } } },
          },
        },
      }));

      const r = await handlers["endpoint:claim"]({ repo: "repoStore", worktree: "/wt/store", role: "web", pid: 11 });
      expect(r.ok).toBe(true);
      expect(r.data.port).toBe(10600);

      const lk = await handlers["endpoint:lookup"]({ repo: "repoStore", worktree: "/wt/store", role: "web" });
      expect(lk.data).toMatchObject({ claimed: true, port: 10600 });

      // …and a repo with no index entry still derives a null identity, so this
      // store's repo section cannot leak into the legacy-rung tests around it.
      const other = await handlers["endpoint:claim"]({ repo: "repoUnindexed", worktree: "/wt/store", role: "web" });
      expect(other).toMatchObject({ ok: false, error: 'role "web" is not declared for repo "repoUnindexed"' });
    } finally {
      delete repoIndex["repoStore"];
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
    }
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

    releaseEndpointsForWorktree(ctx, "repoNoClaims", "/wt/never-claimed");
    expect(existsSync(endpointsPath("repoNoClaims"))).toBe(false);

    const r = await handlers["endpoint:release"]({ repo: "repoNoClaims", worktree: "/wt/never-claimed" });
    expect(r).toMatchObject({ ok: true, data: { released: 0 } });
    expect(existsSync(endpointsPath("repoNoClaims"))).toBe(false);
  });

  test("releaseEndpointsForWorktree swallows a save failure instead of throwing", async () => {
    // root bypasses directory permission bits entirely — chmod 0o555 would not
    // actually block the write, so the throw this test exercises can't occur.
    if (process.getuid?.() === 0) return;

    declareRoles("repoReadonly");
    await handlers["endpoint:claim"]({ repo: "repoReadonly", worktree: "/wt/z", role: "backend", pid: 1 });

    const dir = repoDataDir("repoReadonly");
    chmodSync(dir, 0o555);
    try {
      expect(() => releaseEndpointsForWorktree(ctx, "repoReadonly", "/wt/z")).not.toThrow();
    } finally {
      chmodSync(dir, 0o755);
    }
  });
});
