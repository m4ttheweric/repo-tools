import { describe, test, expect } from "bun:test";
import { buildAskPayload, buildSpawnPayload, buildWrapUpPayload, jobEnv, renderAnswer, renderHerdRow, renderStatus, soleHerdId, workerEnv } from "../../commands/herd.ts";
import type { Commands, HerdListRow, HerdStatusData } from "../../packages/rt-client/src/index.ts";

describe("rt herd payload builders", () => {
  test("workerEnv reads HERD_ID, HERD_JOB, CLAUDE_CODE_SESSION_ID, HERDR_PANE_ID", () => {
    expect(workerEnv({ HERD_ID: "h", HERD_JOB: "j", CLAUDE_CODE_SESSION_ID: "s", HERDR_PANE_ID: "p" })).toEqual({ herd: "h", job: "j", session: "s", pane: "p" });
    expect(() => workerEnv({})).toThrow(/HERD_ID/);
  });

  test("buildAskPayload parses --questions JSON and carries --context", () => {
    const p = buildAskPayload(["--questions", '[{"id":"q","label":"?","multi":false,"options":["a"]}]', "--context", "why"], { HERD_ID: "h", HERD_JOB: "j", CLAUDE_CODE_SESSION_ID: "s" });
    expect(p).toMatchObject({ herd: "h", job: "j", session: "s", context: "why" });
    expect(p.questions).toHaveLength(1);
    expect(() => buildAskPayload(["--questions", "nope"], { HERD_ID: "h", HERD_JOB: "j", CLAUDE_CODE_SESSION_ID: "s" })).toThrow(/JSON/);
  });

  test("buildSpawnPayload reads the brief file", () => {
    const dir = require("os").tmpdir();
    const file = require("path").join(dir, `brief-${process.pid}.md`);
    require("fs").writeFileSync(file, "# brief");
    const p = buildSpawnPayload(["--herd", "h", "--job", "job-a", "--brief", file, "--model", "opus"]);
    expect(p).toMatchObject({ herd: "h", job: "job-a", brief: "# brief", model: "opus" });
  });

  test("buildWrapUpPayload collects repeated --dispose values and booleans", () => {
    expect(buildWrapUpPayload(["h-1", "--close-panes", "--dispose", "a", "--dispose", "b", "--archive-room"])).toEqual({ herd: "h-1", closePanes: true, dispose: ["a", "b"], deleteJobDirs: false, archiveRoom: true });
  });

  test("jobEnv needs the job identity only, not a session", () => {
    expect(jobEnv({ HERD_ID: "h", HERD_JOB: "j" })).toEqual({ herd: "h", job: "j" });
    expect(() => jobEnv({ HERD_JOB: "j" })).toThrow(/HERD_ID/);
  });
});

describe("rt herd list", () => {
  const row = (over: Partial<HerdListRow> = {}): HerdListRow => ({
    id: "hd-1", repo: "r", room: "herd-hd-1", workspace: "w", shepherdSession: "s", shepherdHandle: "shep",
    herdrSocket: null, hidden: false, status: "active", createdAt: 0, wrappedAt: null, jobs: 2, ...over,
  });

  test("a row carries the id, status, room and job count", () => {
    expect(renderHerdRow(row())).toBe("hd-1  active  room herd-hd-1  2 jobs");
    expect(renderHerdRow(row({ jobs: 1 }))).toBe("hd-1  active  room herd-hd-1  1 job");
    expect(renderHerdRow(row({ jobs: 0 }))).toBe("hd-1  active  room herd-hd-1  0 jobs");
  });

  test("exactly one herd is the fallback; zero or two are not", () => {
    expect(soleHerdId([row()])).toBe("hd-1");
    expect(soleHerdId([])).toBeNull();
    expect(soleHerdId([row(), row({ id: "hd-2" })])).toBeNull();
  });
});

function answerData(over: Partial<Commands["herd:answer"]["data"]>): Commands["herd:answer"]["data"] {
  return { gate: "gt-1", status: "open", answer: null, closedReason: null, ...over };
}

describe("renderAnswer", () => {
  test("an open gate is not an answer", () => {
    expect(renderAnswer("gt-1", answerData({ status: "open" }))).toContain("is still open");
  });

  test("a closed gate warns against inventing an answer", () => {
    const out = renderAnswer("gt-1", answerData({ status: "closed", closedReason: "abandoned" }));
    expect(out).toContain("do not invent an answer");
    expect(out).toContain("abandoned");
  });

  test("a parked gate warns against inventing an answer", () => {
    expect(renderAnswer("gt-1", answerData({ status: "parked" }))).toContain("do not invent an answer");
  });

  test("answered with a null answer never renders as an empty answer", () => {
    const out = renderAnswer("gt-1", answerData({ status: "answered", answer: null }));
    expect(out).toContain("carries no answer");
    expect(out).not.toContain("{}");
  });

  test("answered renders the answerer and the answers", () => {
    const out = renderAnswer("gt-1", answerData({ status: "answered", answer: { answers: { q1: "yes" }, by: "human", answeredAt: 1 } }));
    expect(out).toContain("answered by human:");
    expect(out).toContain("\"q1\": \"yes\"");
  });
});

function statusData(over: Partial<HerdStatusData>): HerdStatusData {
  return {
    herd: { id: "hd-1", repo: "r", room: "herd-1", workspace: "w1", shepherdSession: "s", shepherdHandle: "shep", herdrSocket: null, hidden: false, status: "active", createdAt: 0, wrappedAt: null },
    jobs: [],
    unread: 0,
    lifecycleConnected: true,
    hiddenUp: null,
    subscription: { id: "sub-1", dead: false, lastDelivery: null },
    ...over,
  };
}

function job(over: Partial<HerdStatusData["jobs"][number]>): HerdStatusData["jobs"][number] {
  return {
    herd: "hd-1", name: "job-a", worktree: "/tmp/job-a", branch: null, tree: null, pane: "w1:p1",
    agentSession: null, agentId: null, handle: "job-a", status: "active", disposable: false,
    lastGate: null, lastReport: null, createdAt: 0, updatedAt: 0,
    openGate: null, paneStatus: "idle", lastGateStatus: null, lastGateDelivery: null,
    ...over,
  };
}

describe("renderStatus", () => {
  test("a missing subscription names its own remedy", () => {
    expect(renderStatus(statusData({ subscription: null }))).toContain("subscription MISSING (run rt herd resume)");
  });

  test("an answered gate delivered to a dead pane tells the shepherd to DM the worker", () => {
    const data = statusData({ jobs: [job({ lastGate: "gt-9", lastGateStatus: "answered", lastGateDelivery: "dead-pane", handle: "job-a" })] });
    expect(renderStatus(data)).toContain("answered, worker not woken: rt chat dm job-a");
  });

  test("a delivered gate carries no not-woken warning", () => {
    const data = statusData({ jobs: [job({ lastGate: "gt-9", lastGateStatus: "answered", lastGateDelivery: "delivered" })] });
    expect(renderStatus(data)).not.toContain("worker not woken");
  });
});
