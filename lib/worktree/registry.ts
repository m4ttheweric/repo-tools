import { join } from "path";
import { canon } from "../fs-canon.ts";
import { repoDataDir } from "../rt-paths.ts";
import { deleteKvValue, getKvValue, hasKvValue, importLegacyJsonFile, listKvValues, setKvValue, setKvValueCritical } from "../state/index.ts";

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
  readyPendingAt?: string; // ISO; claim-time steps queued to a background task (RT-96)
  readyFailure?: string; // failed step name from the last background settle
  disposableReason?: string;
  retryFailures?: number; // shared backoff counter (create/freshen)
  nextRetryAt?: string; // ISO; skip mutating work until then
  missCount?: number; // consecutive reconcile passes the path was absent from git ground truth (S063 hold)
}

const WORKTREE_REGISTRY_NS = "worktree-registry";

/** Retired storage location — kept only so a leftover pre-migration file can be imported once, then renamed out of the way. */
export function registryPath(repoName: string): string {
  return join(repoDataDir(repoName), "worktrees.json");
}

export interface Registry {
  loadRegistry(repoName: string): TreeRecord[];
  registryEpoch(repoName: string): number;
  saveRegistry(repoName: string, trees: TreeRecord[]): boolean;
  hasRegistry(repoName: string): boolean;
  deleteRegistry(repoName: string): void;
}

/**
 * R031: the epoch counter used to live as a bare module-scope `Map`. The
 * registry rows themselves are already durable (kv store / state.db), so the
 * only state a fresh instance needs to isolate is this in-process write
 * counter: two `createRegistry()` instances never see each other's bumps.
 */
export function createRegistry(): Registry {
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

  /**
   * A pre-Phase-2 worktrees.json carries fields no git repository has any
   * other record of — `kind: "ephemeral"`, claim/dispose `state`, `owner`,
   * `disposal`, `claimedAt`, `readyStamp`, `retryFailures`. Losing it makes
   * the reconciler re-adopt every tree as `unmanaged`, so imported trees are
   * returned as-is on first read, before any git-truth reconciliation runs.
   */
  function loadRegistry(repoName: string): TreeRecord[] {
    if (hasKvValue(WORKTREE_REGISTRY_NS, repoName)) {
      const raw = getKvValue<unknown>(WORKTREE_REGISTRY_NS, repoName, []);
      return Array.isArray(raw) ? (raw as TreeRecord[]) : [];
    }

    const result = importLegacyJsonFile<TreeRecord[]>(registryPath(repoName), (json) => {
      const parsed = json as { trees?: unknown } | null;
      const trees = Array.isArray(parsed?.trees) ? (parsed.trees as TreeRecord[]) : [];
      setKvValue(WORKTREE_REGISTRY_NS, repoName, trees);
      return trees;
    }, { verifyPersisted: () => hasKvValue(WORKTREE_REGISTRY_NS, repoName) });
    return result.imported ? result.value! : [];
  }

  /** How many times this repo's registry has been saved in this process. */
  function registryEpoch(repoName: string): number {
    return epochs.get(repoName) ?? 0;
  }

  /**
   * Critical write: retries on busy (runCriticalWrite via setKvValueCritical)
   * and reports whether the write landed. The epoch bumps only on a landed
   * write... a dropped write must not advance the epoch, or a concurrent
   * reconcile pass reading the epoch afterward would wrongly believe this
   * save happened.
   */
  function saveRegistry(repoName: string, trees: TreeRecord[]): boolean {
    // Folds in (and safely imports/renames) any legacy worktrees.json first —
    // every current call site loads before saving, but nothing enforced that,
    // and a save reached without a prior load would otherwise strand an
    // unread legacy file the moment this function's own write makes the store
    // non-empty. loadRegistry() is the no-op it looks like once already
    // migrated (one indexed point lookup).
    loadRegistry(repoName);
    const ok = setKvValueCritical(WORKTREE_REGISTRY_NS, repoName, trees);
    if (ok) epochs.set(repoName, registryEpoch(repoName) + 1);
    return ok;
  }

  /** Whether this repo has a registry row at all — distinct from an empty registry. */
  function hasRegistry(repoName: string): boolean {
    return hasKvValue(WORKTREE_REGISTRY_NS, repoName);
  }

  /** Drop a whole registry row. Only ever the retired half of a pair, after its records have been merged onto the survivor. */
  function deleteRegistry(repoName: string): void {
    deleteKvValue(WORKTREE_REGISTRY_NS, repoName);
    epochs.set(repoName, registryEpoch(repoName) + 1);
  }

  return { loadRegistry, registryEpoch, saveRegistry, hasRegistry, deleteRegistry };
}

