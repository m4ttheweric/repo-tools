# 2026-07-01 refactor herd — what shipped

Four Claude Code agents ran in parallel (via shepherdr/herdr, each in its own git worktree) alongside an independently-running Tier 2 e2e test agent. All five branches merged into `main` the same day with zero file-level conflicts. Final `main` state: `bunx tsc --noEmit` clean, `bun test lib commands` 557/0, `bun run test:e2e` 29/29, `swift build` (rt-tray) green.

Commits, in merge order:

```
380478d refactor: split status.tsx into commands/status/ modules
75fc453 refactor: finish daemon.ts decomposition, remove dead runner machinery
a5a5d0b fix: rt-tray quality pass -- stop daemon, crash fixes, panel decomposition
a350938 fix: codebase-wide bug sweep across cli.ts, lib/, commands/
583a255 fix: resolve remaining strict-mode tsc errors in lib/daemon
55da9a8 Merge branch 'feat/e2e-tier2' (independent agent, not part of the herd)
```

Full per-agent reports are archived at `~/.shepherdr/reports/repo-tools-2026-07-01/`.

---

## 1. `commands/status.tsx` split

The 2,510-line status dashboard became a nine-file `commands/status/` module (largest file 549 lines):

| File | Contents |
|---|---|
| `types.ts` | `CacheEntry`, `StatusData`, `ActionState`, `SortMode`/`SORT_CYCLE`, `JobTraceState` |
| `data.ts` | `fetchStatusData` |
| `format.ts` | status/review color+label maps, `pipelineIcon`, `jobStatusIcon`, `formatDuration`, `cleanTraceLine`, `extractHunk` |
| `markdown.tsx` | comment-body markdown renderer + syntax highlighting |
| `mr-views.tsx` | `MRRowTUI`, `MRDetailView`, pipeline/diff/reviewer/blocker sections, action bar |
| `reviews.tsx` | `ReviewsView`, `CommentView`, `DiscussionsState`, `buildAllCommenterSummaries`, `groupThreadsByFile` |
| `pipeline.tsx` | `PipelineDetailView`, `JobLogView` |
| `use-dashboard-input.ts` | the entire `useInput` handler, moved behind a context object |
| `dashboard.tsx` | `LiveDashboard` state/effects/render, `DEFAULT_BRANCHES` |
| `index.tsx` | `showStatus` entry point + re-exports of the old public surface |

- Deduped `truncate`/`rpad`/`lpad`/`timeAgo` against the byte-identical copies already in `lib/tui/utils/label.ts`.
- Moved `useTerminalWidth` into `lib/tui/hooks/use-terminal-width.ts`.
- `useSpinnerFrame` in `lib/tui` was upgraded to status.tsx's shared-ticker implementation (the shared ticker exists specifically to prevent a documented OOM) instead of the per-component version regressing that fix.
- **Module registry footgun handled**: `cli.ts` and `lib/module-registry.ts` both updated for the new `./commands/status/index.tsx` path, verified by compiling the binary and running `rt status` against a live daemon.
- Known caveat: the shared spinner's 9th frame differs by one character (`⠣` vs. status.tsx's original `⠇`) — cosmetic, one-line fix in `lib/tui/theme.ts` if wanted.

## 2. `lib/daemon.ts` decomposition + runner removal

`lib/daemon.ts` dropped from **1,402 → 335 lines**, now a thin orchestration layer. New modules in `lib/daemon/`: `api-server.ts`, `boot-reconcile.ts`, `branch-cache.ts`, `cache-refresh.ts`, `command-router.ts`, `endpoint-wiring.ts`, `hooks-guard.ts`, `lane-config.ts`, `pollers.ts`, `remedy-banners.ts`, `remedy-config.ts`, `remedy-wiring.ts`, `repo-index.ts`, `shutdown.ts`, `socket-server.ts`, `user-path.ts`, plus `lib/daemon/herdr/attach-bridge.ts`.

**Dead runner machinery removed**: `lib/runner-store.ts`, `lib/runner-store/compact.ts`, and three test files deleted (the agent found two extra dead test files beyond what it was told to remove). Still-live exports (`LaneConfig`, `Remedy`, `GlobalRemedy`, `proxyWindowName`) relocated into `lib/daemon/lane-config.ts`; load-path tests ported to `lib/daemon/__tests__/lane-config.test.ts`. Nothing writes `~/.rt/runners/*.json` anymore; the daemon's startup port-prune still reads it (see open item below).

