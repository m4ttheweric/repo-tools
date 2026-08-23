import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "path";
import { abandonRun } from "../reconcile.ts";
import { root, seedRun } from "./fixtures.ts";

afterEach(() => { delete process.env.RT_RUNS_ROOT; });

function readRow(dir: string, repo: string, id: string, sql: string): any {
  const db = new Database(join(dir, repo, id, "state.db"), { readonly: true });
  try { return db.query(sql).get(); } finally { db.close(); }
}

test("abandoning a running run sets status and stamps ended_at", () => {
  const dir = root();
  seedRun(dir, "acme", "20260822-130000-cccc", 1000, 2, { status: "running" });

  const res = abandonRun("acme", "20260822-130000-cccc", "no owning process");
  expect(res.ok).toBe(true);

  const row = readRow(dir, "acme", "20260822-130000-cccc", "SELECT status, ended_at FROM runs") as { status: string; ended_at: number };
  expect(row.status).toBe("abandoned");
  expect(row.ended_at).toBeGreaterThan(0);
});

test("abandoning records who did it, so a later patterns view can tell hygiene from pipeline failure", () => {
  const dir = root();
  seedRun(dir, "acme", "20260822-130001-dddd", 1000, 2, { status: "running" });
  abandonRun("acme", "20260822-130001-dddd", "no owning process");

  const f = readRow(dir, "acme", "20260822-130001-dddd", "SELECT value, produced_by FROM fields WHERE key='reconciled'") as { value: string; produced_by: string };
  expect(f.value).toBe("no owning process");
  expect(f.produced_by).toBe("rt runs abandon");
});

test("a run that already ended is refused rather than rewritten", () => {
  const dir = root();
  seedRun(dir, "acme", "20260822-130002-eeee", 1000, 2, { status: "done" });
  const res = abandonRun("acme", "20260822-130002-eeee", "x");
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.error).toContain("already");
});

test("an unknown run is refused, not created", () => {
  root();
  expect(abandonRun("acme", "nope", "x").ok).toBe(false);
});

test("path components are validated", () => {
  root();
  expect(abandonRun("../etc", "x", "y").ok).toBe(false);
  expect(abandonRun("acme", "../../x", "y").ok).toBe(false);
});
