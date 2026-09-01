import { describe, it, expect } from "bun:test";
import { isInsideHerdr, splitPane } from "../herdr-launch.ts";

describe("herdr-launch", () => {
  it("isInsideHerdr returns false when HERDR_ENV is unset", () => {
    const prev = process.env.HERDR_ENV;
    delete process.env.HERDR_ENV;
    expect(isInsideHerdr()).toBe(false);
    if (prev) process.env.HERDR_ENV = prev;
  });

  it("isInsideHerdr returns true when HERDR_ENV=1", () => {
    const prev = process.env.HERDR_ENV;
    process.env.HERDR_ENV = "1";
    expect(isInsideHerdr()).toBe(true);
    if (prev) process.env.HERDR_ENV = prev;
    else delete process.env.HERDR_ENV;
  });
});

describe("splitPane", () => {
  it("a 102x81 parent rect drives a --direction down split", () => {
    const calls: string[] = [];
    const exec = (cmd: string) => {
      calls.push(cmd);
      if (cmd.includes("pane layout")) {
        return JSON.stringify({ result: { layout: { panes: [{ pane_id: "ws1:%0", rect: { width: 102, height: 81, x: 0, y: 0 } }] } } });
      }
      if (cmd.includes("pane split")) return JSON.stringify({ result: { pane: { pane_id: "ws1:%9" } } });
      throw new Error(`unexpected exec: ${cmd}`);
    };
    expect(splitPane("ws1:%0", exec)).toBe("ws1:%9");
    expect(calls[0]).toBe("herdr pane layout --pane ws1:%0");
    expect(calls[1]).toBe("herdr pane split ws1:%0 --direction down --no-focus");
  });

  it("a tiny parent rect drives a tab create", () => {
    const calls: string[] = [];
    const exec = (cmd: string) => {
      calls.push(cmd);
      if (cmd.includes("pane layout")) {
        return JSON.stringify({ result: { layout: { panes: [{ pane_id: "ws1:%0", rect: { width: 40, height: 20, x: 0, y: 0 } }] } } });
      }
      if (cmd.includes("tab create")) return JSON.stringify({ result: { root_pane: { pane_id: "ws1:%new" } } });
      throw new Error(`unexpected exec: ${cmd}`);
    };
    expect(splitPane("ws1:%0", exec)).toBe("ws1:%new");
    expect(calls[1]).toBe("herdr tab create --workspace ws1 --no-focus");
  });

  it("a layout lookup failure falls back to a right split (parity with the old default)", () => {
    const calls: string[] = [];
    const exec = (cmd: string) => {
      calls.push(cmd);
      if (cmd.includes("pane layout")) throw new Error("herdr: pane not found");
      if (cmd.includes("pane split")) return JSON.stringify({ result: { pane: { pane_id: "ws1:%9" } } });
      throw new Error(`unexpected exec: ${cmd}`);
    };
    expect(splitPane("ws1:%0", exec)).toBe("ws1:%9");
    expect(calls[1]).toBe("herdr pane split ws1:%0 --direction right --no-focus");
  });

  it("throws when the split reply carries no pane_id", () => {
    const exec = (cmd: string) => {
      if (cmd.includes("pane layout")) {
        return JSON.stringify({ result: { layout: { panes: [{ pane_id: "ws1:%0", rect: { width: 102, height: 81, x: 0, y: 0 } }] } } });
      }
      return JSON.stringify({ result: { pane: {} } });
    };
    expect(() => splitPane("ws1:%0", exec)).toThrow("herdr pane split did not return a pane_id");
  });
});
