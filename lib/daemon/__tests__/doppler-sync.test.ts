import { afterEach, describe, expect, test } from "bun:test";
import { dirname, join } from "path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";

const tmpHome = mkdtempSync(join(tmpdir(), "rt-doppler-sync-"));
process.env.HOME = tmpHome;

const { reconcileForRepo } = await import("../doppler-sync.ts");
const { setSetting } = await import("../../settings/write.ts");
const { machineSettingsPath, teamSettingsPath } = await import("../../rt-paths.ts");
const { loadDopplerConfig, writeDopplerConfig } = await import("../../doppler-config.ts");

const IDENTITY = "gitlab.com/acme/test-repo";

function seedTemplate(entries: unknown[]): void {
  setSetting("rt.dopplerTemplate", entries, "machine", { repoIdentity: IDENTITY });
}

/** setSetting(..., "team", ...) refuses without a local team store (write.ts's team-selection rule). */
function seedTeam(): void {
  const path = teamSettingsPath("acme");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "// team store\n{}\n");
}

afterEach(() => {
  try { rmSync(join(tmpHome, ".mattstack"), { recursive: true, force: true }); } catch { /* */ }
  try { rmSync(join(tmpHome, ".doppler"),   { recursive: true, force: true }); } catch { /* */ }
});

describe("reconcileForRepo", () => {
  test("returns wrote=0 when no template is declared", async () => {
    const summary = await reconcileForRepo({
      repoIdentity: IDENTITY,
      worktreeRoots: ["/repo/primary"],
    });
    expect(summary).toEqual({ wrote: 0, overridden: 0, unchanged: 0, skipped: "no-template" });
  });

  test("returns wrote=0 when identity can't be derived (no repo section reachable)", async () => {
    const summary = await reconcileForRepo({
      repoIdentity: null,
      worktreeRoots: ["/repo/primary"],
    });
    expect(summary).toEqual({ wrote: 0, overridden: 0, unchanged: 0, skipped: "no-template" });
  });

  test("writes per-app entries for each worktree × template entry", async () => {
    seedTemplate([
      { path: "apps/backend",  project: "backend",  config: "dev" },
      { path: "apps/frontend", project: "frontend", config: "dev" },
    ]);

    const summary = await reconcileForRepo({
      repoIdentity: IDENTITY,
      worktreeRoots: ["/repo/primary", "/repo/wktree-2"],
    });

    expect(summary.wrote).toBe(4);
    expect(summary.overridden).toBe(0);

    const cfg = loadDopplerConfig();
    expect(cfg.scoped["/repo/primary/apps/backend"]).toEqual({
      "enclave.project": "backend",
      "enclave.config":  "dev",
    });
    expect(cfg.scoped["/repo/wktree-2/apps/frontend"]).toEqual({
      "enclave.project": "frontend",
      "enclave.config":  "dev",
    });
  });

  test("resolves a template declared at team.repo scope — where the cutover actually writes it", async () => {
    seedTeam();
    setSetting(
      "rt.dopplerTemplate",
      [{ path: "apps/backend", project: "backend", config: "dev" }],
      "team",
      { repoIdentity: IDENTITY },
    );

    const summary = await reconcileForRepo({
      repoIdentity: IDENTITY,
      worktreeRoots: ["/repo/primary"],
    });

    expect(summary.wrote).toBe(1);
    expect(loadDopplerConfig().scoped["/repo/primary/apps/backend"]).toEqual({
      "enclave.project": "backend",
      "enclave.config":  "dev",
    });
  });

  test("is idempotent — second run reports unchanged", async () => {
    seedTemplate([{ path: "apps/backend", project: "backend", config: "dev" }]);

    await reconcileForRepo({ repoIdentity: IDENTITY, worktreeRoots: ["/repo/primary"] });
    const second = await reconcileForRepo({ repoIdentity: IDENTITY, worktreeRoots: ["/repo/primary"] });

    expect(second.wrote).toBe(0);
    expect(second.unchanged).toBe(1);
    expect(second.overridden).toBe(0);
  });

  test("does not overwrite a user override (different config)", async () => {
    seedTemplate([{ path: "apps/backend", project: "backend", config: "dev" }]);
    writeDopplerConfig({
      scoped: {
        "/repo/primary/apps/backend": {
          "enclave.project": "backend",
          "enclave.config":  "staging",
        },
      },
    });

    const summary = await reconcileForRepo({
      repoIdentity: IDENTITY,
      worktreeRoots: ["/repo/primary"],
    });
    expect(summary.wrote).toBe(0);
    expect(summary.overridden).toBe(1);
    expect(loadDopplerConfig().scoped["/repo/primary/apps/backend"]?.["enclave.config"])
      .toBe("staging");
  });

  test("a value present but wrong-shaped at every scope resolves as absent, not malformed", async () => {
    // The resolver's own per-scope type check already skips a non-array
    // value with a warning before it ever reaches reconcileForRepo — so
    // this degrades the same way "nothing declared" does, honestly.
    const path = machineSettingsPath();
    mkdirSync(join(tmpHome, ".mattstack"), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ repos: { [IDENTITY]: { "rt.dopplerTemplate": { oops: true } } } }),
    );

    const summary = await reconcileForRepo({
      repoIdentity: IDENTITY,
      worktreeRoots: ["/repo/primary"],
    });
    expect(summary).toEqual({ wrote: 0, overridden: 0, unchanged: 0, skipped: "no-template" });
  });

  test("returns skipped=malformed-template when a declared entry can't be expanded", async () => {
    seedTemplate([{ path: "${repoRoot}", project: "backend", config: "dev" }]);

    const summary = await reconcileForRepo({
      repoIdentity: IDENTITY,
      worktreeRoots: ["/repo/primary"],
    });
    expect(summary).toEqual({
      wrote: 0, overridden: 0, unchanged: 0, skipped: "malformed-template",
    });
  });
});
