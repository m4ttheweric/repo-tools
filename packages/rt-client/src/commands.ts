/**
 * The typed command catalog for the rt daemon: one entry per command name,
 * pairing its payload shape with its response data shape. `client.ts` builds
 * its functions against this map so a new command only needs an entry here
 * plus one function, never a change to the transport itself.
 */
import type { PullRequest, MRDetail, Pipeline } from "@mattstack/glance";

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
export interface PaneFocusResult { paneId: string; focused: boolean }

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

// ─── The daemon's remaining out-of-process commands (R013/R016) ──
// rt CLI <-> daemon, tray <-> daemon, and VS Code extension <-> daemon are
// all separate OS processes, so any command reachable from one counts as
// "external" here even when the only known caller today is rt's own CLI.

/** Duplicated shape on purpose (see EventsBusEvent above): mirrors lib/daemon/health.ts's HealthSnapshot. */
export type HealthLevel = "ok" | "degraded" | "unhealthy";
export interface HealthMetrics { rss: number; heapUsed: number; external: number; uptimeMs: number; wsClients: number; watchers: number }
export interface HealthEventLoop { maxLagMs: number; lastStallAt: number | null; lastStallCmd: string | null; stalls: number }
export interface DaemonIdentity { flavor: "dev" | "prod"; version: string; sourceRev: string | null; startedAt: number }

export interface PingData extends DaemonIdentity {
  uptime: number;
  pid: number;
  health: HealthLevel;
  eventLoop: HealthEventLoop;
  heartbeatSeq: number;
  supervision: { bootAttempts: number; lastReadyAt: number | null; recentFailures: unknown[]; lastExit: unknown };
}

export interface StatusData {
  pid: number; uptime: number; watchedRepos: number; cacheEntries: number;
  portsCached: number; portCacheAge: number | null;
  freshness: unknown; identity: DaemonIdentity;
  health: { level: HealthLevel; reasons: string[] }; metrics: HealthMetrics; eventLoop: HealthEventLoop;
  worktreePool: { dormant: true; repos: string[]; message: string } | { dormant: false };
}

export interface TrayStatusData {
  pid: number; uptime: number; memoryUsage: number; watchedRepos: number; cacheEntries: number;
  portsCached: number; portCacheAge: number | null; lastRefresh: number | null;
  portsByRepo: Record<string, number>; pendingNotifications: number;
  health: { level: HealthLevel; reasons: string[] }; metrics: HealthMetrics; eventLoop: HealthEventLoop;
}

/** Duplicated shape on purpose: mirrors lib/port-scanner.ts's PortEntry. */
export interface PortEntry {
  port: number; pid: number; command: string; cwd: string;
  repo: string | null; worktree: string | null; branch: string | null;
  relativeDir: string; uptime: string;
}

export interface PortsData {
  ports: PortEntry[];
  grouped: Record<string, Record<string, PortEntry[]>>;
  updatedAt: number;
  age: number | null;
}

/** Duplicated shape on purpose: mirrors lib/state/notifier-store.ts's NotificationEvent. */
export interface RtNotificationEvent {
  id: string; title: string; message: string; url?: string;
  category: string; timestamp: number; pids?: number[];
}

export interface ReposData {
  repos: Record<string, { path: string; worktrees: Array<{ path: string; branch: string }> }>;
  watched: string[];
}

export interface TccCheckData {
  blocked: Array<{ name: string; path: string; error: string }>;
  accessible: string[];
  totalRepos: number;
  daemonPid: number;
}

export interface WorktreeTreeRow {
  name: string; kind: string; state: string; path: string; branch: string | null;
  repoName: string; mr: { iid: number; state: string; title: string } | null;
  duplicateBranch?: true;
  [extra: string]: unknown;
}
export interface WorktreeListData {
  trees: WorktreeTreeRow[];
  dormant?: true; dormantRepos?: string[]; message?: string;
  readyHeld?: true; readyHeldRepos?: string[];
}
export interface WorktreeProvisionData {
  tree: string; path: string; branch: string; wasOnDeck: boolean;
  readyAt: string | null; branchState: "new" | "tracking-remote" | "existing-clean" | "diverged" | "behind";
  readyFailed?: true; failedStep?: string;
}
export interface WorktreeCreateData { tree: string; path: string }
export interface WorktreeDisposeData {
  disposed: string[];
  refused: Array<{ tree: string; reason: string }>;
  recoverable: Array<{ tree: string; path: string; until: string }>;
}
export interface WorktreeRestoreData {
  restored: true; path: string; tree: string; readyFailed?: true; failedStep?: string;
}
export interface WorktreeFreshenData { ran: string[] }
export interface WorktreeAdoptData {
  main: string; claimed: string[]; unmanaged: string[]; disposed: string[];
  refused: Array<{ tree: string; reason: string }>;
}

