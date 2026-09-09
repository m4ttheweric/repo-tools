import { describe, test, expect } from "bun:test";
import { attendPane } from "../attend.ts";
import type { HerdrRunner } from "../../agent-herdr.ts";

function fakeRunnerFor(calls: Array<{ socket: string | null; args: string[] }>, opts: {
  terminalId?: unknown;
  tabExit?: number;
  tabStdout?: string;
} = {}): (socket: string | null) => HerdrRunner {
  const terminalId = opts.terminalId ?? "term-7";
  return (socket: string | null) => async (args: string[]) => {
    calls.push({ socket, args });
    if (args[0] === "pane" && args[1] === "get") {
      return { stdout: JSON.stringify({ result: { pane: { terminal_id: terminalId } } }), exitCode: 0 };
    }
    if (args[0] === "tab" && args[1] === "create") {
      if (opts.tabStdout !== undefined) return { stdout: opts.tabStdout, exitCode: opts.tabExit ?? 0 };
      return { stdout: JSON.stringify({ result: { root_pane: { pane_id: "wv:p9", tab_id: "wv:t9" } } }), exitCode: opts.tabExit ?? 0 };
    }
    return { stdout: "{}", exitCode: 0 };
  };
}

describe("attendPane", () => {
  test("resolves the terminal id on the given socket, opens a visible tab, and attaches with --takeover", async () => {
    const calls: Array<{ socket: string | null; args: string[] }> = [];
    const res = await attendPane({
      socket: "/tmp/bg.sock", paneId: "wh:p1", session: "bg", label: "attend: job-a",
      callerWorkspace: "wv", herdrRunnerFor: fakeRunnerFor(calls),
    });
    expect(res).toEqual({ ok: true, tab: "wv:t9", pane: "wh:p1" });
    expect(calls).toContainEqual({ socket: "/tmp/bg.sock", args: ["pane", "get", "wh:p1"] });
    expect(calls).toContainEqual({ socket: null, args: ["tab", "create", "--workspace", "wv", "--label", "attend: job-a", "--focus"] });
    const run = calls.find((c) => c.args[0] === "pane" && c.args[1] === "run")!;
    expect(run.socket).toBeNull();
    expect(run.args[2]).toBe("wv:p9");
    expect(run.args[3]).toBe("env -u HERDR_SOCKET_PATH HERDR_SESSION=bg herdr terminal attach term-7 --takeover");
  });

  test("rejects a non-string terminal_id without creating a tab", async () => {
    const calls: Array<{ socket: string | null; args: string[] }> = [];
    const res = await attendPane({
      socket: "/tmp/bg.sock", paneId: "wh:p1", session: "bg", label: "attend: job-a",
      callerWorkspace: "wv", herdrRunnerFor: fakeRunnerFor(calls, { terminalId: 7 }),
    });
    expect(res).toEqual({ ok: false, error: "hidden pane reported no terminal id" });
    expect(calls.some((c) => c.args[0] === "tab")).toBe(false);
  });

  test("fails cleanly when tab create exits zero with non-JSON output", async () => {
    const calls: Array<{ socket: string | null; args: string[] }> = [];
    const res = await attendPane({
      socket: "/tmp/bg.sock", paneId: "wh:p1", session: "bg", label: "attend: job-a",
      callerWorkspace: "wv", herdrRunnerFor: fakeRunnerFor(calls, { tabStdout: "nope" }),
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.error).toMatch(/invalid JSON/);
    expect(calls.some((c) => c.args[0] === "pane" && c.args[1] === "run")).toBe(false);
  });
});
