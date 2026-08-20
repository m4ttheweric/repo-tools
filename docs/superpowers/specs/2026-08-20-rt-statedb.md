# RT-48: state.db — one SQLite state store for rt

**Ticket:** RT-48. **Date:** 2026-08-20, rev 3 (addresses reviews r1 + r2). **Recon basis:** scratchpad/state-cache-shapes.md. **Audit gate evidence:** scratchpad/audit-dead-commands.md.

## Problem

Six JSON state files under `~/.mattstack/rt/` are each a full-file `writeFileSync` on every update, none atomic, none locked, three of them megabyte-class:

| file | size | write cadence | writers |
|---|---|---|---|
| branch-cache.json | 1.7MB | 5-min cycle × N repos + every `rt run` picker | **daemon AND CLI** (race) |
| discussions.json | 1.7MB | synchronous, EVERY single write, no debounce | daemon |
| project-mrs.json | 549KB | 500ms debounce; poll + ~15s deltas + upserts | daemon |
| notifier-state.json | 222KB | once per 5-min cycle | daemon |
| events-cursors.json | 391B | ~15s per watched repo | daemon |
| notify-queue.json | 2B steady | per enqueue/drain | daemon |

Three defects this migration must FIX, not merely relocate: (1) the branch-cache cross-process race (daemon 5-min cycle vs CLI `rt run` enrichment, both full-file read-modify-write, no lock, no temp+rename); (2) the duplicated branch-cache implementation (`lib/daemon/branch-cache.ts` vs `lib/enrich.ts:85-95`, two separately-declared copies of the same shape); (3) unbounded growth (branch-cache has no prune at all; discussions rewrites its whole 1.7MB map per touched MR).

**Audit gate (RT-48 requirement), executed 2026-08-20 — per-store evidence:** branch-cache: fed by the 5-min daemon cycle and read by `rt run`'s picker (748 run hits in-window) plus board/gitq dependencies; project-mrs + discussions: served to mr-board/gitq via rt-client (`project-mrs:read`/`discussions:read`/`mr:by-branch` — live external consumers); notifier-state + notify-queue: back the tray notifications actively delivered (tray alive, drains the queue over IPC); events-cursors: consumed by the daemon's events watchers feeding freshness (daemon `track` machinery, 1287 hits). None qualifies as dead; all six migrate. (The audit's dead files — `llm.json`, `branch-naming.json`, `agent-tasks/` — are not among these stores and are RT-50's problem.)

## Decision (Matt, 2026-08-20 — suite-wide ruling)

One SQLite state database per app. Settings live in the RT-47 stores; state and caches live in `state.db`. This is the standard for every mattstack app; rt implements first. No new per-feature JSON state files anywhere in the suite from now on.

## Design

### The database

