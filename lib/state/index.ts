/**
 * lib/state/index.ts — the state.db barrel (RT-48).
 *
 * EVERY consumer outside lib/state/ imports store APIs through THIS module,
 * never from ./db.ts or a store module directly.
 *
 * Why the rule exists: each store module registers its legacy-JSON importer
 * into `LEGACY_IMPORTS` at MODULE IMPORT TIME, and the v0->v1 migration that
 * drains that array is one-shot (see lib/state/db.ts "Schema versioning").
 * A consumer that imported only ./db.ts and opened the database before some
 * store module had been loaded would migrate to v1 with that store's legacy
 * import silently skipped — forever, since the migration never runs again.
 * Importing the barrel loads every store module first, so the array is
 * complete before any `getStateDb()`/`openStateDb()` call can fire.
 *
 * Registration is pure array pushes: importing this barrel opens no
 * database, creates no file, and runs no migration (spec "The database":
 * "No module-load db access, ever"). lib/state/__tests__/barrel.test.ts
 * locks both halves of that contract. project-mrs-store.ts lives outside
 * lib/state/ (Task 4 keeps it in lib/daemon/ by design) but is held to the
 * same discipline: it imports getStateDb/LEGACY_IMPORTS from ./db.ts
 * directly (never from this barrel, which would cycle back into it) and
 * obtains its logger lazily so importing it here creates no log file.
 *
 * Later RT-48 tasks add their store modules to the side-effect import list
 * and re-export block below.
 *
 * kv-blob.ts, endpoint-claims-store.ts, and run-history-store.ts do not
 * register a LEGACY_IMPORTS entry, but NOT because their contents are all
 * regenerable cache data — the worktree registry (a `kv` blob) and
 * run_history both carry durable, non-regenerable state (ephemeral-tree
 * claim/disposal bookkeeping; `rt run again`'s history). The reason is that
 * LEGACY_IMPORTS' one-shot v0->v1 seam (see db.ts) cannot serve a store
 * whose row is created lazily, key by key, long after that migration has
 * already run (a new repo, a new worktree). Those stores instead import
 * their own legacy JSON file on first READ, directly against
 * lib/state/legacy-import.ts — see repo-index.ts, worktree/registry.ts,
 * endpoint/{store,shim}.ts, run-history.ts, sdm/{state,scan}.ts, and
 * daemon/{home-snapshot,worktree-reconciler}.ts.
 */

// Side-effect imports: these load each store module (and therefore register
// its LEGACY_IMPORTS entry) even for consumers that only want types.
import "./branch-cache.ts";
import "../daemon/project-mrs-store.ts";
import "../daemon/discussions-file-store.ts";
import "./notifier-store.ts";
import "./cursors-store.ts";

export {
  SCHEMA_VERSION,
  LEGACY_IMPORTS,
  openStateDb,
  getStateDb,
  stateDbPath,
  closeStateDb,
  type DbFlavor,
  type LegacyImport,
} from "./db.ts";

export {
  getBranchCacheStore,
  type BranchCacheStore,
  type CacheEntry,
} from "./branch-cache.ts";

export { isBusyError, persistOrWarn } from "./busy.ts";

export {
  getNotifierStateBlob,
  setNotifierStateBlob,
  enqueueNotification,
  drainNotificationQueue,
  peekNotificationQueue,
  isNotificationQueued,
  removeQueuedNotification,
  type NotificationEvent,
} from "./notifier-store.ts";

export { createCursorStore, type CursorStore } from "./cursors-store.ts";

export { getKvValue, setKvValue, deleteKvValue, listKvValues, listKvEntries, hasKvValue, type KvEntry } from "./kv-blob.ts";

export {
  listEndpointClaims,
  replaceEndpointClaims,
  hasEndpointClaims,
  type EndpointClaim,
} from "./endpoint-claims-store.ts";

export {
  appendRunHistoryEntry,
  listRunHistory,
  hasRunHistory,
  type RunHistoryEntry,
} from "./run-history-store.ts";

export {
  isValidChatName,
  joinRoom,
  leaveRoom,
  postMessage,
  readUnread,
  listMessages,
  markRead,
  unreadWakingCount,
  listRooms,
  listMembers,
  armMember,
  touchMember,
  disarmMember,
  clearAllArmed,
  type ChatMember,
  type ChatMessage,
  type WakeMode,
  type RoomSummary,
} from "./chat-store.ts";

export {
  importLegacyJsonFile,
  renameLegacyOutOfTheWay,
  type LegacyImportResult,
} from "./legacy-import.ts";
