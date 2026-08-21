/**
 * The home repo's gitignore boundary.
 *
 * The gitignore IS the boundary: tracked = declarative surfaces (synced
 * across machines), ignored = runtime. `user/local/` is hoisted here rather
 * than left to mattstack-prefs' own folded-in `.gitignore`, so the boundary
 * doesn't depend on that inner file surviving the fold-in.
 *
 * The single-segment directory patterns are leading-slash anchored
 * (`/rt/`, not `rt/`): an unanchored `dir/` pattern matches that name at
 * ANY depth in git, so a future tracked `user/rt/` would be silently
 * ignored by a bare `rt/`. `*.sock` and `.DS_Store` are deliberately left
 * unanchored — those are wanted at any depth.
 */

export const HOME_BOUNDARY: { tracked: string[]; ignored: string[] } = {
  tracked: ["user/", "skills.jsonc", "snapshot-owners.jsonc", "user/secrets/"],
  ignored: [
    "/rt/",
    "/deck/",
    "/shepherdr/",
    "/repos/",
    "/ci-attendants/",
    "/work/",
    "/teams/",
    "user/local/",
    "settings.local.jsonc",
    "user/secrets/*.tmp",
    "*.sock",
    ".DS_Store",
  ],
};

export function renderHomeGitignore(): string {
  return `${HOME_BOUNDARY.ignored.join("\n")}\n`;
}
