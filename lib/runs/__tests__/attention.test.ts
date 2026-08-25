import { describe, expect, test } from "bun:test";
import { computeAttention, fieldValue, lastEventAt, STALE_MS } from "../attention.ts";
import type { RunFieldRow, RunStageRow, RunSummary } from "../../../packages/rt-client/src/commands.ts";

const NOW = 1_000_000_000;
function run(over: Partial<RunSummary> = {}): RunSummary {
  return {
    id: "r", repo: "acme", work_type: "ticket", pipeline: "p", status: "running",
    current_stage: "implement", spawned_by: null, started_at: NOW - 60_000, ended_at: null,
    pack_commits: null, pack_dirty: 0, attention: { needs: false, reason: null, evidence: "" },
    last_event_at: NOW - 60_000, ticket: null, branch: null,
    ...over,
  };
}
const stage = (over: Partial<RunStageRow> = {}): RunStageRow => ({
  name: "implement", status: "running", attempt: 1,
  started_at: NOW - 60_000, ended_at: null, reason: null, detail_path: null, ...over,
});
const field = (key: string, value: string): RunFieldRow => ({ key, value, produced_by: "provision", at: NOW });

test("a failed run needs attention and says which stage", () => {
  const a = computeAttention(run({ status: "failed" }), [stage({ status: "failed", attempt: 3, reason: "assertion failed" })], [], [], NOW);
  expect(a.needs).toBe(true);
  expect(a.reason).toBe("failed");
  expect(a.evidence).toContain("implement");
  expect(a.evidence).toContain("attempt 3");
});

test("a running run silent past the threshold is stale, with its silence as evidence", () => {
  const last = NOW - STALE_MS - 60_000;
  const a = computeAttention(run(), [stage({ started_at: last })], [], [], NOW);
  expect(a.needs).toBe(true);
  expect(a.reason).toBe("stale");
  expect(a.evidence).toMatch(/no event in \d+m/);
});

test("a recently active running run does not need attention", () => {
  const a = computeAttention(run(), [stage({ started_at: NOW - 60_000 })], [], [], NOW);
  expect(a.needs).toBe(false);
  expect(a.reason).toBeNull();
});

test("a finished run with commits and no MR is stranded", () => {
  const a = computeAttention(
    run({ status: "done", ended_at: NOW - 3600_000 }),
    [stage({ status: "done", ended_at: NOW - 3600_000 })],
    [field("branch", "goodwin/mat-1"), field("worktree", "/tmp/wt"), field("commits", "6")], [],
    NOW,
  );
  expect(a.needs).toBe(true);
  expect(a.reason).toBe("stranded");
  expect(a.evidence).toContain("no MR");
});

test("a finished run whose MR was opened does NOT need attention", () => {
  // The field key is `mr` — that is what stage-ship declares in stage-produces
  // and writes via `field set`. Testing any other key would make this predicate
  // fire on every successful run, which is the wallpaper failure the spec
  // spends two paragraphs forbidding.
  const a = computeAttention(
    run({ status: "done", ended_at: NOW - 3600_000 }),
    [stage({ status: "done" })],
    [field("branch", "goodwin/mat-1"), field("commits", "6"), field("mr", "https://gitlab/x/merge_requests/1")], [],
    NOW,
  );
  expect(a.needs).toBe(false);
});

test("a finished run that produced no commits is not stranded", () => {
  // A review-only or watch-only pipeline legitimately ends without shipping.
  const a = computeAttention(
    run({ status: "done", ended_at: NOW - 3600_000 }),
    [stage({ status: "done" })],
    [field("branch", "goodwin/mat-1"), field("worktree", "/tmp/wt")], [],
    NOW,
  );
  expect(a.needs).toBe(false);
});

test("silence is measured from field writes, not just stage boundaries", () => {
  // Stages write their produces the moment they exist, so a long-running
  // implement stage is evidenced by field writes even though no stage has
  // started or ended. Measuring only stage timestamps would call it stale.
  const longAgo = NOW - STALE_MS - 600_000;
  const a = computeAttention(
    run({ started_at: longAgo }), [stage({ started_at: longAgo })],
    [{ key: "commits", value: "3", produced_by: "implement", at: NOW - 60_000 }], [],
    NOW,
  );
  expect(a.needs).toBe(false);
});

