/**
 * The pure half of the repo-identity contract: the wire codec and the
 * remote-URL normalizer. Split from identity.ts so browser bundles can key
 * and label repos without dragging in fs/child_process — this module must
 * never import node builtins or anything that does (the `./identity`
 * subpath export points here, and a browser consumer evaluates it at module
 * scope). Override-aware and derivation entry points stay in identity.ts.
 */

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
