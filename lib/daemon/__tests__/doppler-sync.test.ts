import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const tmpHome = mkdtempSync(join(tmpdir(), "rt-doppler-sync-"));
process.env.HOME = tmpHome;

const { reconcileForRepo } = await import("../doppler-sync.ts");
const { saveTemplate } = await import("../../doppler-template.ts");
const { loadDopplerConfig, writeDopplerConfig } = await import("../../doppler-config.ts");

const REPO = "test-repo";

afterEach(() => {
  try { rmSync(join(tmpHome, ".rt"),     { recursive: true, force: true }); } catch { /* */ }
  try { rmSync(join(tmpHome, ".doppler"), { recursive: true, force: true }); } catch { /* */ }
});

describe("reconcileForRepo", () => {
  test("returns wrote=0 when no template exists", async () => {
    const summary = await reconcileForRepo({
      repoName: REPO,
      worktreeRoots: ["/repo/primary"],
    });
    expect(summary).toEqual({ wrote: 0, overridden: 0, unchanged: 0, skipped: "no-template" });
  });

  test("writes per-app entries for each worktree × template entry", async () => {
    saveTemplate(REPO, [
      { path: "apps/backend",  project: "backend",  config: "dev" },
      { path: "apps/frontend", project: "frontend", config: "dev" },
    ]);

    const summary = await reconcileForRepo({
      repoName: REPO,
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

  test("is idempotent — second run reports unchanged", async () => {
    saveTemplate(REPO, [{ path: "apps/backend", project: "backend", config: "dev" }]);

    await reconcileForRepo({
      repoName: REPO,
      worktreeRoots: ["/repo/primary"],
    });
    const second = await reconcileForRepo({
      repoName: REPO,
      worktreeRoots: ["/repo/primary"],
    });

    expect(second.wrote).toBe(0);
    expect(second.unchanged).toBe(1);
    expect(second.overridden).toBe(0);
  });

  test("does not overwrite a user override (different config)", async () => {
    saveTemplate(REPO, [{ path: "apps/backend", project: "backend", config: "dev" }]);
    writeDopplerConfig({
      scoped: {
        "/repo/primary/apps/backend": {
          "enclave.project": "backend",
          "enclave.config":  "staging",
        },
      },
    });

    const summary = await reconcileForRepo({
      repoName: REPO,
      worktreeRoots: ["/repo/primary"],
    });
    expect(summary.wrote).toBe(0);
    expect(summary.overridden).toBe(1);
    expect(loadDopplerConfig().scoped["/repo/primary/apps/backend"]?.["enclave.config"])
      .toBe("staging");
  });

  test("returns skipped=malformed-template if template can't parse", async () => {
    mkdirSync(join(tmpHome, ".rt", REPO), { recursive: true });
    writeFileSync(
      join(tmpHome, ".rt", REPO, "doppler-template.yaml"),
      "[invalid yaml::",
    );

    const summary = await reconcileForRepo({
      repoName: REPO,
      worktreeRoots: ["/repo/primary"],
    });
    expect(summary).toEqual({
      wrote: 0, overridden: 0, unchanged: 0, skipped: "malformed-template",
    });
  });
});
