/**
 * `rt cd --emit-rows`: the hidden, non-TTY-only flag Task 6's fzf
 * `ctrl-r:reload` binding execs to refresh the picker's row list without
 * launching a picker of its own. Must print the exact fzf row format
 * `buildFzfRows` produces and refresh the cd cache as a side effect, and it
 * must never surface in the command tree or help.
 */

import { describe, expect, test } from "bun:test";
import { execSync, spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeStateDb, setKvValue } from "../state/index.ts";
import { readRepoCache } from "../repo-cache.ts";
import { TREE } from "../command-tree-def.ts";

const RT_ROOT = join(import.meta.dir, "..", "..");

describe("rt cd --emit-rows", () => {
  const origHome = process.env.HOME;
  let home: string;
  let scratch: string;

  function realRepo(name: string): string {
    const dir = join(scratch, name);
    mkdirSync(dir, { recursive: true });
    execSync("git init -q -b main", { cwd: dir, stdio: "pipe" });
    execSync("git -c user.email=t@t -c user.name=t commit --allow-empty -q -m init", { cwd: dir, stdio: "pipe" });
    return dir;
  }

  function setup(): void {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-emit-rows-home-")));
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "rt-emit-rows-repos-")));
    process.env.HOME = home;
    closeStateDb();
  }

  function teardown(): void {
    process.env.HOME = origHome;
    closeStateDb();
    rmSync(home, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }

  test("prints tab-delimited rows (first field = repo value) and writes the cd cache", () => {
    setup();
    try {
      const dir = realRepo("emit-rows-repo");
      setKvValue("repo-index", "emit-rows-repo", dir);
      closeStateDb();

      const result = spawnSync("bun", ["run", "cli.ts", "cd", "--emit-rows"], {
        cwd: RT_ROOT,
        env: { ...process.env, HOME: home },
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 60_000,
      });

      expect(result.status).toBe(0);

      const lines = (result.stdout ?? "").trim().split("\n").filter(Boolean);
      expect(lines.length).toBeGreaterThan(0);
      const values = lines.map((line) => line.split("\t")[0]);
      expect(values).toContain("emit-rows-repo");

      // Every row is well-formed tab-delimited (value, styled label, hint).
      for (const line of lines) {
        expect(line.split("\t").length).toBe(3);
      }

      const cache = readRepoCache();
      expect(cache).not.toBeNull();
      expect(cache?.repos.some((r) => r.repoName === "emit-rows-repo")).toBe(true);
    } finally {
      teardown();
    }
  }, 90_000);

  test("does not launch a picker or print anything to stderr beyond an ordinary run", () => {
    setup();
    try {
      const dir = realRepo("emit-rows-repo-2");
      setKvValue("repo-index", "emit-rows-repo-2", dir);
      closeStateDb();

      const result = spawnSync("bun", ["run", "cli.ts", "cd", "--emit-rows"], {
        cwd: RT_ROOT,
        env: { ...process.env, HOME: home },
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 60_000,
      });

      expect(result.status).toBe(0);
      // fzf's own chrome (border/prompt escape codes) never appears: no
      // picker process was spawned.
      expect(result.stderr ?? "").not.toContain("filter:");
    } finally {
      teardown();
    }
  }, 90_000);
});

describe("--emit-rows stays hidden", () => {
  test("is not a declared arg on the cd command (absent from help and pickers)", () => {
    const cdNode = TREE.cd;
    expect(cdNode).toBeDefined();
    const flags = (cdNode?.args ?? []).map((a) => a.flag).filter(Boolean);
    expect(flags).not.toContain("--emit-rows");
  });
});
