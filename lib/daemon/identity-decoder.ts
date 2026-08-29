/**
 * The shared `parseIdentity` in settings/identity.ts returns the decomposed
 * `{kind,id}` object and is used broadly for that shape (repo labeling,
 * remote derivation, legacy-key detection). Every daemon handler guard
 * instead only ever checked its result for null and kept the original wire
 * string, so branding lives here on that string, not on parseIdentity's own
 * return type -- rebranding parseIdentity itself would ripple into every one
 * of its object-shaped consumers for no behavioral gain.
 */

import { parseIdentity } from "../settings/identity.ts";

export type SerializedIdentity = string & { readonly __brand: "SerializedIdentity" };

export function isSerializedIdentity(wire: string): wire is SerializedIdentity {
  return parseIdentity(wire) !== null;
}

export type RepoDecodeResult =
  | { ok: true; repo: SerializedIdentity }
  | { ok: false; error: string };

/**
 * Reads a payload's repo identity and validates it as a serialized wire
 * string. Checks "repoName" first, then "repo" -- the two fields the
 * current handler catalog actually sends (the worktree commands vs. the
 * endpoint and repos-locate commands) -- so existing callers need no wire
 * change.
 */
export function decodeRepo(payload: unknown): RepoDecodeResult {
  const p = payload as { repoName?: unknown; repo?: unknown } | null | undefined;
  const wire = p?.repoName ?? p?.repo;
  if (typeof wire !== "string" || !isSerializedIdentity(wire)) {
    return { ok: false, error: "repo-unknown" };
  }
  return { ok: true, repo: wire };
}
