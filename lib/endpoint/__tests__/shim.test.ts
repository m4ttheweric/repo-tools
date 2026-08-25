import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { execSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { machineSettingsPath, rtDir, teamSettingsPath, userSettingsPath } from "../../rt-paths.ts";
import { closeStateDb, getStateDb, setKvValue } from "../../state/index.ts";
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
  for (const [repoName, repoPath] of Object.entries(index)) {
    setKvValue("repo-index", repoName, repoPath);
  }
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

// ─── intercepts cache round-trip (RT-50 collapse) ─────────────────────────────

test("interceptsPath points at the retired intercepts.json location under rtDir", () => {
  expect(interceptsPath()).toBe(join(rtDir(), "intercepts.json"));
});

test("writeInterceptRules + loadInterceptRules round-trip through the store", () => {
  writeInterceptRules(rules);
  expect(loadInterceptRules()).toEqual(rules);
});

test("a pre-existing intercepts.json is imported on first read and renamed to .migrated", () => {
  const dir = mkdtempSync(join(tmpdir(), "shim-test-stale-home-"));
  const origHome = process.env.HOME;
  process.env.HOME = dir;
  closeStateDb();
  try {
    mkdirSync(rtDir(), { recursive: true });
    const legacyRules: InterceptRule[] = [{ command: "stale-cmd", repo: "r", repoRemote: null, matches: [] }];
    writeFileSync(interceptsPath(), JSON.stringify({ rules: legacyRules }));
    expect(existsSync(interceptsPath())).toBe(true);

    // First read imports the legacy file's rules into the store.
    expect(loadInterceptRules()).toEqual(legacyRules);
    expect(existsSync(interceptsPath())).toBe(false);
    expect(existsSync(`${interceptsPath()}.migrated`)).toBe(true);

    // A later explicit write still overwrites the imported value.
    writeInterceptRules(rules);
    expect(loadInterceptRules()).toEqual(rules);
  } finally {
    process.env.HOME = origHome;
    closeStateDb();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupt intercepts.json warns and is left in place; loadInterceptRules reads as empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "shim-test-corrupt-home-"));
  const origHome = process.env.HOME;
  const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  process.env.HOME = dir;
  closeStateDb();
  try {
    mkdirSync(rtDir(), { recursive: true });
    writeFileSync(interceptsPath(), "{ not valid json");

    expect(loadInterceptRules()).toEqual([]);
    expect(existsSync(interceptsPath())).toBe(true);
    expect(existsSync(`${interceptsPath()}.migrated`)).toBe(false);
    expect(warnSpy).toHaveBeenCalled();
  } finally {
    warnSpy.mockRestore();
    process.env.HOME = origHome;
    closeStateDb();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadInterceptRules degrades to [] on a missing or malformed store row", () => {
  const dir = mkdtempSync(join(tmpdir(), "shim-test-home-"));
  const origHome = process.env.HOME;
  process.env.HOME = dir;
  closeStateDb();
  try {
    expect(loadInterceptRules()).toEqual([]);
    // Raw corrupt JSON in the row — same shape kv-blob's own tests use.
    getStateDb().query("INSERT INTO kv (ns, k, v, updated_at) VALUES ('intercepts', 'rules', '{not json', 0);").run();
    expect(loadInterceptRules()).toEqual([]);
    // Well-shaped row, malformed entries sanitized.
    setKvValue("intercepts", "rules", { rules: [{ command: "ok", repo: "r" }, { repo: "missing-command" }, "garbage"], generatedAt: Date.now() });
    expect(loadInterceptRules()).toEqual([{ command: "ok", repo: "r", repoRemote: null, matches: [] }]);
  } finally {
    process.env.HOME = origHome;
    closeStateDb();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── buildInterceptRules ─────────────────────────────────────────────────────

describe("buildInterceptRules", () => {
  const origHome = process.env.HOME;
  let home: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-shim-build-")));
    process.env.HOME = home;
    closeStateDb();
  });

  afterEach(() => {
    process.env.HOME = origHome;
    closeStateDb();
    rmSync(home, { recursive: true, force: true });
  });

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
    // rule.repo carries the identity DERIVED from the repo's remote (the
    // endpoint:claim payload key), never the raw index key.
    const byRepo = Object.fromEntries(built.map((r) => [r.repo, r]));
    expect(byRepo["remote:x%2Facme%2Facme-dev"]!.command).toBe("doppler");
    expect(byRepo["remote:x%2Facme%2Facme-dev"]!.repoRemote).toBe("git@x:acme/acme-dev.git");
    expect(byRepo["remote:x%2Facme%2Fempty-repo"]).toBeUndefined();
    expect(byRepo["r-no-remote"]).toBeUndefined();
  });

  test("a repo whose intercepts live in a settings store still gets a rule (remote captured before the resolver is consulted)", async () => {
    const repoPath = makeGitRepo("git@gitlab.com:fake/store-repo.git");
    writeRepoIndex({ "r-store": repoPath });
    writeRepoIntercepts("gitlab.com/fake/store-repo", [{ command: "storecmd", matches: [{ cwdGlob: ".", role: "web" }] }]);

    const built = await buildInterceptRules();
    expect(built).toEqual([{
      command: "storecmd",
      repo: "remote:gitlab.com%2Ffake%2Fstore-repo",
      repoRemote: "git@gitlab.com:fake/store-repo.git",
      matches: [{ cwdGlob: ".", role: "web" }],
    }]);
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
  const origHome = process.env.HOME;
  let home: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-shim-install-")));
    process.env.HOME = home;
    closeStateDb();
  });

  afterEach(() => {
    process.env.HOME = origHome;
    closeStateDb();
    rmSync(home, { recursive: true, force: true });
  });

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
    expect(report).toEqual([{ command: "fakecmd-a", repo: "remote:x%2Facme%2Fr-install", installed: true, current: true }]);

    const removed = uninstallShims();
    expect(removed.removed).toEqual(["fakecmd-a"]);
    expect(existsSync(shimPath("fakecmd-a"))).toBe(false);
    expect(existsSync(untouchedPath)).toBe(true);
  });

  test("installShims never clobbers a pre-existing file at the shim path that isn't ours — reports it skipped instead (F8: this now runs unattended behind Install)", async () => {
    const repoPath = makeGitRepo("git@x:acme/r-occupied.git");
    writeRepoIntercepts("x/acme/r-occupied", [{ command: "fakecmd-occupied", matches: [{ cwdGlob: ".", role: "x" }] }]);
    writeRepoIndex({ "r-occupied": repoPath });

    const userScript = "#!/bin/sh\necho this is MY wrapper, not rt's\n";
    mkdirSync(dirname(shimPath("fakecmd-occupied")), { recursive: true });
    writeFileSync(shimPath("fakecmd-occupied"), userScript);

    const result = await installShims();
    expect(result.installed).toEqual([]);
    expect(result.current).toEqual([]);
    expect(result.skipped).toEqual(["fakecmd-occupied"]);
    expect(readFileSync(shimPath("fakecmd-occupied"), "utf8")).toBe(userScript); // untouched
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
    expect(shimReport()).toContainEqual({ command: "fakecmd-transition", repo: "remote:x%2Facme%2Fr-transition", installed: false, current: false });

    // installed → current
    await installShims();
    expect(shimReport()).toContainEqual({ command: "fakecmd-transition", repo: "remote:x%2Facme%2Fr-transition", installed: true, current: true });

    // shim content drifts from the rendered form → installed but stale
    const path = shimPath("fakecmd-transition");
    writeFileSync(path, readFileSync(path, "utf8") + "\n");
    expect(shimReport()).toContainEqual({ command: "fakecmd-transition", repo: "remote:x%2Facme%2Fr-transition", installed: true, current: false });
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
    closeStateDb();
  });

  afterEach(() => {
    process.env.HOME = origHome;
    closeStateDb();
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

  /** The intercepts cache holding one rule for `repo`, stamped at T0. */
  function writeCache(repo: string): void {
    setKvValue("intercepts", "rules", {
      rules: [{ command: "c", repo, repoRemote: null, matches: [] }],
      generatedAt: T0.getTime(),
    });
  }

  test("no cache at all is not stale (there is nothing to be stale)", () => {
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

  test("a legacy intercepts.json (no store row yet) is imported by the probe itself, and a newer store still reports stale — not the pre-fix {stale:false} on a null cache", () => {
    writeAt(interceptsPath(), JSON.stringify({ rules: [{ command: "c", repo: "r", repoRemote: null, matches: [] }] }), T0);
    writeAt(userSettingsPath(), "{}", NEWER);

    const probe = staleIntercepts();
    expect(probe.stale).toBe(true);
    expect(existsSync(interceptsPath())).toBe(false); // imported and renamed as a side effect of the probe
  });
});
