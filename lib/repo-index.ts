/**
 * Global repo index — tracks all known repos in state.db's kv store
 * (ns='repo-index', one row per repo: k=repoName, v=main-worktree path).
 *
 * The index is a DISPOSABLE CACHE (RT-49, collapsed into state.db by RT-50):
 * it self-populates as rt visits repos (`updateRepoIndex`, called from
 * lib/repo.ts's `getRepoIdentity`). Losing it loses nothing durable — every
 * entry regenerates the next time rt runs inside that repo — except a row
 * whose repo MOVED, which only `updateRepoIndexAsync` or `rt repos locate`
 * can re-point (see `writeIndexRow`) — and meanwhile the
 * picker still surfaces every repo reachable under the `rt.repoRoots`
 * settings key (below) as an unregistered candidate. It is not part of any
 * backup/restore story and never will be.
 *
 * ~/.mattstack/rt/repos.json is written alongside state.db purely as a
 * derived compatibility file for out-of-process rt-client consumers — see
 * repoIndexCompatPath's doc comment below.
 *
 * Provides repo discovery with worktree enumeration so commands
 * can offer pickers when run outside a git repo.
 */

import { execSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, type Dirent } from "fs";
import { homedir } from "os";
import { basename, dirname, join, resolve as resolvePath } from "path";
import { repoDataDir, rtDir } from "./rt-paths.ts";
import { deleteKvValue, getKvValue, getStateDb, hasKvValue, listKvEntries, listKvValues, setKvValue } from "./state/index.ts";
import { rekeyKvNamespace } from "./state/identity-migrate.ts";
import { deriveRepoIdentity, parseIdentity, serializeIdentity } from "./settings/identity.ts";
import { repoLabel, repoLabelFull, repoLabelQualified } from "./repo-label.ts";
import { dim } from "./ansi.ts";
import { getSetting } from "./settings/resolve.ts";
import { mergeRegistries, type TreeRecord } from "./worktree/registry.ts";
import { listWorktreesAsync } from "./worktree/git-async.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface KnownRepo {
  repoName: string;
  /** All available worktree paths */
  worktrees: { path: string; branch: string; isBare: boolean }[];
  dataDir: string;
  /** False for repos discovered by scanning sibling directories, never
   *  explicitly visited by rt. Omitted (implicitly true) for indexed repos. */
  registered?: boolean;
  /** The indexed path no longer exists. The row is kept so `rt repos locate`
   *  can move it as one unit with its registry; it is never a cd target. */
  missing?: true;
}

// ─── Index CRUD ──────────────────────────────────────────────────────────────

interface RepoIndex {
  [repoName: string]: string; // repoName → primary repo root path
}

export const REPO_INDEX_NS = "repo-index";

/**
 * Deprecated derived-compatibility path: state.db is authoritative, but
 * out-of-process rt-client consumers still read this file directly against
 * a PUBLISHED @mattstack/rt-client (gitq's secrets.ts and data.ts, at
 * minimum — they run in their own process and cannot see this process's
 * state.db handle). Kept in sync on every repo-index write so those readers
 * don't go stale. Safe to delete once rt-client resolves the repo index
 * through state.db (or the daemon) and every consumer has upgraded past
 * @mattstack/rt-client 0.3.0.
 */
function repoIndexCompatPath(): string {
  return join(rtDir(), "repos.json");
}

/** Best-effort mirror: a write failure here (permissions, disk full) must never break the state.db write it mirrors, or the command that triggered it — the out-of-process reader just sees a stale file until the next successful write. */
function writeRepoIndexCompat(index: RepoIndex): void {
  try {
    writeFileSync(repoIndexCompatPath(), JSON.stringify(index));
  } catch {
    // best effort — see repoIndexCompatPath's doc comment
  }
}

/**
 * On a machine upgrading from pre-Phase-2 rt, the index namespace starts
 * empty while ~/.mattstack/rt/repos.json still holds every previously
 * visited repo — importing it here (rather than via LEGACY_IMPORTS, gated to
 * fire only once from user_version 0) means a repo registered before the
 * upgrade doesn't silently drop out of `rt cd`'s picker until it's visited
 * again. Only fires when the namespace is truly empty — a repo already
 * indexed on this machine short-circuits, so a live compat file (kept
 * current by every `updateRepoIndex` call below) is never re-imported over
 * itself.
 *
 * Deliberately NOT `lib/state/legacy-import.ts`'s `importLegacyJsonFile`:
 * every other migrated path treats its legacy file as retired and safe to
 * rename away once imported, but repos.json is the ONE path in the set with
 * a second, ongoing job — `updateRepoIndex` below keeps it live as the
 * out-of-process compat mirror gitq reads (see `repoIndexCompatPath`'s doc
 * comment). Renaming it here, even briefly, would delete gitq's data source
 * for every reader between this import and the next `updateRepoIndex` call
 * — which, on a daemon that only primes the index at boot and never writes
 * (lib/daemon/repo-index.ts), could be indefinite. So this import REFRESHES
 * the mirror in place instead of renaming: the file is never deleted, only
 * ever rewritten to the current index, exactly like a normal
 * `updateRepoIndex` write would.
 */
export function loadRepoIndex(): RepoIndex {
  const existing = listKvValues<string>(REPO_INDEX_NS);
  if (Object.keys(existing).length > 0) return existing;

  const path = repoIndexCompatPath();
  if (!existsSync(path)) return existing;

  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    console.warn(`rt: legacy state file ${path} is corrupt JSON, leaving in place: ${(err as Error).message}`);
    return existing;
  }

  const map = json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : {};
  const imported: RepoIndex = {};
  for (const [name, repoPath] of Object.entries(map)) {
    if (typeof repoPath !== "string") continue;
    // Best-effort per entry: a swallowed SQLITE_BUSY here still leaves the
    // entry in `imported` below, so the mirror this function rewrites stays
    // correct even for a row that didn't make it into state.db this time —
    // unlike every other migrated path, nothing is deleted, so a missed row
    // simply retries on the next call that finds the namespace still empty.
    try {
      setKvValue(REPO_INDEX_NS, name, repoPath);
    } catch { /* best effort */ }
    imported[name] = repoPath;
  }

  writeRepoIndexCompat({ ...existing, ...imported });
  return Object.keys(imported).length > 0 ? imported : existing;
}

