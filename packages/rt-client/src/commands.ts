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

export interface Commands {
  "project-mrs:read": { payload: { repoName: string; maxAgeMs?: number; demand?: DemandDecl }; data: ProjectMRsData };
  "discussions:read": { payload: { repoName: string; iid: number }; data: DiscussionsData };
  "mr:by-branch": { payload: { repoName: string; branches: string[] }; data: MrByBranchData };
  /**
   * The forge token for one tracked repo (MAT-33). Repo-scoped on purpose:
   * rt gates access per repo through repo-tracking.json, and this verb is
   * what lets consumers stop reading ~/.rt/secrets.json directly, which
   * walked around that grant model entirely. An untracked repo is refused;
   * the caller's env vars keep precedence on the caller's side.
   */
  "secrets:forge-token": { payload: { repoName: string; forge: ForgeSlug }; data: ForgeTokenData };
  "events:emit": { payload: { topic: string; payload?: unknown }; data: { id: number } };
  "events:wait": { payload: { pattern: string; after?: number; waitMs?: number }; data: { events: EventsBusEvent[]; cursor: number } };
  "events:list": { payload: { pattern: string; after?: number; limit?: number }; data: { events: EventsBusEvent[]; cursor: number } };
}

export type CommandName = keyof Commands;

export const COMMAND_NAMES: readonly CommandName[] = [
  "project-mrs:read",
  "discussions:read",
  "mr:by-branch",
  "secrets:forge-token",
  "events:emit",
  "events:wait",
  "events:list",
];
