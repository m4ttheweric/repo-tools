import { describe, expect, spyOn, test } from "bun:test";
import { formatRunLine, formatRunDetail, runsList, runsShow, runsAbandon } from "../runs.ts";

/**
 * Mock process.exit to throw a sentinel so the real test process never
 * dies, and read the spies' recorded calls BEFORE mockRestore() -- bun's
 * mockRestore() clears .mock.calls, unlike jest's (matches
 * commands/__tests__/skills.test.ts's runExpectingCleanExit).
 */
async function runExpectingCleanExit(fn: () => Promise<void>): Promise<{ exitCode: number | undefined; errors: string[] }> {
  const errors: string[] = [];
  const exitSpy = spyOn(process, "exit").mockImplementation(() => {
    throw new Error("process.exit sentinel");
  });
  const errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
  try {
    await fn();
    return { exitCode: undefined, errors };
  } catch {
    const exitCode = exitSpy.mock.calls.at(-1)?.[0] as number | undefined;
    return { exitCode, errors };
  } finally {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  }
}

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

  test("formatRunDetail shows a failed stage's reason and detail_path", () => {
    const text = formatRunDetail({
      run: run as any,
      stages: [{ name: "gates", status: "failed", attempt: 1, started_at: 1, ended_at: 2, reason: "qa-islands assertion failed", detail_path: "/tmp/gates.log" }],
      fields: [],
      decisions: [],
      schemaAhead: false,
    } as any);
    expect(text).toContain("qa-islands assertion failed");
    expect(text).toContain("/tmp/gates.log");
  });
});

describe("rt runs --repo flag validation", () => {
  test("a dangling --repo with no value fails loudly instead of silently listing unscoped", async () => {
    const { exitCode, errors } = await runExpectingCleanExit(() => runsList(["--repo"]));
    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("--repo requires a value");
  });

  test("--repo immediately followed by another flag is treated as dangling, not a value", async () => {
    const { exitCode, errors } = await runExpectingCleanExit(() => runsList(["--repo", "--json"]));
    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("--repo requires a value");
  });

  test("runsShow rejects a dangling --repo the same way", async () => {
    const { exitCode, errors } = await runExpectingCleanExit(() => runsShow(["20260821-010101-aaaa", "--repo"]));
    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("--repo requires a value");
  });
});

describe("rt runs abandon argument validation", () => {
  test("runs abandon requires a run id", async () => {
    const { exitCode, errors } = await runExpectingCleanExit(() => runsAbandon([]));
    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("abandon needs a run id");
  });

  test("runs abandon rejects a dangling --reason", async () => {
    const { exitCode, errors } = await runExpectingCleanExit(() => runsAbandon(["some-id", "--reason"]));
    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("--reason requires a value");
  });
});
