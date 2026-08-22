import { describe, expect, test } from "bun:test";
import { formatRunLine, formatRunDetail } from "../runs.ts";

describe("rt runs formatting", () => {
  const run = { id: "20260821-010101-aaaa", repo: "alpha", work_type: "feature", pipeline: "default", status: "running", current_stage: "plan", spawned_by: null, started_at: 1755750000000, ended_at: null };

  test("formatRunLine shows id, repo, status, current stage", () => {
    const line = formatRunLine(run as any);
    expect(line).toContain("20260821-010101-aaaa");
    expect(line).toContain("alpha");
    expect(line).toContain("running");
    expect(line).toContain("plan");
  });

  test("formatRunDetail renders stages, fields, decisions sections", () => {
    const text = formatRunDetail({
      run: run as any,
      stages: [{ name: "plan", status: "done", attempt: 1, started_at: 1, ended_at: 2 }],
      fields: [{ key: "ticket", value: "ACME-1", produced_by: "plan", at: 1 }],
      decisions: [{ contract: "execution-strategy@1", scope: "run", selection: '{"tier":"direct-tdd"}', decided_by: "stage-plan", decided_at: 1 }],
      schemaAhead: false,
    } as any);
    expect(text).toContain("plan");
    expect(text).toContain("ticket");
    expect(text).toContain("execution-strategy@1");
  });
});