- Path: `~/.mattstack/rt/state.db` (`rtDir()`-derived, alongside events.db).
- `bun:sqlite`. Pragmas on every open, in this order: `busy_timeout` FIRST (so the WAL conversion itself respects it), then `journal_mode = WAL`, `synchronous = NORMAL`. **Per-process busy_timeout:** CLI = 5000ms (a CLI command may wait); daemon = 250ms (the daemon loop must never block long — on SQLITE_BUSY the daemon write logs a warn and defers to the next cycle). **One exception to warn-and-defer: `notify_queue` writes.** With the in-memory array retired, a dropped INSERT loses the notification permanently (the fallback timer would find nothing and `fired` is already set) — queue INSERT/DELETE statements retry with short backoff (bounded, ~3 attempts) and log an error if still failing; cache writes stay defer-and-move-on.
- **One connection per process, held for the process lifetime** (daemon: opened during startup BEFORE serving, closed at shutdown, mirroring events.db in `lib/daemon/events-bus.ts:75,213-217`; CLI: lazy singleton).
- **No module-load db access, ever.** `getStateDb()` must never be called at module scope — today `notifier.ts:203` runs `loadQueue()` at module load, and that module is reachable from EVERY CLI invocation (`cli.ts:17` → `command-tree.ts:30` → `module-registry.ts:21` → `commands/settings.ts:27`); carried over naively it would create `~/.mattstack/rt/` before `migrateLegacyRtDir()` runs (`cli.ts:43`, `daemon.ts:61`), wedging the RT-46 legacy migration into its conflict branch and making every rt command a migrator. `loadQueue()` is DELETED along with the in-memory array (store-by-store item 4) — nothing replaces it; the table is read on demand. Rule for all stores: initialize on first use; a CLI command that never touches state never opens, creates, or migrates the db (locked by a test).
- **Transaction rule (bun:sqlite reality):** `db.transaction()` callbacks are synchronous — it commits when the callback returns, so wrapping an async function is forbidden; all transactional store code is sync.
- New module **`lib/state/db.ts`**: `getStateDb()` (lazy open + migrate), `openStateDb(path)` (explicit-path seam for tests/stores), `closeStateDb()`, migration runner. **Migration failure policy:** a throwing migration rolls back its IMMEDIATE transaction (db left at the prior version, no partial state) and the error propagates loudly — daemon startup fails visibly, a CLI command errors; no swallow. **Corruption escape (distinct from a failing migration):** if the db file itself cannot be OPENED (SQLITE_CORRUPT/NOTADB), quarantine it — rename to `state.db.corrupt-<date>` — recreate empty, and warn loudly; this preserves today's cold-start-on-corrupt philosophy instead of bricking the daemon on a damaged file.

### Schema versioning (new precedent — events.db has none)

`PRAGMA user_version` holds the schema version; migrations are an ordered in-code list. **The runner is race-proof by construction:** `BEGIN IMMEDIATE` (taking the write lock up front), then RE-READ `user_version` inside the transaction, and only apply migrations still needed; all DDL uses `IF NOT EXISTS`. Two processes racing at v0: the loser blocks on IMMEDIATE (busy_timeout), then sees v1 inside its own transaction and applies nothing. (Review r1 finding 5: the naive "check then migrate" double-runs; this is the fix.)

### Tables (v1)

```sql
CREATE TABLE IF NOT EXISTS branch_cache (
  branch     TEXT PRIMARY KEY,           -- BARE branch name: the cache's semantic key TODAY, kept
  repo       TEXT,                       -- attribute, nullable (CacheEntry.repoName?, optional today)
  ticket     TEXT,                       -- JSON (LinearTicket | null)
  linear_id  TEXT NOT NULL DEFAULT '',
  mr         TEXT,                       -- JSON (MRInfo | null)
  fetched_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS project_mrs (
  repo       TEXT NOT NULL,
  iid        INTEGER NOT NULL,
  pr         TEXT NOT NULL,              -- JSON (glance PullRequest)
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (repo, iid)
);
CREATE TABLE IF NOT EXISTS project_mrs_meta (
  repo            TEXT PRIMARY KEY,
  list_synced_at  INTEGER NOT NULL DEFAULT 0,
  delta_synced_at INTEGER,
  source          TEXT NOT NULL DEFAULT 'poll',
  project_path    TEXT NOT NULL DEFAULT '',
  scope           TEXT                   -- JSON ({authors, windowDays} | null)
);
CREATE TABLE IF NOT EXISTS project_mr_demands (
  repo         TEXT NOT NULL,
  client       TEXT NOT NULL,
  authors      TEXT NOT NULL,            -- JSON string[]
  declared_at  INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (repo, client)
);

CREATE TABLE IF NOT EXISTS discussions (
  repo        TEXT NOT NULL,
  iid         INTEGER NOT NULL,
  discussions TEXT NOT NULL,             -- JSON (Discussion[])
  fetched_at  INTEGER NOT NULL,
  PRIMARY KEY (repo, iid)
);

CREATE TABLE IF NOT EXISTS notify_queue (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,  -- FIFO order
  event_id TEXT NOT NULL,                      -- NotificationEvent.id — pushToTray removes by this (notifier.ts:243-246)
  event    TEXT NOT NULL                       -- JSON (NotificationEvent)
);
CREATE INDEX IF NOT EXISTS idx_notify_queue_event_id ON notify_queue(event_id);

CREATE TABLE IF NOT EXISTS kv (
  ns         TEXT NOT NULL,
  k          TEXT NOT NULL,
  v          TEXT NOT NULL,              -- JSON
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (ns, k)
);
```

