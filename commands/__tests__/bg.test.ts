import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { bgRelease, bgStatus, bgStop, renderStatus } from "../bg.ts";

let home: string;
let origHome: string | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let seen: Array<{ cmd: string; payload: unknown }> = [];
let replies: Record<string, unknown> = {};

beforeEach(() => {
  origHome = process.env.HOME;
  home = realpathSync(mkdtempSync(join(tmpdir(), "rt-bg-cli-")));
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

// ─── status ─────────────────────────────────────────────────────────────────

test("renderStatus: no claims says so plainly", () => {
  const text = renderStatus({ up: true, socket: "/tmp/bg.sock", claims: [] });
  expect(text).toContain("server: up");
  expect(text).toContain("socket: /tmp/bg.sock");
  expect(text).toContain("no live claims");
});

test("renderStatus: claims render owner, pane, age", () => {
  const now = Date.now();
  const text = renderStatus({
    up: true, socket: "/tmp/bg.sock",
    claims: [{ owner: "herd:hd-1", pane: "bg:w1:p1", createdAt: now - 5_000 }],
  });
  expect(text).toContain("herd:hd-1");
  expect(text).toContain("bg:w1:p1");
  expect(text).toMatch(/5s/);
});

test("bg status --json prints the raw record; plain prints the rendering", async () => {
  const data = { up: false, socket: "/tmp/bg.sock", claims: [] };
  replies = { "bg:status": { ok: true, data } };
  const json = await run(bgStatus, ["--json"]);
  expect(JSON.parse(json.stdout)).toEqual({ ok: true, ...data });
  const plain = await run(bgStatus, []);
  expect(plain.stdout).toContain("server: down");
});

// ─── release ────────────────────────────────────────────────────────────────

test("bg release <owner> forwards the claim and prints the outcome", async () => {
  replies = { "bg:release": { ok: true, data: { released: true } } };
  const r = await run(bgRelease, ["herd:hd-1"]);
  expect(seen[0]).toEqual({ cmd: "bg:release", payload: { claim: "herd:hd-1" } });
  expect(r.stdout).toBe("released herd:hd-1");
  expect(r.code).toBe(0);
});

test("bg release <owner> --json prints the raw record", async () => {
  replies = { "bg:release": { ok: true, data: { released: false } } };
  const r = await run(bgRelease, ["herd:hd-1", "--json"]);
  expect(JSON.parse(r.stdout)).toEqual({ ok: true, released: false });
});

test("bg release with no owner and no TTY fails with usage (never spawns a picker)", async () => {
  const r = await run(bgRelease, []);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("usage");
  expect(seen).toEqual([]);
});

test("bg release --json with no owner fails with usage even under RT_BATCH-less env", async () => {
  const r = await run(bgRelease, ["--json"]);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("usage");
});

test("bg release exits non-zero when the daemon refuses", async () => {
  replies = { "bg:release": { ok: false, error: "no such claim" } };
  const r = await run(bgRelease, ["herd:hd-1"]);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("no such claim");
});

// ─── stop ───────────────────────────────────────────────────────────────────

test("bg stop prints stopped on success", async () => {
  replies = { "bg:stop": { ok: true, data: { stopped: true } } };
  const r = await run(bgStop, []);
  expect(r.stdout).toBe("stopped");
  expect(r.code).toBe(0);
});

test("bg stop --json prints the raw record", async () => {
  replies = { "bg:stop": { ok: true, data: { stopped: true } } };
  const r = await run(bgStop, ["--json"]);
  expect(JSON.parse(r.stdout)).toEqual({ ok: true, stopped: true });
});

test("bg stop renders the daemon's refusal text plainly and exits 1", async () => {
  replies = { "bg:stop": { ok: false, error: "bg server has live claims: herd:hd-1, runner:123" } };
  const r = await run(bgStop, []);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("bg server has live claims: herd:hd-1, runner:123");
});
