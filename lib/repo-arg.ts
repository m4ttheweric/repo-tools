/**
 * Shared `--repo <arg>` resolution for CLI commands that forward a repo key
 * to identity-only daemon verbs. Every sender of a repo-keyed daemon payload
 * needs the same reverse-resolution (identity passthrough → directory derive
 * → index lookup by display name) — this is the one place it lives.
 */
import { statSync } from "fs";
import { basename } from "path";
import { deriveRepoIdentity, parseIdentity, serializeIdentity } from "./settings/identity.ts";
import { loadRepoIndex } from "./repo-index.ts";
import { getRepoIdentity } from "./repo.ts";

/** Daemon payload key for the in-repo default — the serialized identity, not the display name. */
export function currentRepoIdentity(): string | undefined {
  return getRepoIdentity()?.identity ?? undefined;
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

  try {
    if (statSync(arg).isDirectory()) return serializeIdentity(await deriveRepoIdentity(arg));
  } catch {
    // not a directory on disk — fall through to the name lookup
  }

  const index = loadRepoIndex();
  const matches = Object.entries(index).filter(
    ([id, path]) => basename(path) === arg || parseIdentity(id)?.id.split("/").pop() === arg,
  );
  if (matches.length === 1) return matches[0]![0];
  if (matches.length > 1) {
    fail(`--repo "${arg}" matches more than one repo: ${matches.map(([id]) => id).join(", ")} — pass the full identity`);
  }
  fail(`--repo "${arg}" did not match a known repo — pass --repo <name> or run from inside a registered repo`);
}

/** Decode a daemon-returned `TreeRow.repoName` (a raw serialized identity) into its display label. Never call this on a value that will be sent back to the daemon as a payload key — it is already the identity there. */
export function repoLabel(serialized: string): string {
  const id = parseIdentity(serialized);
  if (!id) return serialized;
  return id.kind === "remote" ? (id.id.split("/").pop() ?? id.id) : basename(id.id);
}
