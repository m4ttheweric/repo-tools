/**
 * Repo identity: the normalized-remote string that keys `repos.<identity>`
 * sections in every settings store (RT-47 spec, "Repo identity").
 *
 * Identity is `host/path` (lowercase host, path case preserved), derived from
 * `remote.origin.url` — never a filesystem path, so it is checkout-location
 * independent: every worktree of a repo shares the same remote and therefore
 * the same identity. A remote that doesn't match a recognized host form
 * (bare local paths are the main case — repos.json has two) normalizes to
 * null, meaning repo-scoped sections are unreachable for it and only global
 * scopes + legacy apply. That's an honest degrade, not a crash.
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

import { runCapture } from "../subprocess.ts";
import { machineSettingsPath } from "../rt-paths.ts";
import { readStore } from "./stores.ts";

// Full-URL forms: scheme://[user[:pass]@]host/path — https, ssh, git, http, ...
const URL_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/;

// scp-like scp syntax: [user@]host:path (git@gitlab.com:group/repo.git).
// Deliberately excludes anything starting with "/" (absolute local paths)
// so a Windows-drive-letter-free local remote never falsely matches.
const SCP_RE = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/;

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
export function identityFromRemote(remote: string): string | null {
  const store = readStore(machineSettingsPath());
  const overrides = store.global["rt.repoIdentityOverrides"];
  if (overrides !== null && typeof overrides === "object" && !Array.isArray(overrides)) {
    const hit = (overrides as Record<string, unknown>)[remote];
    if (typeof hit === "string") return hit;
  }
  return normalizeRemote(remote);
}

// Per-process, per-repo-path memoization. Promise-valued so concurrent
// callers for the same path share one spawn rather than racing.
const memo = new Map<string, Promise<string | null>>();

/**
 * Async derivation from a repo path: `git -C <repoPath> config --get
 * remote.origin.url`, then identityFromRemote (so overrides apply to
 * derivation too). Never a sync spawn — safe to call from daemon contexts.
 * Memoized per path for the life of the process; a remote change after the
 * first successful derivation is NOT picked up until clearIdentityMemo() —
 * documented behavior, not a bug (see spec: derivation is a one-time capture
 * per process, not a live poll).
 */
export async function deriveRepoIdentity(repoPath: string): Promise<string | null> {
  const cached = memo.get(repoPath);
  if (cached) return cached;

  const promise = (async (): Promise<string | null> => {
    const result = await runCapture(["git", "-C", repoPath, "config", "--get", "remote.origin.url"]);
    if (result.exitCode !== 0) return null;
    const remote = result.stdout.trim();
    if (!remote) return null;
    return identityFromRemote(remote);
  })();

  memo.set(repoPath, promise);
  return promise;
}

/** Test-only: clear the derivation memo so a test can force re-derivation. */
export function clearIdentityMemo(): void {
  memo.clear();
}
