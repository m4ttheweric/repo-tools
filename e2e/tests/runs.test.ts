/**
 * rt runs e2e (SKILLS-28 read side) — proves the whole read path against a
 * real compiled daemon: a pipeline run DB seeded under the harness HOME's
 * REAL default runs root (no RT_RUNS_ROOT override) is visible via the CLI,
 * the REST surface, and the events bus push topic.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { createTestHome, RT_BINARY } from "../harness.ts";
import type { RunDetail, RunSummary } from "../../packages/rt-client/src/commands.ts";

// REST envelope shape (lib/daemon.ts's handleCommand): { ok: true, data } |
// { ok: false, error } — mirrored here since rt-client can't be imported by
// the daemon and there's no shared envelope type to reach for.
type ApiEnvelope<T> = { ok: boolean; data: T; error?: string };

async function waitForSocket(sockPath: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(sockPath)) {
    if (Date.now() > deadline) throw new Error(`daemon socket never appeared at ${sockPath}`);
    await Bun.sleep(100);
  }
}

/** Grab a free TCP port by binding port 0 and releasing it. */
function freePort(): number {
  const srv = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = srv.port;
  srv.stop(true);
  if (!port) throw new Error("failed to allocate a free port");
  return port;
}

// Same seed SQL as lib/runs/__tests__/store.test.ts's seedRun — written
// directly with bun:sqlite here (the daemon is the only reader; the test
// process is allowed to write because it's standing in for
// mattstack-skills' pipeline-state.sh, not rt itself).
function seedRun(runsRoot: string, repo: string, id: string, startedAt: number): void {
  const runDir = join(runsRoot, repo, id);
  mkdirSync(runDir, { recursive: true });
  const db = new Database(join(runDir, "state.db"));
  db.exec(`
    PRAGMA user_version=1;
    CREATE TABLE runs (id TEXT PRIMARY KEY, repo TEXT NOT NULL, work_type TEXT NOT NULL,
      pipeline TEXT NOT NULL, status TEXT NOT NULL, current_stage TEXT,
      spawned_by TEXT, started_at INTEGER NOT NULL, ended_at INTEGER);
    CREATE TABLE stages (run_id TEXT, name TEXT, status TEXT, attempt INTEGER DEFAULT 1,
      started_at INTEGER, ended_at INTEGER, PRIMARY KEY (run_id, name, attempt));
    CREATE TABLE fields (run_id TEXT, key TEXT, value TEXT, produced_by TEXT, at INTEGER, PRIMARY KEY (run_id, key));
    CREATE TABLE decisions (run_id TEXT, contract TEXT, scope TEXT, selection TEXT, decided_by TEXT, decided_at INTEGER, PRIMARY KEY (run_id, contract, scope));
    INSERT INTO runs VALUES ('${id}', '${repo}', 'feature', 'default', 'running', 'plan', NULL, ${startedAt}, NULL);
    INSERT INTO stages VALUES ('${id}', 'plan', 'running', 1, ${startedAt}, NULL);
    INSERT INTO fields VALUES ('${id}', 'ticket', 'ACME-1', 'plan', ${startedAt});
    INSERT INTO decisions VALUES ('${id}', 'execution-strategy@1', 'run', '{"tier":"direct-tdd"}', 'stage-plan', ${startedAt});
  `);
  db.close();
}

// Assigned in beforeAll; every spawned rt process (daemon and CLI) shares it.
let apiPort = 0;
// Every spawned child, so afterAll can reap waiters orphaned by a mid-test
// assertion failure instead of leaving them to their own --timeout.
const children: Array<ReturnType<typeof Bun.spawn>> = [];

