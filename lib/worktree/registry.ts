import { join } from "path";
import { readJson, writeJson } from "../json-store.ts";
import { repoDataDir } from "../rt-paths.ts";

export type TreeKind = "main" | "ephemeral" | "unmanaged";
export type TreeState = "creating" | "on-deck" | "claimed" | "disposable";
export type DisposalMode = "merge" | "job";

export interface TreeRecord {
  name: string;
  path: string; // absolute
  kind: TreeKind;
  state?: TreeState; // ephemeral only
  branch: string | null; // git ground truth, reconciled every pass
  owner?: string;
  disposal?: DisposalMode;
  createdAt: string; // ISO
  claimedAt?: string;
  readyAt?: string; // last successful full readiness (ISO)
  readyStamp?: string; // commit sha the ready steps last ran against
  disposableReason?: string;
  retryFailures?: number; // shared backoff counter (create/freshen)
  nextRetryAt?: string; // ISO; skip mutating work until then
}

interface RegistryFile {
  trees: TreeRecord[];
}

export function registryPath(repoName: string): string {
  return join(repoDataDir(repoName), "worktrees.json");
}

export function loadRegistry(repoName: string): TreeRecord[] {
  const path = registryPath(repoName);
  const data = readJson<Partial<RegistryFile>>(path, { trees: [] });
  return Array.isArray(data?.trees) ? data.trees : [];
}

/**
 * Per-repo write counter, bumped by every `saveRegistry`.
 *
 * The registry has exactly one writer process (the daemon), but not one writer
 * *task*: provision, dispose, freshen and reconcile all interleave on the same
 * event loop. Anything that loads a whole-registry snapshot, awaits, and then
 * saves that snapshot back would silently overwrite whatever landed in between.
 * An in-memory counter is enough to detect that (no cross-process concern) and
 * lives here because `saveRegistry` is the seam every write already funnels
 * through. Callers compare `registryEpoch(repo)` captured right after their
 * load against its value in the same synchronous block as their save.
 */
const epochs = new Map<string, number>();

/** How many times this repo's registry has been saved in this process. */
export function registryEpoch(repoName: string): number {
  return epochs.get(repoName) ?? 0;
}

export function saveRegistry(repoName: string, trees: TreeRecord[]): void {
  const path = registryPath(repoName);
  writeJson(path, { trees });
  epochs.set(repoName, registryEpoch(repoName) + 1);
}

export function findByPath(
  trees: TreeRecord[],
  path: string
): TreeRecord | undefined {
  return trees.find((t) => t.path === path);
}

export function findByBranch(trees: TreeRecord[], branch: string): TreeRecord[] {
  return trees.filter((t) => t.branch === branch);
}

export function usedNames(trees: TreeRecord[]): Set<string> {
  return new Set(trees.map((t) => t.name));
}