/**
 * Branch name from a git dir's HEAD file. "" for a detached HEAD (HEAD holds a
 * raw SHA, not a ref) or an unreadable/absent HEAD — matching what a `branch`
 * line's absence in `git worktree list --porcelain` yields.
 */
function headBranch(gitDir: string): string {
  try {
    const m = readFileSync(join(gitDir, "HEAD"), "utf8").trim().match(/^ref: refs\/heads\/(.+)$/);
    return m ? m[1] : "";
  } catch {
    return "";
  }
}

/**
 * Fast path for the overwhelmingly common single-worktree repo, avoiding a
 * `git worktree list` subprocess per repo (the picker's dominant startup cost).
 * Git creates `.git/worktrees/<name>/` for every LINKED worktree and for none
 * of the main one, so a `.git` that is a real directory with an empty (or
 * absent) `.git/worktrees/` has exactly one worktree, rooted at `dir` — git's
 * own spelling of it, since `dir` is already `git rev-parse --show-toplevel`.
 * Returns null for any other shape (`.git` a file = a linked worktree or
 * submodule; a non-empty `.git/worktrees/`; a bare repo with no `.git`), and
 * the caller falls back to the authoritative `git worktree list`.
 */
function singleWorktree(dir: string): { path: string; branch: string; isBare: false } | null {
  const dotgit = join(dir, ".git");
  let isDir = false;
  try {
    isDir = statSync(dotgit).isDirectory();
  } catch {
    return null;
  }
  if (!isDir) return null;
  try {
    if (readdirSync(join(dotgit, "worktrees")).length > 0) return null;
  } catch { /* absent worktrees dir == single worktree */ }
  // `git worktree list --porcelain` reports the canonical, symlink-resolved
  // path, so this fast path must match it — a caller that reaches a repo
  // through a symlinked ancestor (a stale index row, an app-bundle alias)
  // must not see the two spellings as different repos.
  return { path: safeRealpath(dir), branch: headBranch(dotgit), isBare: false };
}

/** The repo's MAIN worktree path as git reports it, degrading to `repoRoot`. */
function observedMainPath(repoRoot: string): string {
  // A single-worktree repo's main worktree IS repoRoot modulo symlinks (both
  // are git's `--show-toplevel`), so the git spawn only earns its cost when
  // linked worktrees exist and repoRoot might be one of them rather than the
  // main. `.path` (not `repoRoot`) is what's returned: singleWorktree
  // resolves symlinks the same way `git worktree list --porcelain` does, and
  // a caller reaching this repo through a symlinked ancestor must land on the
  // same canonical spelling as the git fallback below would give it.
  const single = singleWorktree(repoRoot);
  if (single) return single.path;
  try {
    const listed = execSync("git worktree list --porcelain", {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: "pipe",
    });
    return listed.split("\n")[0]?.replace("worktree ", "").trim() || repoRoot;
  } catch {
    return repoRoot;
  }
}

/** Async twin of observedMainPath: the repo's MAIN worktree path as git
 *  reports it, degrading to repoRoot. Safe on the daemon thread. */
async function observedMainPathAsync(repoRoot: string): Promise<string> {
  const wts = await listWorktreesAsync(repoRoot);
  return wts?.[0]?.path ?? repoRoot;
}

/**
 * The row's current path, read straight from the namespace rather than through
 * `loadRepoIndex()`: that function's legacy-repos.json import is a migration
 * side effect (it writes rows AND rewrites the mirror), and firing it from
 * inside the write path would reorder it ahead of the write it guards.
 */
function storedIndexPath(repoName: string): string | undefined {
  return getKvValue<string | undefined>(REPO_INDEX_NS, repoName, undefined);
}

/** True when the stored row names a directory that is gone and the repo is now somewhere else — a MOVE, not a second clone. */
function storedPathMoved(stored: string | undefined, mainPath: string): boolean {
  return stored !== undefined && stored !== mainPath && !existsSync(stored);
}

function writeIndexRow(repoName: string, mainPath: string): void {
  try {
    // The read and loadRepoIndex() can throw (an unopenable state.db — e.g.
    // root-owned after a sudo invocation) — inside the try along with the write
    // they bracket, so getRepoIdentity() (which every in-repo command calls)
    // degrades to skipping the index update rather than crashing the command.
    //
    // A moved repo is NOT written here: re-pointing the index row ahead of the
    // worktree registry is what makes the reconciler prune every claimed tree,
    // and the repair that ordering owes is async git — forbidden on the daemon
    // thread, which reaches this function through resolveIndexPathForIdentity.
    // The row stays lost (visible as `missing`) until `updateRepoIndexAsync`
    // or `rt repos locate` moves it as one unit.
    if (storedPathMoved(storedIndexPath(repoName), mainPath)) return;
    setKvValue(REPO_INDEX_NS, repoName, mainPath);
    writeRepoIndexCompat(loadRepoIndex());
  } catch { /* best effort */ }
}

export function updateRepoIndex(repoName: string, repoRoot: string): void {
  writeIndexRow(repoName, observedMainPath(repoRoot));
}

/**
 * `healed` distinguishes a plain index write from a whole move; `ok: false` is
 * ONLY ever a refused/failed locate — the plain write keeps the sync seam's
 * best-effort contract and never reports failure.
 */
export type IndexHealResult = { ok: true; healed: boolean } | { ok: false; error: string };

/**
 * `updateRepoIndex` for callers that can await: the same write, plus the move
 * heal the sync seam cannot perform. The locate runs in the daemon whenever
 * one is present — imported lazily, both to keep the daemon client off every
 * rt command's startup path and because repo-locate.ts imports this module.
 *
 * A refused move is RETURNED, never thrown and never warned about here: the
 * row is left naming the gone path, so a caller that reports success without
 * checking is claiming a repo is indexed when it is not.
 */
export async function updateRepoIndexAsync(repoName: string, repoRoot: string): Promise<IndexHealResult> {
  const mainPath = observedMainPath(repoRoot);
  let stored: string | undefined;
  try {
    stored = storedIndexPath(repoName);
  } catch {
    stored = undefined;
  }
  if (!storedPathMoved(stored, mainPath)) {
    writeIndexRow(repoName, mainPath);
    return { ok: true, healed: false };
  }
  const { locateMovedRepo } = await import("./repo-locate-dispatch.ts");
  const outcome = await locateMovedRepo({ newPath: mainPath, repo: repoName });
  return outcome.ok ? { ok: true, healed: true } : { ok: false, error: outcome.error };
}

