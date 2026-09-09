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
  /** Section headers in the default-branch CODEOWNERS at the last deep or
      backfill. `[]` when the project has none. Absent from a pre-knownSections
      daemon or before the first sweep that demanded a section. */
  knownSections?: string[];
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
 * these mirror lib/daemon/gates-store.ts's types, which rt-client cannot
 * import. gates-store.ts imports them back FROM this package (Commands
 * already flows daemon -> rt-client, e.g. handlers/events.ts), so this is
 * the single source of truth for the wire shape.
 */
/** The `by` value a pane spells when it answers its own gate: the only
    value gates-store.ts's release tracking (CAS winner or loser) reacts to. */
export const GATE_BY_PANE = "pane";

export type GateStatus = "open" | "answered" | "parked" | "closed";
export type GateOption = string | { value: string; label: string };
export interface GateOrigin {
  paneId?: string;
  tabId?: string;
  runId?: string;
  worktree?: string;
  presentation?: "form" | "wait";
}
export interface GateQuestion { id: string; label: string; multi: boolean; options: GateOption[] }
export function gateOptionValue(o: GateOption): string {
  return typeof o === "string" ? o : o.value;
}
export function gateOptionLabel(o: GateOption): string {
  return typeof o === "string" ? o : (o.label || o.value);
}
export interface GateAnswer { answers: Record<string, string | string[] | { value: string | string[]; note?: string }>; by: string; answeredAt: number }
export interface GateRow {
  id: string; subject: string; kind: string;
  questions: GateQuestion[]; meta: Record<string, unknown> | null;
  context?: string | null;
  origin?: GateOrigin | null;
  status: GateStatus; answer: GateAnswer | null;
  openedAt: number; parkedAt: number | null; closedAt: number | null;
  closedReason: "abandoned" | "superseded" | "pruned" | null;
  agent: string | null; pane: string | null;
  nudge: { session: string } | null;
  delivery: { outcome: "delivered" | "dead-pane"; at: number } | null;
  released: boolean;
}

export interface GateSubscription {
  id: string;
  subjectPrefix: string;
  session: string;
  createdAt: number;
  lastDelivery: { outcome: "delivered" | "failed"; at: number } | null;
  dead: boolean;
}

export interface HerdInfo { id: string; repo: string; room: string; workspace: string; shepherdSession: string; shepherdHandle: string; herdrSocket: string | null; hidden: boolean; status: "active" | "wrapped"; createdAt: number; wrappedAt: number | null }
/** A herd row as `herd:list` reports it: the registry row plus how many jobs hang off it. */
export interface HerdListRow extends HerdInfo { jobs: number }
export interface HerdJobInfo { herd: string; name: string; worktree: string; branch: string | null; tree: string | null; pane: string | null; agentSession: string | null; agentId: string | null; handle: string; status: "spawning" | "active" | "at-gate" | "at-milestone" | "done" | "closed" | "crashed"; disposable: boolean; lastGate: string | null; lastReport: number | null; createdAt: number; updatedAt: number }
/** `lastGateStatus`/`lastGateDelivery` come from the job's `lastGate` row: an `answered` gate whose delivery is `dead-pane` is the "answered, worker not woken" case the shepherd must act on. */
export interface HerdStatusData {
  herd: HerdInfo;
  jobs: Array<HerdJobInfo & { openGate: string | null; paneStatus: string | null; lastGateStatus: GateStatus | null; lastGateDelivery: "delivered" | "dead-pane" | null }>;
  unread: number;
  lifecycleConnected: boolean;
  hiddenUp: boolean | null;
  /** The shepherd session's own `herd:<id>/` subscription row, or null when none is live. */
  subscription: { id: string; dead: boolean; lastDelivery: GateSubscription["lastDelivery"] } | null;
}

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

/** `claimed` is the only outcome that woke anyone; `previousHolder` marks a takeover of an expired claim. */
export type ChatClaimOutcome =
  | { outcome: "claimed"; author: string; room: string; previousHolder?: string }
  | { outcome: "held"; author: string; room: string }
  | { outcome: "lost"; holder: string; claimedAt: number; expiresAt: number };

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
  /** herdr's per-pane focus flag; false when herdr itself is backgrounded */
  focused?: boolean;
}

export interface PaneAccount { slot: number; email: string; alias?: string; headroom?: string }
export interface PaneDirectory { path: string; repo: string; branch?: string }
export interface InviteResult { paneId: string; delivered: "accepted" | "queued" | "refused"; reason?: string }

