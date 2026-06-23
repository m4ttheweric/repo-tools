import { describe, test, expect } from "bun:test";
import { isLive, sessionLabel, statusDotClass, sessionsForWorktree } from "./sessions.ts";
import type { ProcessRecord } from "./types.ts";

const rec = (over: Partial<ProcessRecord>): ProcessRecord => ({
  id: "x", cmd: "", cwd: "/w", state: "running", ...over,
});

describe("isLive", () => {
  test("running/starting/warm are live; stopped/crashed/stopping are not", () => {
    expect(isLive("running")).toBe(true);
    expect(isLive("starting")).toBe(true);
    expect(isLive("warm")).toBe(true);
    expect(isLive("stopped")).toBe(false);
    expect(isLive("crashed")).toBe(false);
    expect(isLive("stopping")).toBe(false);
  });
});

describe("sessionLabel", () => {
  test("command label is the id suffix after the last colon", () => {
    expect(sessionLabel(rec({ id: "adjuster-wktree-2:dev" }))).toBe("dev");
  });
  test("shell label is 'shell N' from the term:<dir>:<n> id", () => {
    expect(sessionLabel(rec({ id: "term:adjuster:2", kind: "terminal" }))).toBe("shell 2");
  });
});

describe("statusDotClass", () => {
  test("maps state to a sel-* / muted dot class", () => {
    expect(statusDotClass("running")).toBe("bg-sel-green");
    expect(statusDotClass("crashed")).toBe("bg-sel-red");
    expect(statusDotClass("starting")).toBe("bg-sel-yellow");
    expect(statusDotClass("stopping")).toBe("bg-sel-yellow");
    expect(statusDotClass("warm")).toBe("bg-sel-yellow");
    expect(statusDotClass("stopped")).toBe("bg-muted-foreground");
  });
});

describe("sessionsForWorktree", () => {
  test("keeps all command sessions (any state) and only live shells; commands first", () => {
    const recs: ProcessRecord[] = [
      rec({ id: "w:dev", state: "running" }),
      rec({ id: "w:build", state: "stopped" }),               // dead command — kept
      rec({ id: "term:w:1", kind: "terminal", state: "running" }), // live shell — kept
      rec({ id: "term:w:2", kind: "terminal", state: "stopped" }), // dead shell — dropped
    ];
    const out = sessionsForWorktree(recs);
    expect(out.map((s) => s.id)).toEqual(["w:dev", "w:build", "term:w:1"]);
    expect(out.map((s) => s.kind)).toEqual(["command", "command", "shell"]);
  });

  test("carries through state, cmd, url, startedAt, exitCode", () => {
    const out = sessionsForWorktree([
      rec({ id: "w:dev", cmd: "pnpm run dev", url: "https://x.localhost", startedAt: 5, state: "running" }),
    ]);
    expect(out[0]).toMatchObject({
      id: "w:dev", kind: "command", label: "dev", state: "running",
      cmd: "pnpm run dev", url: "https://x.localhost", startedAt: 5,
    });
  });
});
