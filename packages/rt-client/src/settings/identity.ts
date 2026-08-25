/**
 * Repo identity: the tagged value that keys `repos.<identity>` sections in
 * every settings store.
 *
 * A `remote`-kind identity is `host/path` (lowercase host, path case
 * preserved), derived from `remote.origin.url` — checkout-location
 * independent, since every worktree of a repo shares the same remote. When
 * no usable remote exists, identity falls back to `path`-kind: the realpath
 * of the *main* worktree, which is still shared across that repo's linked
 * worktrees (see `deriveRepoIdentity`) even though it is filesystem-bound.
 * `deriveRepoIdentity` therefore never returns null — every repo has at
 * least a path-kind identity.
 *
 * Three entry points:
 *  - `normalizeRemote` is the pure string transform, no I/O.
 *  - `identityFromRemote` layers the machine store's fork/multi-remote
 *    overrides (`rt.repoIdentityOverrides`, keyed by observed remote URL) on
 *    top of `normalizeRemote`. It's synchronous — the one helper every
 *    non-derivation site uses (run.ts, buildInterceptRules, tests) — so
 *    fork-pinning works everywhere identity is computed from a remote in
 *    hand, not just at derivation time.
 *  - `deriveRepoIdentity` is the async entry point for when only a repo path
 *    is in hand: it shells out to git for the remote (never a sync spawn —
 *    this must stay safe to call from daemon contexts) and then routes
 *    through `identityFromRemote`, memoized per path so repeated callers in
 *    one process don't re-spawn git.
 */

import { existsSync, readFileSync, realpathSync } from "fs";
import { join } from "path";
import { runCapture } from "./exec.ts";
import { machineSettingsPath } from "./paths.ts";
import { readStore } from "./stores.ts";

// Full-URL forms: scheme://[user[:pass]@]host/path — https, ssh, git, http, ...
const URL_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/;

// scp-like scp syntax: [user@]host:path (git@gitlab.com:group/repo.git).
// Deliberately excludes anything starting with "/" (absolute local paths)
// so a Windows-drive-letter-free local remote never falsely matches.
const SCP_RE = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/;

export type RepoIdentity =
  | { kind: "remote"; id: string }
  | { kind: "path"; id: string };

/**
 * The wire form crosses the daemon socket, sits in board config, and lands in
 * console's `/runs/:repo/...` URL — all of which need one slash-free segment.
 * `encodeURIComponent` guarantees that and is exactly reversible.
 */
export function serializeIdentity(id: RepoIdentity): string {
  return `${id.kind}:${encodeURIComponent(id.id)}`;
}

export function parseIdentity(wire: string): RepoIdentity | null {
  const colon = wire.indexOf(":");
  if (colon === -1) return null;
  const kind = wire.slice(0, colon);
  if (kind !== "remote" && kind !== "path") return null;
  const encoded = wire.slice(colon + 1);
  let id: string;
  try {
    id = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  // Canonical wires only: the id segment must be byte-for-byte what
  // serializeIdentity emits. Guard sites validate with parseIdentity and then
  // use the WIRE as a single path component (repoDataDir et al.) — a
  // hand-built wire with a literal "/" ("path:../..") would otherwise parse
  // and escape the state directory.
  if (encodeURIComponent(id) !== encoded) return null;
  return { kind, id };
}

/**
 * Pure normalization: `remote` → `host/path` (lowercase host, `.git` and
 * embedded credentials stripped) or null when the remote doesn't match a
 * recognized host form (local paths, garbage input).
 */
export function normalizeRemote(remote: string): string | null {
  const trimmed = remote.trim();
  if (!trimmed) return null;

  let host: string | undefined;
  let path: string | undefined;

  const urlMatch = URL_RE.exec(trimmed);
  if (urlMatch) {
    host = urlMatch[1];
    path = urlMatch[2];
  } else if (!trimmed.startsWith("/") && !trimmed.startsWith("~")) {
    const scpMatch = SCP_RE.exec(trimmed);
    if (scpMatch) {
      host = scpMatch[1];
      path = scpMatch[2];
    }
  }

  if (!host || !path) return null;

  const normalizedPath = path.replace(/\.git$/, "").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!normalizedPath) return null;

  return `${host.toLowerCase()}/${normalizedPath}`;
}

/**
 * The sync helper every non-derivation call site uses: machine-store
 * fork/multi-remote overrides (exact remote-URL match) then normalizeRemote.
 * Reads the machine store fresh each call (files are small; store reads are
 * not memoized anywhere in the resolver design).
 */
