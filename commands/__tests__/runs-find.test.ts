import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runFind } from "../runs-find.ts";
import { runWriteVerb } from "../runs-write.ts";

const QUIET = { RT_RUN_EMIT: "0" };

async function seededRoot(): Promise<{ root: string; env: Record<string, string> }> {
  const root = mkdtempSync(join(tmpdir(), "rt-runs-find-cli-"));
  return { root, env: { RT_RUNS_ROOT: root, ...QUIET } };
}

async function startRun(env: Record<string, string>, workType = "fix"): Promise<{ runId: string; runDb: string }> {
  const r = await runWriteVerb("run-start", ["--repo", "demo", "--work-type", workType, "--pipeline", "default"], env);
  const parsed = JSON.parse(r.out);
  return { runId: parsed.runId, runDb: parsed.runDb };
}

function setSession(runDb: string, sessionId: string): void {
  const db = new Database(runDb);
  db.exec(`INSERT INTO fields VALUES ((SELECT id FROM runs LIMIT 1), 'claude-session', '${sessionId}', 'plan', 0);`);
  db.close();
}

describe("rt runs find", () => {
  test("prints ok, empty runs, exit 0 when nothing matches", async () => {
    const { env } = await seededRoot();
    const r = runFind(["--session", "nope"], env);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ ok: true, runs: [] });
  });

  test("finds the run DB whose claude-session field matches, shaped as documented", async () => {
    const { env } = await seededRoot();
    const { runId, runDb } = await startRun(env);
    setSession(runDb, "sess-1");

    const r = runFind(["--session", "sess-1"], env);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out);
    expect(out.ok).toBe(true);
    expect(out.runs).toHaveLength(1);
    expect(out.runs[0]).toMatchObject({
      repo: "demo", runId, runDb, status: "running", current_stage: null, ended_at: null,
    });
    expect(typeof out.runs[0].started_at).toBe("number");
  });

  test("--running keeps only running-status matches", async () => {
    const { env } = await seededRoot();
    const { runDb: runningDb } = await startRun(env, "fix");
    setSession(runningDb, "sess-2");
    const { runDb: doneDb } = await startRun(env, "feature");
    setSession(doneDb, "sess-2");
    await runWriteVerb("run-status", ["--status", "done"], { RT_RUN_DB: doneDb, ...QUIET });

    const all = runFind(["--session", "sess-2"], env);
    expect(JSON.parse(all.out).runs).toHaveLength(2);

    const running = runFind(["--session", "sess-2", "--running"], env);
    const runningOut = JSON.parse(running.out);
    expect(runningOut.runs).toHaveLength(1);
    expect(runningOut.runs[0].status).toBe("running");
  });

  test("missing --session is a JSON usage error, exit 2", async () => {
    const { env } = await seededRoot();
    const r = runFind([], env);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false });
  });

  test("empty --session value is a JSON usage error, exit 2", async () => {
    const { env } = await seededRoot();
    const r = runFind(["--session", "--running"], env);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false });
  });

  test("--json is accepted and ignored", async () => {
    const { env } = await seededRoot();
    const r = runFind(["--session", "nope", "--json"], env);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ ok: true, runs: [] });
  });
});
