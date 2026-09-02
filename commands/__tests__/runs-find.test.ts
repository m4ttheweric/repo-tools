import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runFind } from "../runs-find.ts";
import { runWriteVerb } from "../runs-write.ts";

const QUIET = { RT_RUN_EMIT: "0" };

afterEach(() => { delete process.env.RT_RUNS_ROOT; });

// runFind reads RT_RUNS_ROOT off process.env, same as findRunsBySession; the
// temp root is set there directly, matching lib/runs/__tests__/fixtures.ts's
// root() helper. env is still returned for runWriteVerb, which does take an
// explicit env argument.
function seededRoot(): { root: string; env: Record<string, string> } {
  const root = mkdtempSync(join(tmpdir(), "rt-runs-find-cli-"));
  process.env.RT_RUNS_ROOT = root;
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
  test("prints ok, empty runs, exit 0 when nothing matches", () => {
    seededRoot();
    const r = runFind(["--session", "nope"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ ok: true, runs: [] });
  });

  test("finds the run DB whose claude-session field matches, shaped as documented", async () => {
    const { env } = seededRoot();
    const { runId, runDb } = await startRun(env);
    setSession(runDb, "sess-1");

    const r = runFind(["--session", "sess-1"]);
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
    const { env } = seededRoot();
    const { runDb: runningDb } = await startRun(env, "fix");
    setSession(runningDb, "sess-2");
    const { runDb: doneDb } = await startRun(env, "feature");
    setSession(doneDb, "sess-2");
    await runWriteVerb("run-status", ["--status", "done"], { RT_RUN_DB: doneDb, ...QUIET });

    const all = runFind(["--session", "sess-2"]);
    expect(JSON.parse(all.out).runs).toHaveLength(2);

    const running = runFind(["--session", "sess-2", "--running"]);
    const runningOut = JSON.parse(running.out);
    expect(runningOut.runs).toHaveLength(1);
    expect(runningOut.runs[0].status).toBe("running");
  });

  test("missing --session is a JSON usage error, exit 2", () => {
    seededRoot();
    const r = runFind([]);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.out)).toEqual({ ok: false, error: "--session is required" });
  });

  test("dangling --session (no value) reports the write verbs' usage message, exit 2", () => {
    seededRoot();
    const r = runFind(["--session", "--running"]);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.out)).toEqual({ ok: false, error: "--session requires a value" });
  });

  test("--json is accepted and ignored", () => {
    seededRoot();
    const r = runFind(["--session", "nope", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ ok: true, runs: [] });
  });
});
