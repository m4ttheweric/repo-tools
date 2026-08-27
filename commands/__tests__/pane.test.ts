import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { paneAccounts, paneDirectories, paneList, panePeek, paneSpawn } from "../pane.ts";

let home: string;
let origHome: string | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let seen: Array<{ cmd: string; payload: unknown }> = [];
let replies: Record<string, unknown> = {};

beforeEach(() => {
  origHome = process.env.HOME;
  home = realpathSync(mkdtempSync(join(tmpdir(), "rt-pane-cli-")));
  process.env.HOME = home;
  const sockDir = join(home, ".mattstack", "rt");
  mkdirSync(sockDir, { recursive: true });
  seen = [];
  server = Bun.serve({
    unix: join(sockDir, "rt.sock"),
    async fetch(req) {
      const cmd = new URL(req.url).pathname.slice(1);
      const payload = req.method === "POST" ? await req.json() : {};
      seen.push({ cmd, payload });
      return Response.json(replies[cmd] ?? { ok: false, error: `unknown command: ${cmd}` });
    },
  });
});

afterEach(() => {
  server?.stop(true);
  process.env.HOME = origHome;
});

async function run(fn: (args: string[]) => Promise<void>, args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const logSpy = spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(" ")); });
  const errSpy = spyOn(console, "error").mockImplementation((...a: unknown[]) => { err.push(a.map(String).join(" ")); });
  const exitSpy = spyOn(process, "exit").mockImplementation(() => { throw new Error("process.exit sentinel"); });
  let code = 0;
  try {
    await fn(args);
  } catch (e) {
    if (e instanceof Error && e.message === "process.exit sentinel") code = (exitSpy.mock.calls.at(-1)?.[0] as number | undefined) ?? 1;
    else throw e;
  } finally {
    logSpy.mockRestore(); errSpy.mockRestore(); exitSpy.mockRestore();
  }
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

const PANE = { paneId: "w1:p1", workspace: "acme", title: "Evaluate codegen", cwd: "/repos/acme", repo: "acme", branch: "main", agentStatus: "idle", presence: { handle: "meg", status: "live", rooms: ["build"] } };

test("pane list --json prints the rows; plain prints one line per pane", async () => {
  const panes = [PANE, { ...PANE, paneId: "w1:p2", presence: undefined, title: "fred" }];
  replies = { "pane:list": { ok: true, data: { panes } } };
  const json = await run(paneList, ["--json"]);
  expect(JSON.parse(json.stdout)).toEqual({ ok: true, panes });
  const plain = await run(paneList, []);
  expect(plain.stdout).toContain("w1:p1");
  expect(plain.stdout).toContain("meg");
  expect(plain.stdout).toContain("not signed in");
});

test("pane list reports herdr unavailable and exits 1", async () => {
  replies = { "pane:list": { ok: false, error: "herdr unavailable: no socket" } };
  const r = await run(paneList, []);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("herdr unavailable");
});

test("pane peek passes the pane id and --lines", async () => {
  replies = { "pane:peek": { ok: true, data: { paneId: "w1:p1", lines: ["a", "b"] } } };
  const r = await run(panePeek, ["w1:p1", "--lines", "2"]);
  expect(seen[0]).toEqual({ cmd: "pane:peek", payload: { paneId: "w1:p1", lines: 2 } });
  expect(r.stdout).toBe("a\nb");
});

test("pane spawn passes every flag and prints the pane and readiness", async () => {
  replies = { "pane:spawn": { ok: true, data: { pane: PANE, ready: true } } };
  const r = await run(paneSpawn, ["--cwd", "/repos/acme", "--account", "Acme", "--model", "claude-fable-5", "--effort", "high", "--workspace", "chat", "--prompt", "read AGENTS.md", "--json"]);
  expect(seen[0]!.payload).toEqual({ cwd: "/repos/acme", account: "Acme", model: "claude-fable-5", effort: "high", workspace: "chat", prompt: "read AGENTS.md" });
  expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, ready: true, pane: { paneId: "w1:p1" } });
});

test("pane spawn requires --cwd", async () => {
  const r = await run(paneSpawn, []);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("--cwd");
});

test("pane accounts and directories render", async () => {
  replies = {
    "pane:accounts": { ok: true, data: { accounts: [{ slot: 1, email: "a@b.c", alias: "A", headroom: "5h 3%" }] } },
    "pane:directories": { ok: true, data: { directories: [{ path: "/repos/chat", repo: "chat" }] } },
  };
  expect((await run(paneAccounts, [])).stdout).toContain("A");
  const d = await run(paneDirectories, ["--q", "chat"]);
  expect(seen.at(-1)).toEqual({ cmd: "pane:directories", payload: { q: "chat" } });
  expect(d.stdout).toContain("/repos/chat");
});
