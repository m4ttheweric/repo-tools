/**
 * lib/state/identity-migrate.ts — one-shot re-key harness.
 *
 * Migrates legacy name-keyed rows onto serialized `RepoIdentity` keys.
 * Every write is verify-persisted (re-read after write) before the legacy
 * row is dropped: `setKvValue`/`persistOrWarn` swallow SQLITE_BUSY, so a
 * returned write is not necessarily a landed write.
 */

import { setKvValue, deleteKvValue, hasKvValue, listKvValues, getStateDb, persistOrWarn } from "./index.ts";
import { parseIdentity, deriveRepoIdentity, serializeIdentity } from "../settings/identity.ts";

export interface RekeyReport {
  migrated: string[];
  retained: string[];
}

export interface RekeyOpts {
  /** name → serialized identity, or null when unresolvable. Defaults to the real resolver. */
  resolve?: (name: string) => Promise<string | null>;
}

/**
 * Resolves a legacy name to its serialized identity; null when it cannot be
 * pinned to exactly one repo.
 *
 * The exact-key hit comes first: a pre-cutover index row is still keyed by its
 * plain name, and its path is authoritative. But post-cutover the index keys
 * on identities, so a legacy name is not a key at ALL any more, and rows
 * naming one were retained forever. The same reverse lookup `--repo` uses
 * finds them by the checkout's basename or the identity's tail.
 *
 * Ambiguity stays unresolvable on purpose. Re-keying a row onto the wrong
 * repo silently attributes one repo's history to another, which is worse than
 * leaving it under a legacy key that a human can still see and prune.
 */
export async function realResolveLegacyKey(name: string): Promise<string | null> {
  const { loadRepoIndex } = await import("../repo-index.ts");
  const index = loadRepoIndex();

  const path = index[name];
  if (path) return serializeIdentity(await deriveRepoIdentity(path));

  const { reverseLookupByName } = await import("../repo-name-lookup.ts");
  const matches = reverseLookupByName(name, index);
  return matches.length === 1 ? matches[0]![0] : null;
}

export async function rekeyKvNamespace(ns: string, opts: RekeyOpts = {}): Promise<RekeyReport> {
  const resolve = opts.resolve ?? realResolveLegacyKey;
  const report: RekeyReport = { migrated: [], retained: [] };
  for (const [key, value] of Object.entries(listKvValues<unknown>(ns))) {
    if (parseIdentity(key) !== null) continue;
    const identity = await resolve(key);
    if (identity === null) {
      console.warn(`rt: could not re-key ${ns}/${key} to an identity — leaving it in place`);
      report.retained.push(key);
      continue;
    }
    if (hasKvValue(ns, identity)) {
      console.warn(`rt: ${ns}/${identity} already exists; leaving legacy ${key} in place`);
      report.retained.push(key);
      continue;
    }
    setKvValue(ns, identity, value);
    if (!hasKvValue(ns, identity)) {
      console.warn(`rt: ${ns}/${identity} did not persist; leaving legacy ${key} in place`);
      report.retained.push(key);
      continue;
    }
    deleteKvValue(ns, key);
    report.migrated.push(key);
  }
  return report;
}

/**
 * `table`/`col` are internal literals supplied by callers, never user input —
 * no injection surface for the interpolated SQL.
 *
 * Migrates ROW BY ROW (via `rowid`), not one bulk `UPDATE ... WHERE col=k`:
 * a legacy row and an already-identity row can share the rest of the table's
 * PRIMARY KEY (`endpoint_claims` is `(repo, worktree, role)`; `project_mrs`,
 * `discussions`, `project_mr_demands` are similar composite keys) — a bulk
 * UPDATE would throw a PK-violation OUT of this function on the first such
 * collision, which would crash the boot migration outright. Per row: a
 * SQLITE_CONSTRAINT on the single-row UPDATE means the destination identity
 * row already exists, so the destination wins and the stale legacy row is
 * deleted instead (never left duplicated, never thrown).
 */
export async function rekeyTableColumn(table: string, col: string, opts: RekeyOpts = {}): Promise<RekeyReport> {
  const resolve = opts.resolve ?? realResolveLegacyKey;
  const db = getStateDb();
  const report: RekeyReport = { migrated: [], retained: [] };
  const keys = db.query(`SELECT DISTINCT ${col} AS k FROM ${table};`).all() as { k: string }[];
  for (const { k } of keys) {
    if (k == null || parseIdentity(k) !== null) continue;
    const identity = await resolve(k);
    if (identity === null) {
      console.warn(`rt: could not re-key ${table}.${col}=${k} to an identity — leaving it`);
      report.retained.push(k);
      continue;
    }

    const rows = db.query(`SELECT rowid AS id FROM ${table} WHERE ${col} = ?;`).all(k) as { id: number }[];
    for (const { id } of rows) {
      try {
        persistOrWarn("identity-migrate", () => {
          db.query(`UPDATE ${table} SET ${col} = ? WHERE rowid = ?;`).run(identity, id);
        }, { table, col, identity, rowid: id });
      } catch (err) {
        if (!(err as { code?: string } | undefined)?.code?.startsWith("SQLITE_CONSTRAINT")) throw err;
        db.query(`DELETE FROM ${table} WHERE rowid = ?;`).run(id);
        console.warn(
          `rt: ${table}.${col}=${k} (rowid ${id}) collided with an existing ${identity} row — dropped the stale legacy duplicate`,
        );
      }
    }

    // Verify-persisted: a row still under the legacy key here means either a
    // busy write persistOrWarn swallowed, or a row deleted above whose delete
    // itself never landed — either way the key isn't fully migrated yet.
    const remaining = db.query(`SELECT 1 FROM ${table} WHERE ${col} = ? LIMIT 1;`).get(k);
    if (remaining) {
      console.warn(`rt: ${table}.${col} re-key to ${identity} did not fully persist — leaving remaining ${k} rows`);
      report.retained.push(k);
      continue;
    }
    report.migrated.push(k);
  }
  return report;
}
