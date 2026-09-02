import { Database } from "bun:sqlite";
import { join } from "path";
import { isPathComponent } from "./paths.ts";
import { composePackCommits, packProvenance } from "./provenance.ts";
import { recordIdentity } from "./identity.ts";
import { createRunDb, type Fail, type Ok } from "./write.ts";

export type RunStartOpts = {
  repo: string; workType: string; pipeline: string;
  runId?: string; spawnedBy?: string; packDirs?: string[]; ticket?: string;
  mattstackSha?: string; mattstackDirty?: boolean; packSha?: string;
  env?: NodeJS.ProcessEnv; now?: number;
};

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

// Same shape the shell helper minted: local wall clock, four random hex
// digits, the pid. Run ids sort by start time within a repo dir.
function newRunId(now: number): string {
  const d = new Date(now);
  const date = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const rand = Math.floor(Math.random() * 65536).toString(16).padStart(4, "0");
  return `${date}-${time}-${rand}-${process.pid}`;
}

export function runStart(root: string, o: RunStartOpts): Ok<{ runId: string; runDb: string }> | Fail {
  if (!isPathComponent(o.repo)) return { ok: false, error: `--repo must be a single path component: ${o.repo}`, code: 2 };
  const now = o.now ?? Date.now();
  const runId = o.runId ?? newRunId(now);
  if (!isPathComponent(runId)) return { ok: false, error: `--run-id must be a single path component: ${runId}`, code: 2 };
  const runDb = join(root, o.repo, runId, "state.db");
  let db: Database;
  try {
    db = createRunDb(runDb);
  } catch (err) {
    return { ok: false, error: `run DB creation failed: ${String(err)}`, code: 1 };
  }
  try {
    const provenance = packProvenance(o.packDirs ?? []);
    const packCommits = composePackCommits(provenance, o.mattstackSha, o.packSha);
    const packDirty = o.mattstackDirty ? 1 : provenance.dirty;
    try {
      db.run(
        "INSERT INTO runs (id, repo, work_type, pipeline, status, spawned_by, started_at, pack_commits, pack_dirty) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)",
        [runId, o.repo, o.workType, o.pipeline, o.spawnedBy || null, now, packCommits, packDirty],
      );
    } catch {
      return { ok: false, error: `run id already exists: ${runId}`, code: 1 };
    }
    if (o.ticket) {
      db.run("INSERT OR REPLACE INTO fields (run_id, key, value, produced_by, at) VALUES (?, 'ticket', ?, 'work', ?)", [runId, o.ticket, now]);
    }
    recordIdentity(db, o.env ?? process.env, now);
    return { ok: true, runId, runDb };
  } catch (err) {
    return { ok: false, error: `sqlite write failed: ${String(err)}`, code: 1 };
  } finally {
    db.close();
  }
}