let defaultRegistry: Registry | null = null;

function getDefaultRegistry(): Registry {
  return defaultRegistry ??= createRegistry();
}

export function loadRegistry(repoName: string): TreeRecord[] {
  return getDefaultRegistry().loadRegistry(repoName);
}

export function registryEpoch(repoName: string): number {
  return getDefaultRegistry().registryEpoch(repoName);
}

export function saveRegistry(repoName: string, trees: TreeRecord[]): boolean {
  return getDefaultRegistry().saveRegistry(repoName, trees);
}

export function hasRegistry(repoName: string): boolean {
  return getDefaultRegistry().hasRegistry(repoName);
}

export function deleteRegistry(repoName: string): void {
  getDefaultRegistry().deleteRegistry(repoName);
}

export function findByPath(
  trees: TreeRecord[],
  path: string
): TreeRecord | undefined {
  return trees.find((t) => t.path === path);
}

/**
 * Reverse lookup across every repo's registry: given an absolute worktree
 * path, find which repo owns it and the tree's name. Reads the kv store
 * directly (rather than looping `loadRepoIndex()`) so this module doesn't
 * import `../repo-index.ts`, which already imports `mergeRegistries` from
 * here.
 */
export function findTreeByPath(path: string): { repoName: string; tree: string } | null {
  const byRepo = listKvValues<TreeRecord[]>(WORKTREE_REGISTRY_NS);
  for (const [repoName, trees] of Object.entries(byRepo)) {
    const hit = trees.find((t) => t.path === path);
    if (hit) return { repoName, tree: hit.name };
  }
  return null;
}

export function findByBranch(trees: TreeRecord[], branch: string): TreeRecord[] {
  return trees.filter((t) => t.branch === branch);
}

export function usedNames(trees: TreeRecord[]): Set<string> {
  return new Set(trees.map((t) => t.name));
}

const MANAGED_KINDS: ReadonlySet<TreeKind> = new Set<TreeKind>(["main", "ephemeral"]);

/**
 * Total order for two records of the same canonical path: a managed record
 * carries claim/ready state no git repository has another copy of, so it beats
 * `unmanaged`; within one class the later `createdAt` wins; an equal or
 * unparseable stamp keeps the winner side.
 */
function heldRecordWins(held: TreeRecord, challenger: TreeRecord): boolean {
  const heldManaged = MANAGED_KINDS.has(held.kind);
  const challengerManaged = MANAGED_KINDS.has(challenger.kind);
  if (heldManaged !== challengerManaged) return heldManaged;
  return !(Date.parse(challenger.createdAt) > Date.parse(held.createdAt));
}

/**
 * Union two registries of the SAME repo by canonical path — the collapse a
 * name/identity index pair needs, where each side owns half of one on-deck
 * pool. Name collisions across the two sides are left standing: the union is
 * by path, and a record's name is only ever consulted for display and for
 * `usedNames` disambiguation, both of which tolerate a duplicate.
 */
export function mergeRegistries(winner: TreeRecord[], loser: TreeRecord[]): TreeRecord[] {
  const byPath = new Map<string, TreeRecord>();
  const order: string[] = [];
  for (const rec of [...winner, ...loser]) {
    const key = canon(rec.path);
    const held = byPath.get(key);
    if (!held) {
      byPath.set(key, rec);
      order.push(key);
      continue;
    }
    if (!heldRecordWins(held, rec)) byPath.set(key, rec);
  }
  return order.map((key) => byPath.get(key)!);
}
