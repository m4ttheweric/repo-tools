/**
 * process:describe handler test — verifies the enriched-record wiring:
 * ProcessManager entries + StateStore state/pid + worktree resolved from cwd
 * against the repo index (real temp git repo). The pure pieces are tested
 * separately; this covers the seam.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { execSync } from "child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createProcessHandlers } from "../handlers/process.ts";

let repo: string;

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "rt-desc-")));
  execSync(`git init -q "${repo}"`);
  writeFileSync(join(repo, "README"), "x");
  execSync(`git -C "${repo}" add . && git -C "${repo}" -c user.email=t@t -c user.name=t commit -q -m init`);
});

afterEach(() => {
  try { rmSync(repo, { recursive: true, force: true }); } catch { /* */ }
});

function ctxWith(processes: any[], states: Record<string, string>, pids: Record<string, number>) {
  return {
    processManager: { list: () => processes },
    stateStore: {
      getState: (id: string) => states[id] ?? "stopped",
      getPid: (id: string) => pids[id],
    },
    repoIndex: () => ({ myrepo: repo }),
    remedyEngine: { onSpawn() {} },
  };
}

describe("process:describe", () => {
  test("returns records enriched with state, pid, timing, and resolved worktree", async () => {
    const processes = [{
      id: "p1",
      config: { cmd: "npm run dev", cwd: join(repo, "apps/x"), env: { PORT: "10001" } },
      startedAt: 5,
      exitCode: undefined,
    }];
    const handlers = createProcessHandlers(ctxWith(processes, { p1: "running" }, { p1: 999 }) as any);
    const res = await handlers["process:describe"]!({});
    expect(res.ok).toBe(true);
    expect(res.data).toHaveLength(1);
    const r = res.data[0];
    expect(r.id).toBe("p1");
    expect(r.cmd).toBe("npm run dev");
    expect(r.state).toBe("running");
    expect(r.pid).toBe(999);
    expect(r.startedAt).toBe(5);
    expect(r.repo).toBe("myrepo");
    expect(r.worktree).toBe(repo);
    expect(["main", "master"]).toContain(r.branch);
  });
});
