import { Database } from "bun:sqlite";
import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
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

type SeenEmission = { topic: string; payload: { repo: string; runId: string; stage: string | null; kind: string } };

async function withFakeDaemon<T>(body: (seen: SeenEmission[]) => Promise<T>): Promise<T> {
  mkdirSync(dirname(DAEMON_SOCK_PATH), { recursive: true });
  if (existsSync(DAEMON_SOCK_PATH)) rmSync(DAEMON_SOCK_PATH);
  const seen: SeenEmission[] = [];
  const server = Bun.serve({
    unix: DAEMON_SOCK_PATH,
    async fetch(req) { seen.push((await req.json()) as SeenEmission); return new Response(JSON.stringify({ ok: true })); },
  });
  try {
    return await body(seen);
  } finally {
    server.stop(true);
    if (existsSync(DAEMON_SOCK_PATH)) rmSync(DAEMON_SOCK_PATH);
  }
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
    const empty = mkdtempSync(join(tmpdir(), "rt-runs-cli-"));
    const r = await runWriteVerb("run-status", ["--status", "done"], { RT_RUNS_ROOT: empty, ...QUIET });
    expect(r.code).toBe(2);
    expect(JSON.parse(r.out)).toEqual({ ok: false, error: "RT_RUN_DB is not set and no running run matches this session or directory" });
    const missing = await runWriteVerb("snapshot", [], { RT_RUN_DB: "/nowhere/state.db", ...QUIET });
    expect(missing.code).toBe(2);
    expect(JSON.parse(missing.out).error).toContain("run DB not found");
  });

  test("a run DB that fails to open returns the contract's error, exit 1, never throws", async () => {
    const root = mkdtempSync(join(tmpdir(), "rt-runs-cli-"));
    const path = join(root, "state.db");
    writeFileSync(path, "not a sqlite database, just garbage bytes");
    const r = await runWriteVerb("snapshot", [], { RT_RUN_DB: path, ...QUIET });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false });
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
    await withFakeDaemon(async (seen) => {
      const { env } = await startRun();
      await runWriteVerb("stage-start", ["--stage", "plan"], { RT_RUN_DB: env.RT_RUN_DB });
      expect(seen).toEqual([{ topic: "run-updated", payload: { repo: "demo", runId: expect.any(String), stage: "plan", kind: "stage-start" } }]);
    });
  });

  test("run-start emits kind run-start with stage null", async () => {
    await withFakeDaemon(async (seen) => {
      const root = mkdtempSync(join(tmpdir(), "rt-runs-cli-"));
      await runWriteVerb("run-start", ["--repo", "demo", "--work-type", "feature", "--pipeline", "default"], { RT_RUNS_ROOT: root });
      expect(seen).toEqual([{ topic: "run-updated", payload: { repo: "demo", runId: expect.any(String), stage: null, kind: "run-start" } }]);
    });
  });

  test.each([
    ["run-status", ["--status", "done"], [], { stage: null, kind: "run-status" }],
    ["stage-done", ["--stage", "plan"], [["stage-start", "--stage", "plan"]], { stage: "plan", kind: "stage-done" }],
    ["stage-fail", ["--stage", "plan"], [["stage-start", "--stage", "plan"]], { stage: "plan", kind: "stage-fail" }],
    ["field", ["set", "mr-url", "https://x", "--stage", "ship"], [], { stage: "ship", kind: "field-set" }],
    ["decision", ["record", "--contract", "c@1", "--scope", "run", "--selection", "{}", "--decided-by", "w"], [], { stage: "run", kind: "decision" }],
  ] as [string, string[], string[][], { stage: string | null; kind: string }][])(
    "%s emits the row's own kind and stage",
    async (verb, args, setup, want) => {
      await withFakeDaemon(async (seen) => {
        const { env } = await startRun();
        const emitting = { RT_RUN_DB: env.RT_RUN_DB };
        for (const [setupVerb, ...setupArgs] of setup) await runWriteVerb(setupVerb as Parameters<typeof runWriteVerb>[0], setupArgs, emitting);
        await runWriteVerb(verb as Parameters<typeof runWriteVerb>[0], args, emitting);
        const last = seen[seen.length - 1];
        expect(last?.payload.kind).toBe(want.kind);
        expect(last?.payload.stage).toBe(want.stage);
      });
    },
  );
});