/**
 * Raw index-row write: no git probe, no move detection. `updateRepoIndex` is
 * the caller-facing path that DERIVES the main path; this is the primitive for
 * a caller that has already decided what the row must say, and it is the only
 * index write that is safe to run inside a state.db transaction.
 */
export function setIndexPath(key: string, mainPath: string): void {
  setKvValue(REPO_INDEX_NS, key, mainPath);
}

/** Drop one index row. */
export function removeIndexRow(key: string): void {
  deleteKvValue(REPO_INDEX_NS, key);
}

/** Rewrite ~/.mattstack/rt/repos.json from the current rows — a FILE write, so it runs after a transaction commits, never inside one. */
export function refreshRepoIndexMirror(): void {
  try {
    writeRepoIndexCompat(loadRepoIndex());
  } catch {
    // best effort — see repoIndexCompatPath's doc comment
  }
}

/**
 * Resolves a serialized identity to its indexed main-worktree path, tolerating
 * an index whose rows still carry legacy repo-name keys (the state every
 * machine is in right after the identity cutover). A miss scans the legacy
 * rows, derives each row's identity from its path, and on a match ADDS the
 * identity row — additive on purpose: the legacy row must stay for
 * `rt repos prune` to collapse the pair, or its data dir would be stranded.
 * Null when no row, legacy or identity, matches: an unregistered repo stays
 * unregistered — this is a migration, not a registration.
 */
export async function resolveIndexPathForIdentity(serialized: string): Promise<string | null> {
  let index: RepoIndex;
  try {
    index = loadRepoIndex();
  } catch {
    return null;
  }
  const direct = index[serialized];
  if (direct) return direct;
  for (const [key, path] of Object.entries(index)) {
    if (parseIdentity(key) !== null) continue;
    if (!existsSync(path)) continue;
    try {
      if (serializeIdentity(await deriveRepoIdentity(path)) !== serialized) continue;
    } catch {
      continue;
    }
    writeIndexRow(serialized, await observedMainPathAsync(path));
    return path;
  }
  return null;
}

// ─── Rename drift (RT-60) ───────────────────────────────────────────────────

export interface RepoIndexEntry {
  repoName: string;
  path: string;
  /** Epoch ms of the last `updateRepoIndex` write under this name. Rows that
   *  arrived through `loadRepoIndex`'s legacy import all share one stamp, and
   *  a row whose write was dropped (SQLITE_BUSY) reads as 0. */
  updatedAt: number;
}

/**
 * `loadRepoIndex` with each row's write timestamp attached.
 *
 * Deliberately layered ON TOP of `loadRepoIndex()` rather than replacing its
 * body: that function owns the legacy-import path, whose contract is that an
 * entry which fails to reach state.db still comes back in the map (so the
 * compat mirror it rewrites stays complete). Re-listing the table here would
 * silently drop exactly those rows. They surface with `updatedAt: 0` instead,
 * which sorts them last — correct, since a row that never landed is the
 * least-recently-written thing there is.
 */
export function loadRepoIndexEntries(): RepoIndexEntry[] {
  const index = loadRepoIndex();
  const stamps = new Map(listKvEntries<string>(REPO_INDEX_NS).map((e) => [e.key, e.updatedAt]));
  return Object.entries(index).map(([repoName, path]) => ({
    repoName,
    path,
    updatedAt: stamps.get(repoName) ?? 0,
  }));
}

export interface DuplicateEntry {
  entry: RepoIndexEntry;
  /** The name that won the realpath — what the picker shows for this tree. */
  keptAs: string;
}

export interface IndexPartition {
  keep: RepoIndexEntry[];
  duplicates: DuplicateEntry[];
}

function identityRank(entry: RepoIndexEntry): number {
  return parseIdentity(entry.repoName) === null ? 0 : 1;
}

/**
 * Splits index rows that point at the SAME directory under two names.
 *
 * Renaming a repo mints a second key and retires neither: the name comes from
 * the origin remote (`deriveRepoName`), so a remote rename adds one, and a
 * directory rename adds one whenever a compat symlink keeps the old path
 * resolving — `existsSync` follows symlinks, so the dead row passes the
 * liveness filter and the picker shows the tree twice.
 *
 * An identity key beats a legacy name outright, whatever the stamps say: the
 * loser is what prune migrates ONTO the winner, and carrying identity-keyed
 * data back onto a name would re-mint the split the cutover ended.
 *
 * Among rows of the same kind the most recently written wins, because
 * `updateRepoIndex` restamps a name every time rt runs inside that repo: the
 * live identity keeps moving forward while the retired one stays frozen at
 * whenever it was last used. Name order breaks ties so a legacy import (every
 * row stamped within the same millisecond) is at least deterministic.
 *
 * Losers are only hidden, never dropped, by the caller in `getKnownRepos`.
 * Lookups by name elsewhere (`loadRepoIndex()[name]`, and the per-repo data
 * dir keyed off it) keep resolving until `rt repos prune` both migrates the
 * data and evicts the row.
 */
export function partitionByRealpath(entries: RepoIndexEntry[]): IndexPartition {
  const groups = new Map<string, RepoIndexEntry[]>();
  for (const entry of entries) {
    const real = safeRealpath(entry.path);
    const group = groups.get(real);
    if (group) group.push(entry);
    else groups.set(real, [entry]);
  }

  const keep: RepoIndexEntry[] = [];
  const duplicates: DuplicateEntry[] = [];
  for (const group of groups.values()) {
    const sorted = [...group].sort(
      (a, b) =>
        identityRank(b) - identityRank(a) ||
        b.updatedAt - a.updatedAt ||
        a.repoName.localeCompare(b.repoName),
    );
    const winner = sorted[0]!;
    keep.push(winner);
    for (const loser of sorted.slice(1)) duplicates.push({ entry: loser, keptAs: winner.repoName });
  }
  return { keep, duplicates };
}