**Bug fixes made along the way:**
- `process-manager.ts` `kill()`/`spawn()`: macOS returns `EPERM` for a process-group whose only member is a zombie, which made `kill()` reject mid-"stopping" — root cause of the flaky "log buffer is cleared on respawn" test. Now falls back to signalling the child directly; verified stable over 10 consecutive runs.
- Daemon shutdown IPC handler ran `cleanup()` (which force-closes all connections) before returning its `{ok:true}` reply, racing the reply against the connection reset. Cleanup now deferred; logger now flushes on this path too (previously only signal-driven exits flushed).
- `endpoints:bounce-enable` didn't guard `bounceManager.start`, so a taken port surfaced as an opaque 500 instead of `{ok:false, error}` like the forward-map path.
- `tunnel-manager.ts` hand-built hostname strings instead of using the canonical `hostnameFor` helper from `tunnel-config.ts` (drift risk with the ingress YAML).
- Two hand-rolled `git worktree list --porcelain` parsers replaced with the canonical `listWorktrees()` — also stops enriching/listing worktrees whose directories were deleted externally.
- A per-branch dynamic `import("./linear.ts")` inside the discovery loop hoisted to once per refresh.
- `API_INDEX` was missing the existing `POST /api/terminals` route.
- Dead code removed: unused `bounceEndpointId` import, unused `broadcast` export.

**Open item flagged, not fixed:** the startup port-prune (`lib/daemon.ts` / `lane-config.ts: collectRunnerPortLabels`) is now keyed entirely on dead runner data, so every daemon restart prunes all live-ish port allocations, including ones from `process:create`. Mild consequences today; needs a decision (delete the block, or re-key it on labels the daemon can still own).

## 3. `rt-tray` quality pass

Verified with `swift build`. Real bug fixes:

1. **"Stop Daemon" didn't stop the daemon** — sent an HTTP shutdown, but the launchd plist has `KeepAlive=true`, so it silently restarted ~10s later. Now unregisters via `daemonLifecycle.stopDaemon()`.
2. Double-resumed continuation in the logdy port availability check (two unsynchronized queues could both resume) — a runtime crash risk. Now serialized through a guard queue; also removed a force-unwrap on `NWEndpoint.Port(rawValue:)`.
3. `refreshStatus` made `@MainActor` — was reading/writing `isRefreshing`/`currentHealth` off-main from overlapping timer-fired tasks.
4. `setupMenuBar`'s early guard could leave `statusMenu` nil, crashing `updateMenuItems` later — menu setup is now unconditional.
5. `HerdrBridge.isAvailable`'s 30s cache read from main thread and detached tasks with no synchronization — now guarded by `NSLock`.
6. Kill-tree menu item label said "childCount + 1" (direct children) while the action kills all descendants — now matches `allPids.count`.
7. "Kill All" button used a positional index `tag` into `groupItems`, which can be rebuilt between cell creation and click, misrouting the kill — now stores the group name and looks it up at click time.
8. Three `Dictionary(uniqueKeysWithValues:)` calls keyed by pid/name would crash the app on a duplicate — switched to `uniquingKeysWith:`.
9. `ProcessPanelController.startPolling` now invalidates any existing timer first (repeated `onAppear` could leak a second poll timer).
10. `FileHandle(forWritingAtPath: "/dev/null")` returns an optional; a nil silently reintroduced the EPIPE problem the adjacent comment warns about — replaced with `FileHandle.nullDevice`.
11. `ColumnSettings.save` now creates `~/.rt/` if missing and logs write failures instead of silently swallowing them.
12. `TrayServer`'s listener state-handler closure captured `self` strongly (retain cycle via listener → closure → self) — now captures only `socketPath`.

Dead code removed: `lastDaemonStatus` (write-only), an unused `button` binding, `DaemonClient.sendShutdown`/`sendCommand`/`SimpleResponse` and the dead shutdown/POST branches in `queryHTTP`, `DoubleClickOverlay` + its View extension, unused `ProcessOutlineNSView.coordinator`.

**Decomposition:** `ProcessPanelView.swift` (1,135 lines) → `ProcessPanelController.swift` (161, the `ObservableObject` controller), `ProcessOutlineView.swift` (731, the AppKit outline table + wrappers), `ProcessPanelView.swift` (229, SwiftUI panel + chip/button views).

**Deliberately not fixed** (reported instead): `kill(-pid)` process-group semantics for non-group-leader pids; a PID-reuse hazard in the 5s SIGTERM→SIGKILL escalation; an intentional ~1s main-thread block in `/login-item/reset`; `UpdateChecker` shelling out to `rt --version` on the main thread at launch; Swift 6 sendability warnings in `DaemonClient.querySocket` (accesses are actually serialized, so these are future-strictness warnings, not live races); `ProcessColumn` using its display title as both `rawValue` and a persistence key (a rename would silently invalidate saved config); `handleUpdateAvailable` duplicating `NotificationManager.fire` logic; the `NSSound(contentsOf:)` + `content.sound = nil` pattern (intentional — `UNNotificationSound(named:)` silently ignores sound files in `Contents/Resources/` on macOS).

## 4. Codebase-wide bug sweep

