/**
 * The user repo's gitignore hygiene list.
 *
 * Post re-root, `user/` IS the personal repo — structure (nothing employer-
 * adjacent or runtime lives inside it) is the security boundary, not this
 * file. This list is ordinary hygiene: OS/transient noise that would
 * otherwise get committed. All patterns are deliberately unanchored — they
 * are wanted at any depth in the tree.
 */

export const HOME_BOUNDARY: { ignored: string[] } = {
  ignored: [".DS_Store", "*.sock", "*.tmp"],
};

export function renderHomeGitignore(): string {
  return `${HOME_BOUNDARY.ignored.join("\n")}\n`;
}
