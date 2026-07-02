import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  AGENT_WAIT_TIMEOUT_MS,
  herdrAvailable,
  readPane,
  sendTask,
  spawnAgentPane,
  startClaude,
  waitAgentIdle,
} from "../herdr-agent.ts";

let binDir: string;
let savedPath: string;
let savedPaneId: string | undefined;
let savedSocket: string | undefined;

beforeEach(() => {
  binDir = realpathSync(mkdtempSync(join(tmpdir(), "rt-herdr-agent-")));
  savedPath = process.env.PATH ?? "";
  savedPaneId = process.env.HERDR_PANE_ID;
  savedSocket = process.env.HERDR_SOCKET_PATH;

  mkdirSync(join(binDir, "responses"));

  // Fake herdr: record argv, then emit the canned response for the
  // subcommand pair (responses/<arg1>-<arg2>.txt) and exit with its canned
  // status (responses/<arg1>-<arg2>.exit), defaulting to `{}` / exit 0.
  const fake = `#!/bin/sh
echo "$@" >> "${binDir}/calls.log"
resp="${binDir}/responses/$1-$2.txt"
code="${binDir}/responses/$1-$2.exit"
if [ -f "$resp" ]; then cat "$resp"; else echo '{}'; fi
if [ -f "$code" ]; then exit "$(cat "$code")"; fi
exit 0
`;
  writeFileSync(join(binDir, "herdr"), fake);
  chmodSync(join(binDir, "herdr"), 0o755);
  process.env.PATH = `${binDir}:${savedPath}`;

  // herdrAvailable checks the socket path exists; point it at a real file.
  writeFileSync(join(binDir, "fake.sock"), "");
  process.env.HERDR_SOCKET_PATH = join(binDir, "fake.sock");
});

afterEach(() => {
  process.env.PATH = savedPath;
  if (savedPaneId === undefined) delete process.env.HERDR_PANE_ID;
  else process.env.HERDR_PANE_ID = savedPaneId;
  if (savedSocket === undefined) delete process.env.HERDR_SOCKET_PATH;
  else process.env.HERDR_SOCKET_PATH = savedSocket;
  try { rmSync(binDir, { recursive: true, force: true }); } catch { /* */ }
});

function setResponse(sub: string, json: unknown): void {
  writeFileSync(join(binDir, "responses", `${sub}.txt`), JSON.stringify(json));
}

function setExit(sub: string, code: number): void {
  writeFileSync(join(binDir, "responses", `${sub}.exit`), String(code));
}

function calls(): string[] {
  try {
    return readFileSync(join(binDir, "calls.log"), "utf8").trim().split("\n");
  } catch {
    return [];
  }
}

describe("herdrAvailable", () => {
  test("true when the socket exists and workspace list succeeds", () => {
    setResponse("workspace-list", { result: { workspaces: [] } });
    expect(herdrAvailable()).toBe(true);
  });

  test("false when the socket file is missing", () => {
    process.env.HERDR_SOCKET_PATH = join(binDir, "missing.sock");
    expect(herdrAvailable()).toBe(false);
  });

  test("false when the socket exists but workspace list fails", () => {
    setExit("workspace-list", 1);
    expect(herdrAvailable()).toBe(false);
  });
});

describe("spawnAgentPane", () => {
  test("splits own pane when HERDR_PANE_ID is set", () => {
    process.env.HERDR_PANE_ID = "w1:p1";
    setResponse("pane-split", { result: { pane: { pane_id: "w1:p9" } } });
    const pane = spawnAgentPane({ cwd: "/tmp/x", label: "rebase feature", repoName: "x" });
    expect(pane.paneId).toBe("w1:p9");
    expect(calls().some((c) => c.startsWith("pane split w1:p1"))).toBe(true);
  });

  test("creates a tab in the matching workspace when outside herdr", () => {
    delete process.env.HERDR_PANE_ID;
    setResponse("workspace-list", {
      result: { workspaces: [{ workspace_id: "w7", label: "myrepo" }] },
    });
    setResponse("tab-create", { result: { tab: { tab_id: "w7:t3" }, root_pane: { pane_id: "w7:p5" } } });
    const pane = spawnAgentPane({ cwd: "/tmp/myrepo", label: "rebase feature", repoName: "myrepo" });
    expect(pane.paneId).toBe("w7:p5");
    expect(calls().some((c) => c.includes("tab create --workspace w7"))).toBe(true);
  });

  test("creates a workspace when no label matches", () => {
    delete process.env.HERDR_PANE_ID;
    setResponse("workspace-list", { result: { workspaces: [] } });
    setResponse("workspace-create", { result: { root_pane: { pane_id: "w9:p1" } } });
    const pane = spawnAgentPane({ cwd: "/tmp/other", label: "rebase feature", repoName: "other" });
    expect(pane.paneId).toBe("w9:p1");
    expect(calls().some((c) => c.includes("workspace create --cwd /tmp/other"))).toBe(true);
  });
});

describe("startClaude / sendTask / readPane", () => {
  test("startClaude runs claude in the worktree and waits for the prompt", () => {
    setResponse("wait-output", { result: {} });
    startClaude({ paneId: "w1:p9" }, "/tmp/x");
    const log = calls();
    expect(log.some((c) => c.startsWith("pane run w1:p9") && c.includes("claude"))).toBe(true);
    expect(log.some((c) => c.startsWith("wait output w1:p9"))).toBe(true);
  });

  test("startClaude throws when the claude prompt never appears", () => {
    setExit("wait-output", 1);
    expect(() => startClaude({ paneId: "w1:p9" }, "/tmp/x")).toThrow();
  });

  test("sendTask references the task file", () => {
    sendTask({ paneId: "w1:p9" }, "/tmp/task.md");
    expect(calls().some((c) => c.startsWith("pane run w1:p9") && c.includes("/tmp/task.md"))).toBe(true);
  });

  test("readPane returns pane text", () => {
    writeFileSync(join(binDir, "responses", "pane-read.txt"), "some pane output");
    expect(readPane({ paneId: "w1:p9" }, 10)).toContain("some pane output");
  });
});

describe("waitAgentIdle", () => {
  test("resolves idle when herdr exits 0", async () => {
    setExit("wait-agent-status", 0);
    const result = await waitAgentIdle({ paneId: "w1:p9" }, 1000);
    expect(result).toBe("idle");
    expect(calls().some((c) => c.startsWith("wait agent-status w1:p9"))).toBe(true);
  });

  test("resolves timeout when herdr exits non-zero", async () => {
    setExit("wait-agent-status", 1);
    const result = await waitAgentIdle({ paneId: "w1:p9" }, 1000);
    expect(result).toBe("timeout");
  });

  test("AGENT_WAIT_TIMEOUT_MS is ten minutes", () => {
    expect(AGENT_WAIT_TIMEOUT_MS).toBe(10 * 60_000);
  });
});
