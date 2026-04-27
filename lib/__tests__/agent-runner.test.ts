import { describe, expect, test } from "bun:test";
import { resolveAgentInvocation } from "../agent-runner.ts";

describe("resolveAgentInvocation", () => {
  test("uses Claude print mode by default", () => {
    expect(resolveAgentInvocation({})).toEqual({
      cli: "claude",
      args: ["-p"],
    });
  });

  test("uses Codex exec stdin mode when cli is codex", () => {
    expect(resolveAgentInvocation({ cli: "codex" })).toEqual({
      cli: "codex",
      args: ["exec", "-"],
    });
  });

  test("preserves explicit args for Codex", () => {
    expect(resolveAgentInvocation({
      cli: "codex",
      args: ["exec", "--full-auto", "-"],
    })).toEqual({
      cli: "codex",
      args: ["exec", "--full-auto", "-"],
    });
  });
});