describe("RT_RUN_DB fallback", () => {
  const RUN = ["--repo", "demo", "--work-type", "fix", "--pipeline", "default"];

  test("field set without RT_RUN_DB resolves by session and reports runDbResolved", async () => {
    const root = mkdtempSync(join(tmpdir(), "rt-runs-cli-"));
    const env = { RT_RUNS_ROOT: root, CLAUDE_CODE_SESSION_ID: "sess-cli-1", ...QUIET };
    const started = JSON.parse((await runWriteVerb("run-start", RUN, env)).out);
    expect(await runWriteVerb("field", ["set", "branch", "x", "--stage", "provision"], env)).toEqual({ out: '{"ok":true,"runDbResolved":"session"}', code: 0 });
    const db = new Database(started.runDb, { readonly: true });
    expect(db.query("SELECT value FROM fields WHERE key='branch'").get()).toEqual({ value: "x" });
    db.close();
  });

  test("with RT_RUN_DB set the envelope is unchanged", async () => {
    const { env } = await startRun();
    expect(await runWriteVerb("field", ["set", "branch", "x", "--stage", "provision"], { ...env, CLAUDE_CODE_SESSION_ID: "sess-cli-2" })).toEqual({ out: '{"ok":true}', code: 0 });
    const snap = JSON.parse((await runWriteVerb("snapshot", [], env)).out);
    expect(Object.keys(snap)).toEqual(["ok", "run", "stages", "fields", "decisions"]);
  });

  test("field get without RT_RUN_DB still prints the raw value", async () => {
    const root = mkdtempSync(join(tmpdir(), "rt-runs-cli-"));
    const env = { RT_RUNS_ROOT: root, CLAUDE_CODE_SESSION_ID: "sess-cli-3", ...QUIET };
    await runWriteVerb("run-start", [...RUN, "--ticket", "ABC-9"], env);
    expect(await runWriteVerb("field", ["get", "ticket"], env)).toEqual({ out: "ABC-9", code: 0 });
  });

  test("snapshot without RT_RUN_DB appends runDbResolved after the rows", async () => {
    const root = mkdtempSync(join(tmpdir(), "rt-runs-cli-"));
    const env = { RT_RUNS_ROOT: root, CLAUDE_CODE_SESSION_ID: "sess-cli-5", ...QUIET };
    await runWriteVerb("run-start", RUN, env);
    const snap = JSON.parse((await runWriteVerb("snapshot", [], env)).out);
    expect(Object.keys(snap)).toEqual(["ok", "run", "stages", "fields", "decisions", "runDbResolved"]);
    expect(snap.runDbResolved).toBe("session");
  });

  test("two running runs on one session is exit 2 naming both candidates", async () => {
    const root = mkdtempSync(join(tmpdir(), "rt-runs-cli-"));
    const env = { RT_RUNS_ROOT: root, CLAUDE_CODE_SESSION_ID: "sess-cli-4", ...QUIET };
    await runWriteVerb("run-start", [...RUN, "--run-id", "20260902-100000-aaaa-1"], env);
    await runWriteVerb("run-start", [...RUN, "--run-id", "20260902-100001-bbbb-1"], env);
    const r = await runWriteVerb("run-status", ["--status", "done"], env);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.out).error).toBe(
      "RT_RUN_DB is not set and no running run matches this session or directory; candidates: 20260902-100000-aaaa-1, 20260902-100001-bbbb-1",
    );
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
