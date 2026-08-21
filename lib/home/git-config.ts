/**
 * Pure `.git/config` parsing — no fs, no exec. Used to recover the origin
 * remote URL of a clone whose `.git` is about to be (or already was)
 * unlinked, so a caller doesn't need `git remote get-url` (a subprocess) to
 * answer a question the config file already holds as text.
 */

/**
 * Extracts the `url` under `[remote "origin"]`. Only that one section is
 * read — `git config`'s full include/multi-value semantics don't apply here,
 * since this reads a single known-shape file rather than resolving a real
 * git config graph.
 */
export function parseOriginUrl(gitConfigText: string): string | null {
  const lines = gitConfigText.split("\n");
  let inOriginSection = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith("[")) {
      inOriginSection = /^\[remote\s+"origin"\]$/.test(line);
      continue;
    }
    if (!inOriginSection) continue;
    const match = line.match(/^url\s*=\s*(.+)$/);
    if (match) return match[1]!.trim();
  }

  return null;
}
