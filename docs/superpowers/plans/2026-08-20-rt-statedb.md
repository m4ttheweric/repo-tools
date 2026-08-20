# RT-48 state.db Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace rt's six JSON state files with one WAL-mode SQLite database, fixing the branch-cache cross-process race, the duplicated implementation, and unbounded growth.

**Architecture:** New `lib/state/db.ts` (connection + versioned migrations + import) and `lib/state/branch-cache.ts` (single owner of the branch cache); the four other stores keep their public APIs and swap file persistence for tables. Daemon stays the in-memory read model; SQLite is the durability layer.

**Tech stack:** bun:sqlite (WAL), existing bun test conventions (HOME-isolating preload, PATH-fake pattern).

**Spec:** `spec-rt48-statedb.md` (same directory) — THE requirements document, 3 review rounds; every task below cites its sections. Copy it to `docs/superpowers/specs/2026-08-20-rt-statedb.md` in Task 1's first commit. On any conflict between this plan and the spec, the spec wins.

## Global Constraints (from the spec — binding on every task)

- Pragmas in order: `busy_timeout` FIRST (CLI 5000 / daemon 250), then `journal_mode=WAL`, `synchronous=NORMAL`.
- NO module-load db access anywhere; stores initialize on first use; a stateless CLI command must never create/migrate the db.
- `db.transaction()` callbacks are synchronous only — never wrap async.
- Daemon writes: warn-and-defer on BUSY — EXCEPT notify_queue writes, which retry (~3 bounded attempts) then log error.
- branch_cache PRIMARY KEY is the BARE branch (repo is a nullable attribute). Never (repo, branch).
- Migrations: `BEGIN IMMEDIATE`, re-read `user_version` inside the txn, `IF NOT EXISTS` DDL. Open-failure corruption → quarantine `state.db.corrupt-<date>` + recreate + loud warn.
- Payload shapes stay opaque JSON; no daemon IPC changes; no rt-client/board/gitq/tray changes; events.db untouched.
- Commit prefix `RT-48:`; end commit bodies with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: lib/state/db.ts — connection, migrations, import skeleton

**Files:** Create `lib/state/db.ts`, `lib/state/__tests__/db.test.ts`. Copy spec into `docs/superpowers/specs/2026-08-20-rt-statedb.md`.

**Produces (later tasks consume):**
```ts
export type DbFlavor = "cli" | "daemon";
export function openStateDb(path: string, flavor?: DbFlavor): Database; // seam: opens, pragmas, migrates, imports
export function getStateDb(flavor?: DbFlavor): Database;                // lazy singleton at rtDir()/state.db
export function closeStateDb(): void;
export const SCHEMA_VERSION: number; // 1
```
Import hooks: `db.ts` owns the v1 DDL (spec "Tables (v1)" — copy the SQL verbatim) and calls per-store import functions registered in a plain array `LEGACY_IMPORTS: { file: string; import: (db, json) => void }[]` that Tasks 2/4/5/6/7 append to; after COMMIT, rename each imported file to `<name>.json.migrated`. Corrupt JSON: warn + skip + still rename (spec "Migration & contention").

**Steps:**
- [ ] Failing tests: fresh open → v1 schema + `user_version=1`; reopen no-op; two connections racing v0 → exactly one imports, neither throws (spec test 1); corrupt db file → quarantined + recreated (spec "Corruption escape"); pragma values per flavor.
- [ ] Implement per spec "The database" + "Schema versioning".
- [ ] `bun test lib/state` green; `bunx tsc --noEmit` clean; commit.

### Task 2: lib/state/branch-cache.ts — the single-owner store

**Files:** Create `lib/state/branch-cache.ts`, `lib/state/__tests__/branch-cache.test.ts`.

**Produces:**
```ts
export interface CacheEntry { ticket: LinearTicket | null; linearId: string; mr: MRInfo | null; fetchedAt: number; repoName?: string;
  /** @deprecated legacy embedded discussions — readers die in Task 5; fields removed there too */
  discussions?: Discussion[]; discussionsFetchedAt?: number; }
export interface BranchCacheStore {
  entries: Record<string, CacheEntry>;              // the live map — ctx.cache-compatible
  put(branch: string, entry: CacheEntry): void;      // map + row upsert, one call
  delete(branch: string): void;
  reload(): void;                                    // rebuild map from db (replaces loadCache-from-file)
  gc(succeededRepos: Set<string>, maxAgeMs: number): void; // spec "branch-cache GC": rows+map, NULL-repo by age
}
export function getBranchCacheStore(db?: Database): BranchCacheStore;   // process-wide singleton
```
Registers its LEGACY_IMPORT for `branch-cache.json` (key = bare branch, `repo = entry.repoName ?? NULL`, drop legacy `discussions`/`discussionsFetchedAt` fields). Row↔entry: NULL ↔ undefined/null per spec.

