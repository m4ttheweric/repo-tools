import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { machineSettingsPath, rtDir, teamSettingsPath, userSettingsPath } from "../../rt-paths.ts";
import {
  buildInterceptRules,
  installShims,
  interceptsPath,
  loadInterceptRules,
  matchInvocation,
  renderInterceptShim,
  shimPath,
  shimReport,
  staleIntercepts,
  uninstallShims,
  writeInterceptRules,
  type InterceptRule,
} from "../shim.ts";

function writeStore(file: string, obj: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(obj));
}

/** Seeds `rt.intercepts` for `identity` in the team store — the store-only path every rule now goes through. */
function writeRepoIntercepts(identity: string, intercepts: unknown): void {
  writeStore(teamSettingsPath("acme"), { repos: { [identity]: { "rt.intercepts": intercepts } } });
}

function writeRepoIndex(index: Record<string, string>): void {
  mkdirSync(rtDir(), { recursive: true });
  writeFileSync(join(rtDir(), "repos.json"), JSON.stringify(index));
}

/** A throwaway git repo, optionally with `origin` configured, for repoRemote capture. */
function makeGitRepo(remote: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), "shim-test-repo-"));
  execSync("git init -q", { cwd: dir });
  if (remote) execSync(`git remote add origin ${remote}`, { cwd: dir });
  return dir;
}

// ─── renderInterceptShim ──────────────────────────────────────────────────────

test("renderInterceptShim is a sh exec into rt intercept run — no bypass line (handled in Task 7)", () => {
  const s = renderInterceptShim("doppler");
  expect(s.startsWith("#!/bin/sh\n")).toBe(true);
  expect(s).toContain("# rt intercept shim — generated; do not edit (rt intercept install)");
  expect(s).toContain('exec rt intercept run doppler -- "$@"');
  expect(s).not.toContain("RT_INTERCEPT_BYPASS");
  expect(s.endsWith("\n")).toBe(true);
});

test("renderInterceptShim is stable for the same command (idempotent render)", () => {
  expect(renderInterceptShim("pnpm")).toBe(renderInterceptShim("pnpm"));
});

test("renderInterceptShim refuses to render an unsafe command name (gated through shimPath)", () => {
  expect(() => renderInterceptShim("x;y")).toThrow();
});

// ─── shimPath ──────────────────────────────────────────────────────────────

test("shimPath refuses the rt name and path separators", () => {
  expect(() => shimPath("rt")).toThrow();
  expect(() => shimPath("a/b")).toThrow();
  expect(shimPath("doppler").endsWith("/.local/bin/doppler")).toBe(true);
});

test("shimPath refuses whitespace and shell metacharacters (no unescaped splice into the shim)", () => {
  for (const bad of ["a b", "x;y", "$(x)", "`x`", "x|y", "x&y", "x>y", "x<y", "x\ny"]) {
    expect(() => shimPath(bad)).toThrow();
  }
});

test("shimPath refuses empty and dot-segment names", () => {
  for (const bad of ["", ".", ".."]) {
    expect(() => shimPath(bad)).toThrow();
  }
});

// ─── matchInvocation ─────────────────────────────────────────────────────────

const rules: InterceptRule[] = [{
  command: "doppler", repo: "acme-dev", repoRemote: "git@x:acme/acme-dev.git",
  matches: [{ cwdGlob: "apps/backend{,/**}", argPattern: "src/app/server", role: "backend" }],
}];

