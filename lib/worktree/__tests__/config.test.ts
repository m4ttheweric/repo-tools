import { describe, test, expect, beforeEach } from "bun:test";
import { execSync } from "child_process";
import { mkdtempSync, realpathSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { writeJson } from "../../json-store.ts";
import {
  machineSettingsPath,
  repoDataDir,
  rtDir,
  teamSettingsPath,
  userSettingsPath,
} from "../../rt-paths.ts";
import {
  loadWorktreeRepoConfig,
  resolveImplicitInstall,
  resolveReadySteps,
  stripEnvPrefix,
  loadWorktreeAppConfig,
  worktreeSettingsDeclared,
  type WorktreeRepoConfig,
} from "../config.ts";

function tmpRepoPath(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/**
 * A real git repo with a real remote — the store rungs are keyed by repo
 * IDENTITY, and identity comes from `git config --get remote.origin.url`.
 * Faking the derivation would skip exactly the hop these tests exist to prove.
 * Each call makes a FRESH temp path so `deriveRepoIdentity`'s per-path memo
 * can never carry an identity between tests.
 */
function tmpRepoWithRemote(prefix: string, remote: string): string {
  const dir = tmpRepoPath(prefix);
  execSync(`git init -q && git remote add origin ${remote}`, { cwd: dir, shell: "/bin/zsh" });
  return dir;
}

function writeStore(file: string, obj: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(obj, null, 2));
}

describe("worktree config", () => {
  beforeEach(() => {
    process.env.HOME = realpathSync(mkdtempSync(join(tmpdir(), "rtcfg-home-")));
  });

  describe("loadWorktreeRepoConfig", () => {
    test("defaults when config.json is missing", async () => {
      const repoPath = tmpRepoPath("rtcfg-repo-");
      const cfg = await loadWorktreeRepoConfig("myrepo", repoPath);
      expect(cfg).toEqual({
        onDeck: 0,
        root: join(repoPath, ".worktrees"),
        branchFormat: "<ticket>-<slug>",
        ready: [],
      });
    });

    test("defaults when config.json exists but has no 'worktrees' key", async () => {
      const repoPath = tmpRepoPath("rtcfg-repo-");
      writeJson(join(repoDataDir("myrepo"), "config.json"), {
        setup: [],
        clean: [],
        startScript: "start",
        open: { base: "" },
      });
      const cfg = await loadWorktreeRepoConfig("myrepo", repoPath);
      expect(cfg).toEqual({
        onDeck: 0,
        root: join(repoPath, ".worktrees"),
        branchFormat: "<ticket>-<slug>",
        ready: [],
      });
    });

    test("declared block round-trips", async () => {
      const repoPath = tmpRepoPath("rtcfg-repo-");
      const declared = {
        onDeck: 2,
        namePool: ["web", "bellatrix"],
        root: "/absolute/path/to/acme",
        branchFormat: "<ticket>",
        ready: [
          { run: "pnpm genTypes", when: "changed:db/schema/**" },
        ],
      };
      writeJson(join(repoDataDir("myrepo"), "config.json"), {
        setup: [{ label: "x", command: "y" }],
        worktrees: declared,
      });
      const cfg = await loadWorktreeRepoConfig("myrepo", repoPath);
      expect(cfg).toEqual(declared);
    });

    test("expands a leading ~/ in root against call-time HOME", async () => {
      const repoPath = tmpRepoPath("rtcfg-repo-");
      writeJson(join(repoDataDir("myrepo"), "config.json"), {
        worktrees: { root: "~/wt-root" },
      });
      const cfg = await loadWorktreeRepoConfig("myrepo", repoPath);
      expect(cfg.root).toBe(join(process.env.HOME!, "wt-root"));
    });

    test("drops dot-leading namePool entries", async () => {
      // A pool entry named ".trash-x" would build a tree the reconciler's reap
      // duty then deletes as a leftover. The reaper is the only rm -rf in the
      // codebase; this is the door it can come through.
      const repoPath = tmpRepoPath("rtcfg-repo-");
      writeJson(join(repoDataDir("myrepo"), "config.json"), {
        worktrees: { namePool: [".trash-x", "luna"] },
      });
      const cfg = await loadWorktreeRepoConfig("myrepo", repoPath);
      expect(cfg.namePool).toEqual(["luna"]);
    });

    test("leaves an absolute root unchanged", async () => {
      const repoPath = tmpRepoPath("rtcfg-repo-");
      writeJson(join(repoDataDir("myrepo"), "config.json"), {
        worktrees: { root: "/absolute/wt-root" },
      });
      const cfg = await loadWorktreeRepoConfig("myrepo", repoPath);
      expect(cfg.root).toBe("/absolute/wt-root");
    });
  });

  // ─── Through the resolver (RT-47) ──────────────────────────────────────────

  describe("loadWorktreeRepoConfig through the settings resolver", () => {
    const IDENTITY = "gitlab.com/acme/acme-dev";
    const REMOTE = "git@gitlab.com:acme/acme-dev.git";

    test("the deep-merge proof case: team onDeck/ready + user namePool + legacy everything", async () => {
      const repoPath = tmpRepoWithRemote("rtcfg-merge-", REMOTE);

      // team: the shared pool size and the shared ready ladder
      writeStore(teamSettingsPath("acme"), {
        repos: {
          [IDENTITY]: {
            "rt.worktrees": {
              onDeck: 3,
              ready: [{ run: "pnpm install", when: "changed:pnpm-lock.yaml" }],
            },
          },
        },
      });
      // user: one personal field, restating nothing else
      writeStore(userSettingsPath(), {
        repos: { [IDENTITY]: { "rt.worktrees": { namePool: ["web", "bellatrix"] } } },
      });
      // legacy: the pre-migration file, still carrying everything
      writeJson(join(repoDataDir("acme-dev"), "config.json"), {
        worktrees: {
          onDeck: 1,
          namePool: ["legacy-name"],
          root: "/legacy/wt-root",
          branchFormat: "<ticket>",
          ready: [{ run: "legacy-step" }],
        },
      });

      const cfg = await loadWorktreeRepoConfig("acme-dev", repoPath);

      expect(cfg).toEqual({
        onDeck: 3, // team beats legacy
        namePool: ["web", "bellatrix"], // user beats legacy (arrays replace whole)
        root: "/legacy/wt-root", // legacy-only field survives the merge
        branchFormat: "<ticket>", // legacy-only field survives the merge
        ready: [{ run: "pnpm install", when: "changed:pnpm-lock.yaml" }], // team beats legacy
      });
    });

    test("a store-only repo resolves with no legacy config.json at all", async () => {
      const repoPath = tmpRepoWithRemote("rtcfg-storeonly-", REMOTE);
      writeStore(teamSettingsPath("acme"), {
        repos: { [IDENTITY]: { "rt.worktrees": { onDeck: 2, namePool: ["luna"] } } },
      });

      const cfg = await loadWorktreeRepoConfig("acme-dev", repoPath);
      expect(cfg.onDeck).toBe(2);
      expect(cfg.namePool).toEqual(["luna"]);
      // computed default still lives in the reader, not the registry
      expect(cfg.root).toBe(join(repoPath, ".worktrees"));
      expect(cfg.branchFormat).toBe("<ticket>-<slug>");
    });

    test("${repoRoot} in a shared-scope root expands to the repo path", async () => {
      const repoPath = tmpRepoWithRemote("rtcfg-var-", REMOTE);
      writeStore(teamSettingsPath("acme"), {
        repos: { [IDENTITY]: { "rt.worktrees": { root: "${repoRoot}/trees" } } },
      });

      const cfg = await loadWorktreeRepoConfig("acme-dev", repoPath);
      expect(cfg.root).toBe(join(repoPath, "trees"));
    });

    test("a machine-store root of ~/wt still expands: `~` is not a closed-set variable", async () => {
      // The resolver's closed set is ${repoRoot}/${worktree}/${home}/${team:x}
      // — a bare `~` passes straight through it, so the reader's own expandHome
      // is what keeps a machine-store path literal working.
      const repoPath = tmpRepoWithRemote("rtcfg-tilde-", REMOTE);
      writeStore(machineSettingsPath(), {
        repos: { [IDENTITY]: { "rt.worktrees": { root: "~/wt" } } },
      });

      const cfg = await loadWorktreeRepoConfig("acme-dev", repoPath);
      expect(cfg.root).toBe(join(process.env.HOME!, "wt"));
    });

    test("the namePool dot-filter applies to a store value, not just the legacy file", async () => {
      const repoPath = tmpRepoWithRemote("rtcfg-dotstore-", REMOTE);
      writeStore(userSettingsPath(), {
        repos: { [IDENTITY]: { "rt.worktrees": { namePool: [".trash-x", "luna"] } } },
      });

      const cfg = await loadWorktreeRepoConfig("acme-dev", repoPath);
      expect(cfg.namePool).toEqual(["luna"]);
    });

    test("a repo with no derivable identity still reads its legacy file", async () => {
      const repoPath = tmpRepoPath("rtcfg-noident-"); // not a git repo: identity null
      writeStore(teamSettingsPath("acme"), {
        repos: { [IDENTITY]: { "rt.worktrees": { onDeck: 9 } } },
      });
      writeJson(join(repoDataDir("acme-dev"), "config.json"), {
        worktrees: { onDeck: 4 },
      });

      const cfg = await loadWorktreeRepoConfig("acme-dev", repoPath);
      expect(cfg.onDeck).toBe(4); // legacy answers; the repo section is unreachable
    });
  });

  describe("worktreeSettingsDeclared", () => {
    const IDENTITY = "gitlab.com/acme/store-only";
    const REMOTE = "git@gitlab.com:acme/store-only.git";

    test("nothing authored anywhere -> false (the registry default does not count)", async () => {
      const repoPath = tmpRepoWithRemote("rtcfg-act-none-", REMOTE);
      expect(await worktreeSettingsDeclared("store-only", repoPath)).toBe(false);
    });

    test("a team store section with no legacy config.json -> true", async () => {
      const repoPath = tmpRepoWithRemote("rtcfg-act-store-", REMOTE);
      writeStore(teamSettingsPath("acme"), {
        repos: { [IDENTITY]: { "rt.worktrees": { onDeck: 2 } } },
      });
      expect(await worktreeSettingsDeclared("store-only", repoPath)).toBe(true);
    });

    test("an EMPTY legacy worktrees block still counts, exactly as it did pre-resolver", async () => {
      const repoPath = tmpRepoWithRemote("rtcfg-act-legacy-", REMOTE);
      writeJson(join(repoDataDir("store-only"), "config.json"), { worktrees: {} });
      expect(await worktreeSettingsDeclared("store-only", repoPath)).toBe(true);
    });

    test("a config.json with other keys but no worktrees block -> false", async () => {
      const repoPath = tmpRepoWithRemote("rtcfg-act-other-", REMOTE);
      writeJson(join(repoDataDir("store-only"), "config.json"), { setup: [], startScript: "x" });
      expect(await worktreeSettingsDeclared("store-only", repoPath)).toBe(false);
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
        run: "pnpm install",
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
        run: "pnpm install",
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
        { run: "pnpm install", when: "changed:pnpm-lock.yaml" },
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
        { run: "pnpm install", when: "changed:pnpm-lock.yaml" },
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

    test("an env-var prefix on the declared install still suppresses the implicit one", () => {
      const repoPath = tmpRepoPath("rtcfg-resolve5-");
      writeFileSync(join(repoPath, "package.json"), JSON.stringify({ name: "x" }));
      writeFileSync(join(repoPath, "pnpm-lock.yaml"), "");
      const cfg: WorktreeRepoConfig = {
        onDeck: 0,
        root: join(repoPath, ".worktrees"),
        branchFormat: "<ticket>-<slug>",
        ready: [{ run: "SKIP_GEN_TYPES=1 pnpm install --side-effects-cache" }],
      };
      expect(resolveReadySteps(cfg, repoPath)).toEqual(cfg.ready);
    });

    test("an `env VAR=value` prefix on the declared install still suppresses the implicit one", () => {
      const repoPath = tmpRepoPath("rtcfg-resolve6-");
      writeFileSync(join(repoPath, "package.json"), JSON.stringify({ name: "x" }));
      writeFileSync(join(repoPath, "pnpm-lock.yaml"), "");
      const cfg: WorktreeRepoConfig = {
        onDeck: 0,
        root: join(repoPath, ".worktrees"),
        branchFormat: "<ticket>-<slug>",
        ready: [{ run: "env FOO=bar pnpm install" }],
      };
      expect(resolveReadySteps(cfg, repoPath)).toEqual(cfg.ready);
    });

    test("an `env -i` prefix on the declared install still suppresses the implicit one", () => {
      const repoPath = tmpRepoPath("rtcfg-resolve8-");
      writeFileSync(join(repoPath, "package.json"), JSON.stringify({ name: "x" }));
      writeFileSync(join(repoPath, "pnpm-lock.yaml"), "");
      const cfg: WorktreeRepoConfig = {
        onDeck: 0,
        root: join(repoPath, ".worktrees"),
        branchFormat: "<ticket>-<slug>",
        ready: [{ run: "env -i PATH=/usr/bin pnpm install" }],
      };
      expect(resolveReadySteps(cfg, repoPath)).toEqual(cfg.ready);
    });

    test("a command that merely starts with the letters `install` does not suppress it", () => {
      const repoPath = tmpRepoPath("rtcfg-resolve9-");
      writeFileSync(join(repoPath, "package.json"), JSON.stringify({ name: "x" }));
      writeFileSync(join(repoPath, "pnpm-lock.yaml"), "");
      const cfg: WorktreeRepoConfig = {
        onDeck: 0,
        root: join(repoPath, ".worktrees"),
        branchFormat: "<ticket>-<slug>",
        ready: [{ run: "pnpm installer" }],
      };
      expect(resolveReadySteps(cfg, repoPath)).toEqual([
        { run: "pnpm install", when: "changed:pnpm-lock.yaml" },
        { run: "pnpm installer" },
      ]);
    });

    test("an env-var prefix on a NON-install step does not suppress the implicit install", () => {
      const repoPath = tmpRepoPath("rtcfg-resolve7-");
      writeFileSync(join(repoPath, "package.json"), JSON.stringify({ name: "x" }));
      writeFileSync(join(repoPath, "pnpm-lock.yaml"), "");
      const cfg: WorktreeRepoConfig = {
        onDeck: 0,
        root: join(repoPath, ".worktrees"),
        branchFormat: "<ticket>-<slug>",
        ready: [{ run: "SKIP_X=1 pnpm lint" }],
      };
      expect(resolveReadySteps(cfg, repoPath)).toEqual([
        { run: "pnpm install", when: "changed:pnpm-lock.yaml" },
        { run: "SKIP_X=1 pnpm lint" },
      ]);
    });
  });

  describe("stripEnvPrefix", () => {
    test("leaves a bare command alone", () => {
      expect(stripEnvPrefix("pnpm install")).toBe("pnpm install");
    });

    test("strips one or many leading assignments", () => {
      expect(stripEnvPrefix("A=1 pnpm install")).toBe("pnpm install");
      expect(stripEnvPrefix("A=1 B=2 pnpm install --frozen-lockfile")).toBe(
        "pnpm install --frozen-lockfile",
      );
    });

    test("strips a leading `env`, with or without assignments after it", () => {
      expect(stripEnvPrefix("env pnpm install")).toBe("pnpm install");
      expect(stripEnvPrefix("env FOO=bar pnpm install")).toBe("pnpm install");
    });

    test("strips env's own options, including ones that take an argument", () => {
      expect(stripEnvPrefix("env -i PATH=/usr/bin pnpm install")).toBe("pnpm install");
      expect(stripEnvPrefix("env --ignore-environment pnpm install")).toBe("pnpm install");
      expect(stripEnvPrefix("env -u FOO pnpm install")).toBe("pnpm install");
    });

    test("never eats a command's own flags — options only strip after `env`", () => {
      expect(stripEnvPrefix("pnpm -r install")).toBe("pnpm -r install");
      expect(stripEnvPrefix("A=1 pnpm --filter x install")).toBe("pnpm --filter x install");
    });

    test("tolerates quoted assignment values containing spaces", () => {
      expect(stripEnvPrefix('FOO="a b" pnpm install')).toBe("pnpm install");
    });

    test("never eats the command itself", () => {
      expect(stripEnvPrefix("A=1")).toBe("A=1");
      expect(stripEnvPrefix("env")).toBe("env");
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
