import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Logger } from "pino";
import { closeStateDb, setKvValue } from "../../state/index.ts";
import { appendRunHistory, readRunHistory } from "../../run-history.ts";
import { loadRegistry, saveRegistry } from "../../worktree/registry.ts";
import { runBootIdentityMigration } from "../boot-migrate.ts";

function fakeLog(): { log: Logger; infos: unknown[][]; warns: unknown[][] } {
  const infos: unknown[][] = [];
  const warns: unknown[][] = [];
  const log = {
    info: (...args: unknown[]) => { infos.push(args); },
    warn: (...args: unknown[]) => { warns.push(args); },
    error: () => {},
    debug: () => {},
  } as unknown as Logger;
  return { log, infos, warns };
}

const row = { ts: "2026-08-24T00:00:00Z", cmd: "bun test", cwd: "/repo", worktree: "/repo", branch: "main", pkg: ".", script: "test", exit: 0 };

describe("runBootIdentityMigration", () => {
  const origHome = process.env.HOME;
  let home: string;
  let repoPath: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "rt-boot-mig-"));
    process.env.HOME = home;
    closeStateDb();
    repoPath = mkdtempSync(join(tmpdir(), "rt-boot-mig-repo-"));
    // No git remote here, so deriveRepoIdentity falls back to a path-kind
    // identity keyed on this directory's own realpath — deterministic
    // without a real remote fixture.
    setKvValue("repo-index", "acme-repo", repoPath);
  });
  afterEach(() => {
    process.env.HOME = origHome;
    closeStateDb();
    rmSync(home, { recursive: true, force: true });
    rmSync(repoPath, { recursive: true, force: true });
  });

  test("migrates a legacy-keyed db once, across a kv namespace and a table column, and is a no-op the second time", async () => {
    appendRunHistory("acme-repo", row);
    saveRegistry("acme-repo", []);

    const first = fakeLog();
    await runBootIdentityMigration(first.log);

    const runHistoryUnderName = readRunHistory("acme-repo", 10);
    expect(runHistoryUnderName).toEqual([]);
    const registryUnderName = loadRegistry("acme-repo");
    expect(registryUnderName).toEqual([]);

    // Both stores now key on SOME identity string (path-kind, since this repo
    // has no git remote) — assert the row moved, not the exact identity text.
    const migratedInfoCalls = first.infos.filter(([obj]) => (obj as { migrated?: number })?.migrated);
    expect(migratedInfoCalls.length).toBeGreaterThan(0);

    const second = fakeLog();
    await runBootIdentityMigration(second.log);
    const secondMigratedCalls = second.infos.filter(([obj]) => (obj as { migrated?: number })?.migrated);
    expect(secondMigratedCalls).toEqual([]);
  });
});
