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
  /** Codeowner sections this client needs covered (spec: second demand axis). */
  codeownerSections?: string[];
  declaredAt: number;
}

export interface ProjectMRsScope {
  authors: string[];
  windowDays: number;
  uncovered: string[];
  /** Effective synced section union; absent from a pre-sections daemon. */
  sections?: string[];
  /** Demanded sections not yet swept for this client. */
  uncoveredSections?: string[];
}

export interface ProjectMRsData {
  mrs: Record<string, { pr: PullRequest; fetchedAt: number; codeownerSections?: string[] }>;
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

/**
 * Trimmed, structural view of the daemon's `CacheEntry` (lib/state/branch-cache.ts) --
 * rt-client cannot import daemon/lib internals, so this names only the fields
 * console's run-view rows read, spelled exactly as they land on the wire
 * (`mr` is `toMRInfo(pr)`, i.e. `getMRDashboardProps` -- camelCase `webUrl`,
 * nested `pipeline.status`, no `ciStatus`). Extra wire fields (including the
 * rest of `pipeline`) are fine; anything this shape doesn't name is simply
 * not surfaced.
 */
export interface BranchEnrichment {
  ticket: { identifier: string; title: string; url: string } | null;
  mr: { iid: number; webUrl: string | null; state: string; pipeline: { status: string } | null } | null;
  fetchedAt: number;
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

/**
 * Duplicated shape on purpose, same reasoning as EventsBusEvent above:
 * these mirror lib/state/chat-store.ts's types, which rt-client cannot
 * import (it's outside lib/state/ and outside this package entirely).
 */
export type WakeMode = "mention" | "all" | "none";

export interface ChatMember {
  room: string;
  handle: string;
  joinedAt: number;
  lastReadId: number;
  wakeOn: WakeMode;
  cwd?: string;
  pane?: string;
  /** Presence-joined by chat:who's handler — the only place this type is ever returned, and it always attaches one. */
  status: BuddyStatus;
}

export interface ChatMessage {
  id: number;
  room: string;
  handle: string;
  body: string;
  mentions: string[];
  replyTo?: number;
  postedAt: number;
}

export interface RoomSummary {
  room: string;
  memberCount: number;
  unread: number;
  mentions: number;
  lastPostedAt?: number;
  /** Set only by chat:rooms's left join against chat_dms. */
  kind?: "dm";
  participants?: { a: string; b: string };
  /** Set only by chat:rooms's left join against chat_room_defaults; undefined for a room never stamped a default (every DM room included). */
  defaultWake?: WakeMode;
  /** Set only when chat:rooms was asked for archived rooms; absent on an open room. */
  archivedAt?: number;
}

/**
 * Duplicated shape on purpose, same reasoning as ChatMember/ChatMessage
 * above: mirrors lib/state/presence-store.ts's types, which rt-client
 * cannot import.
 */
export type BuddyStatus = "live" | "idle" | "offline";

export interface PresenceRow {
  sessionId: string;
  handle: string;
  baseHandle: string;
  cwd?: string;
  repo?: string;
  branch?: string;
  pane?: string;
  statusText?: string;
  signedInAt: number;
  lastSeenAt: number;
  signedOutAt?: number;
}

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

/** Duplicated shape on purpose (see EventsBusEvent above): mirrors the daemon's pane row, which rt-client cannot import. */
export interface ChatPane {
  paneId: string;
  workspace: string;
  title?: string;
  cwd?: string;
  repo?: string;
  branch?: string;
  agentStatus: AgentStatus;
  sessionId?: string;
  presence?: { handle: string; status: BuddyStatus; rooms: string[] };
}

export interface PaneAccount { slot: number; email: string; alias?: string; headroom?: string }
export interface PaneDirectory { path: string; repo: string; branch?: string }
export interface InviteResult { paneId: string; delivered: "accepted" | "queued" | "refused"; reason?: string }

/** Duplicated shape on purpose: mirrors lib/daemon/inject.ts's InjectResult. */
export type PaneDelivery = "accepted" | "queued" | "refused";
export interface PaneSendResult { paneId: string; delivered: PaneDelivery; reason?: string }

// SKILLS-53: one judgment, computed once in rt, so the console and the tray
// never derive two verdicts that can disagree.
export type Attention = {
  needs: boolean;
  reason: "failed" | "stale" | "stranded" | "blocked" | null;
  evidence: string;
};

export interface RunSummary {
  id: string; repo: string; work_type: string; pipeline: string;
  status: string; current_stage: string | null; spawned_by: string | null;
  started_at: number; ended_at: number | null;
  // v2. Null on runs written before schema v2; pack_dirty means the pack tree
  // had uncommitted changes, so the as-run text may exist in no commit.
  pack_commits: string | null; pack_dirty: number;
  attention: Attention;
  /** Max over stage, field, and decision timestamps; falls back to
      `started_at` when the run has produced no events yet. The board orders
      by silence, so this — not `started_at` — is its sort key. */
  last_event_at: number;
  /** Denormalized from the run's `ticket` / `branch` fields so the LIST view
      can render and search them without a detail fetch per row. Null when
      the run has not produced that field yet. */
  ticket: string | null;
  branch: string | null;
  /** The herdr agent attributed to this run (matched by recorded claude
      session, else by worktree), mirrored live from `herdr agent list`.
      Null when no agent matches or herdr is unavailable; absent on
      pre-mirror daemons. */
  agent?: RunAgent | null;
  /** Executed stages only, in run order — the pipeline may define more that have not started. */
  stages?: { name: string; status: string; started_at: number | null }[];
}
export interface RunAgent {
  status: "working" | "idle" | "blocked" | "done" | "unknown";
  pane: string;
}
export interface RunStageRow {
  name: string; status: string; attempt: number;
  started_at: number | null; ended_at: number | null;
  reason: string | null; detail_path: string | null;
}
export interface RunFieldRow { key: string; value: string; produced_by: string; at: number; }
export interface RunDecisionRow { contract: string; scope: string; selection: string; decided_by: string; decided_at: number; }
export interface RunDetail { run: RunSummary; stages: RunStageRow[]; fields: RunFieldRow[]; decisions: RunDecisionRow[]; schemaAhead: boolean; }

export type AgentSurface = "herdr" | "headless";

export interface AgentRecord {
  id: string; repo: string; cwd: string; provider: string;
  surface: AgentSurface; sessionId: string;
  model?: string; effort?: string; account?: string;
  label?: string; caller?: string; handle?: string;
  paneId?: string; tabId?: string; workspaceId?: string;
  extraArgs?: string; exitCode?: number; resultPath?: string;
  createdAt: number; lastResumedAt?: number; finishedAt?: number;
}

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
  "events:head": { payload: Record<string, never>; data: { cursor: number } };
  "runs:list": { payload: { repo?: string }; data: { runs: RunSummary[] } };
  "runs:get": { payload: { runId: string; repo?: string }; data: RunDetail };
  "runs:abandon": { payload: { runId: string; repo?: string; reason?: string }; data: { ok: boolean } };
  "chat:join": { payload: { room: string; handle: string; wakeOn?: WakeMode; cwd?: string; pane?: string }; data: { handle: string; memberCount: number; unread: number } };
  "chat:leave": { payload: { room: string; handle: string }; data: Record<string, never> };
  "chat:post": { payload: { room: string; handle: string; body: string; mentions?: string[] }; data: { id: number; recipients: string[] } };
  "chat:read": { payload: { handle: string; room?: string; limit?: number; sinceMs?: number }; data: { rooms: { room: string; messages: ChatMessage[] }[] } };
  "chat:rooms": { payload: { handle: string; includeArchived?: boolean }; data: { rooms: RoomSummary[] } };
  "chat:who": { payload: { room: string }; data: { members: ChatMember[] } };
  "chat:mark": { payload: { handle: string; room?: string }; data: Record<string, never> };
  "chat:messages": { payload: { room: string; before?: number; limit?: number }; data: { messages: ChatMessage[] } };