/** Duplicated shape on purpose: mirrors lib/daemon/inject.ts's InjectResult. */
export type PaneDelivery = "accepted" | "queued" | "refused";
export interface PaneSendResult { paneId: string; delivered: PaneDelivery; reason?: string }
/** `attendTab` is set only for a `bg:` ref: focus for a background pane IS
    the attend flow (a visible tab running a terminal attach), and this is
    that tab's id. */
export interface PaneFocusResult { paneId: string; focused: boolean; attendTab?: string }

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

/** Duplicated shape on purpose: mirrors lib/worktree/ready-held.ts's ReadyHeldRepo. */
export interface ReadyHeldRepo {
  /** Serialized repo identity. A key, never displayed. */
  repo: string;
  /** Decoded display name. Never sent back as a key. */
  label: string;
  hash: string;
  approveCommand: string;
}

export interface TrayStatusData {
  pid: number; uptime: number; memoryUsage: number; watchedRepos: number; cacheEntries: number;
  portsCached: number; portCacheAge: number | null; lastRefresh: number | null;
  portsByRepo: Record<string, number>; pendingNotifications: number;
  health: { level: HealthLevel; reasons: string[] }; metrics: HealthMetrics; eventLoop: HealthEventLoop;
  /** Optional because a daemon older than RT-98 does not send it. */
  worktreeReadyHeld?: ReadyHeldRepo[];
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
  /** `others` counts the room's members besides the author, so a caller can tell "woke nobody of 7" from "nobody else is here". */
  "chat:post": { payload: { room: string; handle: string; body: string; mentions?: string[]; quiet?: boolean }; data: { id: number; recipients: string[]; others: number } };
  "chat:ack": { payload: { id: number; handle: string }; data: { author: string; room: string; already: boolean } };
  "chat:claim": { payload: { id: number; handle: string }; data: ChatClaimOutcome };
  "chat:release": { payload: { id: number; handle: string }; data: { holder: string } };
  "chat:read": { payload: { handle: string; room?: string; limit?: number; sinceMs?: number }; data: { rooms: { room: string; messages: ChatMessage[] }[] } };
  "chat:rooms": { payload: { handle: string; includeArchived?: boolean }; data: { rooms: RoomSummary[] } };
  "chat:who": { payload: { room: string }; data: { members: ChatMember[] } };
  "chat:mark": { payload: { handle: string; room?: string; upto?: number }; data: Record<string, never> };
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
  "agent:start": { payload: { repo: string; cwd: string; prompt?: string; surface?: AgentSurface; model?: string; effort?: string; account?: string; label?: string; caller?: string; workspace?: string; tab?: string; extraArgs?: string; env?: Record<string, string>; herdrSocket?: string; handle?: string }; data: AgentRecord };
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
  /** `callerWorkspace` (HERDR_WORKSPACE_ID) is required only for a `bg:`
      ref, whose focus opens an attend tab in the caller's own workspace. */
  "pane:focus": { payload: { paneId: string; callerWorkspace?: string }; data: PaneFocusResult };

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

  // ─── Gate facility (BOARD-20/21) ─────────────────────────────────────────
  "gate:open": { payload: { subject: string; kind: string; questions: GateQuestion[]; meta?: Record<string, unknown>; agent?: string; pane?: string; nudge?: { session: string }; context?: string; origin?: GateOrigin }; data: { id: string; supersededId: string | null } };
  /**
   * A CAS loss is a DEFINED OUTCOME, not an error: `ok:true` with
   * `conflict:true` and the WINNING row, so every consumer gets the winner
   * typed with no envelope hacks. `ok:false` is reserved for
   * not-found/closed/validation failures.
   */
  "gate:answer": { payload: { id: string; answers: GateAnswer["answers"]; by: string }; data: { row: GateRow; conflict?: true } };
  /** `ok:false "not-found"` on an unknown id is terminal; the CLI loop must not re-enter on it.
   *  `timeout` carries no row (nothing settled); `answered`/`closed` always carry the settled row. */
  "gate:wait": { payload: { id: string; waitMs?: number }; data: { status: "timeout" } | { status: "answered" | "closed"; row: GateRow } };
  /** Paged like events:list: an omitted `limit` clamps daemon-side rather than
   *  forcing a full-table read; `cursor` is the paging rowid to resume from. */
  "gate:list": { payload: { open?: boolean; subjectPrefix?: string; kind?: string; limit?: number; cursor?: number }; data: { gates: GateRow[]; cursor: number } };
  "gate:park": { payload: { id: string }; data: { ok: true } };
  "gate:close": { payload: { id: string; reason: "abandoned" | "superseded" | "pruned" }; data: { ok: true } };
  "gate:subscribe": { payload: { subjectPrefix: string; session: string }; data: { id: string } };
  "gate:unsubscribe": { payload: { id: string }; data: { removed: boolean } };
  /** The shepherd's gap-recovery liveness check and the observability window
   *  onto delivery outcomes (dead marks included). */
  "gate:subscriptions": { payload: { session?: string; live?: boolean }; data: { subscriptions: GateSubscription[] } };