**branch_cache keeps the bare-branch primary key** (review r1 findings 3+4): the bare branch IS the cache's semantic key today (`DiskCache.entries: Record<branch, CacheEntry>`); `enrichBranches`' `fetchAndCache` path has no repoName, and a `(repo, branch)` PK would mint permanent duplicate rows plus an undefined collapse tie-break that flaps `checkAndNotify`. The cross-repo branch-name collision is today's documented quirk, carried forward unchanged; `repo` stays what it is today — an optional attribute (used by `worktree:list`'s guard exactly as before).

`kv` holds whole-blob states where per-key granularity buys nothing: notifier state (`ns='notifier', k='state'`, read+written once per cycle as a unit) and event cursors (`ns='events-cursor', k=<repoName>`). Payload shapes stay opaque JSON — this ticket changes persistence, never payload schemas.

### In-memory ownership (explicit — review r1 finding 2)

**The daemon's read model is unchanged: the in-memory map.** `ctx.cache.entries` remains a live in-memory object owned by the daemon; `cache:read` (and its `maxAgeMs` gate) serves that map exactly as today. The db is the durability layer under it. CLI writes become visible to the daemon exactly where file re-reads happen today: the post-enrich reload (`cache-refresh.ts:133`) and `branch:enrich`'s `ctx.loadCache()` become "rebuild map from db" (one SELECT). No handler is rewritten as a live query.

### Store-by-store (constructor seams change; IPC surface does not)

**Honest API statement (review r1 finding 8):** daemon IPC handlers (`cache:read`, `project-mrs:read`, `mr:by-branch`, `discussions:read`, `notifications`, `notifications:peek`), rt-client, mr-board, gitq, tray: unchanged. Store **factory signatures DO change**: `createProjectMRs`, `createDiscussionsFileStore`, `createCursorStore` take a db handle (default `getStateDb()`) instead of a filePath, and their `flushNow`/`flushSoon`/debounce knobs disappear; every construction site (including `commands/daemon.ts:364`, which is a CLI-side construction) and their ~40 existing tests are updated to the seam (`openStateDb(tempPath)`). "Existing tests keep passing" means semantics-level: each store's behavioral assertions survive with the constructor swapped.