**Steps:**
- [ ] Failing tests: spec tests 2 (import incl. renamed file), 3 (two handles, per-row last-writer-wins), 5 (no-repoName upsert hits the same row), GC gating incl. succeeded-repos-only and NULL-repo age rule (spec test 8's store half).
- [ ] Implement; wire the import into Task 1's array.
- [ ] Tests green; tsc clean; commit.

### Task 3: wire branch-cache consumers (daemon + CLI + status fallback)

**Files:** Modify `lib/daemon/branch-cache.ts` (becomes a thin adapter over the store or is deleted into it), `lib/enrich.ts` (DELETE duplicate `CacheEntry`/`DiskCache`/`readDiskCache`/`writeDiskCache`; paths upsert via the store in a transaction), `lib/daemon/freshness.ts` (`updateEntry` at :556 → `store.put`; the :539/:630 flush booleans and calls die), `lib/daemon/handlers/types.ts` (:65 flushCache field removed; `ctx.cache` = the store; **its `CacheEntry` becomes a re-export from `lib/state/branch-cache.ts`** — nine files import the type from here (status TUI, discussions-file-store, poller, handlers) and must keep compiling unchanged), `lib/daemon/shutdown.ts` (:20,:25 flush refs removed), `lib/daemon.ts` (:95,:151,:222 refs), `lib/daemon/cache-refresh.ts` (:133 loadCache → `store.reload()`), `commands/status/data.ts` (fallback reads via the store, readonly), the 5 test fakes stubbing flushCache.

**Steps:**
- [ ] Failing/updated tests: spec tests 4 (write-through at updateEntry), 10 (status fallback with/without db); existing daemon cache tests updated to the store seam and green.
- [ ] Implement; grep-gate: zero `readDiskCache|writeDiskCache|flushCache` references remain.
- [ ] Full `bun test` green; tsc clean; commit.

### Task 4: project-mrs persistence swap

**Files:** Modify `lib/daemon/project-mrs-store.ts` (constructor takes db handle, default `getStateDb("daemon")`; `flushSoon`/debounce deleted; `upsert`/`applyDelta` write touched rows immediately in a txn; `fullSync` = ONE txn per repo preserving the fetchedAt reconcile at :104-148; meta + demands to their tables per spec DDL); its LEGACY_IMPORT for `project-mrs.json`; update `commands/daemon.ts:364` construction; existing ~40 store tests to the `openStateDb(tempPath)` seam.

**Steps:**
- [ ] Existing behavioral suite green through the seam + spec test 6 (upsert newer than syncStartedAt survives concurrent fullSync).
- [ ] tsc clean; commit.

### Task 5: discussions persistence swap

**Files:** Modify `lib/daemon/discussions-file-store.ts` (row upsert/delete; prune keeps algorithm + failedRepos exemption over the `discussions` table; `seedDiscussionsFromBranchCache` DELETED) **and `lib/daemon/discussions-poller.ts` (its caller — remove the `:118` seed call + import, or the build breaks)**; ALSO remove the deprecated `discussions`/`discussionsFetchedAt` fields from `CacheEntry` here (this task kills their last readers, and `discussions-file-store.test.ts`'s seed tests die with the function); LEGACY_IMPORT for `discussions.json` (key split `repo:iid` → columns); tests to seam.

**Steps:**
- [ ] Spec test 7 (single-row write; prune parity; the intended GC-coupled change asserted as intended).
- [ ] Full suite green; tsc clean; commit.

### Task 6: notifier — kv state + queue table

**Files:** Modify `lib/notifier.ts`: state blob via `kv` (`ns='notifier'`); in-memory `notificationQueue` array (:179) + `loadQueue()` (:203, the module-load site) DELETED; three mutation sites → table ops (enqueue INSERT w/ retry-on-busy; drain txn SELECT+DELETE; both remove-by-`event_id` paths :243-246 and :369-377); fired-key hygiene via the shared key-construction helper (extract it if inline today). LEGACY_IMPORTS for `notifier-state.json` (kv blob) and `notify-queue.json` (rows).

**Steps:**
- [ ] Spec tests 9 (restart durability, peek non-destructive, remove-by-id both paths) and the fired-hygiene half of 8; a retry-on-busy unit test.
- [ ] Full suite green; tsc clean; commit.

### Task 7: events-cursors + kv coverage

**Files:** Modify `lib/daemon/freshness.ts` cursor store (`createCursorStore` over `kv` `ns='events-cursor'`); LEGACY_IMPORT for `events-cursors.json`; spec test 13 (kv round-trips, missing-row cold start).

**Steps:** failing tests → implement → suite green → commit.

### Task 8: GC wiring + the no-module-load lock + e2e

**Files:** Modify `lib/daemon/cache-refresh.ts` (record per-repo zero-`onError` success around :64; call `store.gc(succeeded, 30d)` at the tail BEFORE the discussions prune); add spec test 8 (cycle-level: onError repo survives, clean repo prunes, ordering vs discussions prune), test 11 (stateless CLI creates no db — spawn `rt --version`-class command against fresh HOME), test 12 (250ms contention warn-and-defer). Daemon startup: open db before serving (`lib/daemon.ts` startup order).

**Steps:** failing tests → implement → **full `bun test` + e2e suite + `bunx tsc --noEmit` green** → commit.

---

## Final gate (orchestrator)

Whole-branch review (fable), fix wave if needed, then: daemon restart on the branch build, live smoke (`rt status` with daemon down, a real cycle populating state.db, `.json.migrated` files present), merge per finishing-a-development-branch.
