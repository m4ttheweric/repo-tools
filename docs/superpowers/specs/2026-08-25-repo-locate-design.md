# Repo locate + registry merge (RT-63, RT-68) — design

Status: ratified 2026-08-25 (Matt: "get it done"). Binding constraints in **bold**.

## Why

A folder move keeps the repo identity (RT-62) but leaves literal paths stale in
rt's stores. The worktree reconciler (`lib/daemon/worktree-reconciler.ts`,
step (a)) prunes registry rows whose path is absent from `git worktree list`,
so an index path that heals before the registry is rewritten destroys
claimed/on-deck state and replenish mints replacement trees. Separately, the
RT-62 cutover left a name/identity index pair whose two registries each own
half of one on-deck pool, and `rt repos prune` cannot collapse it.

**The daemon is never stopped for any of this.** Mutations of daemon-owned
state go through the daemon, never around it.

## Scope

1. **Registry merge primitive** (`lib/worktree/registry.ts` or sibling):
   `mergeRegistries(winner: TreeRecord[], loser: TreeRecord[]): TreeRecord[]`
   — union by canonical path; on a path present in both, the managed record
   wins (`main`/`ephemeral` beat `unmanaged`; two managed → later `createdAt`;
   tie → winner side). Pure, unit-tested.
2. **Prune uses the merge** (`migrateWorktreeRegistry` in `lib/repo-index.ts`):
   when both names own a registry, merge into the live name, verify persisted,
   delete the retired registry — `registry: "merged"` outcome replaces
   `"refused"` for that case. `rt repos prune` output names the merge.
3. **Prune guard**: a `missing` row that owns a worktree registry is retained
   (reported `retained`, reason `missing`, hint `rt repos locate`) — never
   evicted while it owns data.
4. **Locate core** (`lib/repo-locate.ts`, pure of daemon/CLI):
   `planLocate({ newPath, repoArg? })` → `{ identity, oldPath, indexKeys,
   registryRewrites, claimRewrites, gitRepairPaths }` or a typed refusal;
   `applyLocate(plan)` performs, in one `state.db` transaction: index rows
   (identity + legacy pair) → `newPath`; every registry of the pair:
   prefix-replace `path` for records under `oldPath` (external trees
   untouched), then merge the pair's registries via (1) and delete the legacy
   registry + legacy index row; `endpoint_claims.worktree` prefix; `repos.json`
   mirror. After commit: `git worktree repair <rewritten in-tree paths…>` from
   `newPath`, then a no-arg pass. Verify every registry path exists on disk and
   appears in `git worktree list --porcelain`; on failure restore the pre-apply
   snapshot of the touched rows (captured before the transaction) and report.
   - **Match by identity, never by name**: `serializeIdentity(await
     deriveRepoIdentity(newPath))` must equal a lost index key, or the derived
     identity of a lost legacy-name row's pair. Mismatch → refusal printing
     both identities.
   - `oldPath` must not exist on disk; if it does, refuse ("second clone, not
     a move").
5. **Daemon verb** `repos:locate` (`lib/daemon/handlers/repos.ts`): payload
   `{ newPath, repo?, dryRun? }`; runs `applyLocate` **inside the reconciler's
   in-flight guard** (new `withReconcilerHeld(fn)` on the reconciler object:
   awaits any pass in flight, blocks `kick` from starting a pass until `fn`
   settles), then `hooksGuard.refreshWatchedRepos()`, then emits
   `repo:moved { identity, from, to }` on the events bus. Registered in
   `lib/daemon/command-router.ts` like every other handler.
6. **CLI** `rt repos locate <new-path> [--repo <id|name>] [--dry-run] [--json]`
   (`commands/repos.ts`): resolves `--repo` via `resolveRepoArg`; calls the
   daemon verb when the socket answers, otherwise runs `applyLocate` locally
   (no daemon → nothing to race). No `<new-path>`: scan `rt.repoRoots`
   (existing scanner in `lib/repo-index.ts`) for candidates whose derived
   identity matches a lost row; one match → confirm; several → picker; none →
   list lost rows and exit 1. Never auto-pick.
7. **Lost rows visible**: `getKnownRepos` keeps missing-path rows and marks
   them `missing: true`; `rt cd` / pickers render `name (missing — rt repos
   locate)` and refuse to cd into them.
8. **Implicit heal is move-aware** (RT-65 seam): `updateRepoIndex(identity,
   root)` — when the stored path differs from the observed main path AND the
   stored path no longer exists → route through `applyLocate` (local, or via
   the daemon when it answers) instead of a bare `setKvValue`. Stored path
   still exists → second clone; leave it alone (today's behavior).

## Out of scope

gitq's commonDir-hash store, claimview `uow.json`, `board.cwds`,
`rt.workspacePrefs.workspaces` keys — those owners react to `repo:moved`
(follow-up tickets). The RT-65 `rt worktree list` no-heal bug itself.

## Parity anchors

- Wire keys everywhere: `parseIdentity`/`serializeIdentity` from
  `lib/settings/identity.ts`; legacy pair discovered via
  `resolveIndexPathForIdentity`'s scan, never by basename.
- Registry namespace constant `worktree-registry` (`repo-index.ts` mirrors
  `registry.ts`; keep both).
- Logging: handlers use `ctx.log`; no outcome logging (seams cover it).
- Module registry: any new command module referenced from `cli.ts` must be
  thunked in `lib/module-registry.ts`.
- Comments: constraint-only (clean-code rule).

## Verification

`bunx tsc --noEmit`; `bun test lib commands packages`; a real-state dry run:
`rt repos locate --dry-run ~/Documents/GitHub/assured-dev` against a copy of
`~/.mattstack` (isolated `HOME`) after `mv`-ing a throwaway clone.