function runRt(args: string[], home: string) {
  // Hermetic env mirroring e2e/harness.ts run() — no ambient process.env
  // leaking into children.
  const bunDir = join(process.execPath, "..");
  const proc = Bun.spawn([RT_BINARY, ...args], {
    env: {
      HOME: home,
      PATH: `${join(RT_BINARY, "..")}:${bunDir}:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin`,
      TERM: "xterm-256color",
      RT_SKIP_SETUP: "1",
      CI: "true",
      RT_API_PORT: String(apiPort),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(proc);
  return proc;
}

async function finished(proc: ReturnType<typeof runRt>) {
  const exitCode = await proc.exited;
  return {
    exitCode,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  };
}

describe("rt runs (read-side e2e)", () => {
  let home: string;
  let cleanup: () => void;
  let daemon: ReturnType<typeof runRt>;

  const REPO = "e2e-repo";
  const RUN_ID = "20260821-120000-e2e1";
  const STARTED_AT = 1_755_000_000_000;

  beforeAll(async () => {
    apiPort = freePort();
    ({ path: home, cleanup } = createTestHome());

    // No RT_RUNS_ROOT here — the point of this suite is proving the daemon
    // reads the REAL default path, ~/.mattstack/runs, under the harness HOME.
    const runsRoot = join(home, ".mattstack", "runs");
    seedRun(runsRoot, REPO, RUN_ID, STARTED_AT);

    daemon = runRt(["--daemon"], home);
    await waitForSocket(join(home, ".mattstack", "rt", "rt.sock"));
    if (daemon.exitCode !== null) {
      throw new Error(
        `daemon process exited (code ${daemon.exitCode}) right after creating its socket — ` +
          `port ${apiPort} collision or daemon boot crash; check the daemon's stderr.`,
      );
    }
  });

  afterAll(async () => {
    for (const child of children) {
      try { child.kill(); } catch { /* already gone */ }
    }
    await Promise.all(children.map((c) => c.exited));
    cleanup();
  });

  test("rt runs --json lists the seeded run", async () => {
    const res = await finished(runRt(["runs", "--json"], home));
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout);
    const found = out.runs.find((r: { id: string }) => r.id === RUN_ID);
    expect(found).toBeDefined();
    expect(found.repo).toBe(REPO);
    expect(found.status).toBe("running");
    expect(found.started_at).toBe(STARTED_AT);
  }, 20_000);

  test("rt runs show <id> --json returns stages, fields, decisions", async () => {
    const res = await finished(runRt(["runs", "show", RUN_ID, "--json"], home));
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.run.id).toBe(RUN_ID);
    expect(out.schemaAhead).toBe(false);
    expect(out.stages).toHaveLength(1);
    expect(out.stages[0]).toMatchObject({ name: "plan", status: "running" });
    expect(out.fields).toHaveLength(1);
    expect(out.fields[0]).toMatchObject({ key: "ticket", value: "ACME-1" });
    expect(out.decisions).toHaveLength(1);
    expect(out.decisions[0]).toMatchObject({ contract: "execution-strategy@1", scope: "run" });
  }, 20_000);

  test("GET /api/runs over the harness REST port includes the run", async () => {
    const res = await fetch(`http://127.0.0.1:${apiPort}/api/runs`);
    expect(res.status).toBe(200);
    const out = (await res.json()) as ApiEnvelope<{ runs: RunSummary[] }>;
    expect(out.ok).toBe(true);
    const found = out.data.runs.find((r) => r.id === RUN_ID);
    expect(found).toBeDefined();
    expect(found!.repo).toBe(REPO);
  }, 20_000);

  test("GET /api/runs/:repo/:runId returns the same detail as rt runs show", async () => {
    const res = await fetch(`http://127.0.0.1:${apiPort}/api/runs/${REPO}/${RUN_ID}`);
    expect(res.status).toBe(200);
    const out = (await res.json()) as ApiEnvelope<RunDetail>;
    expect(out.ok).toBe(true);
    expect(out.data.run.id).toBe(RUN_ID);
    expect(out.data.stages).toHaveLength(1);
  }, 20_000);

  test("rt events emit run-updated round-trips through rt events list", async () => {
    const emit = await finished(
      runRt(["events", "emit", "run-updated", "--json", JSON.stringify({ repo: REPO, runId: RUN_ID })], home),
    );
    expect(emit.exitCode).toBe(0);
    const emitted = JSON.parse(emit.stdout);
    expect(emitted.ok).toBe(true);

    const list = await finished(runRt(["events", "list", "run-updated"], home));
    expect(list.exitCode).toBe(0);
    const out = JSON.parse(list.stdout);
    expect(out.ok).toBe(true);
    const found = out.events.find((e: { id: number }) => e.id === emitted.id);
    expect(found).toBeDefined();
    expect(found.topic).toBe("run-updated");
    expect(found.payload).toEqual({ repo: REPO, runId: RUN_ID });
  }, 20_000);
});
