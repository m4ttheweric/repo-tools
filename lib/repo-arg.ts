/**
 * Shared `--repo <arg>` resolution for CLI commands that forward a repo key
 * to identity-only daemon verbs. Every sender of a repo-keyed daemon payload
 * needs the same reverse-resolution (identity passthrough → directory derive
 * → index lookup by display name) — this is the one place it lives.
 */
import { realpathSync, statSync } from "fs";
import { basename } from "path";
import { deriveRepoIdentity, parseIdentity, serializeIdentity } from "./settings/identity.ts";
import { loadRepoIndex } from "./repo-index.ts";
import { getRepoIdentity, identityForRootReadOnly } from "./repo.ts";
import { getRepoRoot } from "./git.ts";

/** Daemon payload key for the in-repo default — the serialized identity, not the display name. */
export function currentRepoIdentity(): string | undefined {
  return getRepoIdentity()?.identity ?? undefined;
}

/**
 * Same as `currentRepoIdentity()`, but resolves against an explicit `cwd`
 * instead of `process.cwd()` (for callers, such as the Claude Code worktree
 * hook, that receive a cwd out-of-band and cannot trust the process's own
 * cwd to match it) and, unlike `currentRepoIdentity()`, never registers the
 * repo as a side effect — it must be safe to call against a repo rt has
 * never seen before without that call being the reason rt now knows it.
 */
export function currentRepoIdentityFor(cwd: string): string | undefined {
  const repoRoot = getRepoRoot(cwd);
  if (!repoRoot) return undefined;
  return identityForRootReadOnly(repoRoot);
}

/**
 * `--repo` may be an already-serialized identity, a directory path, or a
 * bare repo name — resolve any of those to the identity the daemon and
 * repos.json key on. Calls `fail(msg)` (never returns) on an unresolvable
 * or ambiguous name — callers supply their own failure path so each command
 * keeps its own exit-message conventions (JSON vs text, etc).
 */
export async function resolveRepoArg(arg: string, fail: (msg: string) => never): Promise<string> {
  if (parseIdentity(arg)) return arg;

  // Directory derivation only for args SPELLED as paths. A bare name that
  // happens to collide with a directory under cwd ("logs", "docs") must take
  // the index lookup, not silently derive that directory's path identity.
  const looksLikePath = arg.includes("/") || arg.startsWith(".") || arg.startsWith("~");
  if (looksLikePath) {
    try {
      if (statSync(arg).isDirectory()) return serializeIdentity(await deriveRepoIdentity(arg));
    } catch {
      // not a directory on disk — fall through to the name lookup
    }
  }

  const collapsed = reverseLookupByName(arg, loadRepoIndex());
  if (collapsed.length === 1) return collapsed[0]![0];
  if (collapsed.length > 1) {
    fail(`--repo "${arg}" matches more than one repo: ${collapsed.map(([id]) => id).join(", ")} — pass the full identity`);
  }
  fail(`--repo "${arg}" did not match a known repo — pass --repo <name> or run from inside a registered repo`);
}

/**
 * Index rows whose basename or identity tail matches `name`, with each
 * legacy-name/identity pair the additive heal leaves behind collapsed to one
 * row (identity preferred) — until `rt repos prune` collapses the pair for
 * real, both rows point at the same directory and a naive match count calls
 * every healed repo ambiguous.
 */
export function reverseLookupByName(name: string, index: Record<string, string>): [string, string][] {
  const matches = Object.entries(index).filter(
    ([id, path]) => basename(path) === name || parseIdentity(id)?.id.split("/").pop() === name,
  );
  const byRealpath = new Map<string, [string, string]>();
  for (const m of matches) {
    let real: string;
    try {
      real = realpathSync(m[1]);
    } catch {
      real = m[1];
    }
    const prev = byRealpath.get(real);
    if (!prev || (parseIdentity(m[0]) !== null && parseIdentity(prev[0]) === null)) byRealpath.set(real, m);
  }
  return [...byRealpath.values()];
}

export { repoLabel } from "./repo-label.ts";
