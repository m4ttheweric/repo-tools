/**
 * Repo locate: re-point every literal path rt stores for a repo whose folder
 * moved, as one unit.
 *
 * Ordering is the whole point. The reconciler prunes a registry row whose path
 * is absent from `git worktree list`, so an index row that heals ahead of the
 * registry destroys claimed/on-deck state and replenish then mints replacement
 * trees. So the apply repairs git and verifies FIRST, while the index still
 * names the dead path (a reconciler pass that interleaves there finds a repo
 * whose path does not exist and bails), and only then commits index rows,
 * registries and claims in one state.db transaction. Nothing is written until
 * the whole move is known to be sound, which is why there is no rollback path.
 *
 * An in-daemon caller still runs this under the reconciler's in-flight hold:
 * the transaction is atomic against a reader, but the git repair passes are
 * not, and a pass that starts mid-repair can see a half-linked worktree.
 *
 * Pure of the daemon and the CLI: the daemon handler and `commands/repos.ts`
 * both drive these functions, and neither the caller nor the transport is
 * visible from here.
 */

import { existsSync, realpathSync, statSync } from "fs";
import { join, resolve as resolvePath } from "path";
import {
  getKnownRepos,
  loadRepoIndexEntries,
  migrateRepoData,
  migrationIncomplete,
  refreshRepoIndexMirror,
  removeIndexRow,
  setIndexPath,
  type DataMigration,
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
  | "not-main-worktree"
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
  /** Plan-time preview (dry-run display) and the path set verification checks — the apply re-reads and re-roots each registry itself. */
  registryRewrites: RegistryRewrite[];
  /** Plan-time preview, same as `registryRewrites`. */
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
  /** `retained` carries the reason its data dir could not all move; the row is left naming `from`, never `to`. */
  legacyRows: { key: string; outcome: "collapsed" | "retained"; reason?: string }[];
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

/** The one re-root both the plan and the apply run, so what lands is never a plan-time snapshot of the registry. */
function relocateTrees(
  trees: TreeRecord[],
  oldPath: string,
  newPath: string,
): { trees: TreeRecord[]; movedPaths: string[] } {
  const movedPaths: string[] = [];
  const next = trees.map((rec) => {
    const moved = relocatePath(rec.path, oldPath, newPath);
    if (moved === null) return rec;
    movedPaths.push(moved);
    return { ...rec, path: moved };
  });
  return { trees: next, movedPaths };
}

/**
 * Whether `path` is a repo's MAIN worktree. Locating a linked worktree would
 * re-root every stored path onto a base that is one directory of the repo, so
 * this is a gate, not a nicety: a linked worktree derives the same identity as
 * its main worktree and would otherwise plan cleanly.
 *
 * A `.git` directory is main by construction. A `.git` FILE is either a linked
 * worktree or a `--separate-git-dir` main worktree, and only git can tell them
 * apart: git-dir equals git-common-dir for main, and is
 * `<common>/worktrees/<id>` for a linked tree.
 */
async function isMainWorktree(path: string): Promise<boolean> {
  try {
    if (statSync(join(path, ".git")).isDirectory()) return true;
  } catch {
    return false;
  }
  const r = await runGit(path, ["rev-parse", "--git-dir", "--git-common-dir"]);
  if (r.exitCode !== 0) return false;
  const [gitDir, commonDir] = r.stdout.trim().split("\n");
  if (gitDir === undefined || commonDir === undefined) return false;
  // git prints these relative to the worktree unless they are absolute — which
  // is exactly what `resolve` handles and `join` would corrupt.
  return canon(resolvePath(path, gitDir)) === canon(resolvePath(path, commonDir));
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
  if (!(await isMainWorktree(newPath))) {
    return refuse(
      "not-main-worktree",
      `${newPath} is a linked worktree, not the repo's main worktree — locate re-roots every stored path onto the path it is given, so it must be given the repo root`,
    );
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
    const { trees, movedPaths } = relocateTrees(loadRegistry(key), oldPath, newPath);
    for (const moved of movedPaths) {
      if (moved !== newPath) repairPaths.add(moved);
    }
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

function indexWriteKeys(plan: LocatePlan): string[] {
  return [...new Set([...plan.indexKeys, plan.identity])];
}

/**
 * The registry half of the apply: every registry is re-read and re-rooted
 * HERE, not carried over from the plan, so a tree provisioned between plan and
 * apply is moved rather than overwritten. The pair's registries are merged onto
 * the IDENTITY key and every legacy registry row is dropped, so the reconciler
 * (which iterates identity keys) sees one pool instead of two halves.
 */
function writeRegistries(plan: LocatePlan): number {
  const relocate = (key: string) => relocateTrees(loadRegistry(key), plan.oldPath, plan.newPath);
  let moved = 0;
  let touched = hasRegistry(plan.identity);
  let merged: TreeRecord[] = [];
  if (touched) {
    const own = relocate(plan.identity);
    merged = own.trees;
    moved += own.movedPaths.length;
  }
  for (const key of plan.legacyKeys) {
    if (!hasRegistry(key)) continue;
    const legacy = relocate(key);
    merged = mergeRegistries(merged, legacy.trees);
    moved += legacy.movedPaths.length;
    deleteRegistry(key);
    touched = true;
  }
  if (touched) saveRegistry(plan.identity, merged);
  return moved;
}

/**
 * The claims half of the apply, on the same rules as `writeRegistries`: every
 * claim is re-read HERE (a claim taken between plan and apply must move with
 * the repo, not be reverted to the plan's copy), and the pair's claims are
 * merged onto the IDENTITY key with the legacy keys emptied — a legacy row
 * whose index row `collapseLegacyRows` then drops would otherwise keep claim
 * rows under a key nothing looks up again.
 *
 * `endpoint_claims` is keyed `(repo, worktree, role)`, so a pair that claimed
 * the same tree in the same role collides on the merge; the identity's own row
 * wins, which is why it is absorbed last.
 */
function writeClaims(plan: LocatePlan): number {
  const merged = new Map<string, { claim: EndpointClaim; relocated: boolean }>();
  const absorb = (key: string): number => {
    const claims = loadClaims(key);
    for (const c of claims) {
      const moved = relocatePath(c.worktree, plan.oldPath, plan.newPath);
      const claim = moved === null ? c : { ...c, worktree: moved };
      merged.set(JSON.stringify([claim.worktree, claim.role]), { claim, relocated: moved !== null });
    }
    return claims.length;
  };

  let touched = false;
  for (const key of plan.legacyKeys) {
    if (absorb(key) === 0) continue;
    saveClaims(key, []);
    touched = true;
  }
  if (absorb(plan.identity) > 0) touched = true;
  if (!touched) return 0;

  const entries = [...merged.values()];
  saveClaims(plan.identity, entries.map((e) => e.claim));
  return entries.filter((e) => e.relocated).length;
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
  // git lists the main worktree FIRST — membership alone would accept a linked
  // worktree of the same repo as the new root.
  if (listed[0] === undefined || canon(listed[0].path) !== canon(plan.newPath)) {
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

/** Why a legacy row outlived the collapse, in the terms the operator has to act on. */
function retentionReason(data: DataMigration): string {
  const parts: string[] = [];
  if (data.refused.length > 0) parts.push(`both names hold ${data.refused.join(", ")}`);
  if (data.registry === "refused") parts.push("its worktree registry could not be written");
  return parts.join("; ");
}

/**
 * Collapse the legacy half of a healed pair, on prune's rules: the row is
 * dropped only once its data dir has fully moved, because eviction is what
 * makes a leftover unreachable.
 *
 * INVARIANT: a legacy index row must never name a LIVE path without owning a
 * worktree registry. Its registry merged onto the identity inside the
 * transaction, so a retained row is written back to the (now dead) `oldPath`:
 * a reconcile pass keyed on that row then bails on the missing path, where a
 * live path would make it derive the repo's worktree settings, adopt every
 * tree as unmanaged under the legacy key, and replenish a second pool beside
 * the real one.
 */
function collapseLegacyRows(plan: LocatePlan): LocateResult["legacyRows"] {
  const out: LocateResult["legacyRows"] = [];
  for (const key of plan.legacyKeys) {
    const data = migrateRepoData(key, plan.identity);
    if (migrationIncomplete(data)) {
      setIndexPath(key, plan.oldPath);
      out.push({ key, outcome: "retained", reason: retentionReason(data) });
      continue;
    }
    removeIndexRow(key);
    out.push({ key, outcome: "collapsed" });
  }
  return out;
}

/**
 * Repair git's admin files for the moved trees.
 *
 * A path argument fixes both halves of the link for the tree it names (the
 * main repo's `worktrees/<id>/gitdir` entry and that tree's own `.git` file);
 * the no-arg pass then re-links the trees that did NOT move, whose `.git`
 * files still point at the main worktree's old location. Both are needed
 * because a folder move breaks both populations at once.
 *
 * `git worktree repair` exits non-zero on a path argument it cannot resolve,
 * so the list is filtered to what exists — a re-rooted record with nothing on
 * disk is the stale case verification reports, not a failed repair.
 */
async function repairGit(plan: LocatePlan): Promise<{ repaired: string[]; error: string | null }> {
  const repaired = plan.gitRepairPaths.filter((path) => existsSync(path));
  if (repaired.length > 0) {
    const r = await runGit(plan.newPath, ["worktree", "repair", ...repaired]);
    if (r.exitCode !== 0) return { repaired: [], error: `git worktree repair failed: ${r.stderr.trim() || `exit ${r.exitCode}`}` };
  }
  const all = await runGit(plan.newPath, ["worktree", "repair"]);
  if (all.exitCode !== 0) return { repaired: [], error: `git worktree repair failed: ${all.stderr.trim() || `exit ${all.exitCode}`}` };
  return { repaired, error: null };
}

/**
 * Git first, state.db last. Until the transaction commits, the index still
 * names the dead path, so a reconciler pass that interleaves with the repair
 * finds a repo whose path does not exist and bails instead of pruning trees
 * whose gitdir pointers are still being fixed. Nothing is written unless the
 * whole move verifies, which is why no rollback exists.
 */
export async function applyLocate(plan: LocatePlan): Promise<LocateResult> {
  const base = {
    identity: plan.identity,
    from: plan.oldPath,
    to: plan.newPath,
    indexKeys: plan.indexKeys,
  };
  const failed = (repaired: string[], stalePaths: string[], error: string): LocateResult => ({
    ...base,
    ok: false,
    treesRewritten: 0,
    claimsRewritten: 0,
    repaired,
    stalePaths,
    legacyRows: [],
    error,
  });

  const repair = await repairGit(plan);
  if (repair.error !== null) return failed(repair.repaired, [], repair.error);

  const { error, stalePaths } = await verifyLocate(plan);
  if (error !== null) return failed(repair.repaired, stalePaths, error);

  // bun:sqlite transactions are sync-only: every git call lives above this
  // block, never inside it.
  let treesRewritten = 0;
  let claimsRewritten = 0;
  getStateDb().transaction(() => {
    for (const key of indexWriteKeys(plan)) setIndexPath(key, plan.newPath);
    treesRewritten = writeRegistries(plan);
    claimsRewritten = writeClaims(plan);
  })();
  refreshRepoIndexMirror();

  const legacyRows = collapseLegacyRows(plan);
  refreshRepoIndexMirror();
  return { ...base, ok: true, treesRewritten, claimsRewritten, repaired: repair.repaired, stalePaths, legacyRows };
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