  // A session id keys these to one signed-in handle, not a room-membership
  // handle string.
  /**
   * No `baseHandle` means "draw me a first name": the daemon picks the least
   * recently used pool name no live session holds. `viaPane` resolves
   * `sessionId` daemon-side from herdr's `session.snapshot` for the pane id
   * in `pane`, rather than trusting a caller-supplied id -- the caller may
   * have none of its own (a human or another agent signing a target pane in
   * on its behalf); the response's `sessionId` and `room` are then the only
   * way that caller learns what got signed in and joined, since it has
   * nothing local to derive either from.
   */
  "chat:sign-in": {
    payload: {
      sessionId?: string;
      baseHandle?: string;
      cwd?: string;
      repo?: string;
      branch?: string;
      pane?: string;
      statusText?: string;
      viaPane?: boolean;
      /** `viaPane` only: overrides the pane-cwd-derived room outright. */
      room?: string;
      /** `viaPane` only: skip room derivation/join entirely, same as --no-room on the non-pane path. */
      noRoom?: boolean;
    };
    data: { handle: string; baseHandle: string; reclaimed: boolean; sessionId: string; room: string | null };
  };
  "chat:sign-out": { payload: { sessionId: string }; data: Record<string, never> };
  "chat:away": { payload: { sessionId: string; text: string }; data: Record<string, never> };
  "chat:back": { payload: { sessionId: string }; data: Record<string, never> };
  "chat:buddies": { payload: Record<string, never>; data: { buddies: Array<PresenceRow & { status: BuddyStatus }> } };
  "chat:dm": { payload: { from: string; to: string; body: string; sessionId?: string }; data: { room: string; id: number; recipients: string[] } };
  "chat:archive": { payload: { room: string; handle: string; archived: boolean }; data: { room: string; archivedAt: number | null } };
  "chat:dm-open": { payload: { from: string; to: string; sessionId?: string }; data: { room: string; created: boolean } };