export function identityFromRemote(remote: string): RepoIdentity | null {
  const store = readStore(machineSettingsPath());
  const overrides = store.global["rt.repoIdentityOverrides"];
  if (overrides !== null && typeof overrides === "object" && !Array.isArray(overrides)) {
    const hit = (overrides as Record<string, unknown>)[remote];
    if (typeof hit === "string") return { kind: "remote", id: hit };
  }
  const normalized = normalizeRemote(remote);
  return normalized === null ? null : { kind: "remote", id: normalized };
}

// Per-process, per-repo-path memoization. Promise-valued so concurrent
// callers for the same path share one spawn rather than racing.
const memo = new Map<string, Promise<RepoIdentity>>();

/**
 * Async derivation from a repo path: `git -C <repoPath> config --get
 * remote.origin.url`, then identityFromRemote (so overrides apply to
 * derivation too). Never a sync spawn — safe to call from daemon contexts.
 * Never returns null: no usable remote falls back to a path-kind identity
 * (the main worktree's realpath, via `git worktree list`, so every linked
 * worktree of one repo still shares the same identity).
 *
 * Only a `remote`-kind result is memoized, for the life of the process; a
 * remote change after that first success is NOT picked up until
 * clearIdentityMemo() — documented behavior, not a bug (see spec: derivation
 * is a one-time capture per process, not a live poll). A `path`-kind result
 * is never cached and is retried on every subsequent call — cheap to
 * recompute, and a caller racing repo provisioning (mid-clone,
 * daemon-startup, a remote added after the fact) must not permanently lose
 * the chance to pick up a real remote just because it asked too early.
 */
export async function deriveRepoIdentity(repoPath: string): Promise<RepoIdentity> {
  const cached = memo.get(repoPath);
  if (cached) return cached;

  const result = await (async (): Promise<RepoIdentity> => {
    const spawned = await runCapture(["git", "-C", repoPath, "config", "--get", "remote.origin.url"]);
    if (spawned.exitCode === 0) {
      const remote = spawned.stdout.trim();
      const fromRemote = remote ? identityFromRemote(remote) : null;
      if (fromRemote) return fromRemote;
    }
    // Main worktree via `git worktree list` (main is always listed first) —
    // NOT `--git-common-dir/..`, which points outside the tree under
    // `--separate-git-dir` and would derive one shared identity for every
    // repo whose metadata lives in the same parent directory. In that layout
    // git lists the git DIR as the main entry, so the listed path is resolved
    // through its own `--show-toplevel`, degrading to this worktree's
    // toplevel when the entry isn't a work tree at all.
    const listed = await runCapture(["git", "-C", repoPath, "worktree", "list", "--porcelain"]);
    const first = listed.exitCode === 0 ? /^worktree (.+)$/m.exec(listed.stdout)?.[1]?.trim() : undefined;
    let base: string | undefined;
    if (first) {
      const top = await runCapture(["git", "-C", first, "rev-parse", "--show-toplevel"]);
      if (top.exitCode === 0 && top.stdout.trim()) base = top.stdout.trim();
    }
    if (!base) {
      const own = await runCapture(["git", "-C", repoPath, "rev-parse", "--show-toplevel"]);
      base = own.exitCode === 0 && own.stdout.trim() ? own.stdout.trim() : repoPath;
    }
    return { kind: "path", id: safeRealpath(base) };
  })();

  if (result.kind === "remote") memo.set(repoPath, Promise.resolve(result));
  return result;
}

/** Test-only: clear the derivation memo so a test can force re-derivation. */
export function clearIdentityMemo(): void {
  memo.clear();
}

// realpath of a path that no longer exists throws ENOENT. A path-kind identity
// may be derived for a worktree whose directory is already gone (dispose flows
// call this on the tree being removed), and derivation must degrade to the
// literal path there, never throw past its callers.
function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * One-shot helper for rewriting board's existing name-valued config to
 * host/path identities. NOT a runtime path — the daemon never calls it.
 * Resolves a repo name to the identity of the path it points at in repos.json.
 */
export async function resolveNameToIdentity(
  name: string,
  reposJsonPath: string,
): Promise<RepoIdentity | null> {
  if (!existsSync(reposJsonPath)) return null;
  try {
    const index = JSON.parse(readFileSync(reposJsonPath, "utf8")) as Record<string, unknown>;
    const path = index[name];
    if (typeof path !== "string") return null;
    return await deriveRepoIdentity(path);
  } catch {
    return null;
  }
}