1. **branch-cache → one module, one owner, write-through.** New `lib/state/branch-cache.ts` owns the single `CacheEntry` type, **the in-memory map itself**, and row IO; `lib/enrich.ts`'s duplicate types + `readDiskCache`/`writeDiskCache` are DELETED. Ownership is singular (review r2 finding 4): the store object is a process-wide singleton; the daemon's `ctx.cache` becomes a reference to it (handlers keep reading `ctx.cache.entries`, same object), and `enrich.ts` — which runs inside the daemon on some paths — uses the same singleton, so two maps can never diverge in one process. Row↔entry mapping: `repo` NULL ↔ `repoName` undefined; `ticket`/`mr` NULL ↔ null. **Write-through lands at the true mutation site**: `updateEntry` (`freshness.ts:556`) — the `:539,630` batch tails only carry a boolean and stop existing along with `flushCache()`. The `flushCache` interface removal set is named: `handlers/types.ts:65` (HandlerContext field), `shutdown.ts:20,25`, `daemon.ts:95,151,222`, and the 5 test fakes that stub it. CLI-process `enrich.ts` paths upsert only the rows they enriched, in a transaction.
2. **project-mrs.** In-memory map + interface preserved; `flushSoon` gone — `upsert`/`applyDelta` write touched rows immediately in a transaction; `fullSync`'s `fetchedAt`-ordered reconcile (`project-mrs-store.ts:104-148`) becomes ONE transaction per repo, preserving its race-safety as an explicit transaction boundary.
3. **discussions.** `write()`/`remove()` become single-row upsert/delete. The union-membership prune keeps its algorithm and its `failedRepos` exemption; note (review r1 finding 12): branch-cache GC (below) shrinks one leg of the union, so discussions for >30-day-stale branches WITHOUT an open MR now get pruned — that is intended cleanup, stated here as a semantic change, not parity. `seedDiscussionsFromBranchCache` dies with the legacy fields.
4. **notifier.** State snapshot: `kv` blob, one read + one write per cycle as today. Queue: **the `notify_queue` table IS the queue — the in-memory `notificationQueue` array (`notifier.ts:179`) is retired.** All THREE mutation sites go through the table: enqueue INSERT; tray drain = one transaction SELECT-all + DELETE-all (peek reads without deleting, as today); and both remove-by-id paths — `pushToTray` success (`notifier.ts:243-246`) AND the 10s tray-fallback timer's find-and-remove (`notifier.ts:369-377`) — become DELETE by `event_id`. **`fired`-ledger hygiene (review r1 finding 11):** at the cycle tail, `fired` keys belonging to branches with no branch-cache entry are dropped — membership computed via the same key-construction helper the notifier uses to CREATE fired keys (one shared helper, no parsing of key formats) — so evicted branches cannot leak keys or suppress a future real notification if the branch returns.
5. **events-cursors.** `createCursorStore` keeps `get`/`set` over `kv` rows; missing row = cold-start that repo's watcher (today's corruption philosophy).

### New: branch-cache GC (defect 3a — with the failure exemption, review r1 finding 10)

