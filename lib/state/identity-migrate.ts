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

/** Looks a legacy name up in the repo index and derives its serialized identity; null when the name is unknown. */
async function realResolveLegacyKey(name: string): Promise<string | null> {
  const { loadRepoIndex } = await import("../repo-index.ts");
  const path = loadRepoIndex()[name];
  if (!path) return null;
  return serializeIdentity(await deriveRepoIdentity(path));
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
    persistOrWarn("identity-migrate", () => {
      db.query(`UPDATE ${table} SET ${col} = ? WHERE ${col} = ?;`).run(identity, k);
    }, { table, col, identity });
    const landed = db.query(`SELECT 1 FROM ${table} WHERE ${col} = ? LIMIT 1;`).get(identity);
    if (!landed) {
      console.warn(`rt: ${table}.${col} re-key to ${identity} did not persist — leaving ${k}`);
      report.retained.push(k);
      continue;
    }
    report.migrated.push(k);
  }
  return report;
}