describe("matchInvocation", () => {
  const base = { command: "doppler", args: ["run", "--", "bun", "src/app/server.ts"], cwd: "/wt/a/apps/backend", toplevel: "/wt/a", remote: "git@x:acme/acme-dev.git" };
  test("hits on cwdGlob + argPattern + remote", () => {
    expect(matchInvocation(rules, base)?.match.role).toBe("backend");
  });
  test("misses on wrong remote, no toplevel, wrong dir, non-matching args, unknown command", () => {
    expect(matchInvocation(rules, { ...base, remote: "git@x:other/repo.git" })).toBeNull();
    expect(matchInvocation(rules, { ...base, toplevel: null })).toBeNull();
    expect(matchInvocation(rules, { ...base, cwd: "/wt/a/apps/portal" })).toBeNull();
    expect(matchInvocation(rules, { ...base, args: ["run", "--", "jest"] })).toBeNull();
    expect(matchInvocation(rules, { ...base, command: "pnpm" })).toBeNull();
  });
  test("null repoRemote in the rule skips the remote check (repo never had one recorded)", () => {
    expect(matchInvocation([{ ...rules[0]!, repoRemote: null }], { ...base, remote: null })?.match.role).toBe("backend");
  });
  test("cwd equal to toplevel normalizes '' to '.' for the glob", () => {
    const dotRules: InterceptRule[] = [{ command: "doppler", repo: "r", repoRemote: null, matches: [{ cwdGlob: ".", role: "root" }] }];
    expect(matchInvocation(dotRules, { command: "doppler", args: [], cwd: "/wt/a", toplevel: "/wt/a", remote: null })?.match.role).toBe("root");
  });
  test("malformed argPattern on a match is skipped, not thrown", () => {
    const badRules: InterceptRule[] = [{ command: "doppler", repo: "r", repoRemote: null, matches: [{ cwdGlob: ".", argPattern: "(", role: "bad" }] }];
    expect(() => matchInvocation(badRules, { command: "doppler", args: ["x"], cwd: "/wt/a", toplevel: "/wt/a", remote: null })).not.toThrow();
    expect(matchInvocation(badRules, { command: "doppler", args: ["x"], cwd: "/wt/a", toplevel: "/wt/a", remote: null })).toBeNull();
  });
});

// ─── intercepts.json round-trip ───────────────────────────────────────────────

test("interceptsPath points at intercepts.json under rtDir", () => {
  expect(interceptsPath()).toBe(join(rtDir(), "intercepts.json"));
});

test("writeInterceptRules + loadInterceptRules round-trip", () => {
  writeInterceptRules(rules);
  expect(existsSync(interceptsPath())).toBe(true);
  expect(loadInterceptRules()).toEqual(rules);
});

test("loadInterceptRules degrades to [] on a missing or malformed file", () => {
  const dir = mkdtempSync(join(tmpdir(), "shim-test-home-"));
  const origHome = process.env.HOME;
  process.env.HOME = dir;
  try {
    expect(loadInterceptRules()).toEqual([]);
    mkdirSync(rtDir(), { recursive: true });
    writeFileSync(interceptsPath(), "not json");
    expect(loadInterceptRules()).toEqual([]);
    writeFileSync(interceptsPath(), JSON.stringify({ rules: [{ command: "ok", repo: "r" }, { repo: "missing-command" }, "garbage"] }));
    expect(loadInterceptRules()).toEqual([{ command: "ok", repo: "r", repoRemote: null, matches: [] }]);
  } finally {
    process.env.HOME = origHome;
  }
});

// ─── buildInterceptRules ─────────────────────────────────────────────────────

