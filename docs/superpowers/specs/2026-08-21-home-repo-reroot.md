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
    settings.user.jsonc           ← user scope (renamed from user/settings.jsonc)
    local/<machine-key>/
      settings.local.jsonc        ← machine scope, TRACKED, keyed per machine
    secrets/*.json                ← sops-encrypted (unchanged)
    skills.jsonc                  ← moves in from root (compat symlink stays at root)
    snapshot-owners.jsonc         ← moves in from root
    .sops.yaml                    ← moves in from root, REWRITTEN (see sops triple)
    .gitignore                    ← rewritten (see below); `local/` line DELETED
    prefs/, skills/, ...          ← existing content unchanged
  teams/<name>/mattstack/
    settings.team.jsonc           ← team scope (renamed from settings.jsonc); THEIR repo
  rt/ deck/ shepherdr/ repos/ ci-attendants/ work/   ← state; no repo; never travels
```

## Rulings

1. **Structural boundary**: no personal repo tree contains employer material or
   runtime state by construction. .gitignore stops being load-bearing for
   security; the interim guard hooks on the root repo retire when the root repo
   does. (The hooks are hand-installed in `~/.mattstack/.git/hooks/`
   {pre-commit,pre-push} with no source checked into any repo — retiring them
   is a live-system deletion alongside the root `.git`, not a code change.)
2. **Machine scope is tracked and keyed** ("machine-scoped travels keyed"
   amends "machine-local never travels"): each machine's settings live at
   `user/local/<machine-key>/settings.local.jsonc`. Restore = clone + pick your
   machine profile from the list (human-readable keys). Multi-machine never
   clobbers — each writes only its own key.
3. **Machine key**: derived from hostname (slugified LocalHostName), overridable
   via an untracked `~/.mattstack/machine-key` file; `rt restore` prompts to
   pick an existing profile or name a new one, and PERSISTS the choice to
   `~/.mattstack/machine-key` (that file is regenerable, so it may live outside
   user/ without violating ruling 5). `rt restore` itself is forward work
   (RT-31, unbuilt — like snapshot-owners/H2); until it exists, seeding the
   machine-key file is a manual step documented in the migration.
4. **Naming**: scope in the filename, identity in the path —
   settings.user.jsonc / settings.local.jsonc / settings.team.jsonc.
5. **State rule** (regeneration rule restated): everything outside user/ and
   teams/ is re-derivable or acceptable-to-lose; anything neither is mis-filed
   and must be promoted to the declarative layer. Corollary: everything INSIDE
   user/ is declarative and travels — scratch does not belong under user/ (see
   collisions). Age key stays keychain+password-manager (own channel).
6. **Paths/identity in the tracked machine sections are accepted** (private
   personal repo), including board.claudeCommand's account string — Matt's
   explicit call.
7. **Precedence unchanged**: default < team < user < machine (+ repo sections),
   the VS Code-style most-specific-wins ladder. Only storage locations move.

## user/local/ collisions (ruled destinations)

Live today, `user/local/` holds untracked non-profile content that collides
with the machine-profile namespace. Rulings (orchestrator, 2026-08-21):

- **Scratch** (handoff/reply markdown, attic tarballs — including
  `handoff-2026-08-20-installer-needs-from-settings-lane.md`, the live
  installer channel) moves to `~/.mattstack/work/scratch/` (state zone, no
  repo). The cross-agent handoff convention moves with it: new drops go to
  `work/scratch/`, and the attic tarballs are employer-adjacent so they must
  not enter the personal repo.
- **`user/local/claimview/`** (dev-flags.json, ld-flags/ — employer-adjacent
  runtime, forbidden in the personal repo by ruling 1) moves to
  `~/.mattstack/work/claimview/`. The lane greps all mattstack repos +
  `~/.claude` installed skills for readers of the old path and repoints any it
  finds; zero known readers is the expected result, but the grep is mandatory.
- **Inner `.gitignore`**: `user/.gitignore` today is the single line `local/`.
  After the re-root it is THE repo's gitignore, and that line would silently
  untrack every machine profile. It is REWRITTEN during migration to exactly:
  `.DS_Store`, `*.sock`, `*.tmp` (no `local/`). The stray
  `user/.DS_Store` present today is deleted before the first commit. H2's
  allowlist ("whole repo minus ignores") composes with this list.
- **Profile picker**: enumerates only `local/<dir>/` containing a
  `settings.local.jsonc` — a defensive gate so any future non-profile
  directory is never offered as a machine.

## Implementation sketch (its own lane)

**Sequencing**: the keys wave is MERGED (origin/main includes PR #7 and the
deck whitelist PR #8) — this lane branches a fresh worktree off origin/main.
The only concurrent rt-side branch is `board-secrets-scope` (touches
`lib/daemon/handlers/secrets.ts` only — no overlap with paths/stores). Runs
parallel to the board lane; the settings API is unchanged.

- **Resolver — `lib/rt-paths.ts` is the authority; change it FIRST, mirror in
  `packages/rt-client/src/settings/paths.ts`** (the parity test
  `lib/__tests__/settings-paths-parity.test.ts` fails the build on divergence).
  `userSettingsPath` → `~/.mattstack/user/settings.user.jsonc`;
  `machineSettingsPath` → `user/local/<machineKey()>/settings.local.jsonc` —
  machineKey() (hostname-slug, override-file read) makes this impure and must
  be duplicated IDENTICALLY on both sides or parity fails;
  `teamSettingsPath` → `teams/<name>/mattstack/settings.team.jsonc`.
  Also: `listTeams()` (rt-client stores.ts) gates team discovery on the
  settings filename — update its probe to `settings.team.jsonc`; the `--scope`
  option hints in `lib/command-tree-def.ts` (~:602) print all three store
  paths — update. setSetting machine-scope creates `local/<key>/` on first
  write.
- **sops triple — three cwd-coupled values move in lockstep** (breaking one
  silently matches NO creation rule, the wrong-recipient failure mode noted in
  store.ts): (1) `buildSecretsSpawnOptions` cwd pin `mattstackHome()` →
  `<mattstackHome>/user`; (2) `.sops.yaml` `path_regex: user/secrets/.*` →
  `secrets/.*` — the live file is REWRITTEN via `renderSopsYaml` (updated in
  lib/home/age-key.ts), not `git mv`'d; (3) the staging
  `--filename-override user/secrets/<domain>.json` → `secrets/<domain>.json`
  (staging stays in `rt/tmp/`, outside the repo). The verify includes an
  encrypt/decrypt round-trip proving the rules still match post-move.
- **`rt home init` is a rewrite, not a retarget**: the init-plan vocabulary
  built on "root is the repo / prefs folds in" retires — `createRepo`,
  `gitInit`, `foldInPrefs`, `unlinkUserClone`, `adoptCommit`,
  `HomeState.prefsRemoteUrl`, `reason: "prefs-remote-unreadable"` all go.
  Init becomes: ensure `~/.mattstack/` skeleton (state dirs), clone the user
  repo to `user/`, write the machine-key file, create `local/<key>/` if new,
  and create the `skills.jsonc` compat symlink (load-bearing provisioning — a
  restored machine needs it for the 27 unpatched readers, not just this
  migration).
  `writeGitignore` writes the ruled inner-gitignore content; `writeOwners`
  targets `user/snapshot-owners.jsonc`. HOME_BOUNDARY guard simplifies to the
  user-repo tree.
- **skills.jsonc — 27 cross-repo readers** (mr-board, mattstack-skills, gitq
  `scripts/resolve-args.sh` shims + installed `~/.claude` copies) hardcode
  `~/.mattstack/skills.jsonc`. This lane does NOT patch those repos: the
  migration leaves a compat symlink `~/.mattstack/skills.jsonc →
  user/skills.jsonc`. The symlink retires in a follow-up skills-estate sweep
  (tracked outside this lane). `snapshot-owners.jsonc` needs no symlink (zero
  live readers; H2 unbuilt reads the new path).
- Consumers otherwise unchanged: hooks.json shims (rt/ zone), docs sweep,
  e2e/test fixtures that seed store paths update to the new names.
- **H2 (snapshot daemon) spec**: watches `~/.mattstack/user` only; commits by
  allowlist (belt) = the whole repo minus the ruled gitignore.

## Live migration (orchestrator-only, destructive — ordered)

1. **Backup first**: `tar -czf ~/mattstack-preroot-backup-<date>.tar.gz`
   of the full `~/.mattstack` tree (kept outside the tree being mutated;
   delete after the verify passes and a quiet day).
2. Move scratch + claimview per the collision rulings (`work/scratch/`,
   `work/claimview/`); delete `user/.DS_Store` and the stale `local/.gitkeep`.
3. On a FRESH clone of mattstack-home (scratchpad):
   `git filter-repo --subdirectory-filter user`, move in `skills.jsonc`,
   `snapshot-owners.jsonc`; write the rewritten `.sops.yaml` + `.gitignore`;
   `git mv settings.jsonc settings.user.jsonc`; seed
   `local/<machine-key>/settings.local.jsonc` from the live root
   `settings.local.jsonc`. (filter-repo drops the root files' one-day history
   — they re-enter as fresh adds; accepted, the repo is a day old. Rotate-not-
   rewrite doctrine concerns secrets, which remain encrypted in both
   histories.)
4. Force-push to the SAME remote (private, solo). Clone to
   `~/.mattstack/user.new`; verify contents; swap (`user` → aside, `user.new`
   → `user`); only after the full verify passes, delete the aside copy, the
   root `.git/` + guard hooks, and the root `settings.local.jsonc`.
5. Compat symlink `~/.mattstack/skills.jsonc → user/skills.jsonc`; rename the
   team file (`teams/claimview/mattstack/`: `settings.jsonc` →
   `settings.team.jsonc`, committed+pushed in THEIR repo); write
   `~/.mattstack/machine-key`.
6. Restart daemon + deck.
7. **Full verify (defined)**: `rt settings list`/`explain` resolve across all
   three scopes with the expected values; `rt secrets` decrypt round-trip on
   an existing domain + an encrypt round-trip on a scratch key (then removed);
   daemon + deck restart clean; board serves; `rt verify` with all critical
   checks passing.
