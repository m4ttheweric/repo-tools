/**
 * The typed command catalog for the rt daemon: one entry per command name,
 * pairing its payload shape with its response data shape. `client.ts` builds
 * its functions against this map so a new command only needs an entry here
 * plus one function, never a change to the transport itself.
 */
import type { PullRequest, MRDetail } from "@mattstack/glance";

export type Discussion = MRDetail["discussions"][number];

/** What a caller declares it needs, so the daemon can size the sync to cover it. */
export interface DemandDecl {
  client: string;
  authors: string[];
  declaredAt: number;
}

export interface ProjectMRsScope {
  authors: string[];
  windowDays: number;
  uncovered: string[];
}

export interface ProjectMRsData {
  mrs: Record<string, { pr: PullRequest; fetchedAt: number }>;
  listSyncedAt: number;
  source: "poll" | "events" | "mutation";
  syncedAt: number;
  scope?: ProjectMRsScope;
}

export interface DiscussionsData {
  discussions: Discussion[];
  fetchedAt: number;
  stale?: boolean;
}

export interface MrByBranchEntry {
  pr: PullRequest;
  source: "store" | "forge";
}

export interface MrByBranchData {
  byBranch: Record<string, MrByBranchEntry | null>;
  syncedAt: number;
}

/** Forges the daemon can hold a token for. */
export type ForgeSlug = "gitlab" | "github";

export interface ForgeTokenData {
  token: string;
}

/**
 * Duplicated shape on purpose (RT-44): rt-client cannot import daemon
 * internals, so this mirrors lib/daemon/events-bus.ts's BusEvent.
 */
export interface EventsBusEvent { id: number; topic: string; payload: unknown; emittedAt: number }

export interface RunSummary {
  id: string; repo: string; work_type: string; pipeline: string;
  status: string; current_stage: string | null; spawned_by: string | null;
  started_at: number; ended_at: number | null;
  // v2. Null on runs written before schema v2; pack_dirty means the pack tree
  // had uncommitted changes, so the as-run text may exist in no commit.
  pack_commits: string | null; pack_dirty: number;
}
export interface RunStageRow {
  name: string; status: string; attempt: number;
  started_at: number | null; ended_at: number | null;
  reason: string | null; detail_path: string | null;
}
export interface RunFieldRow { key: string; value: string; produced_by: string; at: number; }
export interface RunDecisionRow { contract: string; scope: string; selection: string; decided_by: string; decided_at: number; }
export interface RunDetail { run: RunSummary; stages: RunStageRow[]; fields: RunFieldRow[]; decisions: RunDecisionRow[]; schemaAhead: boolean; }

export interface Commands {
  "project-mrs:read": { payload: { repoName: string; maxAgeMs?: number; demand?: DemandDecl }; data: ProjectMRsData };
  "discussions:read": { payload: { repoName: string; iid: number }; data: DiscussionsData };
  "mr:by-branch": { payload: { repoName: string; branches: string[] }; data: MrByBranchData };
  /**
   * The forge token for one tracked repo (MAT-33). Repo-scoped on purpose:
   * rt gates access per repo through repo-tracking.json, and this verb is
   * what lets consumers stop reading ~/.mattstack/rt/secrets.json directly, which
   * walked around that grant model entirely. An untracked repo is refused;
   * the caller's env vars keep precedence on the caller's side.
   */
  "secrets:forge-token": { payload: { repoName: string; forge: ForgeSlug }; data: ForgeTokenData };
  /**
   * A per-`scope` whitelisted subset of secrets, each scope reading its own
   * encrypted domain(s): "extension" (default, so the VS Code extension
   * needs no change) is linearApiKey/gitlabToken from the `rt` domain;
   * "deck" is cfApiToken/cfZoneId from the `deck` domain; "board" is
   * cross-domain — slackToken/slackClientSecret/slackSigningSecret from the
   * `board` domain plus gitlabToken/switchboardToken/switchboardAdminToken
   * from the `rt` domain. `data` is a union of the per-scope shapes, not a
   * merged bag of every key — that makes a caller narrowing on the wrong
   * scope's fields a compile error instead of a silent `undefined`. Every
   * key optional (present only when set). Not a general secrets export —
   * extend a whitelist here, in lockstep with
   * lib/daemon/handlers/secrets.ts and (for "extension")
   * extensions/vscode/rt-context/src/secrets.ts, if a consumer needs another
   * key.
   *
   * `token` is required and checked in the HANDLER (not a transport-layer
   * gate alone), since this verb is reachable over the unauthenticated unix
   * socket too — see lib/daemon/handlers/secrets.ts's doc comment. HTTP
   * callers get it forwarded automatically from their X-RT-Token header;
   * socket callers must read ~/.mattstack/rt/api-token themselves. The gate
   * applies identically to every scope.
   */
  "secrets:read": {
    payload: { token?: string; scope?: "extension" | "deck" | "board" };
    data:
      | { linearApiKey?: string; gitlabToken?: string }
      | { cfApiToken?: string; cfZoneId?: string }
      | {
          slackToken?: string;
          slackClientSecret?: string;
          slackSigningSecret?: string;
          gitlabToken?: string;
          switchboardToken?: string;
          switchboardAdminToken?: string;
        };
  };
  "events:emit": { payload: { topic: string; payload?: unknown }; data: { id: number } };
  "events:wait": { payload: { pattern: string; after?: number; waitMs?: number }; data: { events: EventsBusEvent[]; cursor: number } };
  "events:list": { payload: { pattern: string; after?: number; limit?: number }; data: { events: EventsBusEvent[]; cursor: number } };
  "runs:list": { payload: { repo?: string }; data: { runs: RunSummary[] } };
  "runs:get": { payload: { runId: string; repo?: string }; data: RunDetail };
}

export type CommandName = keyof Commands;

export const COMMAND_NAMES: readonly CommandName[] = [
  "project-mrs:read",
  "discussions:read",
  "mr:by-branch",
  "secrets:forge-token",
  "secrets:read",
  "events:emit",
  "events:wait",
  "events:list",
  "runs:list",
  "runs:get",
];
