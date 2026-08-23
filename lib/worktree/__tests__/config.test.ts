import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { execSync } from "child_process";
import { mkdtempSync, realpathSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { writeJson } from "../../json-store.ts";
import {
  machineSettingsPath,
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
  const REAL_HOME = process.env.HOME;

  beforeEach(() => {
    process.env.HOME = realpathSync(mkdtempSync(join(tmpdir(), "rtcfg-home-")));
  });

  afterEach(() => {
    if (REAL_HOME === undefined) delete process.env.HOME;
    else process.env.HOME = REAL_HOME;
  });

  describe("loadWorktreeRepoConfig", () => {
    test("defaults when nothing is declared", async () => {
      const repoPath = tmpRepoPath("rtcfg-repo-");
      const cfg = await loadWorktreeRepoConfig("myrepo", repoPath);
      expect(cfg).toEqual({
        onDeck: 0,
        root: join(repoPath, ".worktrees"),
        branchFormat: "<ticket>-<slug>",
        ready: [],
      });
    });
  });

  // ─── Through the resolver (RT-47) ──────────────────────────────────────────

  describe("loadWorktreeRepoConfig through the settings resolver", () => {
    const IDENTITY = "gitlab.com/acme/acme-dev";
    const REMOTE = "git@gitlab.com:acme/acme-dev.git";

    test("a full declared block round-trips through a store", async () => {
      const repoPath = tmpRepoWithRemote("rtcfg-roundtrip-", REMOTE);
      const declared = {
        onDeck: 2,
        namePool: ["web", "bellatrix"],
        root: "/absolute/path/to/acme",
        branchFormat: "<ticket>",
        ready: [
          { run: "pnpm genTypes", when: "changed:db/schema/**" },
        ],
      };
      writeStore(machineSettingsPath(), { repos: { [IDENTITY]: { "rt.worktrees": declared } } });

      const cfg = await loadWorktreeRepoConfig("acme-dev", repoPath);
      expect(cfg).toEqual(declared);
    });

    test("the deep-merge proof case: team onDeck/ready + user namePool + machine root/branchFormat", async () => {
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
      // machine: the strongest rung — restates onDeck, adds root/branchFormat
      writeStore(machineSettingsPath(), {
        repos: {
          [IDENTITY]: {
            "rt.worktrees": { onDeck: 1, root: "/machine/wt-root", branchFormat: "<ticket>" },
          },
        },
      });

      const cfg = await loadWorktreeRepoConfig("acme-dev", repoPath);

      expect(cfg).toEqual({
        onDeck: 1, // machine beats team
        namePool: ["web", "bellatrix"], // user-only field
        root: "/machine/wt-root", // machine-only field
        branchFormat: "<ticket>", // machine-only field
        ready: [{ run: "pnpm install", when: "changed:pnpm-lock.yaml" }], // team-only field
      });
    });

    test("a store-only repo resolves with no store section at all", async () => {
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

    test("a machine-store absolute root is left unchanged", async () => {
      const repoPath = tmpRepoWithRemote("rtcfg-abs-", REMOTE);
      writeStore(machineSettingsPath(), {
        repos: { [IDENTITY]: { "rt.worktrees": { root: "/absolute/wt-root" } } },
      });

      const cfg = await loadWorktreeRepoConfig("acme-dev", repoPath);
      expect(cfg.root).toBe("/absolute/wt-root");
    });

    test("the namePool dot-filter applies to a store value", async () => {
      // A pool entry named ".trash-x" would build a tree the reconciler's reap
      // duty then deletes as a leftover. The reaper is the only rm -rf in the
      // codebase; this is the door it can come through.
      const repoPath = tmpRepoWithRemote("rtcfg-dotstore-", REMOTE);
      writeStore(userSettingsPath(), {
        repos: { [IDENTITY]: { "rt.worktrees": { namePool: [".trash-x", "luna"] } } },
      });

      const cfg = await loadWorktreeRepoConfig("acme-dev", repoPath);
      expect(cfg.namePool).toEqual(["luna"]);
    });

    test("a repo with no derivable identity honestly degrades to pure defaults", async () => {
      // Not a git repo at all: deriveRepoIdentity resolves null, so the
      // store's repo section — declared for a DIFFERENT identity here to
      // prove it can never leak in — is simply unreachable. No legacy
      // fallback exists anymore; defaults are the honest answer.
      const repoPath = tmpRepoPath("rtcfg-noident-");
      writeStore(teamSettingsPath("acme"), {
        repos: { [IDENTITY]: { "rt.worktrees": { onDeck: 9 } } },
      });

      const cfg = await loadWorktreeRepoConfig("acme-dev", repoPath);
      expect(cfg).toEqual({
        onDeck: 0,
        root: join(repoPath, ".worktrees"),
        branchFormat: "<ticket>-<slug>",
        ready: [],
      });
    });
  });

  describe("worktreeSettingsDeclared", () => {
    const IDENTITY = "gitlab.com/acme/store-only";
    const REMOTE = "git@gitlab.com:acme/store-only.git";

    test("nothing authored anywhere -> false (the registry default does not count)", async () => {
      const repoPath = tmpRepoWithRemote("rtcfg-act-none-", REMOTE);
      expect(await worktreeSettingsDeclared("store-only", repoPath)).toBe(false);
    });

    test("a team store section -> true", async () => {
      const repoPath = tmpRepoWithRemote("rtcfg-act-store-", REMOTE);
      writeStore(teamSettingsPath("acme"), {
        repos: { [IDENTITY]: { "rt.worktrees": { onDeck: 2 } } },
      });
      expect(await worktreeSettingsDeclared("store-only", repoPath)).toBe(true);
    });

    test("an EMPTY declared block still counts as declared", async () => {
      const repoPath = tmpRepoWithRemote("rtcfg-act-empty-", REMOTE);
      writeStore(teamSettingsPath("acme"), {
        repos: { [IDENTITY]: { "rt.worktrees": {} } },
      });
      expect(await worktreeSettingsDeclared("store-only", repoPath)).toBe(true);
    });

    test("a repo section with other keys but no worktrees block -> false", async () => {
      const repoPath = tmpRepoWithRemote("rtcfg-act-other-", REMOTE);
      writeStore(teamSettingsPath("acme"), {
        repos: { [IDENTITY]: { "rt.roles": { web: { pool: [3000] } } } },
      });
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
    test("neither file nor store: defaults", () => {
      expect(loadWorktreeAppConfig()).toEqual({ enabled: true, killProcesses: true });
    });

    test("file only (store unowned): seeds from parking-lot.json once, then reads the new file thereafter", () => {
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

    test("store only: store field-bag wins, per-field defaults applied", () => {
      writeStore(machineSettingsPath(), { "rt.worktreeApp": { killProcesses: false } });

      expect(loadWorktreeAppConfig()).toEqual({ enabled: true, killProcesses: false });
    });

    test("store and file both present: store wins per-field, file is never consulted", () => {
      mkdirSync(rtDir(), { recursive: true });
      writeJson(join(rtDir(), "worktrees.json"), { enabled: false, killProcesses: false });
      writeStore(machineSettingsPath(), { "rt.worktreeApp": { enabled: false } });

      expect(loadWorktreeAppConfig()).toEqual({ enabled: false, killProcesses: true });
    });

    test("malformed store probe (unregistered/invalid value) degrades to unowned — file stays authoritative", () => {
      mkdirSync(rtDir(), { recursive: true });
      writeJson(join(rtDir(), "worktrees.json"), { enabled: false, killProcesses: true });
      // An array is the wrong top-level type for an "object" key — the resolver
      // rejects this scope's value, so the key resolves as unowned.
      writeStore(machineSettingsPath(), { "rt.worktreeApp": ["nope"] });

      expect(loadWorktreeAppConfig()).toEqual({ enabled: false, killProcesses: true });
    });
  });
});
