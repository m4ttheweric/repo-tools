import { describe, expect, test } from "bun:test";
import { parseAgentSelection } from "../../commands/sandbox.ts";

describe("parseAgentSelection", () => {
  test("collects --account and repeated --agent-env", () => {
    expect(
      parseAgentSelection(["--account", "acct-3.token", "--agent-env", "ANTHROPIC_MODEL=claude-sonnet-5", "--agent-env", "FOO_BAR=x"]),
    ).toEqual({
      rest: [],
      agentCredentialKey: "acct-3.token",
      agentEnv: { ANTHROPIC_MODEL: "claude-sonnet-5", FOO_BAR: "x" },
    });
  });
  test("passes unrelated args through in rest", () => {
    expect(parseAgentSelection(["--ticket", "MAT-1"])).toEqual({ rest: ["--ticket", "MAT-1"] });
  });
  test("rejects bad keys, names, reserved names, and missing =", () => {
    for (const args of [
      ["--account", "../etc"],
      ["--agent-env", "lower=x"],
      ["--agent-env", "HOME=/x"],
      ["--agent-env", "NOEQUALS"],
      ["--account"],
    ]) {
      const out = parseAgentSelection(args);
      expect("error" in out).toBe(true);
    }
  });
});