~74 fixes across 40 files in `cli.ts`, `lib/`, `commands/` (everything outside the other three agents' scopes). Highlights:

- **`rt commit`** silently dropped and unstaged the first selected file on every run — `.trim()` was eating fzf's empty expect-key line.
- **`rt git reset soft`** was a no-op.
- **`rt port`** killed connected clients (e.g. open browser tabs) instead of just the listening process.
- **`rt mr ship`** could create an MR after a cancelled push.
- **`rt sync`** reported failed pushes as synced.
- **`commitsAhead`** counted upstream commits too, via a three-dot `rev-list` instead of two-dot.
- An Esc-crash cluster in `pickers.ts` traced to a null-hiding-as-string cast.
- `rt run` queue bugs: a discarded queue, launching in the wrong worktree, a missing `SIGINT` handler.
- Enrich cache clobbering + a dropped `repoName`.
- Branch names were shell-interpolated in several places (`git-ops`, `git-backup`, `notifier`, `herdr-launch`, various commands) — replaced with argv arrays to remove the injection risk.
- A never-settling Ink prompt on Ctrl-C.
- Three dead `lib` modules and five dead functions deleted (including `lib/components.tsx`, `lib/filterable-multi-select.tsx`, `lib/tsconfig.ts`).
- `extensions/` excluded from the root `tsconfig.json`.
- Fixed the 8 pre-existing `lib/__tests__/llm.test.ts` failures (config path was captured at import time, breaking under the sandbox's `/tmp` restrictions).

**Reported, not touched** (owned by other in-flight agents at the time): `lib/daemon/` `typeof Terminal` tsc errors and four strictness-errored test files (fixed separately, see below); `workspace-sync` returning file paths in `results[].path`; an unlocked concurrent read-modify-write of `branch-cache.json` between daemon and CLI; `status.tsx` silently hiding MR actions when `repoName` is missing.

**Deliberately skipped, needs a product decision:** `rt run` queue trap in single-package repos; last-run sentinel dropping variation flags; `branch-clean`'s silent `-d`→`-D` escalation; cross-branch backup restore doing a hard reset; rebase `ours`/`theirs` semantics inverted vs. `sync-config` docs; patch-id dropping merge/empty commits in reset-to-origin; `spawnCacheRefresh` broken in the compiled binary; `notifier` state `.fired` never pruned; nine remaining import-time-`HOME` constants; a shared `/g` regex; a `ScrollableList` updater side effect; `run-presets` preset names containing `/` silently fail to save; stray `pico.save` file at the repo root (editor artifact, safe to delete).

## 5. Post-merge tsc cleanup

After merging the four branches, 27 tsc error lines remained in `lib/daemon/` (owned by the daemon-split agent's scope but not caused by it — pre-existing strict-mode drift). Fixed directly on `main`:

- `ReturnType<typeof Bun.Terminal>` → `InstanceType<typeof Bun.Terminal>` (it's a class, not a factory function) in `attach-server.ts` and `process-manager.ts`.
- Non-null assertions on four `lib/daemon/__tests__/*.ts` files doing `handlers["some:key"](...)` where the handler map's value type is optional.
- Missing `ppid` field in the `system-processes-handlers.test.ts` fixture builder.

Result: `bunx tsc --noEmit` fully green for the first time this session.

## 6. Tier 2 e2e suite (independent agent, merged same day)

Not part of the herd, but merged into `main` right after it (`55da9a8`). 15 new interactive picker tests via Termwright PTY automation, on top of the existing 14 Tier 1 tests (29 total):

- `e2e/interactive.ts` (261 lines) — Termwright socket wrapper, `startInteractive()` factory.
- `e2e/fixtures.ts` (154 lines) — git repo/monorepo builders, repo index seeding, worktree helper.
- 4 new test files (472 lines, 15 tests): `picker-basics` (5), `picker-navigation` (4), `picker-separators` (3), `picker-identity` (3).
- CI: Termwright install + cargo cache added to `e2e.yml`.
- `RT_FZF_ALT_SCREEN` env var added (3 lines across 2 files) so fzf uses the alternate screen buffer, which Termwright's VT100 parser can read (its inline `--height=~100%` mode isn't visible to the parser).

**Footgun discovered during merge verification, not by the agent:** `e2e/setup.ts` only rebuilds `dist/rt` if the file doesn't exist — after any source change, a stale cached binary makes e2e silently test old code. Symptom: all 15 Tier 2 tests time out waiting for `filter:` to appear. Always `rm dist/rt` before trusting an e2e run after a merge; this is now noted in the `rt-verification-baseline` memory.

---

## Net effect

- `commands/status.tsx`: 2,510 → largest file 549 (9 files)
- `lib/daemon.ts`: 1,402 → 335 lines (15 new `lib/daemon/` modules)
- `rt-tray/Sources/ProcessPanelView.swift`: 1,135 → 3 files, largest 731
- Runner TUI's storage layer (`lib/runner-store.ts` + `lib/runner-store/`) fully removed
- ~90 real bugs fixed across TypeScript and Swift, several were live crash or data-loss bugs (`rt commit` file-drop, tray app crashes, daemon shutdown race)
- Test baseline: `bunx tsc --noEmit` 0 errors (was ~82 error lines), `bun test lib commands` 557/0 (was 567/8), e2e 29/29, `swift build` green