describe("buildInterceptRules", () => {
  test("flattens repo index x per-repo intercepts, skips repos with none or no derivable identity, captures repoRemote", async () => {
    const repoWithRemote = makeGitRepo("git@x:acme/acme-dev.git");
    const repoEmptyRemote = makeGitRepo("git@x:acme/empty-repo.git");
    const repoNoRemote = makeGitRepo(null);
    writeRepoIntercepts("x/acme/acme-dev", [
      { command: "doppler", matches: [{ cwdGlob: "apps/backend{,/**}", role: "backend" }] },
    ]);
    writeRepoIndex({ "r-with": repoWithRemote, "r-without": repoEmptyRemote, "r-no-remote": repoNoRemote });

    const built = await buildInterceptRules();
    expect(built).toHaveLength(1);
    const byRepo = Object.fromEntries(built.map((r) => [r.repo, r]));
    expect(byRepo["r-with"]!.command).toBe("doppler");
    expect(byRepo["r-with"]!.repoRemote).toBe("git@x:acme/acme-dev.git");
    expect(byRepo["r-without"]).toBeUndefined();
    // No remote → no derivable identity → repo-scoped intercepts unreachable.
    expect(byRepo["r-no-remote"]).toBeUndefined();
  });

  test("a repo whose intercepts live in a settings store still gets a rule (remote captured before the resolver is consulted)", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "rt-shim-store-")));
    const origHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const repoPath = makeGitRepo("git@gitlab.com:fake/store-repo.git");
      writeRepoIndex({ "r-store": repoPath });
      const store = teamSettingsPath("acme");
      mkdirSync(dirname(store), { recursive: true });
      writeFileSync(store, JSON.stringify({
        repos: {
          "gitlab.com/fake/store-repo": {
            "rt.intercepts": [{ command: "storecmd", matches: [{ cwdGlob: ".", role: "web" }] }],
          },
        },
      }));

      const built = await buildInterceptRules();
      expect(built).toEqual([{
        command: "storecmd",
        repo: "r-store",
        repoRemote: "git@gitlab.com:fake/store-repo.git",
        matches: [{ cwdGlob: ".", role: "web" }],
      }]);
    } finally {
      process.env.HOME = origHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("multiple intercept entries in one repo produce one rule each", async () => {
    const repoPath = makeGitRepo("git@x:acme/multi-repo.git");
    writeRepoIntercepts("x/acme/multi-repo", [
      { command: "doppler", matches: [{ cwdGlob: ".", role: "a" }] },
      { command: "pnpm", matches: [{ cwdGlob: ".", role: "b" }] },
    ]);
    writeRepoIndex({ "r-multi": repoPath });
    const built = await buildInterceptRules();
    expect(built.map((r) => r.command).sort()).toEqual(["doppler", "pnpm"]);
  });
});

// ─── installShims / uninstallShims / shimReport ──────────────────────────────

describe("installShims / uninstallShims / shimReport", () => {
  test("installs a shim per distinct command, classifies installed vs current, uninstall removes only marker files", async () => {
    const repoPath = makeGitRepo("git@x:acme/r-install.git");
    writeRepoIntercepts("x/acme/r-install", [{ command: "fakecmd-a", matches: [{ cwdGlob: ".", role: "x" }] }]);
    writeRepoIndex({ "r-install": repoPath });

    const first = await installShims();
    expect(first.installed).toEqual(["fakecmd-a"]);
    expect(first.current).toEqual([]);
    expect(first.rules).toBe(1);
    expect(readFileSync(shimPath("fakecmd-a"), "utf8")).toBe(renderInterceptShim("fakecmd-a"));

    const second = await installShims();
    expect(second.installed).toEqual([]);
    expect(second.current).toEqual(["fakecmd-a"]);

    // A hand-written file with no marker in the same dir must survive uninstall.
    const untouchedPath = join(join(shimPath("fakecmd-a"), "..") , "not-a-shim");
    writeFileSync(untouchedPath, "#!/bin/sh\necho hi\n");

    const report = shimReport();
    expect(report).toEqual([{ command: "fakecmd-a", repo: "r-install", installed: true, current: true }]);

    const removed = uninstallShims();
    expect(removed.removed).toEqual(["fakecmd-a"]);
    expect(existsSync(shimPath("fakecmd-a"))).toBe(false);
    expect(existsSync(untouchedPath)).toBe(true);
  });

  test("re-install repairs a stripped exec bit even when the content is already current", async () => {
    const repoPath = makeGitRepo("git@x:acme/r-chmod.git");
    writeRepoIntercepts("x/acme/r-chmod", [{ command: "fakecmd-chmod", matches: [{ cwdGlob: ".", role: "x" }] }]);
    writeRepoIndex({ "r-chmod": repoPath });

    await installShims();
    const path = shimPath("fakecmd-chmod");
    expect(statSync(path).mode & 0o111).not.toBe(0);

    chmodSync(path, 0o644); // exec bit stripped by hand / a hostile umask
    expect(statSync(path).mode & 0o111).toBe(0);

    const again = await installShims();
    expect(again.current).toContain("fakecmd-chmod"); // content-equal path
    expect(statSync(path).mode & 0o111).not.toBe(0); // …and still repaired
  });

  test("shimReport reports installed:false, current:false for a rule command never installed", () => {
    writeInterceptRules([{ command: "never-installed", repo: "r", repoRemote: null, matches: [] }]);
    expect(shimReport()).toEqual([{ command: "never-installed", repo: "r", installed: false, current: false }]);
  });

  test("shimReport tracks the full installed/current transition (RT-28 verify check)", async () => {
    const repoPath = makeGitRepo("git@x:acme/r-transition.git");
    writeRepoIntercepts("x/acme/r-transition", [{ command: "fakecmd-transition", matches: [{ cwdGlob: ".", role: "x" }] }]);
    writeRepoIndex({ "r-transition": repoPath });

    const built = await buildInterceptRules();
    writeInterceptRules(built);

    // declared, nothing on disk yet
    expect(shimReport()).toContainEqual({ command: "fakecmd-transition", repo: "r-transition", installed: false, current: false });

    // installed → current
    await installShims();
    expect(shimReport()).toContainEqual({ command: "fakecmd-transition", repo: "r-transition", installed: true, current: true });

    // shim content drifts from the rendered form → installed but stale
    const path = shimPath("fakecmd-transition");
    writeFileSync(path, readFileSync(path, "utf8") + "\n");
    expect(shimReport()).toContainEqual({ command: "fakecmd-transition", repo: "r-transition", installed: true, current: false });
  });
});

