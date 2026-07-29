/**
 * The typed command catalog for the rt daemon: one entry per command name,
 * pairing its payload shape with its response data shape. `client.ts` builds
 * its functions against this map so a new command only needs an entry here
 * plus one function, never a change to the transport itself.
 */
import type { PullRequest, MRDetail } from "@workforge/glance-sdk";

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

export interface Commands {
  "project-mrs:read": { payload: { repoName: string; maxAgeMs?: number; demand?: DemandDecl }; data: ProjectMRsData };
  "discussions:read": { payload: { repoName: string; iid: number }; data: DiscussionsData };
  "mr:by-branch": { payload: { repoName: string; branches: string[] }; data: MrByBranchData };
}

export type CommandName = keyof Commands;

export const COMMAND_NAMES: readonly CommandName[] = ["project-mrs:read", "discussions:read", "mr:by-branch"];