/** Duplicated shape on purpose: mirrors lib/endpoint/store.ts's EndpointClaim. */
export interface EndpointClaim { worktree: string; role: string; port: number; ts: number }
export interface EndpointRoleRef { port: number; url: string; running: boolean }
export interface EndpointClaimData { role: string; port: number; url: string; refs: Record<string, EndpointRoleRef> }
export interface EndpointLookupData { claimed: boolean; port: number | null; url: string | null; running: boolean }
export interface EndpointReleaseData { released: number }
export interface EndpointStatusData { repos: Record<string, Array<EndpointClaim & { running: boolean }>> }

/**
 * Duplicated shape on purpose: mirrors @mattstack/glance's `JobDetail`
 * (types.ts), which the package does not re-export from its index.
 */
export type MrJobDetail = { type: "trace"; content: string } | { type: "bridge"; downstreamPipeline: Pipeline };

export interface DiscussionsWriteData { discussions: Discussion[]; fetchedAt: number }
export interface DiscussionsDiffsData { diffs: Array<{ newPath: string; diff: string }>; truncated: boolean }

export type MRActionName =
  | "merge" | "rebase" | "approve" | "unapprove"
  | "setAutoMerge" | "cancelAutoMerge"
  | "retryJob" | "retryPipeline"
  | "toggleDraft" | "requestReReview";

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
  "chat:post": { payload: { room: string; handle: string; body: string; mentions?: string[]; quiet?: boolean }; data: { id: number; recipients: string[] } };
  "chat:ack": { payload: { id: number; handle: string }; data: { author: string; room: string; already: boolean } };
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
  /**
   * `viaPane` mirrors `chat:sign-in`'s: the daemon resolves `pane` to a
   * session id via herdr's `session.snapshot` rather than trusting a
   * caller-supplied one, so a process signing another pane out (herdr-chat,
   * or a human invoking a target pane) needs neither that pane's session id
   * nor its own. The response's `sessionId` is the RESOLVED id, the only way
   * such a caller learns which session file to delete locally.
   */
  "chat:sign-out": {
    payload: { sessionId?: string; pane?: string; viaPane?: boolean };
    data: { sessionId: string };
  };
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
  "pane:focus": { payload: { paneId: string }; data: PaneFocusResult };

  // ─── R013/R016 ────────────────────────────────────────────────
  "cache:read": { payload: { branches?: string[]; maxAgeMs?: number; repoIdentity?: string }; data: Record<string, BranchEnrichment> };
  /** `source` ("cache"|"fresh"|"empty") rides alongside `data` on the wire, not nested under it. */
  "branch:enrich": { payload: { branch: string; repoPath?: string; remoteUrl?: string; repoIdentity?: string }; data: BranchEnrichment | null };
  /** Fire-and-forget kickoff; wire reply is `{ok, message}`, not `{ok,data}`. */
  "cache:refresh": { payload: Record<string, never>; data: { message: string } };
  "daemon:log-level": { payload: { level?: "trace" | "debug" | "info" | "warn" | "error" }; data: { level: string } };
  "ping": { payload: Record<string, never>; data: PingData };
  "status": { payload: Record<string, never>; data: StatusData };
  "tray:status": { payload: Record<string, never>; data: TrayStatusData };
  "tcc:check": { payload: Record<string, never>; data: TccCheckData };
  "repos": { payload: Record<string, never>; data: ReposData };
  "ports": { payload: { repo?: string; refresh?: boolean }; data: PortsData };
  "notifications": { payload: Record<string, never>; data: RtNotificationEvent[] };

  "discussions:refresh": { payload: { repoName: string; iid: number }; data: DiscussionsWriteData };
  "discussions:resolve": { payload: { repoName: string; iid: number; discussionId: string; resolved?: boolean }; data: DiscussionsWriteData };
  "discussions:reply": { payload: { repoName: string; iid: number; discussionId: string; body: string }; data: DiscussionsWriteData };
  "discussions:diffs": { payload: { repoName: string; iid: number }; data: DiscussionsDiffsData };

  /** Wire reply is `{ok:true}` on success (no `data`); a failure is `{ok:false,error}`. */
  "mr:action": { payload: { repoName: string; iid: number; action: MRActionName; args?: unknown[] }; data: Record<string, never> };
  "mr:fetch-job-detail": { payload: { repoName: string; iid: number; jobId: number; pipelineId?: number }; data: MrJobDetail };
  "mr:fetch-job-trace": { payload: { repoName: string; iid: number; jobId: number }; data: string };

  "endpoint:claim": { payload: { repo: string; worktree: string; role: string; pid?: number }; data: EndpointClaimData };
  "endpoint:lookup": { payload: { repo: string; worktree: string; role: string }; data: EndpointLookupData };
  "endpoint:release": { payload: { repo: string; worktree: string; role?: string }; data: EndpointReleaseData };
  "endpoint:status": { payload: { repo?: string }; data: EndpointStatusData };

  "repos:locate": { payload: { newPath: string; repo?: string; dryRun?: boolean }; data: unknown };
  "freshness:reconcile": { payload: Record<string, never>; data: unknown };

  /** Wire reply on success is always `{ok:true, repaired}` (no `data`
   *  wrapper) — `data` here documents the extra field the same way PingData
   *  does for `ping`, not the literal wire nesting (R3). */
  "hooks:repair": { payload: { repo: string }; data: { repaired: boolean } };
  "hooks:watch": { payload: { repo: string }; data: Record<string, never> };

  "sdm:catalog": { payload: { refresh?: boolean }; data: unknown };
  "sdm:snapshot": { payload: { force?: boolean }; data: unknown };
  "sdm:recents": { payload: Record<string, never>; data: unknown };
  "sdm:reconnect": { payload: { key: string }; data: unknown };

  "system-processes": { payload: Record<string, never>; data: unknown };

  "worktree:provision": { payload: { repoName: string; branch?: string; ticket?: string; ticketTitle?: string; disposal?: "job" | "merge"; owner?: string }; data: WorktreeProvisionData };
  "worktree:create": { payload: { repoName: string; onDeck?: boolean }; data: WorktreeCreateData };
  "worktree:dispose": { payload: { repoName?: string; owner?: string; tree?: string; force?: boolean; callerPid?: number }; data: WorktreeDisposeData };
  "worktree:list": { payload: { repoName?: string }; data: WorktreeListData };
  "worktree:restore": { payload: { repoName: string; tree: string }; data: WorktreeRestoreData };
  "worktree:freshen": { payload: { repoName?: string; tree?: string }; data: WorktreeFreshenData };
  "worktree:adopt": { payload: { repoName: string; claim?: boolean }; data: WorktreeAdoptData };
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
  "chat:ack",
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
  "pane:focus",

  // ─── R013/R016 ────────────────────────────────────────────────
  "cache:read",
  "branch:enrich",
  "cache:refresh",
  "daemon:log-level",
  "ping",
  "status",
  "tray:status",
  "tcc:check",
  "repos",
  "ports",
  "notifications",
  "discussions:refresh",
  "discussions:resolve",
  "discussions:reply",
  "discussions:diffs",
  "mr:action",
  "mr:fetch-job-detail",
  "mr:fetch-job-trace",
  "endpoint:claim",
  "endpoint:lookup",
  "endpoint:release",
  "endpoint:status",
  "repos:locate",
  "freshness:reconcile",
  "hooks:repair",
  "hooks:watch",
  "sdm:catalog",
  "sdm:snapshot",
  "sdm:recents",
  "sdm:reconnect",
  "system-processes",
  "worktree:provision",
  "worktree:create",
  "worktree:dispose",
  "worktree:list",
  "worktree:restore",
  "worktree:freshen",
  "worktree:adopt",
];
