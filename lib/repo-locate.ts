/**
 * Repo locate: re-point every literal path rt stores for a repo whose folder
 * moved, as one unit.
 *
 * Ordering is the whole point. The reconciler prunes a registry row whose path
 * is absent from `git worktree list`, so an index row that heals ahead of the
 * registry destroys claimed/on-deck state and replenish then mints replacement
 * trees. Everything that can be written atomically goes in one state.db
 * transaction; `git worktree repair` and the verification run after it, and a
 * verification failure puts the pre-apply rows back.
 *
 * Pure of the daemon and the CLI: the daemon handler and `commands/repos.ts`
 * both drive these functions, and neither the caller nor the transport is
 * visible from here.
 */

import { existsSync, realpathSync } from "fs";
import { join, resolve as resolvePath } from "path";
import {
  getKnownRepos,
  loadRepoIndexEntries,
  migrateRepoData,
  migrationIncomplete,
  refreshRepoIndexMirror,
  removeIndexRow,
  setIndexPath,
  type RepoIndexEntry,
} from "./repo-index.ts";
import {
  deleteRegistry,
  hasRegistry,
  loadRegistry,
  mergeRegistries,
  saveRegistry,
  type TreeRecord,
} from "./worktree/registry.ts";
import { loadClaims, saveClaims, type EndpointClaim } from "./endpoint/store.ts";
import { deriveRepoIdentity, parseIdentity, serializeIdentity } from "./settings/identity.ts";
import { getStateDb } from "./state/index.ts";
import { listWorktreesAsync, runGit } from "./worktree/git-async.ts";

export type LocateRefusalCode =
  | "not-a-git-repo"
  | "nothing-lost"
  | "old-path-exists"
  | "identity-mismatch"
  | "identity-changed";

export interface LocateRefusal {
  refusal: LocateRefusalCode;
  message: string;
}

export interface RegistryRewrite {
  /** Index key this registry belongs to: the identity, or a legacy-name half of a healed pair. */
  repoKey: string;
  /** The whole registry after the re-root, in its original order. */
  trees: TreeRecord[];
  /** New spellings of the records this move re-rooted — what verification checks. */
  movedPaths: string[];
}

export interface ClaimRewrite {
  repoKey: string;
  worktree: string;
  newWorktree: string;
}

export interface LocatePlan {
  identity: string;
  oldPath: string;
  newPath: string;
  indexKeys: string[];
  /** Every `indexKeys` entry that is not the identity — collapsed after a verified apply. */
  legacyKeys: string[];
  registryRewrites: RegistryRewrite[];
  claimRewrites: ClaimRewrite[];
  /** In-tree worktree paths (new spellings, main excluded) handed to `git worktree repair`. */
  gitRepairPaths: string[];
}

export interface LocateResult {
  ok: boolean;
  identity: string;
  from: string;
  to: string;
  indexKeys: string[];
  treesRewritten: number;
  claimsRewritten: number;
  repaired: string[];
  /** Re-rooted registry paths with nothing on disk — a record the reconciler will prune, never a locate failure. */
  stalePaths: string[];
  legacyRows: { key: string; outcome: "collapsed" | "retained" }[];
  restored?: true;
  error?: string;
}

export interface LocateCandidate {
  path: string;
  identity: string;
}

export function isRefusal(x: LocatePlan | LocateRefusal): x is LocateRefusal {
  return "refusal" in x;
}

function refuse(refusal: LocateRefusalCode, message: string): LocateRefusal {
  return { refusal, message };
}

