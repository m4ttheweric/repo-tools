/**
 * Repo-name resolution against rt's global index. rt itself resolves this
 * through state.db (~/.mattstack/rt/state.db); this module runs OUT OF
 * PROCESS (gitq, mr-board, deck), so it has no handle on that db and reads
 * a derived snapshot instead — state.db's kv `repo-index` namespace when
 * reachable, falling back to the legacy `repos.json` mirror
 * (~/.mattstack/rt/repos.json, a flat `{ "<repoName>": "<absolute path>" }`
 * map) rt keeps in sync for exactly this purpose. See rt's
 * lib/repo-index.ts `repoIndexCompatPath` for the write side.
 */
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

function defaultReposJsonPath(): string {
  // Duplicates the ~/.mattstack/rt layout: rt-client has no dependency on rt's
  // lib/, so this literal cannot import rtDir(). repo-tools/lib/rt-paths.ts is
  // the authority — change there first, mirror here.
  return join(homedir(), ".mattstack", "rt", "repos.json");
}

interface RepoIndexRow {
  k: string;
  v: string;
}

interface BunSqliteDatabase {
  query(sql: string): { all(...params: unknown[]): unknown[] };
  close(): void;
}

type BunSqliteDatabaseCtor = new (path: string, opts?: { readonly?: boolean }) => BunSqliteDatabase;

/**
 * Loads bun:sqlite defensively: only Bun's runtime provides this built-in.
 * A non-Bun consumer throws resolving the specifier, caught here so the
 * caller degrades to the repos.json path instead of throwing.
 */
function loadBunSqliteDatabase(): BunSqliteDatabaseCtor | null {
  try {
    return (require("bun:sqlite") as { Database: BunSqliteDatabaseCtor }).Database;
  } catch {
    return null;
  }
}

/**
 * Exact-match lookup against state.db's `repo-index` kv namespace (ns=k=v
 * rows written by rt's setKvValue, so `v` is a JSON-encoded string). Returns
 * null (never throws) on any failure — missing db, unreadable, wrong
 * schema, no match — so the caller always has repos.json as a fallback.
 */
function repoNameFromStateDb(repoPath: string, dbPath: string): string | null {
  if (!existsSync(dbPath)) return null;
  const DatabaseCtor = loadBunSqliteDatabase();
  if (!DatabaseCtor) return null;
  try {
    const db = new DatabaseCtor(dbPath, { readonly: true });
    try {
      const rows = db.query("SELECT k, v FROM kv WHERE ns = 'repo-index';").all() as RepoIndexRow[];
      for (const row of rows) {
        try {
          if (JSON.parse(row.v) === repoPath) return row.k;
        } catch {
          continue;
        }
      }
      return null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function repoNameFromJson(repoPath: string, reposJsonPath: string): string | null {
  try {
    if (!existsSync(reposJsonPath)) return null;
    const raw = readFileSync(reposJsonPath, "utf8");
    const index = JSON.parse(raw) as Record<string, unknown>;
    for (const [repoName, value] of Object.entries(index)) {
      if (value === repoPath) return repoName;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Exact-match lookup: returns the repo name whose recorded path equals
 * `repoPath`, or null if no source has a match. Never throws -- a
 * resolution failure just means the caller falls back to whatever it had
 * before (an unqualified path, a prompt, etc).
 *
 * Prefers state.db (authoritative, kept live by every rt process); falls
 * back to the repos.json compat mirror when state.db is unreachable — a
 * pre-upgrade rt install, a non-Bun consumer, or a state.db this process
 * can't open. `reposJsonPath`, when passed, also relocates the state.db
 * lookup: both files live side by side under the same rt data directory.
 */
export function repoNameForPath(repoPath: string, reposJsonPath?: string): string | null {
  const jsonPath = reposJsonPath ?? defaultReposJsonPath();
  const dbPath = join(dirname(jsonPath), "state.db");
  const fromDb = repoNameFromStateDb(repoPath, dbPath);
  if (fromDb !== null) return fromDb;
  return repoNameFromJson(repoPath, jsonPath);
}
