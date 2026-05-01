import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const tmpHome = mkdtempSync(join(tmpdir(), "rt-auto-fix-orch-"));
process.env.HOME = tmpHome;

const { runAutoFix } = await import("../auto-fix.ts");

const REPO = "test-repo";

afterEach(() => {
  try { rmSync(join(tmpHome, ".rt", REPO), { recursive: true, force: true }); } catch { /* */ }
});

describe("runAutoFix (orchestrator) — eligibility short-circuit", () => {
  function baseCtx() {
    const lines: string[] = [];
    return {
      lines,
      ctx: {
        repoName: REPO,
        repoPath: "/nonexistent",
        branch:   "feat/x",
        sha:      "deadbeef",
        target:   "main",
        mr: {
          authorIsMe:            true,
          status:                "opened",
          isApproved:            true,
          changesRequested:      false,
          pipelineStatus:        "failed",
          pipelineSha:           "deadbeef",
          flakeRetriedAndPassed: false,
        },
        jobLogs:    [],
        gitContext: { commits: "", changedFiles: "", diffStat: "", diff: "" },
        log:        (m: string) => { lines.push(m); },
      },
    };
  }

  test("returns ineligible when MR is not authored by me", async () => {
    const { ctx } = baseCtx();
    ctx.mr.authorIsMe = false;
    const result = await runAutoFix(ctx);
    expect(result.kind).toBe("ineligible");
    if (result.kind === "ineligible") {
      expect(result.reason).toContain("author");
    }
  });

  test("returns ineligible when pipeline is running, not failed", async () => {
    const { ctx } = baseCtx();
    ctx.mr.pipelineStatus = "running";
    const result = await runAutoFix(ctx);
    expect(result.kind).toBe("ineligible");
  });

  test("returns ineligible when MR is a draft", async () => {
    const { ctx } = baseCtx();
    ctx.mr.status = "draft";
    const result = await runAutoFix(ctx);
    expect(result.kind).toBe("ineligible");
  });
});