/** realpathSync, degrading to the literal spelling — a gone path must compare, not throw. */
function canon(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** `path` re-rooted onto `newPath`, or null when it lives outside the moved tree (an external worktree keeps its own path). */
function relocatePath(path: string, oldPath: string, newPath: string): string | null {
  if (path === oldPath) return newPath;
  if (path.startsWith(`${oldPath}/`)) return newPath + path.slice(oldPath.length);
  return null;
}

/**
 * Resolve which index rows a move touches, matching by IDENTITY only.
 *
 * A legacy-name row joins the plan through the identity row it shares a lost
 * directory with — never by name, which is exactly the drift identities exist
 * to end.
 */
export async function planLocate(opts: { newPath: string; repo?: string }): Promise<LocatePlan | LocateRefusal> {
  const newPath = canon(resolvePath(opts.newPath));
  if (!existsSync(join(newPath, ".git"))) {
    return refuse("not-a-git-repo", `${newPath} is not a git repository`);
  }

  const identity = serializeIdentity(await deriveRepoIdentity(newPath));
  const entries = loadRepoIndexEntries();
  const lost = entries.filter((e) => !existsSync(e.path));

  const named: RepoIndexEntry | null = opts.repo ? entries.find((e) => e.repoName === opts.repo) ?? null : null;
  if (opts.repo && !named) {
    return refuse("nothing-lost", `--repo ${opts.repo} is not in the repo index`);
  }
  if (named && existsSync(named.path)) {
    return refuse("old-path-exists", `${opts.repo} is indexed at ${named.path}, which still exists — that is a second clone, not a move`);
  }

  const identityRow = entries.find((e) => e.repoName === identity) ?? null;
  if (identityRow && existsSync(identityRow.path)) {
    return canon(identityRow.path) === newPath
      ? refuse("nothing-lost", `${identity} is already indexed at ${newPath}`)
      : refuse("old-path-exists", `${identity} is already indexed at ${identityRow.path}, which still exists — that is a second clone, not a move`);
  }

  if (!identityRow) {
    if (lost.length === 0) {
      return refuse("nothing-lost", `no indexed repo is missing from disk, so ${newPath} has nothing to be located as`);
    }
    if (parseIdentity(identity)?.kind === "path") {
      return refuse(
        "identity-changed",
        `${newPath} derives ${identity}, and no index row is keyed by it. A repo with no origin remote is identified BY its main worktree's path, so moving it mints a new identity rather than keeping the old one — locate re-points paths, it never re-keys a repo. Register the new path instead: rt repos register ${newPath}`,
      );
    }
    return refuse(
      "identity-mismatch",
      `${newPath} derives ${identity}, which matches no indexed repo whose path is missing (lost rows: ${lost.map((e) => e.repoName).join(", ")})`,
    );
  }
  if (named && canon(named.path) !== canon(identityRow.path)) {
    return refuse(
      "identity-mismatch",
      `${newPath} derives ${identity} (indexed at ${identityRow.path}), but --repo names ${named.repoName} at ${named.path} — locate matches by identity, never by name`,
    );
  }

  const oldPath = identityRow.path;
  const indexKeys = lost.filter((e) => e.path === oldPath).map((e) => e.repoName);
  const legacyKeys = indexKeys.filter((key) => key !== identity);

  const registryRewrites: RegistryRewrite[] = [];
  const repairPaths = new Set<string>();
  for (const key of indexKeys) {
    if (!hasRegistry(key)) continue;
    const movedPaths: string[] = [];
    const trees = loadRegistry(key).map((rec) => {
      const moved = relocatePath(rec.path, oldPath, newPath);
      if (moved === null) return rec;
      movedPaths.push(moved);
      if (moved !== newPath) repairPaths.add(moved);
      return { ...rec, path: moved };
    });
    registryRewrites.push({ repoKey: key, trees, movedPaths });
  }

  const claimRewrites: ClaimRewrite[] = [];
  for (const key of indexKeys) {
    for (const claim of loadClaims(key)) {
      const moved = relocatePath(claim.worktree, oldPath, newPath);
      if (moved === null) continue;
      claimRewrites.push({ repoKey: key, worktree: claim.worktree, newWorktree: moved });
    }
  }

  return {
    identity,
    oldPath,
    newPath,
    indexKeys,
    legacyKeys,
    registryRewrites,
    claimRewrites,
    gitRepairPaths: [...repairPaths],
  };
}

interface LocateSnapshot {
  index: { key: string; path: string | null }[];
  registries: { key: string; trees: TreeRecord[]; existed: boolean }[];
  claims: { key: string; claims: EndpointClaim[] }[];
}

/** Every row the apply can touch, read before the first write — the identity's own rows included, since the merge writes them whether or not the plan rewrote them. */
function captureSnapshot(plan: LocatePlan): LocateSnapshot {
  const claimKeys = [...new Set(plan.claimRewrites.map((c) => c.repoKey))];
  const entries = loadRepoIndexEntries();
  return {
    index: indexWriteKeys(plan).map((key) => ({
      key,
      path: entries.find((e) => e.repoName === key)?.path ?? null,
    })),
    registries: [...new Set([...plan.registryRewrites.map((r) => r.repoKey), plan.identity])].map((key) => ({
      key,
      trees: loadRegistry(key),
      existed: hasRegistry(key),
    })),
    claims: claimKeys.map((key) => ({ key, claims: loadClaims(key) })),
  };
}

function indexWriteKeys(plan: LocatePlan): string[] {
  return [...new Set([...plan.indexKeys, plan.identity])];
}

function restoreSnapshot(snapshot: LocateSnapshot): void {
  getStateDb().transaction(() => {
    for (const row of snapshot.index) {
      if (row.path === null) removeIndexRow(row.key);
      else setIndexPath(row.key, row.path);
    }
    for (const reg of snapshot.registries) {
      if (reg.existed) saveRegistry(reg.key, reg.trees);
      else deleteRegistry(reg.key);
    }
    for (const c of snapshot.claims) saveClaims(c.key, c.claims);
  })();
}

/**
 * The registry half of the apply: the pair's registries are merged onto the
 * IDENTITY key and every legacy registry row is dropped, so the reconciler
 * (which iterates identity keys) sees one pool instead of two halves.
 */
function writeRegistries(plan: LocatePlan): void {
  const byKey = new Map(plan.registryRewrites.map((r) => [r.repoKey, r.trees]));
  let merged = byKey.get(plan.identity) ?? loadRegistry(plan.identity);
  let touched = byKey.has(plan.identity);
  for (const key of plan.legacyKeys) {
    const legacy = byKey.get(key);
    if (!legacy) continue;
    merged = mergeRegistries(merged, legacy);
    deleteRegistry(key);
    touched = true;
  }
  if (touched) saveRegistry(plan.identity, merged);
}

function writeClaims(plan: LocatePlan): void {
  for (const key of new Set(plan.claimRewrites.map((c) => c.repoKey))) {
    const moves = new Map(
      plan.claimRewrites.filter((c) => c.repoKey === key).map((c) => [c.worktree, c.newWorktree]),
    );
    saveClaims(
      key,
      loadClaims(key).map((c) => {
        const moved = moves.get(c.worktree);
        return moved === undefined ? c : { ...c, worktree: moved };
      }),
    );
  }
}

/**
 * Every re-rooted tree that exists on disk must also be one git knows about;
 * a re-rooted tree with nothing on disk is a stale record, which the
 * reconciler prunes on its own and which must not fail an otherwise correct
 * move.
 */
async function verifyLocate(plan: LocatePlan): Promise<{ error: string | null; stalePaths: string[] }> {
  const listed = await listWorktreesAsync(plan.newPath);
  if (listed === null) return { error: `git worktree list failed in ${plan.newPath}`, stalePaths: [] };
  const known = new Set(listed.map((w) => canon(w.path)));
  if (!known.has(canon(plan.newPath))) {
    return { error: `${plan.newPath} is not the main worktree git reports`, stalePaths: [] };
  }

  const stalePaths: string[] = [];
  for (const rewrite of plan.registryRewrites) {
    for (const path of rewrite.movedPaths) {
      if (!existsSync(path)) {
        stalePaths.push(path);
        continue;
      }
      if (!known.has(canon(path))) {
        return { error: `${path} exists but git does not list it as a worktree of ${plan.newPath}`, stalePaths };
      }
    }
  }
  return { error: null, stalePaths };
}

/**
 * Collapse the legacy half of a healed pair, on prune's rules: the row is
 * dropped only once its data dir has fully moved, because eviction is what
 * makes a leftover unreachable.
 */
function collapseLegacyRows(plan: LocatePlan): LocateResult["legacyRows"] {
  const out: LocateResult["legacyRows"] = [];
  for (const key of plan.legacyKeys) {
    const data = migrateRepoData(key, plan.identity);
    if (migrationIncomplete(data)) {
      out.push({ key, outcome: "retained" });
      continue;
    }
    removeIndexRow(key);
    out.push({ key, outcome: "collapsed" });
  }
  return out;
}

export async function applyLocate(plan: LocatePlan): Promise<LocateResult> {
  const snapshot = captureSnapshot(plan);
  const base = {
    identity: plan.identity,
    from: plan.oldPath,
    to: plan.newPath,
    indexKeys: plan.indexKeys,
    treesRewritten: plan.registryRewrites.reduce((n, r) => n + r.movedPaths.length, 0),
    claimsRewritten: plan.claimRewrites.length,
  };

  // bun:sqlite transactions are sync-only: every git call lives below this
  // block, never inside it.
  getStateDb().transaction(() => {
    for (const key of indexWriteKeys(plan)) setIndexPath(key, plan.newPath);
    writeRegistries(plan);
    writeClaims(plan);
  })();
  refreshRepoIndexMirror();

  // Path arguments fix each linked worktree's entry in the main repo's admin
  // dir; the no-arg pass then fixes the `.git` file inside every linked
  // worktree. A move breaks both directions, so both passes run.
  if (plan.gitRepairPaths.length > 0) {
    await runGit(plan.newPath, ["worktree", "repair", ...plan.gitRepairPaths]);
  }
  await runGit(plan.newPath, ["worktree", "repair"]);

  const { error, stalePaths } = await verifyLocate(plan);
  if (error !== null) {
    restoreSnapshot(snapshot);
    refreshRepoIndexMirror();
    return { ...base, ok: false, repaired: plan.gitRepairPaths, stalePaths, legacyRows: [], restored: true, error };
  }

  const legacyRows = collapseLegacyRows(plan);
  refreshRepoIndexMirror();
  return { ...base, ok: true, repaired: plan.gitRepairPaths, stalePaths, legacyRows };
}

/**
 * Directories the repo scan surfaced whose derived identity is one of the
 * index's lost rows — the candidate set `rt repos locate` offers when it is
 * given no path. Never auto-picked: this only proposes.
 */
export async function findLocateCandidates(): Promise<LocateCandidate[]> {
  const repos = getKnownRepos({ includeMissing: true });
  const lostKeys = new Set(repos.filter((r) => r.missing).map((r) => r.repoName));
  if (lostKeys.size === 0) return [];

  const candidates: LocateCandidate[] = [];
  for (const repo of repos) {
    if (repo.registered !== false) continue;
    const path = repo.worktrees[0]?.path;
    if (!path) continue;
    let identity: string;
    try {
      identity = serializeIdentity(await deriveRepoIdentity(path));
    } catch {
      continue;
    }
    if (!lostKeys.has(identity)) continue;
    candidates.push({ path, identity });
  }
  return candidates;
}
