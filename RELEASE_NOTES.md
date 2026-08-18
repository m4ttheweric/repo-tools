the worktree lifecycle release. `rt worktree` replaces the parking lot with a provision/dispose lifecycle backed by an on-deck pool of ready trees, and the daemon moves to realtime event tracking with per-repo grants. also ships the `@mattstack/rt-client` package, StrongDM agent verbs, and a batch of nav picker quality-of-life work. (an experimental mattcloud sandbox surface was built and retired entirely within this range, so it ships nothing.)

### Worktree lifecycle

- new `rt worktree` verb family: `provision`, `create`, `dispose`, `list`, `freshen`, `adopt`, and `each`, with a nav picker when invoked bare
- on-deck pool: pre-created worktrees kept ready by the daemon (replenish/shrink), a ready-step engine with changed-glob triggers, and name pools with ticket-derived branch names
- `provision` claims from the pool or cold-creates, revalidates the claim under lock, and surfaces degraded readiness instead of hiding it
- `dispose` is guarded (MR-sha anchor, tolerant of generated drift, lease-aware) and renames to trash with async reaping, so verb latency is independent of tree size; if the trash rename fails, the branch and registry record are kept
- merge reactor: merged MRs trigger auto-return of your shell and guarded auto-dispose of the finished tree
- per-repo worktree registry with a reconcile pass (ground-truth branches, unmanaged-tree adoption), epoch-checked saves so stale snapshots cannot clobber concurrent writes, and per-tree operation locks
- the parking lot is deleted; `rt park` remains as a deprecated stub pointing at `rt worktree`
- install dedup sees through env-var prefixes, and pnpm implicit installs default to a plain install

### Daemon: realtime tracking and freshness

- per-repo tracking levels (`live`/`poll`/`off`) with per-cache opt-in grants, edited interactively via `rt daemon track`
- realtime events watchers replace the ActionCable MR subscriptions; events fan out to granted stores (project upserts, teammate pushes, notes)
- delta sync: incremental `updatedAfter` pulls with a daily deep reconcile, demand-scoped to a 30-day window; a failed deep reconcile falls back to delta instead of wedging the repo
- pipeline top-up inside delta sync (4-wide fetches, restores 5-minute pipeline freshness, stuck pipelines age out after 24h)
- freshness on demand: `cache:read` takes a max-age gate, and `rt daemon status` gains `--fresh`/`--max-age` plus events freshness reporting
- discussions lifted into `~/.rt/discussions.json` with grant-aware reads; bot-authored notes are skipped
- MR actions write back: mutations refresh the stores they changed, and a failed read-back can no longer report a succeeded mutation as failed
- notification correctness: `mr_ready` keys on mergeability, `mr_approved` requires a new approver, conflict flaps stopped
- `mr:by-branch` batch read (store-first with forge write-back)
- `secrets:forge-token`, a grant-gated forge-token verb
- cron trigger layer: broadcast pattern to debounced command
- `rt daemon status` stops calling a live daemon dead

### rt-client

- published as `@mattstack/rt-client`: typed commands, unix-socket transport, relay, repo-name resolution, and a fake-daemon subpath export for tests
- daemon handlers for the client catalog carry the catalog's own types

### StrongDM

- agent JSON envelopes for `connect`, `status`, and `connections`, with a production guard and non-interactive reason/duration defaults
- desktop-app preflight: launches SDM.app when the CLI probe errors
- `rt sdm connections` listing, and the rt-sdm-connect agent orchestration skill

### Navigation

- image previews in the fzf preview pane, with iTerm2 routing and character-art fallback when kitten cannot render
- live listing refresh while the picker is open, via the nav-watch fs-event bridge
- sort menu on ctrl-s, list wraparound at both ends, and cursor retention after opening a file
- fzf `--expect` keys are honored on exit 1, so ctrl-up no longer acts as a cancel; the run repo picker treats ctrl-up as back

### Notifications and tray

- notification sounds coalesce, so a burst plays one tone
- notifier fallback dispatch is an async spawn with kill escalation

### Fixes and internals

- dev-mode wrapper replaces `--tsconfig-override` with a cwd pivot (bun#22023)
- glance renamed to `@mattstack/glance` and bumped through 0.18, following its rebase contract
- tests isolate HOME via a bunfig preload, and log writers resolve `~/.rt/logs` at call time, so test runs stop polluting real logs
- README refreshed for the public profile

**Full Changelog**: https://github.com/m4ttstack/rt/compare/v2.5.0...v2.6.0
