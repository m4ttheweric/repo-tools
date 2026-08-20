/**
 * The home repo's gitignore boundary (RT-30, per MAT-374 rulings 1-3, 5).
 *
 * The gitignore IS the boundary: tracked = declarative surfaces (synced
 * across machines), ignored = runtime. `user/local/` is hoisted here rather
 * than left to mattstack-prefs' own folded-in `.gitignore`, so the boundary
 * doesn't depend on that inner file surviving the fold-in.
 */

export const HOME_BOUNDARY: { tracked: string[]; ignored: string[] } = {
  tracked: ["user/", "skills.jsonc", "snapshot-owners.jsonc", "user/secrets/"],
  ignored: [
    "rt/",
    "deck/",
    "shepherdr/",
    "repos/",
    "ci-attendants/",
    "work/",
    "teams/",
    "user/local/",
    "settings.local.jsonc",
    "*.sock",
    ".DS_Store",
  ],
};

export function renderHomeGitignore(): string {
  return `${HOME_BOUNDARY.ignored.join("\n")}\n`;
}
