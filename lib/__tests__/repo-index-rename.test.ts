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
import { closeStateDb, getStateDb, setKvValue } from "../state/index.ts";
import {
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
          data: { moved: [], merged: [], refused: [], removedDir: false },
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
      expect(result).toEqual({ moved: [], merged: [], refused: [], removedDir: false });
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
});
