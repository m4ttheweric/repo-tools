---
name: rt:settings
description: Use when reading or writing any mattstack app setting (rt, deck, mr-board, gitq, console), adding or registering a settings key, choosing its scope (user/team/machine), porting an app's config file into ~/.mattstack, changing a setting from a script, or writing code that reads configuration from anywhere other than the settings resolver — a hand-edited settings jsonc, an invented config file or store path, an env var for something a human configures. Also use when a setting resolves undefined (or getSetting throws unknown-key) for a key that looks configured.
---

# The settings contract

Every mattstack app setting is a declared key in the suite settings stores,
resolved by one shared resolver. The instinct "just write a config file" —
or "just sed the jsonc" — is the bug this contract exists to prevent.

## The contract

1. Read with `getSetting`, write with `setSetting` — from
   `@mattstack/rt-client` in apps, from `lib/settings/resolve.ts` /
   `lib/settings/write.ts` inside repo-tools, and `rt settings
   get/set/list/explain` from shells and scripts (a `set` takes a JSON
   value — wrap string values in JSON double-quotes: a literal as
   `'"matt"'`, a shell variable as `"\"$var\""` — and always names its
   scope with `--scope`; scope is never inferred). Never edit a settings `*.jsonc` by hand (sed/jq included),
   never invent an app config file, never construct a store path —
   `setSetting` preserves comments and refuses malformed or duplicate-key
   files that a hand edit would silently corrupt into a store that reads
   as empty.
2. Every key is DECLARED: a registry row in
   `packages/rt-client/src/settings/registry-defs.ts` (type, allowed scopes,
   merge, description — add a `default` only after clearing line 5; a
   `board.*` row never has one). An explicit `getSetting` of an undeclared key
   THROWS; an undeclared key found in a store file warns and is skipped.
   A new key is the registry row first, then delivery: rt itself sees the
   row immediately, but every consumer app holds a COPY of rt-client in its
   node_modules (deck bundles it into a compiled binary) that stays stale
   until that copy is refreshed — and a plain `bun install` against a
   published-version pin refreshes NOTHING; the add-a-key checklist in the
   routed doc carries the real per-consumer delivery steps. A key that
   resolves undefined — or throws unknown-key — in one app while
   `rt settings` knows it is a stale copy, not a missing value.
3. Scopes, weakest → strongest: `default < team < user < team.repo <
   user.repo < machine < machine.repo` — most-specific wins; machine
   outranks user outranks team. Pick the scope by whose intent it is: team
   convention / this human on every machine / this machine only. Path
   literals are legal only in the machine store.
4. The stores are git-backed and travel — scope lives in the filename. The
   user store (`user/settings.user.jsonc`) AND the machine store
   (`user/local/<machine-key>/settings.local.jsonc` — tracked, keyed per
   machine) live in the personal home repo (`~/.mattstack/user` IS that
   repo), and the home-snapshot daemon auto-commits and pushes them within
   ~80s. Team stores (`teams/<team>/mattstack/settings.team.jsonc`) live in
   the team's own repo — a team write stays local until committed and
   pushed, and `setSetting` prints that reminder.
5. A registry `default` is the sharpest field on a row: it materializes as
   a present value on every install. The `board.*` block bans defaults
   OUTRIGHT — a new board.* row never carries `default:`, fresh key or
   not; the fallback lives in the app-side read
   (`getSetting(k).value ?? fallback`), never in the row, and writing both
   is still the bug. Keys ported from an app's legacy config file omit
   defaults for a second reason: the ownership latch —
   `getSetting(key).value === undefined` means the legacy file still owns
   it, and a default flips the key store-authoritative. Any registry
   block's own comment binds every row added under it.
6. A secret is never a setting: tokens and keys live in the sops-encrypted
   secrets store, read env-first, then the daemon's token-gated
   `secrets:read`.
7. Repo-scoped sections key on the RAW `host/path` identity, never the
   serialized `remote:…` wire form — the rt:repo-identity skill owns that
   boundary.

`rt settings explain <key>` shows per-scope provenance and is the first
move on any "why is this value what it is" question.

## Where the details live

| Need | Read |
|---|---|
| Full architecture: three-layer rule, store files on disk, resolver semantics, the add-a-key checklist, porting + ownership latch, footguns (call-time HOME, stale copies, sops cwd) | `docs/settings-architecture.md` in the repo-tools checkout this skill symlinks from (here: `~/Documents/GitHub/repo-tools`) |
| Which identity form keys what — raw vs serialized | `docs/repo-identity.md`, same checkout |
| Per-app key tables (which key, which scope, what shape) | `docs/superpowers/specs/2026-08-20-suite-settings-migration.md`, same checkout |
| Resolver API while standing in a consumer repo | `node_modules/@mattstack/rt-client/README.md` (from that repo's root) |