  // ─── Agent handoff (rt agent) ────────────────────────────────────────────
  "agent:start": { payload: { repo: string; cwd: string; prompt?: string; surface?: AgentSurface; model?: string; effort?: string; account?: string; label?: string; caller?: string; workspace?: string; tab?: string; extraArgs?: string }; data: AgentRecord };
  "agent:resume": { payload: { id: string; prompt?: string; surface?: AgentSurface; workspace?: string; tab?: string }; data: AgentRecord };
  "agent:get": { payload: { id: string }; data: AgentRecord };
  "agent:list": { payload: { repo?: string }; data: { agents: AgentRecord[] } };
  "chat:invite": { payload: { paneId: string; room: string; note?: string; from: string; callerPane?: string }; data: InviteResult };
  "pane:list": { payload: Record<string, never>; data: { panes: ChatPane[] } };
  "pane:peek": { payload: { paneId: string; lines?: number }; data: { paneId: string; lines: string[] } };
  "pane:accounts": { payload: Record<string, never>; data: { accounts: PaneAccount[] } };
  "pane:directories": { payload: { q?: string }; data: { directories: PaneDirectory[] } };
  "pane:spawn": {
    payload: { cwd: string; account?: string; model?: string; effort?: string; prompt?: string; workspace?: string };
    data: { pane: ChatPane; ready: boolean };
  };
  "pane:send": { payload: { paneId: string; text: string; callerPane?: string }; data: PaneSendResult };
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
  "events:head",
  "runs:list",
  "runs:get",
  "runs:abandon",
  "chat:join",
  "chat:leave",
  "chat:post",
  "chat:read",
  "chat:rooms",
  "chat:who",
  "chat:mark",
  "chat:messages",
  "chat:sign-in",
  "chat:sign-out",
  "chat:away",
  "chat:back",
  "chat:buddies",
  "chat:dm",
  "chat:archive",
  "chat:dm-open",
  "agent:start",
  "agent:resume",
  "agent:get",
  "agent:list",
  "chat:invite",
  "pane:list",
  "pane:peek",
  "pane:accounts",
  "pane:directories",
  "pane:spawn",
  "pane:send",
];
