# The mattstack settings architecture

How every mattstack app (rt, deck, mr-board, gitq) declares, reads, and writes
human-intent configuration. Read this before adding a key, porting an app, or
building anything that touches `~/.mattstack`. The dated design records live in
`docs/superpowers/specs/` (2026-08-20 suite spec, 2026-08-21 re-root spec) and
Linear (MAT-374, RT-30/31/32); this file is the live contract.

## The three-layer rule

Every piece of app state is exactly one of:

1. **Human intent** → a settings store (git-backed, this document).
2. **Secret** → the sops/age-encrypted store under `user/secrets/` — NEVER a
   settings store, never plaintext on disk. Consumers read env-first, then the
   rt daemon's token-gated `secrets:read` verb (`lib/daemon/handlers/secrets.ts`,
   per-caller scopes with explicit whitelists).
3. **Runtime** → plain files under `~/.mattstack/<app>/` (state dirs: `rt/`,
   `deck/`, `shepherdr/`, `repos/`, `ci-attendants/`, `work/`). Machine-local,
   re-derivable or acceptable-to-lose, never in git.

If something is neither re-derivable nor declared, it is mis-filed — promote it
to a store or the secrets layer.

## Stores and scopes

Precedence: `default < team < user < team.repo < user.repo < machine < machine.repo`
(VS Code-style most-specific-wins; repo sections are keyed by normalized remote
identity `host/path` — the RAW form, never the serialized `remote:…` wire form
that keys everything outside the settings stores; [repo-identity.md](repo-identity.md)
is the contract for which form goes where). On disk — scope in the filename,
identity in the path:

| Scope   | File | Tracked in |
|---|---|---|
| team    | `~/.mattstack/teams/<team>/mattstack/settings.team.jsonc` | the team's own repo |
| user    | `~/.mattstack/user/settings.user.jsonc` | the personal repo (`mattstack-home`) |
| machine | `~/.mattstack/user/local/<machine-key>/settings.local.jsonc` | the personal repo — tracked and KEYED per machine ("travels keyed"); machines never share a profile |

`~/.mattstack` itself is a plain directory, not a repo — `~/.mattstack/user` IS
the personal repo. The machine key is the hostname slug, overridable by the
untracked `~/.mattstack/machine-key` file; `machineKey()` in `lib/rt-paths.ts`
is the authority (override honored only as a safe single path segment). The rt
snapshot daemon auto-commits and pushes the personal repo (debounced; claimed
zones in `user/snapshot-owners.jsonc` excluded; `rt home claim|release`), so
every store write becomes a `snapshot:` commit within ~80s — by design.

## The resolver and registry

One in-process resolver for the whole suite, in `@mattstack/rt-client`
(`packages/rt-client/src/settings/`): `getSetting(key)` re-reads the stores on
every call (no memoization); `setSetting(key, value, scope, opts)` does
comment-preserving jsonc edits with a refusal ladder (malformed/duplicate-key
files are never blind-edited). `lib/rt-paths.ts` is the PATH authority —
change it first, mirror in `packages/rt-client/src/settings/paths.ts`
(`lib/__tests__/settings-paths-parity.test.ts` fails the build on divergence).

Every key is declared in the suite registry
(`packages/rt-client/src/settings/registry-defs.ts`): name, type, allowed
scopes, merge (`deep` merges across scopes for objects), description, optional
default. Prefixes: `rt.*`, `deck.*`, `board.*`, `gitq.*`, `mattstack.*`,
`claude.*`. `rt settings set/get/explain/list` accept any registered key;
`rt settings explain <key>` shows per-scope provenance and is the first
debugging move.

Apps read IN-PROCESS via rt-client (deck boots before the daemon, so daemon
round-trips for settings are wrong by design); the daemon's settings verbs
exist for out-of-process callers only.

## Adding a key (the checklist)

1. Add the registry row in `registry-defs.ts` (pick the scope by who the intent
   belongs to: team convention / this human everywhere / this machine).
2. `cd packages/rt-client && bun run build` — dist is what consumers copy, and
   the dist-freshness test fails otherwise.
3. Deliver the new registry to every consumer — a node_modules copy never
   updates itself. A `file:` consumer (today: console) re-copies on
   `bun install`; the apps pinned to the published package (mr-board, gitq,
   board) only see the key after an rt-client version bump + publish +
   install; deck additionally BUNDLES rt-client into its compiled binary —
   rebuild + fresh-inode install + `codesign -f -s -` to pick up path or
   registry changes.
4. Read via `getSetting`, write via `setSetting`. Never construct store paths
   by hand; never cache a path or a value at module load.

## Porting an app's config (the ownership latch)

When a key migrates from an app's own config file, the transition pattern is:
`getSetting(KEY).value === undefined` ⇒ the store does NOT own the key ⇒ read
(and write) the legacy file as before; probe failures (try/catch) count as
unowned plus ONE warning that never echoes values. Once the store owns the key
it wins (per-field for field-bag objects, wholesale for maps — document which),
and store values go through the SAME validators as file values. Writers hitting
ENOENT on the legacy file write the store instead (file-authority is
meaningless with no file). The cutover imports live values, VERIFIES the write
actually persisted, then renames the legacy file to `<name>.migrated` — never
unlinks it, so an interrupted run loses nothing and a corrupt file (left in
place, unrenamed) stays recoverable by hand. Verifying is not optional:
`persistOrWarn` swallows `SQLITE_BUSY`, so a write that returned is not
necessarily a write that landed. Reference implementations:
`lib/state/legacy-import.ts`, `lib/run-history.ts`,
`extensions/vscode/rt-context/src/branchNaming.ts`, `mr-board/src/config.ts`,
`gitq/src/core/{worktrees,forges}.ts`, `local-apps/src/api/platform-settings.ts`.

**Invariant: keys behind an ownership latch must carry NO registry `default`** —
a default materializes as a present value and flips the key store-authoritative
on every install (stated at the `board.*` block in registry-defs).

## Footguns (each cost a real debugging session)

- Bun freezes `os.homedir()` and the spawn-PATH at process start. Resolve HOME
  at call time (`process.env.HOME ?? homedir()`) everywhere; tests repoint
  `process.env.HOME` at a temp dir via a bunfig preload — never remove those
  preloads, and never let a test touch the real `~/.mattstack`.
- `file:` dependencies are COPIES (see step 3 above). Stale copies fail
  silently — old paths resolve nothing and every key reads as unset.
- sops resolves `.sops.yaml` and its `path_regex` relative to the spawn cwd;
  the cwd pin, the regex, and the `--filename-override` move in lockstep
  (`lib/secrets/store.ts`), and decrypting a `.tmp` staging file needs
  `--input-type json` (sops infers the store from the extension).
- The dev-mode `rt` wrapper runs from the main repo-tools checkout — whatever
  branch that checkout has is what `rt` and a restarted daemon run.
- Settings are boot-read in deck/board — a store change needs an app restart;
  the config-file watchers do not see store edits.

## Per-app key tables

The authoritative per-app tables (which key, which scope, what shape) are in
`docs/superpowers/specs/2026-08-20-suite-settings-migration.md`; app-facing
summaries live in each app's README (gitq, mr-board) and
`~/.mattstack/work/scratch/handoff-2026-08-21-deck-state-for-react-rewrite.md`
for deck.
