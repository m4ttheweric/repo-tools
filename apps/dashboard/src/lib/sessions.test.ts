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
    expect(sessionLabel(rec({ id: "portal-wktree-2:dev" }))).toBe("dev");
  });
  test("shell label is 'shell N' from the term:<dir>:<n> id", () => {
    expect(sessionLabel(rec({ id: "term:portal:2", kind: "terminal" }))).toBe("shell 2");
  });
  test("prefers the herdr agent name over a raw term_ id", () => {
    expect(sessionLabel(rec({ id: "term_655065a87e0714a", agent: "claude" }))).toBe("claude");
  });
  test("bare herdr pane with no agent reads 'terminal', not the raw id", () => {
    expect(sessionLabel(rec({ id: "term_65501f0f20e422a" }))).toBe("terminal");
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

  test("numbers duplicate labels within a worktree (claude 1, claude 2); singletons unnumbered", () => {
    const out = sessionsForWorktree([
      rec({ id: "term_aaa", agent: "claude", state: "running" }),
      rec({ id: "term_bbb", agent: "claude", state: "running" }),
      rec({ id: "term_ccc", agent: "codex", state: "running" }),
    ]);
    expect(out.map((s) => s.label)).toEqual(["claude 1", "claude 2", "codex"]);
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