  // ─── Herd (shepherd run registry) ────────────────────────────────────────
  "herd:start":  { payload: { name: string; repo: string; session: string; hidden?: boolean }; data: { herd: string; room: string; workspace: string; subscription: string; handle: string; hidden: boolean } };
  "herd:resume": { payload: { herd: string; session: string }; data: { subscription: string; gates: GateRow[]; unread: number; status: HerdStatusData; handle: string } };
  "herd:status": { payload: { herd: string }; data: HerdStatusData };
  /** Active herds only unless `all`, so a shepherd's "which herd am I on" question has one answer. */
  "herd:list":   { payload: { all?: boolean }; data: { herds: HerdListRow[] } };
  "herd:close":  { payload: { herd: string; job: string }; data: { job: string; status: "closed" } };
  /** `brief` is the brief TEXT, not a path: the CLI reads the file. It is stored at `<jobsRoot>/<herd>/<job>/job.md`, so a respawn with `dir` and no `brief` reads it back. */
  "herd:spawn":  { payload: { herd: string; job: string; brief?: string; dir?: string; model?: string; effort?: string; account?: string; disposable?: boolean }; data: { herd: string; job: string; pane: string; worktree: string; branch: string | null; tree: string | null; /** null = no provisioning ran (--dir); false = cold create, worth announcing. */ wasOnDeck: boolean | null; agentId: string; sessionId: string; handle: string } };
  "herd:gates":  { payload: { herd: string }; data: { gates: GateRow[] } };
  "herd:ask":       { payload: { herd: string; job: string; session: string; pane?: string; questions: GateQuestion[]; context?: string }; data: { gate: string } };
  "herd:milestone": { payload: { herd: string; job: string; session: string; pane?: string; artifact: string; summary?: string }; data: { gate: string; message: number } };
  "herd:answer":    { payload: { gate: string }; data: { gate: string; status: GateStatus; answer: GateAnswer | null; closedReason: GateRow["closedReason"] } };
  "herd:report":    { payload: { herd: string; job: string; body: string }; data: { message: number } };
  /** `callerWorkspace` is the attending session's own HERDR_WORKSPACE_ID: the attached tab opens there, not in the herd's workspace. */
  "herd:attend":      { payload: { herd: string; job: string; callerWorkspace: string }; data: { tab: string; pane: string } };
  "herd:stop-hidden": { payload: Record<string, never>; data: { stopped: boolean } };
  "herd:wrap-up": { payload: { herd: string; closePanes?: boolean; dispose?: string[]; deleteJobDirs?: boolean; archiveRoom?: boolean }; data: { closed: string[]; workspaceClosed: boolean; disposed: string[]; refused: Array<{ tree: string; reason: string }>; deletedJobDirs: boolean; archived: boolean } };

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

  // ─── Background server (daemon-owned headless herdr session) ────────────
  "bg:ensure": { payload: { claim?: string }; data: { socket: string; started: boolean; parity: { ok: boolean; drift: string[] } | null } };
  "bg:status": { payload: Record<string, never>; data: { up: boolean; socket: string; claims: Array<{ owner: string; pane: string | null; createdAt: number }> } };
  /** Rejects (`ok:false`) naming every live claim owner while any claim is held. */
  "bg:stop": { payload: Record<string, never>; data: { stopped: boolean } };
  "bg:release": { payload: { claim: string }; data: { released: boolean } };
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
  "chat:claim",
  "chat:release",
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
  "gate:open",
  "gate:answer",
  "gate:wait",
  "gate:list",
  "gate:park",
  "gate:close",
  "gate:subscribe",
  "gate:unsubscribe",
  "gate:subscriptions",
  "herd:start",
  "herd:resume",
  "herd:status",
  "herd:list",
  "herd:close",
  "herd:spawn",
  "herd:gates",
  "herd:ask",
  "herd:milestone",
  "herd:answer",
  "herd:report",
  "herd:attend",
  "herd:stop-hidden",
  "herd:wrap-up",
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

  "bg:ensure",
  "bg:status",
  "bg:stop",
  "bg:release",
];
