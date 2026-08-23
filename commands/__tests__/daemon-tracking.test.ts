/**
 * manageTracking's off-branch — CLI wiring (the rider, RT-50).
 *
 * `lib/daemon-config.ts`'s RT_DIR is a MODULE-LOAD-TIME constant (frozen to
 * whatever HOME was active the first time that module was imported in this
 * process), and the repo-index store's `getStateDb()` singleton binds to
 * ambient HOME the same way (first call in the process, no per-test repoint
 * here) — so `readRepoIndex()` in commands/daemon.ts does NOT follow a
 * per-test HOME repoint the way the settings stores do. Rather than fight
 * that, this test drives manageTracking through its real seams as they
 * actually exist: the repo-index store (ns='repo-index') under the (ambient,
 * process-wide) state.db, and the settings stores under the (same,
 * dynamically-resolved) HOME. Nothing is mocked — console.log is captured
 * only to keep the run quiet. Every fixture is written with a name unique to
 * this file and precisely restored in afterEach, since the ambient HOME is
 * shared with every other test file in this process that doesn't repoint it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { machineSettingsPath, teamSettingsPath } from "../../lib/rt-paths.ts";
import { getSetting } from "../../lib/settings/resolve.ts";
import { deleteKvValue, getKvValue, setKvValue } from "../../lib/state/index.ts";
import { manageTracking } from "../daemon.ts";

const REPO_NAME = "rt-rider-cli-wiring-repo";
const TEAM_NAME = "rt-rider-cli-wiring-team";
const IDENTITY = `rttest/${REPO_NAME}`;
const REPO_INDEX_NS = "repo-index";

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
  let priorRepoIndexEntry: string | null;
  let priorTeamStore: string | null;
  let priorMachineStore: string | null;
  let repoPath: string;

  beforeEach(() => {
    console.log = () => {};

    priorRepoIndexEntry = getKvValue<string | null>(REPO_INDEX_NS, REPO_NAME, null);
    priorTeamStore = readOrNull(teamSettingsPath(TEAM_NAME));
    priorMachineStore = readOrNull(machineSettingsPath());

    // A real git repo with a fake-but-normalizable remote — identity derives
    // directly (`rttest/${REPO_NAME}`), no override plumbing needed.
    repoPath = realpathSync(mkdtempSync(join(tmpdir(), "rt-rider-cli-repo-")));
    execSync("git init -q", { cwd: repoPath });
    execSync(`git remote add origin git@rttest:${REPO_NAME}.git`, { cwd: repoPath });

    setKvValue(REPO_INDEX_NS, REPO_NAME, repoPath);

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
    if (priorRepoIndexEntry === null) deleteKvValue(REPO_INDEX_NS, REPO_NAME);
    else setKvValue(REPO_INDEX_NS, REPO_NAME, priorRepoIndexEntry);
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