export type PruneReason = "missing" | "duplicate";

export interface PrunedEntry {
  repoName: string;
  path: string;
  reason: PruneReason;
  /** Set only for `duplicate`: the name that kept the directory. */
  keptAs?: string;
  /** Set only for `duplicate`: what became of the retired name's data dir. */
  data?: DataMigration;
  /**
   * Set when the row is KEPT despite qualifying for eviction: a `duplicate`
   * whose migration could not finish, or a `missing` row that still owns a
   * worktree registry. Eviction is exactly what makes those leftovers
   * unreachable.
   */
  retained?: true;
  /** Set with `retained`: the verb that resolves this row. */
  hint?: string;
}

/** Outcome of carrying everything keyed to a retired name onto the live name. */
export interface DataMigration {
  /** Entries moved wholesale — the live name held nothing by that name. */
  moved: string[];
  /** Entries merged line-wise. Only ever `run-history.jsonl`. */
  merged: string[];
  /** Entries left in place because both names hold one and merging would guess. */
  refused: string[];
  /** True once the retired data dir is gone, which only happens if nothing was refused. */
  removedDir: boolean;
  /**
   * The retired name's worktree registry: `"moved"` onto the live name,
   * `"merged"` into the live name's own registry (the name/identity pair the
   * identity cutover left, each side owning half of one on-deck pool),
   * `"refused"` because the write could not be verified, or `"none"` if it
   * had none.
   *
   * This lives in state.db's kv, not the data dir, so it is invisible to a
   * directory walk — and it is the record the daemon keys by, so a retired
   * name that keeps it while the index row goes away leaves the reconciler
   * silently skipping the repo.
   */
  registry: "moved" | "merged" | "refused" | "none";
}

/** True when anything is still keyed to the retired name after a migration. */
export function migrationIncomplete(d: DataMigration): boolean {
  return d.refused.length > 0 || d.registry === "refused";
}

/**
 * The one filename whose collisions resolve without guessing: an append-only
 * JSONL whose every line carries its own `ts`, so the union sorted by `ts` is
 * the history either name would have recorded alone. Every other collision is
 * a genuine ambiguity and gets refused.
 */
const MERGEABLE_BY_TIMESTAMP = "run-history.jsonl";

/**
 * Mirrors `lib/worktree/registry.ts`'s namespace rather than importing it:
 * that module pulls in the legacy-import machinery and the whole TreeRecord
 * surface, and this only needs to move one opaque row. The constant is a
 * parity anchor — the two must not drift.
 */
const WORKTREE_REGISTRY_NS = "worktree-registry";

/**
 * Moves the retired name's worktree registry onto the live name.
 *
 * The daemon keys registries by the INDEX name
 * (`lib/daemon/worktree-reconciler.ts` iterates the repo index), while the CLI
 * looks them up by git identity. A rename splits those two, and evicting the
 * retired index row then makes the registry unreachable:
 * `repoHasWorktreeActivity` sees an empty registry under the live name and
 * skips the repo, so the reconciler quietly stops managing its worktrees.
 * That is why this moves with the data dir instead of being left behind.
 *
 * A live name that already has a registry is MERGED, not refused: both sides
 * describe the same repo's trees, so the union by path (`mergeRegistries`)
 * loses neither half of a pool that a name/identity pair split.
 */
function migrateWorktreeRegistry(from: string, to: string, opts: { dryRun?: boolean }): DataMigration["registry"] {
  let outcome: "moved" | "merged";
  try {
    if (!hasKvValue(WORKTREE_REGISTRY_NS, from)) return "none";
    outcome = hasKvValue(WORKTREE_REGISTRY_NS, to) ? "merged" : "moved";
    if (opts.dryRun) return outcome;

    const retired = getKvValue<TreeRecord[]>(WORKTREE_REGISTRY_NS, from, []);
    const live = outcome === "merged" ? getKvValue<TreeRecord[]>(WORKTREE_REGISTRY_NS, to, []) : [];
    const next = outcome === "merged" ? mergeRegistries(live, retired) : retired;
    setKvValue(WORKTREE_REGISTRY_NS, to, next);

    // persistOrWarn swallows SQLITE_BUSY, so a returned write is not a landed
    // one — and on a merge the destination row already existed, so its mere
    // presence proves nothing. Compare the readback.
    if (JSON.stringify(getKvValue<TreeRecord[]>(WORKTREE_REGISTRY_NS, to, [])) !== JSON.stringify(next)) {
      console.warn(`rt: ${from}'s worktree registry did not persist under ${to} — leaving it in place`);
      return "refused";
    }
  } catch (err) {
    console.warn(`rt: could not move ${from}'s worktree registry to ${to} (${(err as Error).message})`);
    return "refused";
  }
  deleteKvValue(WORKTREE_REGISTRY_NS, from);
  return outcome;
}

/**
 * Guards `ensureWorktreeRegistryRekeyed` to one run per open state.db: a
 * WeakSet keyed on the `Database` instance, not a plain module boolean, so a
 * HOME swap (a fresh `getStateDb()` after `closeStateDb()` — every test's own
 * isolation, and any future multi-HOME run) re-arms the check instead of
 * skipping a namespace it has never actually looked at.
 */
const worktreeRegistryRekeyRuns = new WeakSet<object>();

/**
 * One-shot legacy-name -> identity re-key of the worktree registry, run from
 * the same first-read point the prior rename migration used. Unlike the repo
 * index itself — a disposable cache that self-heals as rt revisits each repo —
 * a registry row left under its pre-identity name is not: the daemon's
 * `deps.repoIndex()` only ever yields identity keys now, so a legacy-named row
 * would silently stop being reconciled forever. `rekeyKvNamespace` is
 * idempotent (an already-identity key is skipped), so a repeat call after a
 * full migration costs one empty namespace scan.
 *
 * The guard is marked only AFTER the rekey resolves: a rejected pass must be
 * retried on a later reconcile, not latched off for the db handle's life.
 */
export function ensureWorktreeRegistryRekeyed(): Promise<void> {
  const db = getStateDb();
  if (worktreeRegistryRekeyRuns.has(db)) return Promise.resolve();
  return rekeyKvNamespace(WORKTREE_REGISTRY_NS).then(() => {
    worktreeRegistryRekeyRuns.add(db);
  });
}

