import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getRunLiveness, livenessFrom, probeAgents, resetLivenessCache, worktreeActivityAt } from "../liveness.ts";
import type { runCapture } from "../../subprocess.ts";

const herdrPayload = JSON.stringify({
  result: {
    agents: [
      { agent_status: "working", cwd: "/repos/acme", foreground_cwd: "/repos/acme/.worktrees/moody", pane_id: "w90:p1", agent_session: { value: "sess-1" } },
      { agent_status: "idle", cwd: "/repos/other", foreground_cwd: "/repos/other", pane_id: "w1:p1", agent_session: { value: "sess-2" } },
      { agent_status: "blocked", cwd: "/repos/acme/.worktrees/moody", pane_id: "w90:p2", agent_session: { value: "sess-3" } },
      { agent_status: "someday-new-status", cwd: "/repos/zeta", pane_id: "w5:p1" },
    ],
  },
});

const fakeExec = (stdout: string, exitCode = 0): typeof runCapture =>
  async () => ({ stdout, stderr: "", exitCode });

afterEach(() => resetLivenessCache());

test("probeAgents keeps every agent with its status, session, and cwds", async () => {
  const agents = await probeAgents(fakeExec(herdrPayload));
  expect(agents).toHaveLength(4);
  expect(agents?.[0]).toEqual({ status: "working", pane: "w90:p1", session: "sess-1", cwds: ["/repos/acme", "/repos/acme/.worktrees/moody"] });
  expect(agents?.[2]?.status).toBe("blocked");
  // An unrecognized status normalizes rather than leaking novel strings.
  expect(agents?.[3]?.status).toBe("unknown");
});

test("probeAgents returns null on failure — distinct from an empty answer", async () => {
  expect(await probeAgents(fakeExec("", 1))).toBeNull();
  expect(await probeAgents(fakeExec("not json"))).toBeNull();
  expect(await probeAgents(fakeExec(JSON.stringify({ result: { agents: [] } })))).toEqual([]);
});

test("agentFor prefers the recorded session over any cwd match", async () => {
  const l = await getRunLiveness(fakeExec(herdrPayload));
  expect(l.agentFor("sess-2", "/repos/acme/.worktrees/moody")).toEqual({ status: "idle", pane: "w1:p1" });
});

test("agentFor falls back to cwd containment, most actionable status first", async () => {
  const l = await getRunLiveness(fakeExec(herdrPayload));
  // Both w90 panes sit in moody; blocked outranks working.
  expect(l.agentFor(null, "/repos/acme/.worktrees/moody")).toEqual({ status: "blocked", pane: "w90:p2" });
  expect(l.agentFor("sess-gone", "/repos/elsewhere")).toBeNull();
});

test("working-agent rungs match only working agents", async () => {
  const l = await getRunLiveness(fakeExec(herdrPayload));
  expect(l.workingSessionPane("sess-1")).toBe("w90:p1");
  expect(l.workingSessionPane("sess-2")).toBeNull();
  expect(l.workingAgentPane("/repos/acme/.worktrees/moody")).toBe("w90:p1");
  // A sibling worktree must not inherit the agent, prefix or not.
  expect(l.workingAgentPane("/repos/acme/.worktrees/moo")).toBeNull();
});

test("livenessFrom([]) yields a liveness with no agent evidence", () => {
  const l = livenessFrom([]);
  expect(l.agentFor("sess-1", "/repos/acme")).toBeNull();
  expect(l.workingAgentPane("/repos/acme")).toBeNull();
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
