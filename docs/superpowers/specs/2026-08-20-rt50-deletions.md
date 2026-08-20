# RT-50 step 1 — dead-command deletions + cruft (spec)

Scope: the deletion lane of RT-50 (Linear: "settings/state endgame"). Settings-key
migration is step 2, a separate plan. All removals below were ruled by Matt on
2026-08-20 (Linear RT-50 comment + session handoff); rulings are final.

## Commands removed (code + registry + docs + tests)

| Command | Also removed with it |
|---|---|
| `rt mr` / `rt pr` | per-repo `mr.json` read/write code; the files under `~/.mattstack/rt/repos/*/mr.json` |
| `rt branch` | branch-clean; **branch-naming.json FILES STAY** (VS Code extension reads them) — only rt's verb goes |
| `rt turbo` | build-history.json code + files |
| `rt open` | — |
| `rt code` | workspace-prefs.json code + file |
| `rt agent` | — |
| `rt workspace` | daemon `workspace:sync:*` handler family, `lib/workspace-sync.ts`, workspace-sync.json |
| `rt park` | parking-lot.json code + the 16 per-repo files (on-deck replaced parking) |
| `rt doppler` (verb ONLY) | **machinery stays**: `lib/daemon/doppler-sync.ts` worktree-create auto-sync and doppler-template.yaml handling untouched |

Kept by ruling regardless of usage: `rt sync`, `rt status`, `rt update` (dies with
brew in MAT-383 phase 2, not before).

## Caller-check audit results (evidence gathered 2026-08-20)

- 14 days of `~/.mattstack/rt/logs/cli.*`: zero hits for mr/pr, branch, turbo, open,
  code, agent, workspace, hooks, plugin. `park` 11 hits (ruled removed anyway),
  `doppler` 13 (verb-only removal stands). The 352 `validate` hits are the top-level
  `rt validate` command, not `rt plugin validate`.
- No installed Claude plugin pack (assured, claimview, mattstack, official) references
  `rt hooks` or `rt plugin`.
- **RULED (Matt, 2026-08-20 mid-session): `rt hooks` and `rt plugin` are hard keeps.**
  Their commands, daemon verbs (hooks:status/repair/watch), hooks-guard, and the
  api-server repair route are untouched by this lane. (Supporting evidence anyway:
  `rt plugin` is driven by e2e tests and the rt:create-plugin skill; `rt hooks` is the
  sole writer of the state hooks-guard reads.)

## Cruft deleted from ~/.mattstack/rt (no code involved)

- `daemon.log` (5.7MB Jul), `diag.log` (2MB Jul), `sync.log` (Jul 16) — pre-convention,
  superseded by `logs/`
- `.DS_Store` ×3 (top, repos/, plugins/)
- `attach-*.sock` ×4 (May/June, dead)
- `.attic-2026-08-20.tar.gz`
- the six `*.json.migrated` blobs (branch-cache, discussions, events-cursors,
  notifier-state, notify-queue, project-mrs) — Matt ok'd; state.db is live and green
- state files orphaned by the code deletions above: `workspace-prefs.json`,
  `workspace-sync.json`, per-repo `mr.json`, `build-history.json`,
  16× `parking-lot.json`

## Constraints

- Worktree `repo-tools-rt50-wt`, branch `goodwinmattheweric/rt-50-settings-state-endgame`.
- Every command-tree `module:` removal must remove its `lib/module-registry.ts` entry
  in the same commit (compiled-binary footgun, CLAUDE.md).
- No compat shims, no deprecation stubs: pure canonical removal.
- Green gates: `tsc` 0 errors, `bun run test:all`, e2e suite; delete `dist/rt` before
  trusting e2e.
- Tests spawning quit/kill/launchctl must pass `env: process.env` from the first run.
