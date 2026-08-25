import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getRunLiveness, probeWorkingAgents, resetLivenessCache, worktreeActivityAt } from "../liveness.ts";
import type { runCapture } from "../../subprocess.ts";

const herdrPayload = JSON.stringify({
  result: {
    agents: [
      { agent_status: "working", cwd: "/repos/acme", foreground_cwd: "/repos/acme/.worktrees/moody", pane_id: "w90:p1", agent_session: { value: "sess-1" } },
      { agent_status: "idle", cwd: "/repos/other", foreground_cwd: "/repos/other", pane_id: "w1:p1", agent_session: { value: "sess-2" } },
    ],
  },
});

const fakeExec = (stdout: string, exitCode = 0): typeof runCapture =>
  async () => ({ stdout, stderr: "", exitCode });

afterEach(() => resetLivenessCache());

test("probeWorkingAgents keeps only working agents, keyed by cwds and session id", async () => {
  const agents = await probeWorkingAgents(fakeExec(herdrPayload));
  expect(agents.byCwd.get("/repos/acme")).toBe("w90:p1");
  expect(agents.byCwd.get("/repos/acme/.worktrees/moody")).toBe("w90:p1");
  expect(agents.byCwd.has("/repos/other")).toBe(false);
  expect(agents.bySession.get("sess-1")).toBe("w90:p1");
  expect(agents.bySession.has("sess-2")).toBe(false);
});

test("probeWorkingAgents degrades to empty on a failed or garbled probe", async () => {
  expect((await probeWorkingAgents(fakeExec("", 1))).byCwd.size).toBe(0);
  expect((await probeWorkingAgents(fakeExec("not json"))).byCwd.size).toBe(0);
});

test("workingSessionPane matches only a working agent's session", async () => {
  const l = await getRunLiveness(fakeExec(herdrPayload));
  expect(l.workingSessionPane("sess-1")).toBe("w90:p1");
  expect(l.workingSessionPane("sess-2")).toBeNull();
  expect(l.workingSessionPane("sess-unknown")).toBeNull();
});

test("workingAgentPane matches the worktree itself and cwds inside it", async () => {
  const l = await getRunLiveness(fakeExec(herdrPayload));
  expect(l.workingAgentPane("/repos/acme/.worktrees/moody")).toBe("w90:p1");
  expect(l.workingAgentPane("/repos/acme")).toBe("w90:p1");
  // A sibling worktree must not inherit the agent, prefix or not.
  expect(l.workingAgentPane("/repos/acme/.worktrees/moo")).toBeNull();
  expect(l.workingAgentPane("/repos/elsewhere")).toBeNull();
});

test("worktreeActivityAt reads a linked worktree's gitdir through the .git file", () => {
  const root = mkdtempSync(join(tmpdir(), "rt-liveness-"));
  try {
    const gitdir = join(root, "real-gitdir");
    const wt = join(root, "wt");
    mkdirSync(gitdir, { recursive: true });
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, ".git"), `gitdir: ${gitdir}\n`);
    writeFileSync(join(gitdir, "HEAD"), "ref: refs/heads/x\n");
    const fresh = Date.now() / 1000;
    utimesSync(join(gitdir, "HEAD"), fresh, fresh);
    const at = worktreeActivityAt(wt);
    expect(at).not.toBeNull();
    expect(Math.abs((at as number) - fresh * 1000)).toBeLessThan(2000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("worktreeActivityAt is null for a missing worktree", () => {
  expect(worktreeActivityAt("/nowhere/never/existed")).toBeNull();
});
