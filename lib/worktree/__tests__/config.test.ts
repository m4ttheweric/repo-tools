import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { writeJson } from "../../json-store.ts";
import { repoDataDir, rtDir } from "../../rt-paths.ts";
import {
  loadWorktreeRepoConfig,
  resolveImplicitInstall,
  resolveReadySteps,
  loadWorktreeAppConfig,
  type WorktreeRepoConfig,
} from "../config.ts";

function tmpRepoPath(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

describe("worktree config", () => {
  beforeEach(() => {
    process.env.HOME = realpathSync(mkdtempSync(join(tmpdir(), "rtcfg-home-")));
  });

  describe("loadWorktreeRepoConfig", () => {
    test("defaults when config.json is missing", () => {
      const repoPath = tmpRepoPath("rtcfg-repo-");
      const cfg = loadWorktreeRepoConfig("myrepo", repoPath);
      expect(cfg).toEqual({
        onDeck: 0,
        root: join(repoPath, ".worktrees"),
        branchFormat: "<ticket>-<slug>",
        ready: [],
      });
    });

    test("defaults when config.json exists but has no 'worktrees' key", () => {
      const repoPath = tmpRepoPath("rtcfg-repo-");
      writeJson(join(repoDataDir("myrepo"), "config.json"), {
        setup: [],
        clean: [],
        startScript: "start",
        open: { base: "" },
      });
      const cfg = loadWorktreeRepoConfig("myrepo", repoPath);
      expect(cfg).toEqual({
        onDeck: 0,
        root: join(repoPath, ".worktrees"),
        branchFormat: "<ticket>-<slug>",
        ready: [],
      });
    });

    test("declared block round-trips", () => {
      const repoPath = tmpRepoPath("rtcfg-repo-");
      const declared = {
        onDeck: 2,
        namePool: ["hogwarts", "bellatrix"],
        root: "/absolute/path/to/assured",
        branchFormat: "<ticket>",
        ready: [
          { run: "pnpm genTypes", when: "changed:db/schema/**" },
        ],
      };
      writeJson(join(repoDataDir("myrepo"), "config.json"), {
        setup: [{ label: "x", command: "y" }],
        worktrees: declared,
      });
      const cfg = loadWorktreeRepoConfig("myrepo", repoPath);
      expect(cfg).toEqual(declared);
    });

    test("expands a leading ~/ in root against call-time HOME", () => {
      const repoPath = tmpRepoPath("rtcfg-repo-");
      writeJson(join(repoDataDir("myrepo"), "config.json"), {
        worktrees: { root: "~/wt-root" },
      });
      const cfg = loadWorktreeRepoConfig("myrepo", repoPath);
      expect(cfg.root).toBe(join(process.env.HOME!, "wt-root"));
    });

    test("leaves an absolute root unchanged", () => {
      const repoPath = tmpRepoPath("rtcfg-repo-");
      writeJson(join(repoDataDir("myrepo"), "config.json"), {
        worktrees: { root: "/absolute/wt-root" },
      });
      const cfg = loadWorktreeRepoConfig("myrepo", repoPath);
      expect(cfg.root).toBe("/absolute/wt-root");
    });
  });

  describe("resolveImplicitInstall", () => {
    test("no package.json -> null", () => {
      const repoPath = tmpRepoPath("rtcfg-noinstall-");
      expect(resolveImplicitInstall(repoPath)).toBeNull();
    });

    test("packageManager field prefix -> matching manager step", () => {
      const repoPath = tmpRepoPath("rtcfg-pm-");
      writeFileSync(
        join(repoPath, "package.json"),
        JSON.stringify({ name: "x", packageManager: "pnpm@9.1.0" })
      );
      expect(resolveImplicitInstall(repoPath)).toEqual({
        run: "pnpm install --side-effects-cache",
        when: "changed:pnpm-lock.yaml",
      });
    });

    test("lockfile sniff: only bun.lockb present -> bun step", () => {
      const repoPath = tmpRepoPath("rtcfg-bunlock-");
      writeFileSync(join(repoPath, "package.json"), JSON.stringify({ name: "x" }));
      writeFileSync(join(repoPath, "bun.lockb"), "");
      expect(resolveImplicitInstall(repoPath)).toEqual({
        run: "bun install",
        when: "changed:bun.lock*",
      });
    });

    test("lockfile sniff: bun.lock (text lockfile) -> bun step", () => {
      const repoPath = tmpRepoPath("rtcfg-bunlock2-");
      writeFileSync(join(repoPath, "package.json"), JSON.stringify({ name: "x" }));
      writeFileSync(join(repoPath, "bun.lock"), "");
      expect(resolveImplicitInstall(repoPath)).toEqual({
        run: "bun install",
        when: "changed:bun.lock*",
      });
    });

    test("lockfile sniff: pnpm-lock.yaml -> pnpm step", () => {
      const repoPath = tmpRepoPath("rtcfg-pnpmlock-");
      writeFileSync(join(repoPath, "package.json"), JSON.stringify({ name: "x" }));
      writeFileSync(join(repoPath, "pnpm-lock.yaml"), "");
      expect(resolveImplicitInstall(repoPath)).toEqual({
        run: "pnpm install --side-effects-cache",
        when: "changed:pnpm-lock.yaml",
      });
    });

    test("lockfile sniff: yarn.lock -> yarn step", () => {
      const repoPath = tmpRepoPath("rtcfg-yarnlock-");
      writeFileSync(join(repoPath, "package.json"), JSON.stringify({ name: "x" }));
      writeFileSync(join(repoPath, "yarn.lock"), "");
      expect(resolveImplicitInstall(repoPath)).toEqual({
        run: "yarn install",
        when: "changed:yarn.lock",
      });
    });

    test("package.json alone (no packageManager, no lockfile) -> npm step", () => {
      const repoPath = tmpRepoPath("rtcfg-npm-");
      writeFileSync(join(repoPath, "package.json"), JSON.stringify({ name: "x" }));
      expect(resolveImplicitInstall(repoPath)).toEqual({
        run: "npm install",
        when: "changed:package-lock.json",
      });
    });
  });

  describe("resolveReadySteps", () => {
    test("prepends implicit install when not declared", () => {
      const repoPath = tmpRepoPath("rtcfg-resolve1-");
      writeFileSync(join(repoPath, "package.json"), JSON.stringify({ name: "x" }));
      writeFileSync(join(repoPath, "pnpm-lock.yaml"), "");
      const cfg: WorktreeRepoConfig = {
        onDeck: 0,
        root: join(repoPath, ".worktrees"),
        branchFormat: "<ticket>-<slug>",
        ready: [{ run: "node scripts/gen-types.js", when: "changed:db/schema/**" }],
      };
      expect(resolveReadySteps(cfg, repoPath)).toEqual([
        { run: "pnpm install --side-effects-cache", when: "changed:pnpm-lock.yaml" },
        { run: "node scripts/gen-types.js", when: "changed:db/schema/**" },
      ]);
    });

    test("does not double the implicit install when config declares its own pnpm line", () => {
      const repoPath = tmpRepoPath("rtcfg-resolve2-");
      writeFileSync(join(repoPath, "package.json"), JSON.stringify({ name: "x" }));
      writeFileSync(join(repoPath, "pnpm-lock.yaml"), "");
      const cfg: WorktreeRepoConfig = {
        onDeck: 0,
        root: join(repoPath, ".worktrees"),
        branchFormat: "<ticket>-<slug>",
        ready: [
          { run: "pnpm install --side-effects-cache", when: "changed:pnpm-lock.yaml" },
          { run: "pnpm genTypes", when: "changed:db/schema/**" },
        ],
      };
      expect(resolveReadySteps(cfg, repoPath)).toEqual(cfg.ready);
    });

    test("a declared non-install step for the manager does not suppress the implicit install", () => {
      const repoPath = tmpRepoPath("rtcfg-resolve4-");
      writeFileSync(join(repoPath, "package.json"), JSON.stringify({ name: "x" }));
      writeFileSync(join(repoPath, "pnpm-lock.yaml"), "");
      const cfg: WorktreeRepoConfig = {
        onDeck: 0,
        root: join(repoPath, ".worktrees"),
        branchFormat: "<ticket>-<slug>",
        ready: [{ run: "pnpm lint" }],
      };
      expect(resolveReadySteps(cfg, repoPath)).toEqual([
        { run: "pnpm install --side-effects-cache", when: "changed:pnpm-lock.yaml" },
        { run: "pnpm lint" },
      ]);
    });

    test("no implicit install (no package.json) -> just declared steps", () => {
      const repoPath = tmpRepoPath("rtcfg-resolve3-");
      const cfg: WorktreeRepoConfig = {
        onDeck: 0,
        root: join(repoPath, ".worktrees"),
        branchFormat: "<ticket>-<slug>",
        ready: [{ run: "echo hi" }],
      };
      expect(resolveReadySteps(cfg, repoPath)).toEqual(cfg.ready);
    });
  });

  describe("loadWorktreeAppConfig", () => {
    test("defaults when neither worktrees.json nor parking-lot.json exists", () => {
      expect(loadWorktreeAppConfig()).toEqual({ enabled: true, killProcesses: true });
    });

    test("seeds from parking-lot.json once, then reads the new file thereafter", () => {
      mkdirSync(rtDir(), { recursive: true });
      writeFileSync(
        join(rtDir(), "parking-lot.json"),
        JSON.stringify({ enabled: false })
      );

      const first = loadWorktreeAppConfig();
      expect(first).toEqual({ enabled: false, killProcesses: true });

      // Prove it's now reading the new file, not re-seeding from the legacy one.
      writeJson(join(rtDir(), "worktrees.json"), { enabled: true, killProcesses: false });
      const second = loadWorktreeAppConfig();
      expect(second).toEqual({ enabled: true, killProcesses: false });
    });
  });
});
