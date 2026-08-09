import { describe, expect, test } from "bun:test";
import { parseAgentSelection, parseEventsArgs, renderSandboxEvent } from "../../commands/sandbox.ts";
import type { SandboxEvent } from "../sandbox.ts";

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

  test("collects --attended with its --tui-account (attended lanes, MAT-235)", () => {
    expect(parseAgentSelection(["--attended", "--tui-account", "acct-3"])).toEqual({
      rest: [],
      attended: true,
      tuiCredentialKey: "acct-3",
    });
  });

  test("attended lane validation is Mac-side friendly (mirrors the controller's 400s)", () => {
    // attended implies a tui account; a tui account implies attended; one auth mode per lane.
    for (const args of [
      ["--attended"],
      ["--tui-account", "acct-3"],
      ["--attended", "--tui-account", "acct-3", "--account", "acct-3.token"],
      ["--attended", "--tui-account", "../etc"],
      ["--attended", "--tui-account"],
    ]) {
      const out = parseAgentSelection(args);
      expect("error" in out).toBe(true);
    }
    expect((parseAgentSelection(["--attended"]) as { error: string }).error).toContain("--tui-account");
  });
});

describe("parseEventsArgs", () => {
  test("id, default since 0, --since and --json honored", () => {
    expect(parseEventsArgs(["sb-1"])).toEqual({ id: "sb-1", since: 0, json: false });
    expect(parseEventsArgs(["sb-1", "--since", "42", "--json"])).toEqual({ id: "sb-1", since: 42, json: true });
  });
  test("missing id / non-integer since are errors", () => {
    expect("error" in parseEventsArgs([])).toBe(true);
    expect("error" in parseEventsArgs(["sb-1", "--since", "x"])).toBe(true);
  });
});

describe("renderSandboxEvent", () => {
  const base = { seq: 7, ts: "2026-08-09T01:00:00Z", sandboxId: "sb-1" };
  test("question, state, captured lane.json, process-dead", () => {
    expect(renderSandboxEvent({ ...base, type: "question", payload: {} } as SandboxEvent)).toContain("question.md");
    expect(renderSandboxEvent({ ...base, type: "state", payload: { state: "error", message: "seed failed" } } as SandboxEvent)).toContain("error");
    expect(
      renderSandboxEvent({
        ...base, type: "captured",
        payload: { file: "lane.json", content: JSON.stringify({ state: "blocked", turns: 3 }) },
      } as SandboxEvent),
    ).toContain("lane: blocked");
    expect(renderSandboxEvent({ ...base, type: "process-dead", payload: { reason: "agent-terminated", exitCode: 1 } } as SandboxEvent)).toContain("agent-terminated");
  });
  test("every line leads with [seq]", () => {
    expect(renderSandboxEvent({ ...base, type: "report", payload: {} } as SandboxEvent)).toMatch(/^\[7\]/);
  });
});