/** `ts` of a run-history line. Unparseable lines sort last, keeping their order. */
function lineTimestamp(line: string): number {
  try {
    const parsed = Date.parse((JSON.parse(line) as { ts?: string }).ts ?? "");
    return Number.isNaN(parsed) ? Infinity : parsed;
  } catch {
    return Infinity;
  }
}

function mergeRunHistory(fromFile: string, toFile: string): void {
  const lines = [readFileSync(toFile, "utf8"), readFileSync(fromFile, "utf8")]
    .flatMap((body) => body.split("\n"))
    .filter((line) => line.trim() !== "")
    .map((line, i) => ({ line, ts: lineTimestamp(line), i }))
    .sort((a, b) => a.ts - b.ts || a.i - b.i);
  writeFileSync(toFile, `${lines.map((entry) => entry.line).join("\n")}\n`);
}

/**
 * Carries `~/.mattstack/rt/repos/<from>/` onto `<to>/` so a rename stops
 * stranding the retired name's data.
 *
 * Runs from `rt repos prune` rather than from rename detection at runtime:
 * moving one repo's data onto another off a derived-name change nobody asked
 * about is a guess, and this is the verb where the operator asked.
 *
 * Never destructive. A name present on both sides is merged only when its own
 * contents say how; anything else is left standing in BOTH places and
 * reported. A refusal keeps the retired directory as well — it is removed only
 * once everything in it has moved.
 */
export function migrateRepoData(from: string, to: string, opts: { dryRun?: boolean } = {}): DataMigration {
  const result: DataMigration = { moved: [], merged: [], refused: [], removedDir: false, registry: "none" };
  if (from === to) return result;

  result.registry = migrateWorktreeRegistry(from, to, opts);

  const fromDir = repoDataDir(from);
  const toDir = repoDataDir(to);
  if (!existsSync(fromDir)) return result;

  let names: string[];
  try {
    names = readdirSync(fromDir);
  } catch (err) {
    console.warn(`rt: could not read ${from}'s data dir (${(err as Error).message})`);
    return result;
  }

  for (const name of names) {
    if (!existsSync(join(toDir, name))) result.moved.push(name);
    else if (name === MERGEABLE_BY_TIMESTAMP) result.merged.push(name);
    else result.refused.push(name);
  }

  if (opts.dryRun) {
    result.removedDir = result.refused.length === 0;
    return result;
  }

  try {
    mkdirSync(toDir, { recursive: true });
    for (const name of result.moved) renameSync(join(fromDir, name), join(toDir, name));
    for (const name of result.merged) {
      mergeRunHistory(join(fromDir, name), join(toDir, name));
      rmSync(join(fromDir, name));
    }
    if (result.refused.length === 0) {
      rmSync(fromDir, { recursive: true });
      result.removedDir = true;
    }
  } catch (err) {
    console.warn(`rt: could not migrate ${from}'s data to ${to} (${(err as Error).message})`);
  }
  return result;
}

/**
 * Evicts index rows that no longer name anything: a path that has stopped
 * existing, and the losing half of every realpath collision.
 *
 * Missing paths are removed BEFORE the duplicate pass, so a rename whose new
 * name points at a directory that has since been deleted leaves the old name
 * standing rather than evicting the only row that still resolves.
 *
 * A `duplicate` carries everything keyed to it onto the surviving name first,
 * and the row is dropped ONLY once nothing is left behind: a migration that
 * refused anything marks the entry `retained` and keeps the row, because
 * eviction is exactly what makes a leftover unreachable. A `missing` row is
 * left un-migrated on purpose: its path is gone, so there is no surviving name
 * to carry it to, and its data dir stays untouched rather than being deleted.
 * A `missing` row that still owns a worktree registry is likewise `retained`:
 * the registry is the daemon's only handle to that repo's trees, keyed by
 * this row's name, so evicting the row would strand it.
 */
export function pruneRepoIndex(opts: { dryRun?: boolean } = {}): PrunedEntry[] {
  const entries = loadRepoIndexEntries();
  const removed: PrunedEntry[] = [];
  const live: RepoIndexEntry[] = [];

  for (const entry of entries) {
    if (existsSync(entry.path)) {
      live.push(entry);
      continue;
    }
    // A gone path whose registry is still here is a MOVE, not a deletion:
    // dropping the row orphans the pool's claim state under a key nothing
    // iterates any more.
    let ownsRegistry = false;
    try {
      ownsRegistry = hasKvValue(WORKTREE_REGISTRY_NS, entry.repoName);
    } catch { /* unreadable db — treat as no registry and prune as before */ }
    removed.push({
      repoName: entry.repoName,
      path: entry.path,
      reason: "missing",
      ...(ownsRegistry ? { retained: true as const, hint: "rt repos locate" } : {}),
    });
  }

  for (const dup of partitionByRealpath(live).duplicates) {
    const data = migrateRepoData(dup.entry.repoName, dup.keptAs, opts);
    removed.push({
      repoName: dup.entry.repoName,
      path: dup.entry.path,
      reason: "duplicate",
      keptAs: dup.keptAs,
      data,
      ...(migrationIncomplete(data) ? { retained: true as const } : {}),
    });
  }

  if (opts.dryRun || removed.length === 0) return removed;

  for (const r of removed) {
    if (r.retained) continue;
    deleteKvValue(REPO_INDEX_NS, r.repoName);
  }
  writeRepoIndexCompat(loadRepoIndex());
  return removed;
}

// ─── rt.repoRoots (RT-49) ───────────────────────────────────────────────────

const LEADING_TILDE_RE = /^~(?:$|\/)/;

/**
 * Expands a LEADING `~` — bare `~` or `~/...` — to $HOME. Mid-string `~` and
 * other spellings (`~user`) pass through unchanged: `${home}` is the other
 * documented spelling (expanded by the settings resolver itself), and a
 * general tilde feature is explicitly out of scope — this expansion is
 * scanner-local by design.
 *
 * HOME is resolved at CALL time via `process.env.HOME ?? homedir()`, mirroring
 * rt-paths.ts: `homedir()` alone does not track a runtime `process.env.HOME`
 * mutation (it reads the OS user database), which would make this untestable
 * and would diverge from the rest of rt's HOME-relative path resolution.
 */
