/**
 * Matches Linear-style identifiers: 1+ letters, a hyphen, 1+ digits.
 * e.g. CV-1287, ENG-456, PLAT-12
 */
const LINEAR_ID_RE = /^[A-Za-z]+-\d+$/;

/**
 * Extract a Linear ticket identifier from a git branch name.
 *
 * Splits the branch on `/` and scans segments from last to first,
 * returning the first segment that matches the TEAM-NNN pattern.
 *
 * Based on the proven approach in gitq-core/src/linear.ts.
 *
 * Examples:
 *   "feature/cv-1287"           → "CV-1287"
 *   "matt/ENG-456-some-desc"    → null  (segment isn't purely the ID)
 *   "feature/cv-1287-add-stuff" → null  (segment has trailing text)
 *
 * For branches where the ID is embedded in a longer segment (e.g.
 * "feature/cv-1287-add-photos"), we also try a prefix-match fallback.
 */
export function extractLinearId(branch: string): string | null {
  const segments = branch.split('/');

  // Pass 1: exact segment match (most reliable)
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i]!;
    if (LINEAR_ID_RE.test(seg)) {
      return seg.toUpperCase();
    }
  }

  // Pass 2: prefix match — the segment starts with TEAM-NNN followed by
  // a separator (hyphen, underscore). Handles "cv-1287-add-photos".
  const PREFIX_RE = /^([A-Za-z]+-\d+)[-_]/;
  for (let i = segments.length - 1; i >= 0; i--) {
    const match = PREFIX_RE.exec(segments[i]!);
    if (match) {
      return match[1]!.toUpperCase();
    }
  }

  return null;
}

/**
 * Parse a GitLab/GitHub remote URL to extract the project path.
 *
 * Handles both SSH and HTTPS formats:
 *   "git@gitlab.com:my-org/my-repo.git" → "my-org/my-repo"
 *   "https://gitlab.com/my-org/my-repo.git" → "my-org/my-repo"
 */
export function parseRemoteUrl(url: string): { host: string; projectPath: string } | null {
  // SSH format: git@host:org/repo.git
  const sshMatch = /^git@([^:]+):(.+?)(?:\.git)?$/.exec(url);
  if (sshMatch) {
    return { host: `https://${sshMatch[1]}`, projectPath: sshMatch[2]! };
  }

  // HTTPS format: https://host/org/repo.git
  const httpsMatch = /^https?:\/\/([^/]+)\/(.+?)(?:\.git)?$/.exec(url);
  if (httpsMatch) {
    return { host: `https://${httpsMatch[1]}`, projectPath: httpsMatch[2]! };
  }

  return null;
}
