import { describe, expect, test } from "bun:test";
import { parseAgentSelection, parseAttachArgs, parseEventsArgs, renderSandboxEvent, requireBrief } from "../../commands/sandbox.ts";
import { formatSandboxAge, sandboxPickerCandidates } from "../sandbox.ts";
import type { SandboxDetail, SandboxEvent, SandboxState } from "../sandbox.ts";

/** Minimal SandboxDetail for picker tests. */
function sb(id: string, state: SandboxState, attended = false): SandboxDetail {
  return {
    id, repoId: "acme-dev", branch: `branch-${id}`, imageTag: "base:1",
    state, createdAt: "2026-08-10T00:00:00Z", ports: {}, lastEventSeq: 0,
    ...(attended ? { attended: true } : {}),
  };
}

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

describe("sandboxPickerCandidates", () => {
  // One of every relevant shape: the picker fixture pool.
  const pool: SandboxDetail[] = [
    sb("aaaa-running-headless", "running"),
    sb("bbbb-running-attended", "running", true),
    sb("cccc-suspended", "suspended"),
    sb("dddd-creating", "creating"),
    sb("eeee-error", "error"),
    sb("ffff-destroyed", "destroyed"),
  ];
  const ids = (verb: Parameters<typeof sandboxPickerCandidates>[1]) =>
    sandboxPickerCandidates(pool, verb).map(d => d.id);

  test("attach offers only running attended lanes (prepareAttendedAttach's own gates)", () => {
    expect(ids("attach")).toEqual(["bbbb-running-attended"]);
  });
  test("steer offers only running headless lanes (the lane supervisor consumes steer.md)", () => {
    expect(ids("steer")).toEqual(["aaaa-running-headless"]);
  });
  test("suspend offers running sandboxes, attended or not (compute to drop)", () => {
    expect(ids("suspend")).toEqual(["aaaa-running-headless", "bbbb-running-attended"]);
  });
  test("resume offers only suspended sandboxes", () => {
    expect(ids("resume")).toEqual(["cccc-suspended"]);
  });
  test("events and destroy offer everything not destroyed (triage + cleanup verbs)", () => {
    const everythingLive = ["aaaa-running-headless", "bbbb-running-attended", "cccc-suspended", "dddd-creating", "eeee-error"];
    expect(ids("events")).toEqual(everythingLive);
    expect(ids("destroy")).toEqual(everythingLive);
  });
});

describe("formatSandboxAge", () => {
  const now = Date.parse("2026-08-10T12:00:00Z");
  test("compact m/h/d buckets", () => {
    expect(formatSandboxAge("2026-08-10T11:59:40Z", now)).toBe("now");
    expect(formatSandboxAge("2026-08-10T11:15:00Z", now)).toBe("45m");
    expect(formatSandboxAge("2026-08-10T09:00:00Z", now)).toBe("3h");
    expect(formatSandboxAge("2026-08-08T12:00:00Z", now)).toBe("2d");
  });
  test("unparseable createdAt renders ? instead of NaN", () => {
    expect(formatSandboxAge("not-a-date", now)).toBe("?");
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
