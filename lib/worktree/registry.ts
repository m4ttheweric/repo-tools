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
  const data = readJson<RegistryFile>(path, { trees: [] });
  return data.trees;
}

export function saveRegistry(repoName: string, trees: TreeRecord[]): void {
  const path = registryPath(repoName);
  writeJson(path, { trees });
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