function expandLeadingTilde(entry: string): string {
  if (!LEADING_TILDE_RE.test(entry)) return entry;
  const home = process.env.HOME ?? homedir();
  const rest = entry.slice(1).replace(/^\//, "");
  return rest === "" ? home : join(home, rest);
}

/**
 * Reads the `rt.repoRoots` machine-store setting, expanding `${home}` (the
 * resolver, via `getSetting`'s default `expand: true`) and a leading `~`
 * (scanner-local, see `expandLeadingTilde`). Non-string elements and entries
 * that still don't exist after expansion are skipped, each with a one-line
 * stderr warning naming the entry — never silently dropped.
 *
 * Fail-open: if the resolver itself throws (an authored entry using an
 * unexpandable closed-set variable, e.g. `${repoRoot}`), this warns once and
 * returns `[]` — degrading to inference-only roots, exactly today's
 * behavior. `getKnownRepos` sits under every picker; a bad authored value
 * must never brick `rt cd`. `rt settings get rt.repoRoots` remains the loud
 * diagnostic path for a value this drops.
 */
function readConfiguredRepoRoots(): string[] {
  let raw: unknown;
  try {
    raw = getSetting<unknown[]>("rt.repoRoots").value;
  } catch (err) {
    console.warn(
      `rt: rt.repoRoots could not be resolved (${(err as Error).message}) — scanning inferred roots only`,
    );
    return [];
  }

  if (!Array.isArray(raw)) return [];

  const roots: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") {
      console.warn(`rt: skipping non-string rt.repoRoots entry: ${JSON.stringify(entry)}`);
      continue;
    }
    const expanded = expandLeadingTilde(entry);
    if (!existsSync(expanded)) {
      console.warn(`rt: skipping rt.repoRoots entry "${entry}" — path does not exist (${expanded})`);
      continue;
    }
    roots.push(expanded);
  }
  return roots;
}

/**
 * `realpathSync`, guarded: a path that vanishes or becomes unreadable
 * between an existence check and this call (TOCTOU), or one that was never
 * checked, falls back to its own spelling rather than throwing —
 * `getKnownRepos` must never crash on a stale root or candidate path.
 */
