/**
 * lib/daemon/boot-migrate.ts — one-shot daemon-boot identity re-key.
 *
 * Every per-repo store is keyed on the serialized `RepoIdentity`, and each
 * store exports its own re-key function. This module is the single place that
 * calls all of them, once, at daemon startup.
 *
 * ORDERING (bounded, NOT guaranteed): every re-key below resolves a legacy
 * NAME to an identity via `loadRepoIndex()[name]`. The repo index itself is
 * never re-keyed (a disposable name/path cache that self-heals — see
 * lib/repo-index.ts's doc comment — dedup'd only by `rt repos prune`). That
 * prune runs in the CLI process directly against state.db, NOT through the
 * daemon, so it can run before the daemon starts or concurrently with this
 * runner — there is no ordering guarantee against it. The safety net is the
 * verb-layer guard: every repo-keyed handler refuses a non-identity payload,
 * so a not-yet-migrated repo's verbs return empty — never corrupt or misroute.
 * The one bounded cost of losing that race: a store whose legacy name→path row
 * a prune already evicted cannot resolve the name and leaves those rows
 * retained (re-warned each boot) — regenerable caches or an append-only
 * history log, never anything corrupted.
 *
 * Every re-key is independently swallowed (warn, not throw): one store's
 * migration failing must never stop the rest, or stop the daemon from
 * finishing boot.
 */

import type { Logger } from "pino";
import { ensureWorktreeRegistryRekeyed } from "../repo-index.ts";
import { rekeyEventsCursorNamespace } from "../state/cursors-store.ts";
import { rekeyRepoTrackingSettings } from "../repo-tracking.ts";
import { rekeyRunHistoryTable } from "../run-history.ts";
import { rekeyEndpointClaimsTable } from "../endpoint/store.ts";
import { rekeyBranchCacheTable } from "../state/branch-cache.ts";
import {
  rekeyProjectMrsTable,
  rekeyProjectMrsMetaTable,
  rekeyProjectMrDemandsTable,
} from "./project-mrs-store.ts";
import { rekeyDiscussionsTable } from "./discussions-file-store.ts";

/** One named re-key step; run independently so one failure never blocks the rest. */
interface RekeyStep {
  name: string;
  run: () => Promise<{ migrated: string[]; retained: string[] }>;
}

const STEPS: RekeyStep[] = [
  { name: "worktree-registry", run: async () => { await ensureWorktreeRegistryRekeyed(); return { migrated: [], retained: [] }; } },
  { name: "events-cursor", run: rekeyEventsCursorNamespace },
  { name: "rt.repoTracking", run: rekeyRepoTrackingSettings },
  { name: "run_history.repo", run: rekeyRunHistoryTable },
  { name: "endpoint_claims.repo", run: rekeyEndpointClaimsTable },
  { name: "branch_cache.repo", run: rekeyBranchCacheTable },
  { name: "project_mrs.repo", run: rekeyProjectMrsTable },
  { name: "project_mrs_meta.repo", run: rekeyProjectMrsMetaTable },
  { name: "project_mr_demands.repo", run: rekeyProjectMrDemandsTable },
  { name: "discussions.repo", run: rekeyDiscussionsTable },
];

/**
 * Runs every store's re-key exactly once. Each is idempotent by construction
 * (the harness skips any key that already parses as a serialized identity),
 * so calling this more than once — a restart, a second daemon boot against
 * the same state.db — costs only an empty scan per store, never a duplicate
 * migration.
 */
export async function runBootIdentityMigration(log: Logger): Promise<void> {
  for (const step of STEPS) {
    try {
      const report = await step.run();
      if (report.migrated.length > 0) {
        log.info({ store: step.name, migrated: report.migrated.length }, "boot identity migration: re-keyed legacy rows");
      }
      if (report.retained.length > 0) {
        log.warn({ store: step.name, retained: report.retained.length }, "boot identity migration: legacy rows could not be re-keyed");
      }
    } catch (err) {
      log.warn({ err, store: step.name }, "boot identity migration: step failed, leaving legacy rows in place");
    }
  }
}
