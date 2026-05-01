import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const tmpHome = mkdtempSync(join(tmpdir(), "rt-auto-fix-elig-"));
process.env.HOME = tmpHome;

const { evaluateEligibility } = await import("../auto-fix-eligibility.ts");
const { appendLogEntry } = await import("../../auto-fix-log.ts");

const REPO = "test-repo";

afterEach(() => {
  try { rmSync(join(tmpHome, ".rt", REPO), { recursive: true, force: true }); } catch { /* */ }
});

function fakeMR(opts: Partial<{
  authorIsMe: boolean;
  status: string;
  isApproved: boolean;
  changesRequested: boolean;
  pipelineStatus: string;
  pipelineSha: string;
  flakeRetriedAndPassed: boolean;
}>) {
  return {
    authorIsMe:            opts.authorIsMe            ?? true,
    status:                opts.status                ?? "opened",
    isApproved:            opts.isApproved            ?? true,
    changesRequested:      opts.changesRequested      ?? false,
    pipelineStatus:        opts.pipelineStatus        ?? "failed",
    pipelineSha:           opts.pipelineSha           ?? "deadbeef",
    flakeRetriedAndPassed: opts.flakeRetriedAndPassed ?? false,
  };
}

describe("evaluateEligibility", () => {
  const baseInput = {
    repoName: REPO,
    branch: "feat/x",
    headSha: "deadbeef",
    now: 1700000000000,
    cooldownMs: 5 * 60 * 1000,
    attemptCap: 2,
  };

  test("eligible for a clean approved failed pipeline", () => {
    expect(evaluateEligibility({ ...baseInput, mr: fakeMR({}) }))
      .toEqual({ eligible: true });
  });

  test("not eligible: not authored by me", () => {
    const r = evaluateEligibility({ ...baseInput, mr: fakeMR({ authorIsMe: false }) });
    expect(r.eligible).toBe(false);
    expect(r.eligible || r.reason).toContain("author");
  });

  test("not eligible: status=draft", () => {
    const r = evaluateEligibility({ ...baseInput, mr: fakeMR({ status: "draft" }) });
    expect(r.eligible).toBe(false);
    expect(r.eligible || r.reason).toContain("status");
  });

  test("not eligible: not approved", () => {
    const r = evaluateEligibility({ ...baseInput, mr: fakeMR({ isApproved: false }) });
    expect(r.eligible).toBe(false);
    expect(r.eligible || r.reason).toContain("approve");
  });

  test("not eligible: changes_requested pending", () => {
    const r = evaluateEligibility({ ...baseInput, mr: fakeMR({ changesRequested: true }) });
    expect(r.eligible).toBe(false);
    expect(r.eligible || r.reason).toContain("changes");
  });

  test("not eligible: pipeline not failed", () => {
    const r = evaluateEligibility({ ...baseInput, mr: fakeMR({ pipelineStatus: "running" }) });
    expect(r.eligible).toBe(false);
    expect(r.eligible || r.reason).toContain("pipeline");
  });

  test("not eligible: pipeline SHA doesn't match MR HEAD", () => {
    const r = evaluateEligibility({
      ...baseInput,
      mr: fakeMR({ pipelineSha: "stale" }),
    });
    expect(r.eligible).toBe(false);
    expect(r.eligible || r.reason).toContain("HEAD");
  });

  test("not eligible: flake (retried-and-passed)", () => {
    const r = evaluateEligibility({ ...baseInput, mr: fakeMR({ flakeRetriedAndPassed: true }) });
    expect(r.eligible).toBe(false);
    expect(r.eligible || r.reason).toContain("flake");
  });

  test("not eligible: attempt cap reached for this SHA", () => {
    appendLogEntry(REPO, { branch: "feat/x", sha: "deadbeef", attemptedAt: 0, outcome: "error",         durationMs: 1 });
    appendLogEntry(REPO, { branch: "feat/x", sha: "deadbeef", attemptedAt: 0, outcome: "rejected_diff", durationMs: 1 });
    const r = evaluateEligibility({ ...baseInput, mr: fakeMR({}) });
    expect(r.eligible).toBe(false);
    expect(r.eligible || r.reason).toContain("attempt");
  });

  test("not eligible: cooldown active (last fixed commit too recent)", () => {
    appendLogEntry(REPO, {
      branch: "feat/x", sha: "older-sha",
      attemptedAt: baseInput.now - 60_000,
      outcome: "fixed", durationMs: 1, commitSha: "abc",
    });
    const r = evaluateEligibility({ ...baseInput, mr: fakeMR({}) });
    expect(r.eligible).toBe(false);
    expect(r.eligible || r.reason).toContain("cooldown");
  });

  test("eligible: cooldown elapsed (last fixed commit > 5 min ago)", () => {
    appendLogEntry(REPO, {
      branch: "feat/x", sha: "older-sha",
      attemptedAt: baseInput.now - 6 * 60_000,
      outcome: "fixed", durationMs: 1, commitSha: "abc",
    });
    expect(evaluateEligibility({ ...baseInput, mr: fakeMR({}) }))
      .toEqual({ eligible: true });
  });
});
