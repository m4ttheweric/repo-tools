import { describe, expect, test } from "bun:test";
import { __test__ } from "../agent.ts";

const { parseStartArgs, parseResumeArgs } = __test__;

describe("parseStartArgs", () => {
  test("full flag set", () => {
    const p = parseStartArgs([
      "--prompt", "do it", "--surface", "headless", "--model", "haiku",
      "--effort", "low", "--account", "a@b.c", "--label", "job7",
      "--caller", "board:review", "--workspace", "reviews", "--tab", "!7",
      "--extra-args", "--permission-mode plan",
    ]);
    expect(p).toEqual({
      prompt: "do it", surface: "headless", model: "haiku", effort: "low",
      account: "a@b.c", label: "job7", caller: "board:review",
      workspace: "reviews", tab: "!7", extraArgs: "--permission-mode plan",
    });
  });

  test("bad surface fails", () => {
    expect(() => parseStartArgs(["--surface", "tmux"])).toThrow(/surface/);
  });

  test("--prompt-file reads the file", () => {
    const path = `${process.env.TMPDIR ?? "/tmp"}/agent-prompt-${process.pid}.txt`;
    require("fs").writeFileSync(path, "from file");
    expect(parseStartArgs(["--prompt-file", path]).prompt).toBe("from file");
  });

  test("--prompt and --prompt-file together fail", () => {
    expect(() => parseStartArgs(["--prompt", "a", "--prompt-file", "/x"])).toThrow(/one of/);
  });
});

describe("parseResumeArgs", () => {
  test("id positional + optional prompt/surface", () => {
    expect(parseResumeArgs(["ag-12345678", "--prompt", "next", "--surface", "herdr"]))
      .toEqual({ id: "ag-12345678", prompt: "next", surface: "herdr" });
  });
  test("missing id fails", () => {
    expect(() => parseResumeArgs(["--prompt", "x"])).toThrow(/id/);
  });

  test("parseResumeArgs reads --workspace and --tab", () => {
    const r = parseResumeArgs(["ag-1", "--workspace", "reviews", "--tab", "⟲ !5", "--prompt", "go"]);
    expect(r).toMatchObject({ id: "ag-1", workspace: "reviews", tab: "⟲ !5", prompt: "go" });
  });
});
