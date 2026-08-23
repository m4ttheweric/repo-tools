/**
 * Global repo index — tracks all known repos in state.db's kv store
 * (ns='repo-index', one row per repo: k=repoName, v=main-worktree path).
 *
 * The index is a DISPOSABLE CACHE (RT-49, collapsed into state.db by RT-50):
 * it self-populates as rt visits repos (`updateRepoIndex`, called from
 * lib/repo.ts's `getRepoIdentity`). Losing it loses nothing durable — every
 * entry regenerates the next time rt runs inside that repo, and meanwhile the
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
import { existsSync, readdirSync, realpathSync, writeFileSync, type Dirent } from "fs";
import { homedir } from "os";
import { basename, dirname, join, resolve as resolvePath } from "path";
import { repoDataDir, rtDir } from "./rt-paths.ts";
import { listKvValues, setKvValue } from "./state/index.ts";
import { dim } from "./ansi.ts";
import { getSetting } from "./settings/resolve.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface KnownRepo {
  repoName: string;
  /** All available worktree paths */
  worktrees: { path: string; branch: string; isBare: boolean }[];
  dataDir: string;
  /** False for repos discovered by scanning sibling directories, never
   *  explicitly visited by rt. Omitted (implicitly true) for indexed repos. */
  registered?: boolean;
}

// ─── Index CRUD ──────────────────────────────────────────────────────────────

interface RepoIndex {
  [repoName: string]: string; // repoName → primary repo root path
}

const REPO_INDEX_NS = "repo-index";

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

export function loadRepoIndex(): RepoIndex {
  return listKvValues<string>(REPO_INDEX_NS);
}

export function updateRepoIndex(repoName: string, repoRoot: string): void {
  let mainPath: string;
  try {
    const mainWorktree = execSync("git worktree list --porcelain", {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: "pipe",
    });
    mainPath = mainWorktree.split("\n")[0]?.replace("worktree ", "").trim() || repoRoot;
  } catch {
    mainPath = repoRoot;
  }
  try {
    setKvValue(REPO_INDEX_NS, repoName, mainPath);
  } catch { /* best effort */ }
  writeRepoIndexCompat(loadRepoIndex());
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
 */
export function getKnownRepos(): KnownRepo[] {
  const index = loadRepoIndex();
  const repos: KnownRepo[] = [];

  for (const [repoName, mainPath] of Object.entries(index)) {
    if (!existsSync(mainPath)) continue;

    const worktrees: KnownRepo["worktrees"] = [];
    try {
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
  const knownNames = new Set(known.map(r => r.repoName));
  // realpath'd for set-membership ONLY — a symlinked path component (macOS
  // /tmp → /private/tmp being the canonical case) must not let the same
  // directory double-emit under two spellings. `known` itself keeps its
  // original, user-visible spellings (KnownRepo.worktrees[].path, repos.json,
  // `rt cd` targets) untouched.
  const knownPaths = new Set(known.flatMap(r => r.worktrees.map(w => safeRealpath(w.path))));

  return [...known, ...scanUnregisteredRepos(known, knownNames, knownPaths)];
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
 * same reason documented in lib/herdr-agent.ts: Bun resolves the executable
 * path from a startup snapshot of the environment otherwise, ignoring PATH
 * mutated at runtime — a test that fakes `git` on PATH would silently hit
 * the real binary without this. This is the only git spawn the scan
 * performs (spec: branch-label cap).
 */
function branchOf(repoPath: string): string {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: repoPath,
      encoding: "utf8",
      stdio: "pipe",
      env: process.env,
    }).trim();
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

/** Shared repo → picker-option mapping, dimmed + labeled for unregistered repos. */
export function repoOption(r: KnownRepo): { value: string; label: string; hint: string; color?: string } {
  const location = r.worktrees.length > 1
    ? `${r.worktrees.length} worktrees`
    : r.worktrees[0]?.path.replace(homedir(), "~") || "";

  return {
    value: r.repoName,
    label: r.repoName,
    hint: r.registered === false
      ? (location ? `${location} · unregistered` : "unregistered")
      : location,
    ...(r.registered === false ? { color: dim } : {}),
  };
}

// ─── Test seam ───────────────────────────────────────────────────────────────

export const __test__ = {
  expandLeadingTilde,
  readConfiguredRepoRoots,
  safeRealpath,
  buildRootSet,
};
