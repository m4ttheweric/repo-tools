import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { syncBranch } from "../sync.ts";
import type { StackGuardRunners } from "../../lib/stack-guard.ts";

let tmpRoot: string;
let savedSyncLogPath: string | undefined;

beforeEach(() => {
  tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "rt-sync-guard-")));
  savedSyncLogPath = process.env.RT_SYNC_LOG_PATH;
  process.env.RT_SYNC_LOG_PATH = join(tmpRoot, "sync.log");
});

afterEach(() => {
  if (savedSyncLogPath === undefined) delete process.env.RT_SYNC_LOG_PATH;
  else process.env.RT_SYNC_LOG_PATH = savedSyncLogPath;
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
});

const GIT = "git -c user.email=t@t -c user.name=t";
function sh(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: "pipe", encoding: "utf8" }).trim();
}

/**
 * A clone on `feature` whose origin/master has moved on since the last
 * fetch: the local ref still points at the base commit, so a fetch is
 * observable as origin/master changing.
 */
function makeStaleClone(): { clone: string; base: string; tip: string } {
  const origin = join(tmpRoot, "origin.git");
  const seed = join(tmpRoot, "seed");
  execSync(`git init -q --bare -b master "${origin}"`);
  execSync(`git init -q -b master "${seed}"`);
  writeFileSync(join(seed, "a.txt"), "base\n");
  sh(`${GIT} add . && ${GIT} commit -qm base`, seed);
  sh(`git remote add origin "${origin}" && git push -q origin master`, seed);
  const base = sh("git rev-parse HEAD", seed);

  const clone = join(tmpRoot, "clone");
  execSync(`git clone -q "${origin}" "${clone}"`);
  sh(`${GIT} checkout -qb feature`, clone);
  writeFileSync(join(clone, "f.txt"), "feature\n");
  sh(`${GIT} add . && ${GIT} commit -qm feature && git push -q -u origin feature`, clone);

  writeFileSync(join(seed, "a.txt"), "moved\n");
  sh(`${GIT} commit -qam moved && git push -q origin master`, seed);
  const tip = sh("git rev-parse HEAD", seed);
  return { clone, base, tip };
}

const gitqMember: StackGuardRunners = {
  gitqStacks: async () => JSON.stringify({ stacks: [{ stackName: "s1", root: "master", nodes: [{ branch: "feature", parent: "master" }] }] }),
  forgeOpenMrs: async () => ({ ok: true, mrs: [] }),
};

const forgeDown: StackGuardRunners = {
  gitqStacks: async () => null,
  forgeOpenMrs: async () => ({ ok: false, error: "gh: not logged in" }),
};

describe("syncBranch stack guard", () => {
  test("a gitq stack member is refused before fetch, reset, or rebase", async () => {
    const { clone, base } = makeStaleClone();
    const head = sh("git rev-parse HEAD", clone);

    const summary = await syncBranch(clone, { quiet: true, stackRunners: gitqMember, strictStackCheck: true });

    expect(summary.refusal?.kind).toBe("stack-refusal");
    expect(summary.error).toContain("s1");
    expect(sh("git rev-parse origin/master", clone)).toBe(base);
    expect(sh("git rev-parse HEAD", clone)).toBe(head);
    expect(summary.rebaseResult).toBeNull();
  });

  test("forge unavailable under strict mode is refused as unverifiable, still before fetch", async () => {
    const { clone, base } = makeStaleClone();

    const summary = await syncBranch(clone, { quiet: true, stackRunners: forgeDown, strictStackCheck: true });

    expect(summary.refusal?.kind).toBe("stack-check-unavailable");
    expect(sh("git rev-parse origin/master", clone)).toBe(base);
  });

  test("forge unavailable under lenient mode proceeds with the sync", async () => {
    const { clone, tip } = makeStaleClone();

    const summary = await syncBranch(clone, { quiet: true, dryRun: true, stackRunners: forgeDown, strictStackCheck: false });

    expect(summary.refusal).toBeUndefined();
    expect(summary.error).toBeUndefined();
    expect(sh("git rev-parse origin/master", clone)).toBe(tip);
  });
});
