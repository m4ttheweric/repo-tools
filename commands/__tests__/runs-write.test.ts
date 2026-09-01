import { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { DAEMON_SOCK_PATH } from "../../lib/daemon-config.ts";
import { runWriteVerb } from "../runs-write.ts";
import { runsList } from "../runs.ts";

const QUIET = { RT_RUN_EMIT: "0" };

async function startRun(): Promise<{ env: Record<string, string>; runDb: string }> {
  const root = mkdtempSync(join(tmpdir(), "rt-runs-cli-"));
  const r = await runWriteVerb("run-start", ["--repo", "demo", "--work-type", "fix", "--pipeline", "default"], { RT_RUNS_ROOT: root, ...QUIET });
  const parsed = JSON.parse(r.out);
  return { env: { RT_RUN_DB: parsed.runDb, ...QUIET }, runDb: parsed.runDb };
}

describe("rt runs write verbs", () => {
  test("run-start prints ok, runId, runDb and exits 0", async () => {
    const root = mkdtempSync(join(tmpdir(), "rt-runs-cli-"));
    const r = await runWriteVerb("run-start", ["--repo", "demo", "--work-type", "feature", "--pipeline", "default", "--spawned-by", "test"], { RT_RUNS_ROOT: root, ...QUIET });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out);
    expect(out.ok).toBe(true);
    expect(out.runDb).toBe(join(root, "demo", out.runId, "state.db"));
    expect(existsSync(out.runDb)).toBe(true);
  });

  test("run-start without its required flags is a JSON usage error, exit 2", async () => {
    const r = await runWriteVerb("run-start", ["--repo", "demo"], QUIET);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false });
  });

  test("run-start rejects a --mattstack-dirty value outside 0|1", async () => {
    const root = mkdtempSync(join(tmpdir(), "rt-runs-cli-"));
    const r = await runWriteVerb("run-start", ["--repo", "demo", "--work-type", "fix", "--pipeline", "default", "--mattstack-dirty", "2"], { RT_RUNS_ROOT: root, ...QUIET });
    expect(r.code).toBe(2);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false });
  });

  test("a value flag with no value is exit 2", async () => {
    const { env } = await startRun();
    const r = await runWriteVerb("stage-start", ["--stage"], env);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.out).error).toContain("--stage");
  });

  test("an empty required flag value is a usage error, not a stage named the empty string", async () => {
    const { env, runDb } = await startRun();
    const r = await runWriteVerb("stage-start", ["--stage", ""], env);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.out).ok).toBe(false);
    const db = new Database(runDb, { readonly: true });
    expect(db.query("SELECT COUNT(*) AS n FROM stages").get()).toEqual({ n: 0 });
    db.close();
  });

  test("subcommands without RT_RUN_DB fail with a JSON error, exit 2", async () => {
    const r = await runWriteVerb("run-status", ["--status", "done"], QUIET);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.out)).toEqual({ ok: false, error: "RT_RUN_DB is not set" });
    const missing = await runWriteVerb("snapshot", [], { RT_RUN_DB: "/nowhere/state.db", ...QUIET });
    expect(missing.code).toBe(2);
    expect(JSON.parse(missing.out).error).toContain("run DB not found");
  });

  test("stage lifecycle through the CLI, including the never-started guard at exit 3", async () => {
    const { env, runDb } = await startRun();
    expect(await runWriteVerb("stage-done", ["--stage", "plan"], env)).toEqual({ out: JSON.stringify({ ok: false, error: "stage never started: plan" }), code: 3 });
    expect((await runWriteVerb("stage-start", ["--stage", "plan"], env)).out).toBe('{"ok":true}');
    expect((await runWriteVerb("stage-done", ["--stage", "plan"], env)).code).toBe(0);
    expect((await runWriteVerb("stage-start", ["--stage", "plan"], env)).code).toBe(0);
    expect((await runWriteVerb("stage-fail", ["--stage", "plan", "--reason", "boom", "--detail-path", "/tmp/x.log"], env)).code).toBe(0);
    const db = new Database(runDb, { readonly: true });
    expect(db.query("SELECT attempt, status, reason FROM stages ORDER BY attempt").all()).toEqual([{ attempt: 1, status: "done", reason: null }, { attempt: 2, status: "failed", reason: "boom" }]);
    db.close();
  });

  test("field set prints ok; field get prints the raw value or nothing with exit 3", async () => {
    const { env } = await startRun();
    expect(await runWriteVerb("field", ["set", "mr-url", "https://x/1?a='b'", "--stage", "ship"], env)).toEqual({ out: '{"ok":true}', code: 0 });
    expect(await runWriteVerb("field", ["get", "mr-url"], env)).toEqual({ out: "https://x/1?a='b'", code: 0 });
    expect(await runWriteVerb("field", ["get", "nope"], env)).toEqual({ out: "", code: 3 });
    expect((await runWriteVerb("field", ["set", "k"], env)).code).toBe(2);
    expect((await runWriteVerb("field", ["frob"], env)).code).toBe(2);
  });

  test("decision record, snapshot, and run-status", async () => {
    const { env } = await startRun();
    expect((await runWriteVerb("decision", ["record", "--contract", "execution-strategy@1", "--scope", "run", "--selection", '{"tier":"direct-tdd"}', "--decided-by", "stage-plan"], env)).code).toBe(0);
    expect((await runWriteVerb("decision", ["record", "--contract", "c", "--scope", "run", "--selection", "nope", "--decided-by", "x"], env)).code).toBe(2);
    const snap = JSON.parse((await runWriteVerb("snapshot", [], env)).out);
    expect(snap.ok).toBe(true);
    expect(snap.run.status).toBe("running");
    expect(snap.decisions).toHaveLength(1);
    expect((await runWriteVerb("run-status", ["--status", "done"], env)).out).toBe('{"ok":true}');
    expect((await runWriteVerb("run-status", ["--status", "paused"], env)).code).toBe(2);
    expect(JSON.parse((await runWriteVerb("snapshot", [], env)).out).run.status).toBe("done");
  });

  test("a write emits run-updated when a daemon is listening", async () => {
    mkdirSync(dirname(DAEMON_SOCK_PATH), { recursive: true });
    if (existsSync(DAEMON_SOCK_PATH)) rmSync(DAEMON_SOCK_PATH);
    const seen: unknown[] = [];
    const server = Bun.serve({
      unix: DAEMON_SOCK_PATH,
      async fetch(req) { seen.push(await req.json()); return new Response(JSON.stringify({ ok: true })); },
    });
    try {
      const { env } = await startRun();
      await runWriteVerb("stage-start", ["--stage", "plan"], { RT_RUN_DB: env.RT_RUN_DB });
      expect(seen).toEqual([{ topic: "run-updated", payload: { repo: "demo", runId: expect.any(String), stage: "plan", kind: "stage-start" } }]);
    } finally {
      server.stop(true);
      if (existsSync(DAEMON_SOCK_PATH)) rmSync(DAEMON_SOCK_PATH);
    }
  });
});

describe("rt runs positional rejection", () => {
  test("a positional that is not a subcommand is a usage error, exit 2, before any daemon call", async () => {
    const exitSpy = spyOn(process, "exit").mockImplementation((() => { throw new Error("exit"); }) as never);
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(runsList(["stage-start", "--stage", "plan"])).rejects.toThrow("exit");
      expect(exitSpy).toHaveBeenCalledWith(2);
      expect(String(errSpy.mock.calls[0]?.[0])).toContain("unknown subcommand");
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});