// ─── staleIntercepts ─────────────────────────────────────────────────────────
//
// Its own fresh HOME per test: the probe compares real mtimes across the whole
// ~/.mattstack tree, so a store file another test in this file left behind
// would decide the answer. Every mtime is set EXPLICITLY with utimesSync —
// touching two files in the same tick gives them the same mtime on some
// filesystems, which would make "newer than" a coin flip.

describe("staleIntercepts", () => {
  const origHome = process.env.HOME;
  let home: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-stale-")));
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(home, { recursive: true, force: true });
  });

  const T0 = new Date(1_700_000_000_000);
  const NEWER = new Date(1_700_000_600_000);
  const OLDER = new Date(1_699_999_400_000);

  function writeAt(file: string, content: string, when: Date): void {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    utimesSync(file, when, when);
  }

  /** intercepts.json holding one rule for `repo`, stamped at T0. */
  function writeCache(repo: string): void {
    writeInterceptRules([{ command: "c", repo, repoRemote: null, matches: [] }]);
    utimesSync(interceptsPath(), T0, T0);
  }

  test("no cache file at all is not stale (there is nothing to be stale)", () => {
    expect(staleIntercepts()).toEqual({ stale: false });
  });

  test("every source older than the cache is not stale", () => {
    writeCache("r");
    writeAt(userSettingsPath(), "{}", OLDER);
    writeAt(machineSettingsPath(), "{}", OLDER);
    writeAt(teamSettingsPath("acme"), "{}", OLDER);
    expect(staleIntercepts()).toEqual({ stale: false });
  });

  test("a store file newer than the cache is stale and names the file", () => {
    writeCache("r");
    writeAt(userSettingsPath(), "{}", NEWER);
    const probe = staleIntercepts();
    expect(probe.stale).toBe(true);
    expect(probe.reason).toContain(userSettingsPath());
  });

  test("a team store newer than the cache is stale", () => {
    writeCache("r");
    writeAt(teamSettingsPath("acme"), "{}", NEWER);
    expect(staleIntercepts().stale).toBe(true);
  });
});
