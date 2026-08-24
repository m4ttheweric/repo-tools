import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

export function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "rt-runs-store-"));
  process.env.RT_RUNS_ROOT = dir;
  return dir;
}

type SeedOpts = {
  status?: string;
  packCommits?: string;
  packDirty?: number;
  stageReason?: string;
  stageDetailPath?: string;
};

export function seedRun(dir: string, repo: string, id: string, startedAt: number, userVersion = 1, o: SeedOpts = {}): void {
  const runDir = join(dir, repo, id);
  mkdirSync(runDir, { recursive: true });
  const v2 = userVersion >= 2;
  const db = new Database(join(runDir, "state.db"));
  db.exec(`
    PRAGMA user_version=${userVersion};
    CREATE TABLE runs (id TEXT PRIMARY KEY, repo TEXT NOT NULL, work_type TEXT NOT NULL,
      pipeline TEXT NOT NULL, status TEXT NOT NULL, current_stage TEXT,
      spawned_by TEXT, started_at INTEGER NOT NULL, ended_at INTEGER${v2 ? ", pack_commits TEXT, pack_dirty INTEGER DEFAULT 0" : ""});
    CREATE TABLE stages (run_id TEXT, name TEXT, status TEXT, attempt INTEGER DEFAULT 1,
      started_at INTEGER, ended_at INTEGER${v2 ? ", reason TEXT, detail_path TEXT" : ""}, PRIMARY KEY (run_id, name, attempt));
    CREATE TABLE fields (run_id TEXT, key TEXT, value TEXT, produced_by TEXT, at INTEGER, PRIMARY KEY (run_id, key));
    CREATE TABLE decisions (run_id TEXT, contract TEXT, scope TEXT, selection TEXT, decided_by TEXT, decided_at INTEGER, PRIMARY KEY (run_id, contract, scope));
    INSERT INTO runs VALUES ('${id}', '${repo}', 'feature', 'default', '${o.status ?? "running"}', 'plan', NULL, ${startedAt}, NULL${v2 ? `, ${o.packCommits ? `'${o.packCommits}'` : "NULL"}, ${o.packDirty ?? 0}` : ""});
    INSERT INTO stages VALUES ('${id}', 'plan', 'running', 1, ${startedAt}, NULL${v2 ? `, ${o.stageReason ? `'${o.stageReason}'` : "NULL"}, ${o.stageDetailPath ? `'${o.stageDetailPath}'` : "NULL"}` : ""});
    INSERT INTO fields VALUES ('${id}', 'ticket', 'ACME-1', 'plan', ${startedAt});
    INSERT INTO fields VALUES ('${id}', 'branch', 'goodwin/mat-1', 'plan', ${startedAt + 5000});
    INSERT INTO decisions VALUES ('${id}', 'execution-strategy@1', 'run', '{"tier":"direct-tdd"}', 'stage-plan', ${startedAt});
  `);
  db.close();
}
