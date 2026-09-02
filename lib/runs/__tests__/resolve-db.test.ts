import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolveRunDb } from "../resolve-db.ts";
import { runStart } from "../start.ts";
import { fieldSet, openRunDb, runStatus } from "../write.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rt-resolve-db-"));
}

const NO_MATCH = "RT_RUN_DB is not set and no running run matches this session or directory";

function start(root: string, runId: string, o: { session?: string; worktree?: string; now: number; done?: boolean }): string {
  const r = runStart(root, {
    repo: "demo", workType: "fix", pipeline: "default", runId, now: o.now,
    env: o.session ? { CLAUDE_CODE_SESSION_ID: o.session } : {},
  });
  if (!r.ok) throw new Error(r.error);
  const db = openRunDb(r.runDb);
  if (o.worktree) fieldSet(db, "worktree", o.worktree, "provision", o.now);
  if (o.done) runStatus(db, "done", o.now + 1);
  db.close();
  return r.runDb;
}

describe("resolveRunDb", () => {
  test("RT_RUN_DB wins without scanning", () => {
    expect(resolveRunDb({ RT_RUN_DB: "/x/state.db", RT_RUNS_ROOT: "/nowhere" }, "/")).toEqual({ ok: true, db: "/x/state.db", resolved: "env" });
  });

  test("exactly one running run on this session resolves by session", () => {
    const root = tmp();
    const db = start(root, "r1", { session: "s1", now: 1000 });
    start(root, "r2", { session: "s2", now: 2000 });
    expect(resolveRunDb({ RT_RUNS_ROOT: root, CLAUDE_CODE_SESSION_ID: "s1" }, "/elsewhere")).toEqual({ ok: true, db, resolved: "session" });
  });

  test("two running runs on this session and no worktree match names both candidates, oldest first", () => {
    const root = tmp();
    start(root, "r2", { session: "s1", now: 2000 });
    start(root, "r1", { session: "s1", now: 1000 });
    expect(resolveRunDb({ RT_RUNS_ROOT: root, CLAUDE_CODE_SESSION_ID: "s1" }, "/elsewhere")).toEqual({ ok: false, error: `${NO_MATCH}; candidates: r1, r2` });
  });

  test("a cwd inside a run's worktree resolves the newest such run", () => {
    const root = tmp();
    const tree = join(tmp(), "tree");
    start(root, "older", { worktree: tree, now: 1000 });
    const newest = start(root, "newer", { worktree: tree, now: 2000 });
    expect(resolveRunDb({ RT_RUNS_ROOT: root }, join(tree, "src", "deep"))).toEqual({ ok: true, db: newest, resolved: "worktree" });
    expect(resolveRunDb({ RT_RUNS_ROOT: root }, tree)).toEqual({ ok: true, db: newest, resolved: "worktree" });
  });

  test("a sibling directory that shares the worktree's prefix is not a match", () => {
    const root = tmp();
    const tree = join(tmp(), "tree");
    start(root, "r1", { worktree: tree, now: 1000 });
    expect(resolveRunDb({ RT_RUNS_ROOT: root }, `${tree}-other`)).toEqual({ ok: false, error: NO_MATCH });
  });

  test("a done run is ignored on both rungs", () => {
    const root = tmp();
    const tree = join(tmp(), "tree");
    start(root, "r1", { session: "s1", worktree: tree, now: 1000, done: true });
    expect(resolveRunDb({ RT_RUNS_ROOT: root, CLAUDE_CODE_SESSION_ID: "s1" }, tree)).toEqual({ ok: false, error: NO_MATCH });
  });

  test("nothing running is a plain error with no candidate list", () => {
    expect(resolveRunDb({ RT_RUNS_ROOT: tmp(), CLAUDE_CODE_SESSION_ID: "s1" }, "/elsewhere")).toEqual({ ok: false, error: NO_MATCH });
  });
});
