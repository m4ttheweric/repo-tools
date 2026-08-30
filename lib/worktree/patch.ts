import { loadRegistry, saveRegistry, type TreeRecord } from "./registry.ts";

/**
 * Load-mutate-save one registry row. Everything from the load to the save
 * runs in one synchronous block (no `await` in between), which is what
 * makes this safe without an epoch/conflict check: nothing else can
 * interleave a competing write in the gap. Callers that hold `trees` across
 * an `await` (e.g. the reconciler's whole-registry pass) need their own
 * `registryEpoch` guard instead; this helper is only for a single row.
 *
 * Returns false and writes nothing when no row at `path` exists; otherwise
 * returns whatever `saveRegistry` reports for whether the write landed.
 */
export function patchTree(
  repoName: string,
  path: string,
  patch: (rec: TreeRecord) => void,
): boolean {
  const trees = loadRegistry(repoName);
  const rec = trees.find((t) => t.path === path);
  if (!rec) return false;
  patch(rec);
  return saveRegistry(repoName, trees);
}
