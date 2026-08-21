/**
 * manageTracking's off-branch — CLI wiring (the rider, RT-50).
 *
 * `lib/daemon-config.ts`'s RT_DIR is a MODULE-LOAD-TIME constant (frozen to
 * whatever HOME was active the first time that module was imported in this
 * process), so `readRepoIndex()` in commands/daemon.ts does NOT follow a
 * per-test HOME repoint the way the settings stores do. Rather than fight
 * that, this test drives manageTracking through its real seams as they
 * actually exist: repos.json under the (ambient, process-wide) RT_DIR, and
 * the settings stores under the (same, dynamically-resolved) HOME. Nothing
 * is mocked — console.log is captured only to keep the run quiet. Every
 * fixture is written with a name unique to this file and precisely restored
 * in afterEach, since the ambient HOME is shared with every other test file
 * in this process that doesn't repoint it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { RT_DIR } from "../../lib/daemon-config.ts";
import { machineSettingsPath, teamSettingsPath } from "../../lib/rt-paths.ts";
import { getSetting } from "../../lib/settings/resolve.ts";
import { manageTracking } from "../daemon.ts";

const REPO_NAME = "rt-rider-cli-wiring-repo";
const TEAM_NAME = "rt-rider-cli-wiring-team";
const IDENTITY = `rttest/${REPO_NAME}`;
const REPOS_JSON_PATH = join(RT_DIR, "repos.json");

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Restores `path` to its prior content, or removes it if it didn't exist before. */
function restore(path: string, prior: string | null): void {
  if (prior === null) {
    try { rmSync(path, { force: true }); } catch { /* already gone */ }
  } else {
    writeFileSync(path, prior);
  }
}

describe("manageTracking off-branch (CLI wiring)", () => {
  const origLog = console.log;
  let priorReposJson: string | null;
  let priorTeamStore: string | null;
  let priorMachineStore: string | null;
  let repoPath: string;

  beforeEach(() => {
    console.log = () => {};

    priorReposJson = readOrNull(REPOS_JSON_PATH);
    priorTeamStore = readOrNull(teamSettingsPath(TEAM_NAME));
    priorMachineStore = readOrNull(machineSettingsPath());

    // A real git repo with a fake-but-normalizable remote — identity derives
    // directly (`rttest/${REPO_NAME}`), no override plumbing needed.
    repoPath = realpathSync(mkdtempSync(join(tmpdir(), "rt-rider-cli-repo-")));
    execSync("git init -q", { cwd: repoPath });
    execSync(`git remote add origin git@rttest:${REPO_NAME}.git`, { cwd: repoPath });

    mkdirSync(RT_DIR, { recursive: true });
    const repos = priorReposJson ? JSON.parse(priorReposJson) : {};
    repos[REPO_NAME] = repoPath;
    writeFileSync(REPOS_JSON_PATH, JSON.stringify(repos));

    // Team intent still declares this repo — mattstack.tracking's VALUE has
    // its own "repos" field (identity → intent); it is not the store file's
    // top-level repo-section sharding (that's for repo-scoped setting keys).
    const teamStore = teamSettingsPath(TEAM_NAME);
    mkdirSync(dirname(teamStore), { recursive: true });
    writeFileSync(teamStore, JSON.stringify({
      "mattstack.tracking": { repos: { [IDENTITY]: { caches: ["branches"] } } },
    }));

    // An existing machine grant for it, as if it had been tracked already.
    const machineStore = machineSettingsPath();
    mkdirSync(dirname(machineStore), { recursive: true });
    const machine = priorMachineStore ? JSON.parse(priorMachineStore) : {};
    machine["rt.repoTracking"] = {
      ...(machine["rt.repoTracking"] ?? {}),
      [REPO_NAME]: { mode: "live", caches: ["branches"] },
    };
    writeFileSync(machineStore, JSON.stringify(machine));
  });

  afterEach(() => {
    console.log = origLog;
    rmSync(repoPath, { recursive: true, force: true });
    restore(REPOS_JSON_PATH, priorReposJson);
    restore(teamSettingsPath(TEAM_NAME), priorTeamStore);
    restore(machineSettingsPath(), priorMachineStore);
  });

  test("off on a team-tracked repo plants an explicit {mode:\"off\"} marker, not a delete", async () => {
    await manageTracking([REPO_NAME, "off"]);

    const saved = getSetting<Record<string, unknown>>("rt.repoTracking").value;
    expect(saved[REPO_NAME]).toEqual({ mode: "off" });
  });

  test("off on a repo the team no longer names deletes outright", async () => {
    writeFileSync(teamSettingsPath(TEAM_NAME), JSON.stringify({ "mattstack.tracking": { repos: {} } }));

    await manageTracking([REPO_NAME, "off"]);

    const saved = getSetting<Record<string, unknown>>("rt.repoTracking").value;
    expect(saved[REPO_NAME]).toBeUndefined();
  });
});
