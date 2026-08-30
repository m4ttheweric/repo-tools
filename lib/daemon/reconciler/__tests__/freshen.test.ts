import { describe, test, expect, beforeEach } from "bun:test";
import { execSync } from "child_process";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import type { Logger } from "pino";
import { writeJson } from "../../../json-store.ts";
import { rtDir } from "../../../rt-paths.ts";
import { closeStateDb } from "../../../state/index.ts";
import { headSha } from "../../../worktree/git-async.ts";
import { loadRegistry, saveRegistry } from "../../../worktree/registry.ts";
import { freshenRepo } from "../freshen.ts";

const GIT_ID = "-c user.email=t@t -c user.name=t";

function sh(cmd: string, cwd?: string): void {
  execSync(cmd, { cwd, shell: "/bin/zsh", stdio: "pipe" });
}

function fakeLog(): Logger {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger;
}

function makeRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rtfreshen-")));
  sh("git init -b main && git -c user.email=t@t -c user.name=t commit --allow-empty -m init", dir);
  return dir;
}

function addBareOrigin(repo: string): void {
  const bare = mkdtempSync(join(tmpdir(), "rtfreshen-bare-"));
  sh(`git clone --bare ${repo} ${bare}/o.git && git -C ${repo} remote add origin ${bare}/o.git && git -C ${repo} fetch origin`);
}

function cloneOrigin(repo: string): string {
  const originUrl = execSync(`git -C ${repo} remote get-url origin`, { encoding: "utf8" }).trim();
  const clone = realpathSync(mkdtempSync(join(tmpdir(), "rtfreshen-clone-")));
  sh(`git clone -q ${originUrl} ${clone}`);
  return clone;
}

function pushFile(clone: string, relPath: string, contents: string): string {
  writeFileSync(join(clone, relPath), contents);
  sh(`git add -A && git ${GIT_ID} commit -m ${relPath}`, clone);
  sh(`git push -q origin main`, clone);
  return execSync("git rev-parse HEAD", { cwd: clone, encoding: "utf8" }).trim();
}

describe("freshen.ts: freshenRepo", () => {
  const repoName = "acme";
  let repo: string;

  beforeEach(() => {
    process.env.HOME = realpathSync(mkdtempSync(join(tmpdir(), "rtfreshen-home-")));
    closeStateDb();
    repo = makeRepo();
    addBareOrigin(repo);
    writeJson(join(rtDir(), "worktrees.json"), { enabled: true, killProcesses: false });
  });

  test("idle main behind origin gets ff'd; worktree:freshened emitted", async () => {
    saveRegistry(repoName, [
      { name: basename(repo), path: repo, kind: "main", branch: "main", createdAt: new Date().toISOString() },
    ]);

    const clone = cloneOrigin(repo);
    const sha1 = pushFile(clone, "feature.txt", "hi\n");

    const events: Array<{ type: string; data: unknown }> = [];
    const ran = await freshenRepo({
      repoName,
      repoPath: repo,
      emit: (type: string, data: unknown) => events.push({ type, data }),
      log: fakeLog(),
    });

    expect(ran).toContain(basename(repo));
    expect(await headSha(repo)).toBe(sha1);
    expect(events.some((e) => e.type === "worktree:freshened")).toBe(true);
  });

  test("dirty non-idle main is left untouched", async () => {
    writeFileSync(join(repo, "dirty.txt"), "uncommitted\n");
    saveRegistry(repoName, [
      { name: basename(repo), path: repo, kind: "main", branch: "main", createdAt: new Date().toISOString() },
    ]);

    const beforeSha = await headSha(repo);
    const ran = await freshenRepo({ repoName, repoPath: repo, emit: () => {}, log: fakeLog() });

    expect(ran).toEqual([]);
    expect(await headSha(repo)).toBe(beforeSha);
    expect(existsSync(join(repo, "dirty.txt"))).toBe(true);
    const rec = loadRegistry(repoName).find((t) => t.path === repo)!;
    expect(rec.readyAt).toBeUndefined();
  });
});
