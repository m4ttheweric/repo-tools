import { describe, expect, test } from "bun:test";
import { parseAgentSelection, parseAttachArgs, parseEventsArgs, renderSandboxEvent, requireBrief } from "../../commands/sandbox.ts";
import type { SandboxEvent } from "../sandbox.ts";

describe("parseAttachArgs", () => {
  test("id with optional --exec", () => {
    expect(parseAttachArgs(["sb-1"])).toEqual({ id: "sb-1", exec: false });
    expect(parseAttachArgs(["sb-1", "--exec"])).toEqual({ id: "sb-1", exec: true });
  });
  test("no id is not an error — null id signals the picker fallback (RT-23)", () => {
    expect(parseAttachArgs([])).toEqual({ id: null, exec: false });
    expect(parseAttachArgs(["--exec"])).toEqual({ id: null, exec: true });
  });
  test("unknown flags are errors", () => {
    expect("error" in parseAttachArgs(["sb-1", "--bogus"])).toBe(true);
    expect("error" in parseAttachArgs(["--bogus"])).toBe(true);
  });
});

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

describe("requireBrief", () => {
  test("a given brief passes through untouched", () => {
    expect(requireBrief("MAT-1: fix it", false)).toEqual({ brief: "MAT-1: fix it" });
    expect(requireBrief("MAT-1: fix it", true)).toEqual({ brief: "MAT-1: fix it" });
  });

  test("briefless attended is legal — the operator IS the session (empty brief sent)", () => {
    expect(requireBrief(null, true)).toEqual({ brief: "" });
  });

  test("briefless headless is still refused with the flags named", () => {
    const out = requireBrief(null, false);
    expect("error" in out).toBe(true);
    if ("error" in out) {
      expect(out.error).toContain("--job");
      expect(out.error).toContain("--ticket");
    }
  });
});

describe("parseEventsArgs", () => {
  test("id, default since 0, --since and --json honored", () => {
    expect(parseEventsArgs(["sb-1"])).toEqual({ id: "sb-1", since: 0, json: false });
    expect(parseEventsArgs(["sb-1", "--since", "42", "--json"])).toEqual({ id: "sb-1", since: 42, json: true });
  });
  test("no id is not an error — null id signals the picker fallback (RT-23)", () => {
    expect(parseEventsArgs([])).toEqual({ id: null, since: 0, json: false });
    expect(parseEventsArgs(["--since", "9", "--json"])).toEqual({ id: null, since: 9, json: true });
  });
  test("non-integer since / unknown flags are errors", () => {
    expect("error" in parseEventsArgs(["sb-1", "--since", "x"])).toBe(true);
    expect("error" in parseEventsArgs(["--bogus"])).toBe(true);
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
