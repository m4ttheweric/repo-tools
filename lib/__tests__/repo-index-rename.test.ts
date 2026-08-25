/**
 * lib/repo-index.ts — RT-60: rename drift.
 *
 * A renamed repo leaves two index rows for one directory: the name comes from
 * the origin remote, so a remote rename mints a second key, and a directory
 * rename mints one whenever a compat symlink keeps the old path resolving.
 * These cover the picker hiding the retired name and `rt repos prune` evicting
 * it.
 *
 * Same HOME discipline as repo-index.test.ts: rt-paths resolves HOME at call
 * time, so every test gets a fresh tree.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { execSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { repoDataDir, rtDir } from "../rt-paths.ts";
import { closeStateDb, getStateDb, listKvValues, setKvValue } from "../state/index.ts";
import {
  ensureWorktreeRegistryRekeyed,
  getKnownRepos,
  loadRepoIndexEntries,
  migrateRepoData,
  partitionByRealpath,
  pruneRepoIndex,
  type RepoIndexEntry,
} from "../repo-index.ts";

const REPO_INDEX_NS = "repo-index";

describe("repo-index — rename drift (RT-60)", () => {
  const origHome = process.env.HOME;
  let home: string;
  let scratch: string;
  let warnSpy: ReturnType<typeof spyOn<Console, "warn">>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "rt-rename-home-"));
    scratch = mkdtempSync(join(tmpdir(), "rt-rename-repos-"));
    process.env.HOME = home;
    closeStateDb();
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    process.env.HOME = origHome;
    closeStateDb();
    rmSync(home, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });

  // ─── fixtures ──────────────────────────────────────────────────────────────

  /** A real git repo, so getKnownRepos' `git worktree list --porcelain`
   *  resolves instead of falling into its catch. */
  function realRepo(name: string): string {
    const dir = join(scratch, name);
    mkdirSync(dir, { recursive: true });
    execSync("git init -q -b main", { cwd: dir, stdio: "pipe" });
    execSync("git -c user.email=t@t -c user.name=t commit --allow-empty -q -m init", { cwd: dir, stdio: "pipe" });
    return dir;
  }

  /** Indexes `repoName` -> `path` at an EXPLICIT timestamp. setKvValue stamps
   *  Date.now(), whose millisecond resolution collides across two writes in the
   *  same tick — the whole point here is ordering two rows apart. */
  function indexRepoAt(repoName: string, path: string, updatedAt: number): void {
    setKvValue(REPO_INDEX_NS, repoName, path);
    getStateDb()
      .query("UPDATE kv SET updated_at = ? WHERE ns = ? AND k = ?;")
      .run(updatedAt, REPO_INDEX_NS, repoName);
  }

  function pickerNames(): string[] {
    return getKnownRepos()
      .filter((r) => r.registered !== false)
      .map((r) => r.repoName)
      .sort();
  }

  function mirror(): Record<string, string> {
    const p = join(rtDir(), "repos.json");
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
  }

  function entry(repoName: string, path: string, updatedAt: number): RepoIndexEntry {
    return { repoName, path, updatedAt };
  }

  // ─── picker dedupe ─────────────────────────────────────────────────────────

  describe("picker dedupe", () => {
    test("a compat symlink keeping the old name alive shows the tree once, under the newer name", () => {
      const deck = realRepo("deck");
      symlinkSync(deck, join(scratch, "local-apps"));
      indexRepoAt("local-apps", join(scratch, "local-apps"), 1_000);
      indexRepoAt("deck", deck, 2_000);

      expect(pickerNames()).toEqual(["deck"]);
    });

    test("a remote rename — two names, one identical path — shows the tree once", () => {
      const repo = realRepo("repo-tools");
      indexRepoAt("repo-tools", repo, 1_000);
      indexRepoAt("rt", repo, 2_000);

      expect(pickerNames()).toEqual(["rt"]);
    });

    test("the retired name still resolves in the index — the picker hides it, nothing evicts it", () => {
      const deck = realRepo("deck");
      symlinkSync(deck, join(scratch, "local-apps"));
      indexRepoAt("local-apps", join(scratch, "local-apps"), 1_000);
      indexRepoAt("deck", deck, 2_000);

      getKnownRepos();

      expect(loadRepoIndexEntries().map((e) => e.repoName).sort()).toEqual(["deck", "local-apps"]);
    });

    test("distinct directories are never collapsed", () => {
      indexRepoAt("alpha", realRepo("alpha"), 1_000);
      indexRepoAt("beta", realRepo("beta"), 2_000);

      expect(pickerNames()).toEqual(["alpha", "beta"]);
    });
  });

  // ─── partitionByRealpath ───────────────────────────────────────────────────

  describe("partitionByRealpath", () => {
    test("the most recently written row wins", () => {
      const { keep, duplicates } = partitionByRealpath([
        entry("old", scratch, 1_000),
        entry("new", scratch, 2_000),
      ]);
      expect(keep.map((e) => e.repoName)).toEqual(["new"]);
      expect(duplicates).toEqual([{ entry: entry("old", scratch, 1_000), keptAs: "new" }]);
    });

    test("an equal timestamp — every row of one legacy import — breaks by name, not insertion order", () => {
      const a = partitionByRealpath([entry("zeta", scratch, 1_000), entry("alpha", scratch, 1_000)]);
      const b = partitionByRealpath([entry("alpha", scratch, 1_000), entry("zeta", scratch, 1_000)]);
      expect(a.keep.map((e) => e.repoName)).toEqual(["alpha"]);
      expect(b.keep.map((e) => e.repoName)).toEqual(["alpha"]);
    });

    test("a path that cannot be realpath'd falls back to its own spelling rather than throwing", () => {
      const gone = join(scratch, "vanished");
      const { keep, duplicates } = partitionByRealpath([entry("a", gone, 1_000), entry("b", gone, 2_000)]);
      expect(keep.map((e) => e.repoName)).toEqual(["b"]);
      expect(duplicates.map((d) => d.entry.repoName)).toEqual(["a"]);
    });
  });

  // ─── prune ─────────────────────────────────────────────────────────────────

  describe("pruneRepoIndex", () => {
    test("removes a row whose path is gone", () => {
      indexRepoAt("alive", realRepo("alive"), 2_000);
      indexRepoAt("gone", join(scratch, "never-existed"), 1_000);

      const removed = pruneRepoIndex();

      expect(removed).toEqual([{ repoName: "gone", path: join(scratch, "never-existed"), reason: "missing" }]);
      expect(loadRepoIndexEntries().map((e) => e.repoName)).toEqual(["alive"]);
    });

    test("removes the losing half of a realpath collision, naming the winner", () => {
      const deck = realRepo("deck");
      symlinkSync(deck, join(scratch, "local-apps"));
      indexRepoAt("local-apps", join(scratch, "local-apps"), 1_000);
      indexRepoAt("deck", deck, 2_000);

      const removed = pruneRepoIndex();

      expect(removed).toEqual([
        {
          repoName: "local-apps",
          path: join(scratch, "local-apps"),
          reason: "duplicate",
          keptAs: "deck",
          // This retired name never had a data dir, so there was nothing to carry.
          data: { moved: [], merged: [], refused: [], removedDir: false, registry: "none" },
        },
      ]);
      expect(loadRepoIndexEntries().map((e) => e.repoName)).toEqual(["deck"]);
    });

    test("a duplicate group whose newer name has since been deleted keeps the row that still resolves", () => {
      const repo = realRepo("shared");
      indexRepoAt("survivor", repo, 1_000);
      indexRepoAt("newer-but-gone", join(scratch, "shared-moved"), 2_000);

      const removed = pruneRepoIndex();

      expect(removed.map((r) => r.repoName)).toEqual(["newer-but-gone"]);
      expect(loadRepoIndexEntries().map((e) => e.repoName)).toEqual(["survivor"]);
    });

    test("--dry-run reports the same removals and writes nothing", () => {
      indexRepoAt("alive", realRepo("alive"), 2_000);
      indexRepoAt("gone", join(scratch, "never-existed"), 1_000);

      const dry = pruneRepoIndex({ dryRun: true });

      expect(dry.map((r) => r.repoName)).toEqual(["gone"]);
      expect(loadRepoIndexEntries().map((e) => e.repoName).sort()).toEqual(["alive", "gone"]);
    });

    test("a clean index removes nothing and leaves the mirror alone", () => {
      indexRepoAt("alpha", realRepo("alpha"), 1_000);
      const before = mirror();

      expect(pruneRepoIndex()).toEqual([]);
      expect(mirror()).toEqual(before);
    });

    test("refreshes the out-of-process compat mirror", () => {
      indexRepoAt("alive", realRepo("alive"), 2_000);
      indexRepoAt("gone", join(scratch, "never-existed"), 1_000);

      pruneRepoIndex();

      expect(Object.keys(mirror())).toEqual(["alive"]);
    });
  });
  // ─── data migration (RT-60) ────────────────────────────────────────────────

  describe("migrateRepoData", () => {
    function writeData(repoName: string, file: string, body: string): string {
      const dir = repoDataDir(repoName);
      mkdirSync(dir, { recursive: true });
      const path = join(dir, file);
      writeFileSync(path, body);
      return path;
    }

    const RUN_HISTORY = "run-history.jsonl";
    const early = '{"ts":"2026-07-01T00:00:00.000Z","cmd":"early"}';
    const late = '{"ts":"2026-07-25T00:00:00.000Z","cmd":"late"}';

    test("moves a file the surviving name does not have", () => {
      writeData("repo-tools", RUN_HISTORY, `${early}\n`);

      const result = migrateRepoData("repo-tools", "rt");

      expect(result.moved).toEqual([RUN_HISTORY]);
      expect(result.merged).toEqual([]);
      expect(result.removedDir).toBe(true);
      expect(readFileSync(join(repoDataDir("rt"), RUN_HISTORY), "utf8")).toBe(`${early}\n`);
      expect(existsSync(repoDataDir("repo-tools"))).toBe(false);
    });

    test("merges run-history by ts, oldest first, losing nothing", () => {
      writeData("repo-tools", RUN_HISTORY, `${early}\n`);
      writeData("rt", RUN_HISTORY, `${late}\n`);

      const result = migrateRepoData("repo-tools", "rt");

      expect(result.merged).toEqual([RUN_HISTORY]);
      expect(result.refused).toEqual([]);
      expect(readFileSync(join(repoDataDir("rt"), RUN_HISTORY), "utf8")).toBe(`${early}\n${late}\n`);
      expect(existsSync(repoDataDir("repo-tools"))).toBe(false);
    });

    test("a corrupt run-history line survives the merge, sorted last", () => {
      writeData("repo-tools", RUN_HISTORY, `not json\n`);
      writeData("rt", RUN_HISTORY, `${late}\n`);

      migrateRepoData("repo-tools", "rt");

      expect(readFileSync(join(repoDataDir("rt"), RUN_HISTORY), "utf8")).toBe(`${late}\nnot json\n`);
    });

    test("refuses any other collision and keeps BOTH copies", () => {
      writeData("repo-tools", "presets.json", "retired");
      writeData("rt", "presets.json", "live");

      const result = migrateRepoData("repo-tools", "rt");

      expect(result.refused).toEqual(["presets.json"]);
      expect(result.removedDir).toBe(false);
      expect(readFileSync(join(repoDataDir("rt"), "presets.json"), "utf8")).toBe("live");
      expect(readFileSync(join(repoDataDir("repo-tools"), "presets.json"), "utf8")).toBe("retired");
    });

    test("a refusal still lets the non-colliding files through", () => {
      writeData("repo-tools", "presets.json", "retired");
      writeData("repo-tools", RUN_HISTORY, `${early}\n`);
      writeData("rt", "presets.json", "live");

      const result = migrateRepoData("repo-tools", "rt");

      expect(result.moved).toEqual([RUN_HISTORY]);
      expect(result.refused).toEqual(["presets.json"]);
      expect(existsSync(join(repoDataDir("rt"), RUN_HISTORY))).toBe(true);
      expect(existsSync(repoDataDir("repo-tools"))).toBe(true);
    });

    test("--dry-run reports the same plan and touches nothing", () => {
      writeData("repo-tools", RUN_HISTORY, `${early}\n`);
      writeData("rt", RUN_HISTORY, `${late}\n`);

      const planned = migrateRepoData("repo-tools", "rt", { dryRun: true });

      expect(planned.merged).toEqual([RUN_HISTORY]);
      expect(readFileSync(join(repoDataDir("rt"), RUN_HISTORY), "utf8")).toBe(`${late}\n`);
      expect(readFileSync(join(repoDataDir("repo-tools"), RUN_HISTORY), "utf8")).toBe(`${early}\n`);
    });

    test("a retired name with no data dir is a no-op", () => {
      const result = migrateRepoData("repo-tools", "rt");
      expect(result).toEqual({ moved: [], merged: [], refused: [], removedDir: false, registry: "none" });
    });
  });

  describe("prune carries data forward", () => {
    test("a duplicate's data reaches the surviving name before the row is dropped", () => {
      const dir = realRepo("deck");
      symlinkSync(dir, join(scratch, "local-apps"));
      mkdirSync(repoDataDir("local-apps"), { recursive: true });
      writeFileSync(join(repoDataDir("local-apps"), "run-history.jsonl"), '{"ts":"2026-07-25T00:00:00.000Z"}\n');

      indexRepoAt("deck", dir, 2_000);
      indexRepoAt("local-apps", join(scratch, "local-apps"), 1_000);

      const removed = pruneRepoIndex();
      const dup = removed.find((r) => r.repoName === "local-apps");

      expect(dup?.keptAs).toBe("deck");
      expect(dup?.data?.moved).toEqual(["run-history.jsonl"]);
      expect(existsSync(join(repoDataDir("deck"), "run-history.jsonl"))).toBe(true);
      expect(existsSync(repoDataDir("local-apps"))).toBe(false);
    });

    test("a winner that is a serialized identity is still one valid directory — literal colon, encoded slash", () => {
      const dir = realRepo("canonical");
      const identity = "remote:gitlab.com%2Fgroup%2Fcanonical";
      mkdirSync(repoDataDir("canonical-legacy"), { recursive: true });
      writeFileSync(join(repoDataDir("canonical-legacy"), "run-history.jsonl"), '{"ts":"2026-07-25T00:00:00.000Z"}\n');

      indexRepoAt(identity, dir, 2_000);
      indexRepoAt("canonical-legacy", dir, 1_000);

      const removed = pruneRepoIndex();
      const dup = removed.find((r) => r.repoName === "canonical-legacy");

      expect(dup?.keptAs).toBe(identity);
      expect(dup?.data?.moved).toEqual(["run-history.jsonl"]);
      expect(existsSync(join(repoDataDir(identity), "run-history.jsonl"))).toBe(true);
      expect(existsSync(repoDataDir("canonical-legacy"))).toBe(false);
    });

    test("a missing row's data dir is left alone — there is no surviving name to carry it to", () => {
      mkdirSync(repoDataDir("gone"), { recursive: true });
      writeFileSync(join(repoDataDir("gone"), "run-history.jsonl"), "{}\n");
      indexRepoAt("gone", join(scratch, "never-existed"), 1_000);

      const removed = pruneRepoIndex();

      expect(removed.find((r) => r.repoName === "gone")?.data).toBeUndefined();
      expect(existsSync(join(repoDataDir("gone"), "run-history.jsonl"))).toBe(true);
    });

    test("--dry-run does not move data either", () => {
      const dir = realRepo("deck");
      symlinkSync(dir, join(scratch, "local-apps"));
      mkdirSync(repoDataDir("local-apps"), { recursive: true });
      writeFileSync(join(repoDataDir("local-apps"), "run-history.jsonl"), "{}\n");
      indexRepoAt("deck", dir, 2_000);
      indexRepoAt("local-apps", join(scratch, "local-apps"), 1_000);

      pruneRepoIndex({ dryRun: true });

      expect(existsSync(join(repoDataDir("local-apps"), "run-history.jsonl"))).toBe(true);
      expect(existsSync(join(repoDataDir("deck"), "run-history.jsonl"))).toBe(false);
    });
  });
  // ─── the worktree registry travels with the name (RT-60) ───────────────────

  describe("worktree registry migration", () => {
    const WT_NS = "worktree-registry";
    const tree = (path: string) => [{ path, branch: "main", kind: "main" }];

    test("moves the retired name's registry onto the live name", () => {
      setKvValue(WT_NS, "repo-tools", tree("/x/repo-tools"));

      const result = migrateRepoData("repo-tools", "rt");

      expect(result.registry).toBe("moved");
      expect(listKvValues(WT_NS)["rt"]).toEqual(tree("/x/repo-tools"));
      expect(Object.keys(listKvValues(WT_NS))).toEqual(["rt"]);
    });

    test("merges when the live name already has one — one pool, both halves", () => {
      setKvValue(WT_NS, "repo-tools", [
        { name: "t1", path: "/x/t1", kind: "ephemeral", state: "on-deck", branch: "on-deck/t1", createdAt: "2026-01-01T00:00:00.000Z" },
      ]);
      setKvValue(WT_NS, "rt", [
        { name: "main", path: "/x/main", kind: "main", branch: "main", createdAt: "2026-01-01T00:00:00.000Z" },
      ]);

      const result = migrateRepoData("repo-tools", "rt");

      expect(result.registry).toBe("merged");
      expect((listKvValues(WT_NS)["rt"] as Array<{ path: string }>).map((t) => t.path)).toEqual(["/x/main", "/x/t1"]);
      expect(listKvValues(WT_NS)["repo-tools"]).toBeUndefined();
    });

    test("no registry under the retired name is 'none', not a failure", () => {
      expect(migrateRepoData("repo-tools", "rt").registry).toBe("none");
    });

    test("--dry-run reports the move without performing it", () => {
      setKvValue(WT_NS, "repo-tools", tree("/x/repo-tools"));

      expect(migrateRepoData("repo-tools", "rt", { dryRun: true }).registry).toBe("moved");

      expect(Object.keys(listKvValues(WT_NS))).toEqual(["repo-tools"]);
    });

    test("prune carries the registry before evicting the row — the reconciler keeps finding it", () => {
      const dir = realRepo("repo-tools");
      indexRepoAt("repo-tools", dir, 1_000);
      indexRepoAt("rt", dir, 2_000);
      setKvValue(WT_NS, "repo-tools", tree(dir));

      const removed = pruneRepoIndex();

      expect(removed.find((r) => r.repoName === "repo-tools")?.data?.registry).toBe("moved");
      expect(listKvValues(WT_NS)["rt"]).toEqual(tree(dir));
      expect(loadRepoIndexEntries().map((e) => e.repoName)).toEqual(["rt"]);
    });

    test("a merged registry is a COMPLETE migration — the retired index row is evicted", () => {
      const dir = realRepo("repo-tools");
      indexRepoAt("repo-tools", dir, 1_000);
      indexRepoAt("rt", dir, 2_000);
      setKvValue(WT_NS, "repo-tools", tree("/x/retired"));
      setKvValue(WT_NS, "rt", tree("/x/live"));

      const removed = pruneRepoIndex();

      expect(removed.find((r) => r.repoName === "repo-tools")?.data?.registry).toBe("merged");
      expect(removed.find((r) => r.repoName === "repo-tools")?.retained).toBeUndefined();
      expect(loadRepoIndexEntries().map((e) => e.repoName)).toEqual(["rt"]);
    });

    test("--dry-run reports the merge without performing it", () => {
      setKvValue(WT_NS, "repo-tools", tree("/x/retired"));
      setKvValue(WT_NS, "rt", tree("/x/live"));

      expect(migrateRepoData("repo-tools", "rt", { dryRun: true }).registry).toBe("merged");

      expect(listKvValues(WT_NS)["repo-tools"]).toEqual(tree("/x/retired"));
      expect(listKvValues(WT_NS)["rt"]).toEqual(tree("/x/live"));
    });

    test("a refused FILE also keeps the row", () => {
      const dir = realRepo("repo-tools");
      indexRepoAt("repo-tools", dir, 1_000);
      indexRepoAt("rt", dir, 2_000);
      for (const name of ["repo-tools", "rt"]) {
        mkdirSync(repoDataDir(name), { recursive: true });
        writeFileSync(join(repoDataDir(name), "presets.json"), name);
      }

      const removed = pruneRepoIndex();

      expect(removed.find((r) => r.repoName === "repo-tools")?.retained).toBe(true);
      expect(loadRepoIndexEntries().map((e) => e.repoName).sort()).toEqual(["repo-tools", "rt"]);
    });
  });

  // ─── worktree registry legacy rekey ────────────────────────────────

  describe("ensureWorktreeRegistryRekeyed", () => {
    const WT_NS = "worktree-registry";
    const tree = (path: string) => [{ path, branch: "main", kind: "main" }];

    test("moves a legacy name-keyed row onto the repo's identity, and a repeat call is a no-op", async () => {
      const dir = realRepo("repo-tools");
      execSync("git remote add origin https://gitlab.com/g/repo-tools.git", { cwd: dir, stdio: "pipe" });
      indexRepoAt("repo-tools", dir, 1_000);
      setKvValue(WT_NS, "repo-tools", tree(dir));

      await ensureWorktreeRegistryRekeyed();

      expect(listKvValues(WT_NS)["remote:gitlab.com%2Fg%2Frepo-tools"]).toEqual(tree(dir));
      expect(listKvValues(WT_NS)["repo-tools"]).toBeUndefined();

      await ensureWorktreeRegistryRekeyed();
      expect(Object.keys(listKvValues(WT_NS))).toEqual(["remote:gitlab.com%2Fg%2Frepo-tools"]);
    });

    test("a legacy name absent from the repo index is left in place, warned, never dropped", async () => {
      setKvValue(WT_NS, "never-indexed", tree("/x/gone"));

      await ensureWorktreeRegistryRekeyed();

      expect(listKvValues(WT_NS)["never-indexed"]).toEqual(tree("/x/gone"));
      expect(warnSpy).toHaveBeenCalled();
    });
  });
});