test("a decision counts as a heartbeat too", () => {
  // A stage that records a decision and nothing else is still alive; without
  // this it would go stale mid-deliberation.
  const longAgo = NOW - STALE_MS - 600_000;
  const a = computeAttention(
    run({ started_at: longAgo }), [stage({ started_at: longAgo })], [],
    [{ contract: "model-tiering@1", scope: "run", selection: "{}", decided_by: "stage-plan", decided_at: NOW - 60_000 }],
    NOW,
  );
  expect(a.needs).toBe(false);
});

test("failed beats stale when both could apply", () => {
  const a = computeAttention(run({ status: "failed" }), [stage({ status: "failed", started_at: NOW - STALE_MS * 3 })], [], [], NOW);
  expect(a.reason).toBe("failed");
});

test("lastEventAt is the newest of stage, field, and decision timestamps", () => {
  const t = lastEventAt(
    run({ started_at: NOW - 100_000 }),
    [stage({ started_at: NOW - 90_000, ended_at: NOW - 80_000 })],
    [field("ticket", "ACME-1")], // field() stamps `at: NOW`, the newest of the three
    [{ contract: "c@1", scope: "run", selection: "{}", decided_by: "stage-plan", decided_at: NOW - 50_000 }],
  );
  expect(t).toBe(NOW);
});

test("lastEventAt falls back to started_at for a run with no recorded events", () => {
  const r = run({ started_at: NOW - 100_000 });
  expect(lastEventAt(r, [], [], [])).toBe(NOW - 100_000);
});

test("fieldValue returns the value for a present key, null when the field is absent", () => {
  const fields = [field("ticket", "ACME-1"), field("branch", "goodwin/mat-1")];
  expect(fieldValue(fields, "ticket")).toBe("ACME-1");
  expect(fieldValue(fields, "branch")).toBe("goodwin/mat-1");
  expect(fieldValue(fields, "mr")).toBeNull();
  expect(fieldValue([], "ticket")).toBeNull();
});

describe("liveness evidence keeps a silent-but-driven run out of the stale band", () => {
  const OLD = NOW - STALE_MS - 60_000;
  const oldField = (key: string, value: string): RunFieldRow => ({ key, value, produced_by: "provision", at: OLD });
  const WT = "/repos/acme/.worktrees/moody";
  const liveness = (over: Partial<import("../attention.ts").RunLiveness> = {}) => ({
    workingSessionPane: () => null,
    workingAgentPane: () => null,
    worktreeActiveAt: () => null,
    ...over,
  });

  test("a working agent in the run's worktree clears stale", () => {
    const a = computeAttention(run(), [stage({ started_at: OLD })], [oldField("worktree", WT)], [], NOW,
      liveness({ workingAgentPane: (wt) => (wt === WT ? "w90:p1" : null) }));
    expect(a.needs).toBe(false);
  });

  test("recent git activity in the worktree clears stale", () => {
    const a = computeAttention(run(), [stage({ started_at: OLD })], [oldField("worktree", WT)], [], NOW,
      liveness({ worktreeActiveAt: () => NOW - 5 * 60_000 }));
    expect(a.needs).toBe(false);
  });

  test("git activity older than the threshold does not clear stale", () => {
    const a = computeAttention(run(), [stage({ started_at: OLD })], [oldField("worktree", WT)], [], NOW,
      liveness({ worktreeActiveAt: () => NOW - STALE_MS - 1 }));
    expect(a.needs).toBe(true);
    expect(a.reason).toBe("stale");
    expect(a.evidence).toContain("worktree quiet");
    expect(a.evidence).toContain("no agent working there");
  });

  test("a working agent running the run's recorded session clears stale, wherever it sits", () => {
    const a = computeAttention(run(), [stage({ started_at: OLD })],
      [oldField("worktree", WT), oldField("claude-session", "sess-1")], [], NOW,
      liveness({ workingSessionPane: (id) => (id === "sess-1" ? "w8S:pF" : null) }));
    expect(a.needs).toBe(false);
  });

  test("a session-id miss still falls through the worktree and heartbeat rungs", () => {
    const a = computeAttention(run(), [stage({ started_at: OLD })],
      [oldField("worktree", WT), oldField("claude-session", "sess-gone")], [], NOW,
      liveness({ worktreeActiveAt: () => NOW - 60_000 }));
    expect(a.needs).toBe(false);
  });

  test("liveness with no worktree field falls back to the plain silence evidence", () => {
    const a = computeAttention(run(), [stage({ started_at: OLD })], [], [], NOW, liveness());
    expect(a.needs).toBe(true);
    expect(a.evidence).not.toContain("worktree");
  });
});