function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function stripTrailingSep(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

interface RootEntry {
  /** `path.resolve`d, trailing-separator-stripped spelling. Every candidate
   *  path under this root is built from THIS spelling (not the realpath), so
   *  `repoOption`'s `homedir()` → `~` display keeps working for a
   *  `~`-authored root. */
  spelling: string;
  /** `safeRealpath`'d spelling — used for set-membership ONLY. */
  real: string;
  /** Configured (rt.repoRoots) roots get root-is-a-repo + worktree-pool
   *  detection; inferred roots (parents of already-indexed repos) keep
   *  pre-RT-49 semantics verbatim — both extra rules are configured-only by
   *  design, so an unset key reproduces today's behavior exactly. */
  configured: boolean;
}

function normalizeRoot(raw: string, configured: boolean): RootEntry {
  const spelling = stripTrailingSep(resolvePath(raw));
  return { spelling, real: safeRealpath(spelling), configured };
}

/**
 * The deduped, ordered root set: configured roots first (in `rt.repoRoots`
 * array order), then inferred roots (parents of indexed repos, sorted for
 * determinism). Two roots that collapse to the same realpath — a configured
 * root and its inferred-parent twin, a trailing-slash spelling, or a
 * symlink-aliased spelling — are deduped here, with configured semantics
 * winning (it is processed first and the later duplicate is dropped).
 */
function buildRootSet(known: KnownRepo[]): RootEntry[] {
  const configured = readConfiguredRepoRoots().map((r) => normalizeRoot(r, true));
  const inferredRaw = [...new Set(known.map((r) => dirname(r.worktrees[0]!.path)).filter(existsSync))].sort();
  const inferred = inferredRaw.map((r) => normalizeRoot(r, false));

  const seen = new Set<string>();
  const ordered: RootEntry[] = [];
  for (const entry of [...configured, ...inferred]) {
    if (seen.has(entry.real)) continue;
    seen.add(entry.real);
    ordered.push(entry);
  }
  return ordered;
}

// ─── Discovery ───────────────────────────────────────────────────────────────

/**
 * Get all known repos from the global index, with worktree discovery.
 * Used when rt is run outside a git repo to offer a picker.
 *
 * `includeMissing` is opt-in: a caller that resolves a repo and then chdirs
 * or spawns against its worktree path must ask for `missing` rows explicitly
 * and refuse them (`missingRepoRefusal`) before acting, or leave the default
 * off and keep today's silent-exclusion behavior.
 */
export function getKnownRepos(opts?: { includeMissing?: boolean }): KnownRepo[] {
  // Same degrade-don't-crash rule as getRepoIdentity()'s index write: an
  // unopenable state.db (root-owned after a `sudo rt …`) must not take down
  // the `rt cd`/`rt run` picker — it falls back to the unregistered-scan
  // results below, exactly like an empty index does.
  let entries: RepoIndexEntry[];
  try {
    entries = loadRepoIndexEntries();
  } catch {
    entries = [];
  }
  const repos: KnownRepo[] = [];

  const liveEntries: RepoIndexEntry[] = [];
  const lostEntries: RepoIndexEntry[] = [];
  for (const e of entries) (existsSync(e.path) ? liveEntries : lostEntries).push(e);

  // Hidden here, not evicted — see partitionByRealpath.
  const { keep } = partitionByRealpath(liveEntries);

  for (const { repoName, path: mainPath } of keep) {
    const worktrees: KnownRepo["worktrees"] = [];
    // Single-worktree repos (the vast majority) skip the git subprocess and
    // synthesize the one worktree from disk; only repos with linked worktrees
    // pay for the authoritative porcelain parse below.
    const single = singleWorktree(mainPath);
    if (single) {
      worktrees.push(single);
    } else try {
      const output = execSync("git worktree list --porcelain", {
        cwd: mainPath,
        encoding: "utf8",
        stdio: "pipe",
      });

      let currentPath = "";
      let currentBranch = "";
      let isBare = false;

      for (const line of output.split("\n")) {
        if (line.startsWith("worktree ")) {
          if (currentPath) {
            worktrees.push({ path: currentPath, branch: currentBranch, isBare });
          }
          currentPath = line.replace("worktree ", "").trim();
          currentBranch = "";
          isBare = false;
        } else if (line.startsWith("branch ")) {
          currentBranch = line.replace("branch refs/heads/", "").trim();
        } else if (line === "bare") {
          isBare = true;
        }
      }
      if (currentPath) {
        worktrees.push({ path: currentPath, branch: currentBranch, isBare });
      }
    } catch {
      worktrees.push({ path: mainPath, branch: "", isBare: false });
    }

    repos.push({
      repoName,
      worktrees: worktrees.filter(w => !w.isBare && existsSync(w.path)),
      dataDir: repoDataDir(repoName),
    });
  }

  const known = repos.filter(r => r.worktrees.length > 0);
  // A pair of rows for one gone directory is one lost repo, not two.
  const lost: KnownRepo[] = opts?.includeMissing
    ? partitionByRealpath(lostEntries).keep.map((e) => ({
        repoName: e.repoName,
        worktrees: [{ path: e.path, branch: "", isBare: false }],
        dataDir: repoDataDir(e.repoName),
        missing: true as const,
      }))
    : [];
  // Lost names are excluded for the same reason lost paths are (below): a lost
  // legacy-name row is named after the directory that moved, so counting it as
  // known would shadow that directory's NEW location out of the scan — the one
  // candidate `rt repos locate` exists to surface.
  const knownNames = new Set(known.map(r => r.repoName));
  // realpath'd for set-membership ONLY — a symlinked path component (macOS
  // /tmp → /private/tmp being the canonical case) must not let the same
  // directory double-emit under two spellings. `known` itself keeps its
  // original, user-visible spellings (KnownRepo.worktrees[].path, repos.json,
  // `rt cd` targets) untouched. Lost paths are deliberately absent: the scan
  // must be free to surface the moved repo's NEW directory.
  const knownPaths = new Set(known.flatMap(r => r.worktrees.map(w => safeRealpath(w.path))));

  return [...known, ...lost, ...scanUnregisteredRepos([...known, ...lost], knownNames, knownPaths)];
}

interface Candidate {
  name: string;
  /** Display/picker spelling: `join(<root's resolved spelling>, ...)`. */
  path: string;
  /** True for a `<pool>/<slot>` worktree-pool candidate. */
  composite: boolean;
}

function hasGitMarker(path: string): boolean {
  return existsSync(join(path, ".git"));
}

/**
 * Accepts a candidate if it clears both dedupe axes — path (realpath'd) and
 * name — recording it into `knownPaths`/`knownNames` so a later root (or the
 * same directory reached via two spellings) cannot re-emit it.
 */
function tryAddCandidate(
  name: string,
  path: string,
  knownNames: Set<string>,
  knownPaths: Set<string>,
  candidates: Candidate[],
  composite: boolean,
): void {
  const real = safeRealpath(path);
  if (knownPaths.has(real)) return;
  if (knownNames.has(name)) return;
  knownPaths.add(real);
  knownNames.add(name);
  candidates.push({ name, path, composite });
}

/**
 * Scans one root for unregistered candidates. Configured roots get two
 * rules inferred roots never apply (both explicitly configured-only, so
 * "unset key = today's behavior" holds for names as well as membership):
 *
 *  - root-is-a-repo: a configured root that itself contains `.git` is ONE
 *    candidate — the root itself, named by its basename — and its children
 *    are NOT scanned (the likeliest misconfiguration: pointing at a repo
 *    instead of its parent).
 *  - worktree-pool detection: a `.git`-less child whose OWN children include
 *    at least one `.git` dir/file is a worktree-pool folder; each qualifying
 *    grandchild becomes a candidate named `<pool>/<slot>`. The pool folder's
 *    own name is never checked against `knownNames` — Matt's convention
 *    names the pool folder after its indexed repo, so a name-first skip
 *    would silence the rule in exactly that case. The plain `knownNames`
 *    skip applies ONLY to the `.git`-bearing child branch, and only AFTER
 *    the `.git` probe decides the candidate kind.
 *
 * Symlinked directories are invisible at both the child and grandchild level
 * — `Dirent#isDirectory()` is false for a symlink under `withFileTypes`,
 * today's behavior carried forward as a decision.
 */
function scanRoot(
  root: RootEntry,
  knownNames: Set<string>,
  knownPaths: Set<string>,
  candidates: Candidate[],
): void {
  if (root.configured && hasGitMarker(root.spelling)) {
    tryAddCandidate(basename(root.spelling), root.spelling, knownNames, knownPaths, candidates, false);
    return;
  }

  let entries: Dirent[];
  try {
    entries = readdirSync(root.spelling, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const childPath = join(root.spelling, entry.name);

    if (hasGitMarker(childPath)) {
      if (knownNames.has(entry.name)) continue;
      tryAddCandidate(entry.name, childPath, knownNames, knownPaths, candidates, false);
      continue;
    }

    if (!root.configured) continue; // inferred roots: no pool detection

    let grandEntries: Dirent[];
    try {
      grandEntries = readdirSync(childPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const g of grandEntries) {
      if (!g.isDirectory() || g.name.startsWith(".")) continue;
      const grandPath = join(childPath, g.name);
      if (!hasGitMarker(grandPath)) continue;
      tryAddCandidate(`${entry.name}/${g.name}`, grandPath, knownNames, knownPaths, candidates, true);
    }
  }
}

const BRANCH_LABEL_CAP = 50;

/**
 * `<pool>/<slot>` → a single sanitized path segment, so a pool candidate's
 * writable `dataDir` (run.ts's preset/variation save paths `mkdirSync` it)
 * can never land INSIDE the pool's own indexed-repo data dir
 * (`repos/<pool>/<slot>/...` nested under `repos/<pool>/`). A plain
 * candidate's name has no `/` and passes through unchanged.
 */
function candidateDataDirName(name: string, composite: boolean): string {
  return composite ? name.replaceAll("/", "__") : name;
}

/**
 * `execSync`'s `env` is passed explicitly (not left to the default) for the
 * same reason documented in lib/agent-herdr.ts: Bun resolves the executable
 * path from a startup snapshot of the environment otherwise, ignoring PATH
 * mutated at runtime — a test that fakes `git` on PATH would silently hit
 * the real binary without this. This is the only git spawn the scan
 * performs (spec: branch-label cap).
 */
function branchOf(repoPath: string): string {
  const dotgit = join(repoPath, ".git");
  // A plain repo (.git is a directory) reads its branch straight from HEAD, no
  // subprocess. A linked worktree (.git is a file) has no local HEAD ref file
  // to parse, so it keeps the authoritative git spawn.
  try {
    if (statSync(dotgit).isDirectory()) return headBranch(dotgit);
  } catch { /* fall through to the git spawn */ }
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: repoPath,
      encoding: "utf8",
      stdio: "pipe",
      env: process.env,
    }).trim();
    return branch === "HEAD" ? "" : branch; // "HEAD" is git's detached-HEAD sentinel
  } catch {
    return ""; // detached HEAD or other edge case — leave blank
  }
}

