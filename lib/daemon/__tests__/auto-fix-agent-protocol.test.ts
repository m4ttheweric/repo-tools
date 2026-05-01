import { describe, expect, test } from "bun:test";
import {
  assembleAutoFixPrompt,
  parseAgentResult,
} from "../auto-fix-agent-protocol.ts";

describe("assembleAutoFixPrompt", () => {
  test("contains task framing, scope rules, and exit protocol instructions", () => {
    const prompt = assembleAutoFixPrompt({
      branch: "feat/x",
      target: "main",
      jobLogs: [{ name: "lint", trace: "error: missing semicolon at line 42" }],
      gitContext: {
        commits: "- a1b2c3 fix lint",
        changedFiles: "src/foo.ts",
        diffStat: "1 file, 2 insertions",
        diff: "--- a/src/foo.ts\n+++ b/src/foo.ts\n",
      },
      fileCap: 5,
      lineCap: 200,
      denylist: ["package.json", "infra/**"],
      allowTestFixes: false,
    });
    expect(prompt).toContain("pipeline on this branch is failing");
    expect(prompt).toContain("RESULT: fixed");
    expect(prompt).toContain("RESULT: skipped");
    expect(prompt).toContain("RESULT: error");
    expect(prompt).toContain("≤ 5 files");
    expect(prompt).toContain("≤ 200 lines");
    expect(prompt).toContain("package.json");
    expect(prompt).toContain("infra/**");
    expect(prompt).toContain("error: missing semicolon at line 42");
    expect(prompt).toContain("feat/x");
    expect(prompt).toContain("main");
  });

  test("when allowTestFixes is true, prompt includes test-failure guidance", () => {
    const prompt = assembleAutoFixPrompt({
      branch: "feat/x", target: "main", jobLogs: [],
      gitContext: { commits: "", changedFiles: "", diffStat: "", diff: "" },
      fileCap: 5, lineCap: 200, denylist: [], allowTestFixes: true,
    });
    expect(prompt.toLowerCase()).toContain("test failures are in scope");
  });

  test("when allowTestFixes is false, prompt restricts to lint/types/format", () => {
    const prompt = assembleAutoFixPrompt({
      branch: "feat/x", target: "main", jobLogs: [],
      gitContext: { commits: "", changedFiles: "", diffStat: "", diff: "" },
      fileCap: 5, lineCap: 200, denylist: [], allowTestFixes: false,
    });
    expect(prompt.toLowerCase()).toContain("test failures are out of scope");
  });
});

describe("parseAgentResult", () => {
  test("RESULT: fixed with summary", () => {
    const out = "did stuff\nRESULT: fixed: bumped semver in tsconfig\n";
    expect(parseAgentResult(out)).toEqual({ kind: "fixed", summary: "bumped semver in tsconfig" });
  });

  test("RESULT: fixed without colon-summary still parses", () => {
    const out = "RESULT: fixed\n";
    expect(parseAgentResult(out)).toEqual({ kind: "fixed", summary: "" });
  });

  test("RESULT: skipped with reason", () => {
    expect(parseAgentResult("RESULT: skipped: this looks like a real bug, not lint\n"))
      .toEqual({ kind: "skipped", reason: "this looks like a real bug, not lint" });
  });

  test("RESULT: error with note", () => {
    expect(parseAgentResult("RESULT: error: bun typecheck blew up\n"))
      .toEqual({ kind: "error", note: "bun typecheck blew up" });
  });

  test("missing RESULT line → unrecognized", () => {
    expect(parseAgentResult("hello world\nno result here"))
      .toEqual({ kind: "unrecognized" });
  });

  test("uses the LAST RESULT line if multiple appear", () => {
    const out = "RESULT: skipped: thinking\nRESULT: fixed: actually I figured it out\n";
    expect(parseAgentResult(out)).toEqual({ kind: "fixed", summary: "actually I figured it out" });
  });
});
