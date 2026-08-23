import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { resetToOrigin } from "../reset.ts";

let tmpRoot: string;
let savedSyncLogPath: string | undefined;

beforeEach(() => {
  tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "rt-reset-")));
  // resetToOrigin logs every git command via syncLog; redirect it to a temp
  // file so these tests never append to the real ~/.mattstack/rt/sync.log.
  savedSyncLogPath = process.env.RT_SYNC_LOG_PATH;
  process.env.RT_SYNC_LOG_PATH = join(tmpRoot, "sync.log");
});

afterEach(() => {
  if (savedSyncLogPath === undefined) delete process.env.RT_SYNC_LOG_PATH;
  else process.env.RT_SYNC_LOG_PATH = savedSyncLogPath;
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
});

function sh(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
}

function commit(repo: string, file: string, content: string, msg: string): void {
  writeFileSync(join(repo, file), content);
  sh(`git add "${file}"`, repo);
  sh(`git -c user.email=t@t -c user.name=t commit -qm "${msg}"`, repo);
}

/**
 * Bare origin with master + a pushed `feature` branch, master then advancing
 * past the feature fork point, and a clone sitting on `feature`. The starting
 * point for every divergence scenario below.
 */
function makeFixture(): { origin: string; local: string } {
  const origin = join(tmpRoot, "origin.git");
  const seed = join(tmpRoot, "seed");
  const local = join(tmpRoot, "local");

  sh(`git init -q --bare "${origin}"`, tmpRoot);
  sh(`git init -q -b master "${seed}"`, tmpRoot);
  sh(`git remote add origin "${origin}"`, seed);
  commit(seed, "base.txt", "base", "base");
  commit(seed, "m1.txt", "m1", "master 1");
  sh(`git push -q origin master`, seed);

  sh(`git checkout -qb feature`, seed);
  commit(seed, "f1.txt", "f1", "feature 1");
  commit(seed, "f2.txt", "f2", "feature 2");
  sh(`git push -q origin feature`, seed);

  sh(`git checkout -q master`, seed);
  for (let i = 2; i <= 5; i++) commit(seed, `m${i}.txt`, `m${i}`, `master ${i}`);
  sh(`git push -q origin master`, seed);

  sh(`git clone -q "${origin}" "${local}"`, tmpRoot);
  sh(`git checkout -q feature`, local);
  return { origin, local };
}

/** Second clone used to rewrite the remote branch out from under `local`. */
function rewriteRemoteFeature(origin: string, mutate: (helper: string) => void): void {
  const helper = join(tmpRoot, `helper-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  sh(`git clone -q "${origin}" "${helper}"`, tmpRoot);
  sh(`git checkout -q feature`, helper);
  mutate(helper);
  sh(`git push -qf origin feature`, helper);
}

describe("resetToOrigin divergence direction", () => {
  test("local rebased onto newer master → local-newer, HEAD untouched", async () => {
    const { local } = makeFixture();
    sh(`git -c user.email=t@t -c user.name=t rebase -q origin/master`, local);
    const headBefore = sh(`git rev-parse HEAD`, local);

    const result = await resetToOrigin({ cwd: local, quiet: true, autoConfirm: true, skipFetch: true });

    expect(result.status).toBe("local-newer");
    expect(result.cherryPicked).toEqual([]);
    expect(result.backupBranch).toBeNull();
    expect(sh(`git rev-parse HEAD`, local)).toBe(headBefore);
  });

  test("remote rebased onto newer master → reset to remote", async () => {
    const { origin, local } = makeFixture();
    rewriteRemoteFeature(origin, (helper) => {
      sh(`git -c user.email=t@t -c user.name=t rebase -q origin/master`, helper);
    });
    sh(`git fetch -q origin`, local);

    const result = await resetToOrigin({ cwd: local, quiet: true, autoConfirm: true, skipFetch: true });

    expect(result.status).toBe("reset");
    expect(sh(`git rev-parse HEAD`, local)).toBe(sh(`git rev-parse origin/feature`, local));
  });

  test("remote rewritten on same base, extra local commit → reset + cherry-pick", async () => {
    const { origin, local } = makeFixture();
    rewriteRemoteFeature(origin, (helper) => {
      sh(`git -c user.email=t@t -c user.name=t commit -q --amend -m "feature 2 (reworded)"`, helper);
    });
    commit(local, "f3.txt", "f3", "feature 3 local only");
    sh(`git fetch -q origin`, local);

    const result = await resetToOrigin({ cwd: local, quiet: true, autoConfirm: true, skipFetch: true });

    expect(result.status).toBe("cherry-picked");
    expect(result.cherryPicked).toHaveLength(1);
    expect(result.backupBranch).toStartWith("rt-backup/reset/feature/");
    expect(sh(`git log -1 --format=%s`, local)).toBe("feature 3 local only");
    expect(sh(`git log -1 --format=%s HEAD~1`, local)).toBe("feature 2 (reworded)");
  });

  test("in sync → no-op", async () => {
    const { local } = makeFixture();
    const result = await resetToOrigin({ cwd: local, quiet: true, autoConfirm: true, skipFetch: true });
    expect(result.status).toBe("in-sync");
  });

  test("local behind remote → fast-forward", async () => {
    const { origin, local } = makeFixture();
    rewriteRemoteFeature(origin, (helper) => {
      commit(helper, "f3.txt", "f3", "feature 3");
    });
    sh(`git fetch -q origin`, local);

    const result = await resetToOrigin({ cwd: local, quiet: true, autoConfirm: true, skipFetch: true });

    expect(result.status).toBe("fast-forward");
    expect(sh(`git rev-parse HEAD`, local)).toBe(sh(`git rev-parse origin/feature`, local));
  });
});