/**
 * Scan every configured (`rt.repoRoots`) and inferred (parents of indexed
 * repos) root for git repos rt has never been run in. This is what lets
 * `rt cd` surface a repo the first time you ever pick it, instead of
 * requiring you to `cd` there manually first — and, since RT-49, the first
 * time on a fresh machine altogether, once `rt.repoRoots` is seeded.
 *
 * Candidates are collected across ALL roots before any branch lookup: if the
 * total exceeds `BRANCH_LABEL_CAP`, the per-candidate `git rev-parse` is
 * skipped for every candidate (all-or-nothing, uniform rows, no partial
 * labeling, and no unbounded git spawning on a big scan).
 */
function scanUnregisteredRepos(
  known: KnownRepo[],
  knownNames: Set<string>,
  knownPaths: Set<string>,
): KnownRepo[] {
  const roots = buildRootSet(known);
  const candidates: Candidate[] = [];
  for (const root of roots) scanRoot(root, knownNames, knownPaths, candidates);

  const skipBranchLookup = candidates.length > BRANCH_LABEL_CAP;

  return candidates.map((c) => ({
    repoName: c.name,
    worktrees: [{ path: c.path, branch: skipBranchLookup ? "" : branchOf(c.path), isBare: false }],
    dataDir: repoDataDir(candidateDataDirName(c.name, c.composite)),
    registered: false,
  }));
}

// ─── Picker option formatting ───────────────────────────────────────────────

/** Shared repo → picker-option mapping, dimmed + labeled for unregistered
    repos. `value` stays the raw index key (the wire identity — dispatch needs
    it); only `label` is decoded for humans. Prefer `repoOptions` for a full
    list — it disambiguates repos whose identities share a last segment. */
export function repoOption(r: KnownRepo, label: string = repoLabel(r.repoName)): { value: string; label: string; hint: string; color?: string } {
  if (r.missing) {
    return { value: r.repoName, label, hint: "missing — rt repos locate", color: dim };
  }

  const location = r.worktrees.length > 1
    ? `${r.worktrees.length} worktrees`
    : r.worktrees[0]?.path.replace(homedir(), "~") || "";

  return {
    value: r.repoName,
    label,
    hint: r.registered === false
      ? (location ? `${location} · unregistered` : "unregistered")
      : location,
    ...(r.registered === false ? { color: dim } : {}),
  };
}

function duplicateRepoNames(repos: KnownRepo[]): Set<string> {
  const counts = new Map<string, number>();
  for (const r of repos) counts.set(r.repoName, (counts.get(r.repoName) ?? 0) + 1);
  return new Set([...counts].filter(([, n]) => n > 1).map(([name]) => name));
}

/**
 * One list, one value per row. A lost legacy-name row and the scanned
 * directory that name moved to carry the SAME `repoName`, so an unqualified
 * value resolves the live directory to the dead row. The qualifier trails the
 * name because fzf matches on this field (`--nth=1`).
 */
function repoOptionValue(r: KnownRepo, i: number, duplicated: Set<string>): string {
  return duplicated.has(r.repoName) ? `${r.repoName}#${i}` : r.repoName;
}

/** Picker options for a repo list: short labels, upgraded to owner/name where
    two repos would otherwise render identically, and to the full decoded id
    when even owner/name collides (same owner/name on two hosts; two path
    repos sharing a basename). Resolve what the picker returns with
    `repoFromOptionValue` — the values are list-scoped, not bare index keys. */
export function repoOptions(repos: KnownRepo[]): Array<ReturnType<typeof repoOption>> {
  const shortCounts = new Map<string, number>();
  const qualifiedCounts = new Map<string, number>();
  for (const r of repos) {
    const short = repoLabel(r.repoName);
    shortCounts.set(short, (shortCounts.get(short) ?? 0) + 1);
    const qualified = repoLabelQualified(r.repoName);
    qualifiedCounts.set(qualified, (qualifiedCounts.get(qualified) ?? 0) + 1);
  }
  const duplicated = duplicateRepoNames(repos);
  return repos.map((r, i) => {
    const short = repoLabel(r.repoName);
    const qualified = repoLabelQualified(r.repoName);
    const label = (shortCounts.get(short) ?? 0) <= 1
      ? short
      : (qualifiedCounts.get(qualified) ?? 0) > 1 ? repoLabelFull(r.repoName) : qualified;
    return { ...repoOption(r, label), value: repoOptionValue(r, i, duplicated) };
  });
}

/** The row a `repoOptions` value came from. The list must be the one the
    options were built from — values are positional when names collide. */
export function repoFromOptionValue(repos: KnownRepo[], value: string): KnownRepo | undefined {
  const duplicated = duplicateRepoNames(repos);
  return repos.find((r, i) => repoOptionValue(r, i, duplicated) === value);
}

/** The one-line refusal every picker prints instead of cd-ing into a repo whose indexed path is gone. */
export function missingRepoRefusal(r: KnownRepo): string {
  const gone = r.worktrees[0]?.path ?? "its indexed path";
  return `${r.repoName} is no longer at ${gone} — run: rt repos locate <new-path> --repo ${r.repoName}`;
}

// ─── Test seam ───────────────────────────────────────────────────────────────

export const __test__ = {
  expandLeadingTilde,
  readConfiguredRepoRoots,
  safeRealpath,
  buildRootSet,
};
