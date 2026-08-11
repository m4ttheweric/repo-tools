import { describe, expect, spyOn, test } from "bun:test";
import { dispatchLifecycle, parseAgentSelection, parseAttachArgs, parseEventsArgs, renderSandboxEvent, requireBrief, resolveSandboxOrExit } from "../../commands/sandbox.ts";
import { formatSandboxAge, sandboxPickerCandidates, sandboxPickerRow } from "../sandbox.ts";
import type { SandboxClient, SandboxDetail, SandboxEvent, SandboxState } from "../sandbox.ts";

/** Minimal SandboxDetail for picker tests. */
function sb(id: string, state: SandboxState, attended = false): SandboxDetail {
  return {
    id, repoId: "assured-dev", branch: `branch-${id}`, imageTag: "base:1",
    state, createdAt: "2026-08-10T00:00:00Z", ports: {}, lastEventSeq: 0,
    ...(attended ? { attended: true } : {}),
  };
}

/** Fake client whose ground truth is just a list of ids (resolution tests). */
function clientWith(ids: string[]): SandboxClient {
  const details = ids.map(id => sb(id, "running"));
  return { async list() { return details; } } as unknown as SandboxClient;
}

describe("resolveSandboxOrExit", () => {
  // The RT-24 live failure: an 8-char short id typed at a verb.
  const full = "b37d2680-193d-42c0-9317-ecc0148c70e4";
  const other = "f00dfeed-1111-2222-3333-444455556666";

  test("an unambiguous prefix resolves to the full sandbox", async () => {
    const detail = await resolveSandboxOrExit(clientWith([full, other]), "b37d2680");
    expect(detail.id).toBe(full);
  });

  test("an exact id passes through untouched (picker-selected ids re-resolve as exact hits)", async () => {
    const detail = await resolveSandboxOrExit(clientWith(["abc", "abcd"]), "abc");
    expect(detail.id).toBe("abc");
  });

  // The refusal paths follow attach's idiom exactly: the resolver's message
  // in red on stderr, then exit 64. Client failures infraExit (2). The exits
  // are trapped as thrown sentinels so the test process survives.
  async function trapExit(run: () => Promise<unknown>): Promise<{ code: number | undefined; stderr: string }> {
    const lines: string[] = [];
    const errSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.join(" "));
    });
    const exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw Object.assign(new Error(`exit ${code}`), { exitCode: code });
    }) as typeof process.exit);
    try {
      await run();
      throw new Error("expected an exit, got a return");
    } catch (err) {
      return { code: (err as { exitCode?: number }).exitCode, stderr: lines.join("\n") };
    } finally {
      errSpy.mockRestore();
      exitSpy.mockRestore();
    }
  }

  test("an ambiguous prefix exits 64 naming the candidate ids", async () => {
    const out = await trapExit(() => resolveSandboxOrExit(clientWith(["abc-1", "abc-2"]), "abc"));
    expect(out.code).toBe(64);
    expect(out.stderr).toContain("abc-1");
    expect(out.stderr).toContain("abc-2");
  });

  test("not-found exits 64 with the resolver's message, never a raw controller 404", async () => {
    const out = await trapExit(() => resolveSandboxOrExit(clientWith([full]), "zzz"));
    expect(out.code).toBe(64);
    expect(out.stderr).toContain("sandbox zzz not found");
  });

  test("a client failure infraExits (2), the family's plumbing-error idiom", async () => {
    const broken = { async list(): Promise<SandboxDetail[]> { throw new Error("controller GET /sandboxes failed: 502"); } } as unknown as SandboxClient;
    const out = await trapExit(() => resolveSandboxOrExit(broken, "b37d"));
    expect(out.code).toBe(2);
    expect(out.stderr).toContain("502");
  });
});

describe("dispatchLifecycle", () => {
  const full = "b37d2680-193d-42c0-9317-ecc0148c70e4";
  const other = "f00dfeed-1111-2222-3333-444455556666";

  /** Fake client that records which id each lifecycle call received. */
  function recordingClient(ids: string[]) {
    const calls: Array<[string, string]> = [];
    const details = ids.map(id => sb(id, "running"));
    const client = {
      async list() { return details; },
      async suspend(id: string) { calls.push(["suspend", id]); },
      async up(id: string) { calls.push(["up", id]); },
      async destroy(id: string) { calls.push(["destroy", id]); },
    } as unknown as SandboxClient;
    return { client, calls };
  }

  test("RT-24 regression: destroy with an unambiguous 8-char prefix sends the FULL id to the controller", async () => {
    // The live failure: `rt sandbox destroy b37d2680` shipped the prefix raw
    // and the controller 404ed. The controller must only ever see full ids.
    const { client, calls } = recordingClient([full, other]);
    const resolved = await dispatchLifecycle(client, "destroy", "b37d2680");
    expect(resolved).toBe(full);
    expect(calls).toEqual([["destroy", full]]);
  });

  test("suspend and resume resolve through the same seam (resume maps to the controller's up)", async () => {
    const { client, calls } = recordingClient([full, other]);
    await dispatchLifecycle(client, "suspend", "b37d2680");
    await dispatchLifecycle(client, "resume", "f00dfeed");
    expect(calls).toEqual([["suspend", full], ["up", other]]);
  });
});

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

describe("sandboxPickerRow", () => {
  const now = Date.parse("2026-08-10T12:00:00Z");
  const detail: SandboxDetail = {
    ...sb("0b70c1d2-3e4f-5a6b-7c8d-9e0f1a2b3c4d", "running"),
    branch: "goodwinmattheweric/mat-273-scratch",
    createdAt: "2026-08-10T09:00:00Z",
  };

  test("value is the full id — the selection feeds the verb exactly as a typed id", () => {
    expect(sandboxPickerRow(detail, now).value).toBe("0b70c1d2-3e4f-5a6b-7c8d-9e0f1a2b3c4d");
  });
  test("label is the friendly identity: repo · branch, never the bare UUID", () => {
    expect(sandboxPickerRow(detail, now).label).toBe("assured-dev · goodwinmattheweric/mat-273-scratch");
  });
  test("hint carries short id, state, and age", () => {
    expect(sandboxPickerRow(detail, now).hint).toBe("0b70c1d2  running  3h");
  });
  test("attended lanes are marked in the hint", () => {
    const attended = { ...detail, attended: true };
    expect(sandboxPickerRow(attended, now).hint).toBe("0b70c1d2  running  3h  attended");
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