Gating is on SUCCESS, not on `failedRepos` (review r2 finding 1: `refreshAllMRs` swallows fetch errors into `onError` and never throws, so a token-expired repo never lands in `failedRepos` while its `fetchedAt` stays frozen — the exemption must not depend on error propagation that doesn't happen). Rule: GC prunes a repo's rows **only in a cycle where that repo's refresh completed with zero `onError` invocations** — cache-refresh already owns the loop and the `onError` callback (`cache-refresh.ts:64`), so it records per-repo success and hands the succeeded-repo set to the GC; a clean cycle refreshes the repo's live branches (bumping `fetched_at` for everything the refresh touched — noting some paths legitimately skip the bump, e.g. no-token/non-GitLab branches, which then age out and re-enrich on demand: acceptable for a cache), making age-pruning within a succeeded repo safe. Rows with NULL `repo` are prunable by age alone (unattributable; they re-enrich on demand — accepted). **Placement (review r2 finding 8):** GC runs through the branch-cache STORE (rows + in-memory map together), and runs BEFORE the discussions prune computes its union membership, so both prunes see the same world in the same cycle. Evicted branches' notifier snapshots rebuild-from-current next cycle (harmless) and their `fired` keys are dropped by the ledger hygiene above. 30 days is a constant, not a setting.

### Migration & contention (review r1 findings 5, 6, 7)

- **One-shot import** runs inside the same `BEGIN IMMEDIATE` migration transaction (v0→v1): import each legacy JSON file that exists and parses (corrupt = warn + skip); branch-cache entries import keyed by branch with `repo = entry.repoName ?? NULL`, legacy dead fields dropped. After COMMIT, rename sources to `<name>.json.migrated` (kept one release; RT-50 deletes).
- **Daemon-thread stall honesty:** `busy_timeout` is a blocking wait. Steady-state CLI transactions are single-digit-ms row upserts, so worst-case daemon blocking is ms, not 5s. The one long transaction is the import (~3.4MB of JSON), so: the daemon performs open+migrate during startup, BEFORE serving (mirroring events.db's construction timing), never mid-serve; and if a CLI process is mid-import when the daemon starts, the daemon blocks in startup, not in its event loop. No sync subprocess calls anywhere near this code.
- **Upgrade ordering (old daemon + new CLI):** rollout is daemon-first — deploy, restart daemon (it migrates at startup), then CLI use follows; this is the same runbook RT-47 used. If a new CLI migrates first anyway, a still-running old daemon will recreate and write orphan JSON files until its restart; those writes are cache-only and self-heal within one 5-min cycle after restart (worst case: a few enrichments re-fetched). Accepted and documented; stray recreated `.json` files are swept by RT-50. The migration itself cannot double-run (IMMEDIATE + re-read + IF NOT EXISTS).

### No-daemon fallback

`rt status`'s fallback (`commands/status/data.ts:46-53`) reads state.db via the shared `lib/state/branch-cache.ts` reader. Missing db = empty result, like today's missing file. "Status works daemonless" preserved.

### events.db: stays separate (spec decision)

Different lifecycle (append-only journal, hourly sweep, RT-44 waiter machinery), no cross-store transaction need, merging is churn. state.db copies its patterns and improves them (busy_timeout, user_version, IMMEDIATE migrations). Not revisited unless a cross-db transaction need appears.

## Non-goals

- No daemon IPC changes; no rt-client/mr-board/gitq/tray changes.
- No payload shape redesign; no new settings keys.
- No board/deck/gitq adoption here — suite ruling recorded; each app adopts in its own ticket.
- events.db untouched; repos.json (RT-49) and intercepts.json (RT-47) stay files by design; pid/sock/daemon.json/logs stay files.

## Tests

(HOME isolation per convention; stores constructed via `openStateDb(tempPath)` seam.)

1. db.ts: fresh open → v1 schema; reopen no-op; **two connections racing v0 → exactly one imports, neither throws, both land at v1** (the finding-5 regression test).
2. Import: pre-seeded legacy JSON → correct rows (branch key preserved bare, `repo` NULL when absent), sources renamed `.json.migrated`; corrupt file → warn + empty + renamed.
3. Cross-process branch-cache: two handles, interleaved upserts to different branches → both survive; same branch → last-writer-wins per row.
4. Write-through: mutations at `updateEntry` (`freshness.ts:556`) persist (kill the in-memory map, rebuild from db, entries present) — no `flushCache` equivalent exists to call anywhere (the interface removal set in store item 1).
5. Bare-branch semantics: `enrichBranches`-style upsert with no repoName updates the SAME row a daemon write created (no `''`/NULL duplicate) — the finding-3 regression test.
6. project-mrs: existing behavioral suite green through the seam; upsert with `fetchedAt` newer than `syncStartedAt` survives a concurrent `fullSync` prune (transaction boundary).
7. discussions: single-row write touches one row; prune parity for live branches; the intended-change case (stale branch, no MR → discussion pruned after GC) asserted as intended.
8. GC: >30d rows deleted only for repos whose refresh had zero `onError` calls that cycle; a repo with a swallowed fetch error (onError fired, nothing thrown) keeps ALL rows — the r2-finding-1 regression test; NULL-repo rows deleted by age; evicted branch's `fired` keys dropped (returning branch re-notifies); GC runs before the discussions prune and both see the same membership.
9. notify_queue: enqueue → new handle (daemon restart) → drain returns once; peek does not delete; remove-by-`event_id` (both the pushToTray-success and fallback-timer paths) removes exactly that event.
10. status fallback: daemon absent, db present → served; db absent → empty, no crash.
11. No-db-on-stateless-CLI: a command that touches no state, run against a fresh HOME, creates NO state.db and runs no migration (locks the no-module-load rule).
12. Contention: a daemon-flavored connection (250ms busy_timeout) hitting a held write lock logs a warn and defers — no throw, no block beyond the timeout.
13. kv round-trip: events-cursors get/set per repo; notifier state blob read-modify-write across two cycles; missing kv row = cold-start behavior.
