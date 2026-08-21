# Home-repo re-root — user/ IS the repo (spec amendment)

Ruled by Matt 2026-08-21 (conversation; supersedes MAT-374 ruling 2's "~/.mattstack
IS the clone" and stratum 5's "machine-local never travels"). Motivation: the
settings consolidation routed all declarative intent into the stores under
`user/`, hollowing out root-level-clone's rationale while leaving employer
material (team clones, ci-attendants) under a personal repo tree guarded only by
.gitignore. Boundaries move from ignore-based to structural.

## The ruled shape

```
~/.mattstack/                     ← plain directory, NO repo
  user/                           ← THE personal repo (mattstack-home re-rooted)
    settings.user.jsonc           ← user scope (renamed from settings.jsonc)
    local/<machine-key>/
      settings.local.jsonc        ← machine scope, TRACKED, keyed per machine
    secrets/*.json                ← sops-encrypted (unchanged)
    skills.jsonc                  ← moves in from root
    snapshot-owners.jsonc         ← moves in from root
    .sops.yaml                    ← moves in from root (cwd-pin follows)
    prefs/, skills/, ...          ← existing content unchanged
  teams/<name>/mattstack/
    settings.team.jsonc           ← team scope (renamed from settings.jsonc); THEIR repo
  rt/ deck/ shepherdr/ repos/ ci-attendants/ work/   ← state; no repo; never travels
```

## Rulings

1. **Structural boundary**: no personal repo tree contains employer material or
   runtime state by construction. .gitignore stops being load-bearing for
   security; the interim guard hooks on the root repo retire when the root repo
   does.
2. **Machine scope is tracked and keyed** ("machine-scoped travels keyed"
   amends "machine-local never travels"): each machine's settings live at
   `user/local/<machine-key>/settings.local.jsonc`. Restore = clone + pick your
   machine profile from the list (human-readable keys). Multi-machine never
   clobbers — each writes only its own key.
3. **Machine key**: derived from hostname (slugified LocalHostName), overridable
   via an untracked `~/.mattstack/machine-key` file; `rt restore` prompts to
   pick an existing profile or name a new one.
4. **Naming**: scope in the filename, identity in the path —
   settings.user.jsonc / settings.local.jsonc / settings.team.jsonc.
5. **State rule** (regeneration rule restated): everything outside user/ and
   teams/ is re-derivable or acceptable-to-lose; anything neither is mis-filed
   and must be promoted to the declarative layer. Age key stays keychain+
   password-manager (own channel).
6. **Paths/identity in the tracked machine sections are accepted** (private
   personal repo), including board.claudeCommand's account string — Matt's
   explicit call.
7. **Precedence unchanged**: default < team < user < machine (+ repo sections),
   the VS Code-style most-specific-wins ladder. Only storage locations move.

## Implementation sketch (its own lane, parallel to board)

- Resolver (`packages/rt-client/src/settings/paths.ts` + stores/write):
  `userSettingsPath` → `~/.mattstack/user/settings.user.jsonc`;
  `machineSettingsPath` → `user/local/<machineKey()>/settings.local.jsonc`
  (machineKey resolves hostname-slug with the override file);
  `teamSettingsPath` → `teams/<name>/mattstack/settings.team.jsonc`.
  setSetting machine-scope creates the machine dir on first write.
- Live migration (orchestrator): re-root mattstack-home history
  (`git filter-repo --subdirectory-filter user` on a fresh clone + move the
  three root files in + `git mv settings.jsonc settings.user.jsonc` +
  seed `local/<key>/settings.local.jsonc` from the current
  `settings.local.jsonc`), force-push to the SAME remote (private, solo —
  history rewrite acceptable here as the repo is 1 day old; Matt's rotate-not-
  rewrite doctrine concerns secrets, and the secrets remain encrypted in both
  histories), re-clone into `~/.mattstack/user`, delete the root `.git` +
  hooks, rename the team file, restart daemon + deck, full verify.
- Consumers to update: sops cwd-pin (`buildSecretsSpawnOptions` →
  `user/`), skills.jsonc readers (manifest walk), snapshot-owners readers
  (H2, unbuilt), `rt home init`/`key`/boundary + guard code (init targets
  user/; HOME_BOUNDARY simplifies to the user-repo tree), hooks.json shims
  (unaffected — rt/ zone), docs.
- H2 (snapshot daemon) spec: watches `~/.mattstack/user` only; commits by
  allowlist (belt), which is now just "the whole repo minus *.tmp".
- e2e/test fixtures that seed store paths update to the new names.
