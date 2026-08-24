import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeStateDb, getStateDb, setKvValue, listKvValues } from "../index.ts";
import { rekeyKvNamespace, rekeyTableColumn } from "../identity-migrate.ts";
import { appendRunHistoryEntry, listRunHistory } from "../run-history-store.ts";

describe("rekeyKvNamespace", () => {
  const origHome = process.env.HOME;
  let home: string;
  let warnSpy: ReturnType<typeof spyOn<Console, "warn">>;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "rt-rek-")); process.env.HOME = home; closeStateDb(); warnSpy = spyOn(console, "warn").mockImplementation(() => {}); });
  afterEach(() => { warnSpy.mockRestore(); process.env.HOME = origHome; closeStateDb(); rmSync(home, { recursive: true, force: true }); });

  test("a legacy name resolvable to a remote identity is re-keyed", async () => {
    setKvValue("repo-index", "repo-tools", "/tmp/does-not-need-to-exist");
    setKvValue("demo-ns", "repo-tools", { v: 1 });
    // resolveLegacyKey is fed a fixed resolver in the test via opts:
    const report = await rekeyKvNamespace("demo-ns", {
      resolve: async (name) => (name === "repo-tools" ? "remote:gitlab.com%2Fg%2Frepo-tools" : null),
    });
    expect(report.migrated).toEqual(["repo-tools"]);
    const rows = listKvValues("demo-ns");
    expect(rows["remote:gitlab.com%2Fg%2Frepo-tools"]).toEqual({ v: 1 });
    expect(rows["repo-tools"]).toBeUndefined();
  });

  test("a key already a serialized identity is left untouched", async () => {
    setKvValue("demo-ns", "remote:gitlab.com%2Fg%2Fr", { v: 2 });
    const report = await rekeyKvNamespace("demo-ns", { resolve: async () => null });
    expect(report.migrated).toEqual([]);
    expect(listKvValues("demo-ns")["remote:gitlab.com%2Fg%2Fr"]).toEqual({ v: 2 });
  });

  test("an unresolvable legacy name is retained and warned, never dropped", async () => {
    setKvValue("demo-ns", "ghost", { v: 3 });
    const report = await rekeyKvNamespace("demo-ns", { resolve: async () => null });
    expect(report.retained).toEqual(["ghost"]);
    expect(listKvValues("demo-ns")["ghost"]).toEqual({ v: 3 });
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe("rekeyTableColumn", () => {
  const origHome = process.env.HOME;
  let home: string;
  let warnSpy: ReturnType<typeof spyOn<Console, "warn">>;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "rt-rek-table-")); process.env.HOME = home; closeStateDb(); warnSpy = spyOn(console, "warn").mockImplementation(() => {}); });
  afterEach(() => { warnSpy.mockRestore(); process.env.HOME = origHome; closeStateDb(); rmSync(home, { recursive: true, force: true }); });

  const row = { ts: "2026-08-24T00:00:00Z", cmd: "bun test", cwd: "/repo", worktree: "/repo", branch: "main", pkg: ".", script: "test", exit: 0 };

  test("a legacy-named row is re-keyed onto its resolved identity", async () => {
    appendRunHistoryEntry("repo-tools", row, getStateDb());
    const report = await rekeyTableColumn("run_history", "repo", {
      resolve: async (name) => (name === "repo-tools" ? "remote:gitlab.com%2Fg%2Frepo-tools" : null),
    });
    expect(report.migrated).toEqual(["repo-tools"]);
    expect(listRunHistory("remote:gitlab.com%2Fg%2Frepo-tools", 10, getStateDb()).map((e) => e.cmd)).toEqual(["bun test"]);
    expect(listRunHistory("repo-tools", 10, getStateDb())).toEqual([]);
  });

  test("a row already keyed by a serialized identity is left untouched", async () => {
    appendRunHistoryEntry("remote:gitlab.com%2Fg%2Fr", row, getStateDb());
    const report = await rekeyTableColumn("run_history", "repo", { resolve: async () => null });
    expect(report.migrated).toEqual([]);
    expect(listRunHistory("remote:gitlab.com%2Fg%2Fr", 10, getStateDb())).toHaveLength(1);
  });

  test("an unresolvable legacy row is retained and warned, never dropped", async () => {
    appendRunHistoryEntry("ghost-repo", row, getStateDb());
    const report = await rekeyTableColumn("run_history", "repo", { resolve: async () => null });
    expect(report.retained).toEqual(["ghost-repo"]);
    expect(listRunHistory("ghost-repo", 10, getStateDb())).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalled();
  });

  test("a legacy row colliding with an already-identity row migrates without throwing, leaving exactly the identity row", async () => {
    const db = getStateDb();
    db.exec("CREATE TABLE IF NOT EXISTS endpoint_claims (repo TEXT NOT NULL, worktree TEXT NOT NULL, role TEXT NOT NULL, port INTEGER NOT NULL, pid INTEGER, ts TEXT NOT NULL, PRIMARY KEY (repo, worktree, role))");
    const insert = db.query("INSERT INTO endpoint_claims (repo, worktree, role, port, pid, ts) VALUES (?,?,?,?,?,?)");
    insert.run("acme-repo", "wt1", "web", 4000, null, "2026-08-24T00:00:00Z");
    insert.run("remote:gitlab.com%2Fg%2Facme-repo", "wt1", "web", 5000, null, "2026-08-24T01:00:00Z");

    const report = await rekeyTableColumn("endpoint_claims", "repo", {
      resolve: async (name) => (name === "acme-repo" ? "remote:gitlab.com%2Fg%2Facme-repo" : null),
    });
    expect(report.migrated).toEqual(["acme-repo"]);

    const rows = db.query("SELECT repo, port FROM endpoint_claims WHERE worktree = 'wt1' AND role = 'web'").all() as { repo: string; port: number }[];
    expect(rows).toEqual([{ repo: "remote:gitlab.com%2Fg%2Facme-repo", port: 5000 }]);
    expect(warnSpy).toHaveBeenCalled();
  });
});
