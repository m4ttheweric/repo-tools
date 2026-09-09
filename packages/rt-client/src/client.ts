/**
 * Typed reads against the rt daemon's command surface (see commands.ts).
 * Every function degrades to `{ ok: false, error }` instead of throwing,
 * inherited from rtCommand -- callers surface daemon-down verbatim.
 */
import { rtCommand } from "./transport.ts";
import type { RtResponse, RtClientOptions } from "./transport.ts";
import type {
  DemandDecl,
  ProjectMRsData,
  DiscussionsData,
  MrByBranchData,
  BranchEnrichment,
  ForgeSlug,
  ForgeTokenData,
  RunSummary,
  RunDetail,
  WakeMode,
  ChatMember,
  ChatMessage,
  ChatClaimOutcome,
  RoomSummary,
  BuddyStatus,
  PresenceRow,
  AgentRecord,
  Commands,
} from "./commands.ts";

/**
 * One repo's project open-MR store. A cold repo forces a full paginated sync
 * on the daemon side when maxAgeMs demands it, which can run tens of seconds
 * on a big project -- hence the long timeout.
 *
 * `demand` tells the daemon what this caller needs covered (client id, the
 * authors it cares about, when it declared that need), so the daemon can
 * size the sync to actually cover it rather than trusting the store's
 * self-reported source.
 */
export function readProjectMRs(
  repoName: string,
  maxAgeMs?: number,
  opts: RtClientOptions = {},
  demand?: DemandDecl,
): Promise<RtResponse<ProjectMRsData>> {
  const payload: Record<string, unknown> = { repoName };
  if (maxAgeMs !== undefined) payload.maxAgeMs = maxAgeMs;
  if (demand !== undefined) payload.demand = demand;
  return rtCommand<ProjectMRsData>("project-mrs:read", payload, { sockPath: opts.sockPath, timeoutMs: 90_000 });
}

export function readDiscussions(
  repoName: string,
  iid: number,
  opts: RtClientOptions = {},
): Promise<RtResponse<DiscussionsData>> {
  return rtCommand<DiscussionsData>(
    "discussions:read",
    { repoName, iid },
    { sockPath: opts.sockPath, timeoutMs: 30_000 },
  );
}

export function readMrsByBranch(
  repoName: string,
  branches: string[],
  opts: RtClientOptions = {},
): Promise<RtResponse<MrByBranchData>> {
  return rtCommand<MrByBranchData>(
    "mr:by-branch",
    { repoName, branches },
    { sockPath: opts.sockPath, timeoutMs: 60_000 },
  );
}

/**
 * Cached ticket/MR enrichment for a set of branches, keyed by branch name
 * (the cache's own primary key -- see lib/state/branch-cache.ts). Serves
 * whatever the daemon already has; it does not trigger a fetch.
 */
export function readBranchCache(
  branches: string[],
  opts: RtClientOptions = {},
): Promise<RtResponse<Record<string, BranchEnrichment>>> {
  return rtCommand<Record<string, BranchEnrichment>>(
    "cache:read",
    { branches },
    { sockPath: opts.sockPath, timeoutMs: 10_000 },
  );
}

/**
 * The forge token for one tracked repo (MAT-33). Grant-gated on the daemon
 * side: an untracked repo comes back `ok: false` with the `rt daemon track`
 * command to run, which is the fail-closed shape callers should surface
 * verbatim. Callers keep env-var precedence on their own side; this is the
 * fallback that replaces reading ~/.mattstack/rt/secrets.json directly.
 */
export function resolveForgeToken(
  repoName: string,
  forge: ForgeSlug,
  opts: RtClientOptions = {},
): Promise<RtResponse<ForgeTokenData>> {
  return rtCommand<ForgeTokenData>(
    "secrets:forge-token",
    { repoName, forge },
    { sockPath: opts.sockPath, timeoutMs: 10_000 },
  );
}

export function listRuns(
  repo?: string,
  opts: RtClientOptions = {},
): Promise<RtResponse<{ runs: RunSummary[] }>> {
  const payload: Record<string, unknown> = {};
  if (repo !== undefined) payload.repo = repo;
  return rtCommand<{ runs: RunSummary[] }>("runs:list", payload, { sockPath: opts.sockPath, timeoutMs: 10_000 });
}

export function getRun(
  runId: string,
  repo?: string,
  opts: RtClientOptions = {},
): Promise<RtResponse<RunDetail>> {
  const payload: Record<string, unknown> = { runId };
  if (repo !== undefined) payload.repo = repo;
  return rtCommand<RunDetail>("runs:get", payload, { sockPath: opts.sockPath, timeoutMs: 10_000 });
}

/**
 * SKILLS-54. rt's only write path into run state, so a wedged run can be
 * resolved by a person instead of lying in the data forever. The write happens
 * in the daemon and is attributed there; consumers never touch the run DB.
 */
export function abandonRun(
  runId: string,
  repo?: string,
  reason?: string,
  opts: RtClientOptions = {},
): Promise<RtResponse<{ ok: boolean }>> {
  const payload: Record<string, unknown> = { runId };
  if (repo !== undefined) payload.repo = repo;
  if (reason !== undefined) payload.reason = reason;
  return rtCommand<{ ok: boolean }>("runs:abandon", payload, { sockPath: opts.sockPath, timeoutMs: 10_000 });
}

// ─── Chat (RT-48 Task 6) ──────────────────────────────────────────────────
// The web viewer's (plan 2's) entire dependency: it reaches the daemon
// through these wrappers over the unix socket, so no /api/chat/* REST rows
// ship and needsToken() stays untouched.

export function chatJoin(
  a: { room: string; handle: string; wakeOn?: WakeMode; cwd?: string; pane?: string },
  o: RtClientOptions = {},
): Promise<RtResponse<{ handle: string; memberCount: number; unread: number }>> {
  const payload: Record<string, unknown> = { room: a.room, handle: a.handle };
  if (a.wakeOn !== undefined) payload.wakeOn = a.wakeOn;
  if (a.cwd !== undefined) payload.cwd = a.cwd;
  if (a.pane !== undefined) payload.pane = a.pane;
  return rtCommand<{ handle: string; memberCount: number; unread: number }>("chat:join", payload, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 });
}

export function chatLeave(
  a: { room: string; handle: string },
  o: RtClientOptions = {},
): Promise<RtResponse<Record<string, never>>> {
  return rtCommand<Record<string, never>>("chat:leave", { room: a.room, handle: a.handle }, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 });
}

export function chatPost(
  a: { room: string; handle: string; body: string; mentions?: string[]; quiet?: boolean },
  o: RtClientOptions = {},
): Promise<RtResponse<{ id: number; recipients: string[]; others: number }>> {
  const payload: Record<string, unknown> = { room: a.room, handle: a.handle, body: a.body };
  if (a.mentions !== undefined) payload.mentions = a.mentions;
  if (a.quiet) payload.quiet = true;
  return rtCommand<{ id: number; recipients: string[]; others: number }>("chat:post", payload, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 });
}

export function chatAck(
  a: { id: number; handle: string },
  o: RtClientOptions = {},
): Promise<RtResponse<{ author: string; room: string; already: boolean }>> {
  return rtCommand<{ author: string; room: string; already: boolean }>(
    "chat:ack",
    { id: a.id, handle: a.handle },
    { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 },
  );
}

export function chatClaim(a: { id: number; handle: string }, o: RtClientOptions = {}): Promise<RtResponse<ChatClaimOutcome>> {
  return rtCommand<ChatClaimOutcome>("chat:claim", { id: a.id, handle: a.handle }, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 });
}

export function chatRelease(a: { id: number; handle: string }, o: RtClientOptions = {}): Promise<RtResponse<{ holder: string }>> {
  return rtCommand<{ holder: string }>("chat:release", { id: a.id, handle: a.handle }, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 });
}

export function chatRead(
  a: { handle: string; room?: string; limit?: number; sinceMs?: number },
  o: RtClientOptions = {},
): Promise<RtResponse<{ rooms: { room: string; messages: ChatMessage[] }[] }>> {
  const payload: Record<string, unknown> = { handle: a.handle };
  if (a.room !== undefined) payload.room = a.room;
  if (a.limit !== undefined) payload.limit = a.limit;
  if (a.sinceMs !== undefined) payload.sinceMs = a.sinceMs;
  return rtCommand<{ rooms: { room: string; messages: ChatMessage[] }[] }>("chat:read", payload, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 });
}

export function chatRooms(
  a: { handle: string; includeArchived?: boolean },
  o: RtClientOptions = {},
): Promise<RtResponse<{ rooms: RoomSummary[] }>> {
  const payload: Record<string, unknown> = { handle: a.handle };
  if (a.includeArchived === true) payload.includeArchived = true;
  return rtCommand<{ rooms: RoomSummary[] }>("chat:rooms", payload, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 });
}

export function chatWho(
  a: { room: string },
  o: RtClientOptions = {},
): Promise<RtResponse<{ members: ChatMember[] }>> {
  return rtCommand<{ members: ChatMember[] }>("chat:who", { room: a.room }, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 });
}

export function chatMark(
  a: Commands["chat:mark"]["payload"],
  o: RtClientOptions = {},
): Promise<RtResponse<Commands["chat:mark"]["data"]>> {
  const payload: Record<string, unknown> = { handle: a.handle };
  if (a.room !== undefined) payload.room = a.room;
  if (a.upto !== undefined) payload.upto = a.upto;
  return rtCommand<Commands["chat:mark"]["data"]>("chat:mark", payload, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 });
}

export function chatMessages(
  a: { room: string; before?: number; limit?: number },
  o: RtClientOptions = {},
): Promise<RtResponse<{ messages: ChatMessage[] }>> {
  const payload: Record<string, unknown> = { room: a.room };
  if (a.before !== undefined) payload.before = a.before;
  if (a.limit !== undefined) payload.limit = a.limit;
  return rtCommand<{ messages: ChatMessage[] }>("chat:messages", payload, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 });
}

// ─── Presence ──────────────────────────────────────────────────────────

export function chatSignIn(
  a: Commands["chat:sign-in"]["payload"],
  o: RtClientOptions = {},
): Promise<RtResponse<Commands["chat:sign-in"]["data"]>> {
  const payload: Record<string, unknown> = {};
  if (a.sessionId !== undefined) payload.sessionId = a.sessionId;
  if (a.baseHandle !== undefined) payload.baseHandle = a.baseHandle;
  if (a.cwd !== undefined) payload.cwd = a.cwd;
  if (a.repo !== undefined) payload.repo = a.repo;
  if (a.branch !== undefined) payload.branch = a.branch;
  if (a.pane !== undefined) payload.pane = a.pane;
  if (a.statusText !== undefined) payload.statusText = a.statusText;
  if (a.viaPane !== undefined) payload.viaPane = a.viaPane;
  if (a.room !== undefined) payload.room = a.room;
  if (a.noRoom !== undefined) payload.noRoom = a.noRoom;
  return rtCommand<Commands["chat:sign-in"]["data"]>("chat:sign-in", payload, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 });
}

export function chatSignOut(
  a: Commands["chat:sign-out"]["payload"],
  o: RtClientOptions = {},
): Promise<RtResponse<Commands["chat:sign-out"]["data"]>> {
  const payload: Record<string, unknown> = {};
  if (a.sessionId !== undefined) payload.sessionId = a.sessionId;
  if (a.pane !== undefined) payload.pane = a.pane;
  if (a.viaPane !== undefined) payload.viaPane = a.viaPane;
  return rtCommand<Commands["chat:sign-out"]["data"]>("chat:sign-out", payload, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 });
}

export function chatAway(
  a: { sessionId: string; text: string },
  o: RtClientOptions = {},
): Promise<RtResponse<Record<string, never>>> {
  return rtCommand<Record<string, never>>("chat:away", { sessionId: a.sessionId, text: a.text }, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 });
}

export function chatBack(
  a: { sessionId: string },
  o: RtClientOptions = {},
): Promise<RtResponse<Record<string, never>>> {
  return rtCommand<Record<string, never>>("chat:back", { sessionId: a.sessionId }, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 });
}

export function chatBuddies(
  o: RtClientOptions = {},
): Promise<RtResponse<{ buddies: Array<PresenceRow & { status: BuddyStatus }> }>> {
  return rtCommand<{ buddies: Array<PresenceRow & { status: BuddyStatus }> }>("chat:buddies", {}, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 });
}

export function chatDm(
  a: { from: string; to: string; body: string; sessionId?: string },
  o: RtClientOptions = {},
): Promise<RtResponse<{ room: string; id: number; recipients: string[] }>> {
  const payload: Record<string, unknown> = { from: a.from, to: a.to, body: a.body };
  if (a.sessionId !== undefined) payload.sessionId = a.sessionId;
  return rtCommand<{ room: string; id: number; recipients: string[] }>("chat:dm", payload, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 });
}

export function chatArchive(
  a: { room: string; handle: string; archived: boolean },
  o: RtClientOptions = {},
): Promise<RtResponse<{ room: string; archivedAt: number | null }>> {
  return rtCommand<{ room: string; archivedAt: number | null }>(
    "chat:archive",
    { room: a.room, handle: a.handle, archived: a.archived },
    { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 },
  );
}

export function chatDmOpen(
  a: { from: string; to: string; sessionId?: string },
  o: RtClientOptions = {},
): Promise<RtResponse<{ room: string; created: boolean }>> {
  const payload: Record<string, unknown> = { from: a.from, to: a.to };
  if (a.sessionId !== undefined) payload.sessionId = a.sessionId;
  return rtCommand<{ room: string; created: boolean }>("chat:dm-open", payload, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 });
}

export function eventsHead(o: RtClientOptions = {}): Promise<RtResponse<{ cursor: number }>> {
  return rtCommand<{ cursor: number }>("events:head", {}, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 });
}

export function eventsEmit(
  topic: string,
  payload?: unknown,
  o: RtClientOptions = {},
): Promise<RtResponse<{ id: number }>> {
  const p: Record<string, unknown> = { topic };
  if (payload !== undefined) p.payload = payload;
  return rtCommand<{ id: number }>("events:emit", p, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 });
}

export function eventsWait(
  payload: Commands["events:wait"]["payload"],
  o: RtClientOptions = {},
): Promise<RtResponse<Commands["events:wait"]["data"]>> {
  return rtCommand<Commands["events:wait"]["data"]>("events:wait", payload, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 250_000 });
}

export function eventsList(
  payload: Commands["events:list"]["payload"],
  o: RtClientOptions = {},
): Promise<RtResponse<Commands["events:list"]["data"]>> {
  return rtCommand<Commands["events:list"]["data"]>("events:list", payload, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 });
}

// ─── Agent handoff (rt agent) ─────────────────────────────────────────────

export function agentStart(
  a: Commands["agent:start"]["payload"], o: RtClientOptions = {},
): Promise<RtResponse<AgentRecord>> {
  const payload: Record<string, unknown> = { repo: a.repo, cwd: a.cwd };
  for (const k of ["prompt", "surface", "model", "effort", "account", "label", "caller", "workspace", "tab", "extraArgs", "env", "herdrSocket", "handle", "bg"] as const) {
    if (a[k] !== undefined) payload[k] = a[k];
  }
  return rtCommand<AgentRecord>("agent:start", payload, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 30_000 });
}

export function agentResume(
  a: Commands["agent:resume"]["payload"], o: RtClientOptions = {},
): Promise<RtResponse<AgentRecord>> {
  const payload: Record<string, unknown> = { id: a.id };
  for (const k of ["prompt", "surface", "workspace", "tab"] as const) {
    if (a[k] !== undefined) payload[k] = a[k];
  }
  return rtCommand<AgentRecord>("agent:resume", payload, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 30_000 });
}

export function agentGet(a: { id: string }, o: RtClientOptions = {}): Promise<RtResponse<AgentRecord>> {
  return rtCommand<AgentRecord>("agent:get", { id: a.id }, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 });
}

export function agentList(a: { repo?: string }, o: RtClientOptions = {}): Promise<RtResponse<{ agents: AgentRecord[] }>> {
  const payload: Record<string, unknown> = {};
  if (a.repo !== undefined) payload.repo = a.repo;
  return rtCommand<{ agents: AgentRecord[] }>("agent:list", payload, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 });
}

// ─── Panes (rt chat invite) ────────────────────────────────────────────────
// herdr-facing verbs; the daemon answers `herdr unavailable` without herdr.

export function paneList(o: RtClientOptions = {}): Promise<RtResponse<Commands["pane:list"]["data"]>> {
  return rtCommand<Commands["pane:list"]["data"]>("pane:list", {}, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 });
}

export function panePeek(a: Commands["pane:peek"]["payload"], o: RtClientOptions = {}): Promise<RtResponse<Commands["pane:peek"]["data"]>> {
  const payload: Record<string, unknown> = { paneId: a.paneId };
  if (a.lines !== undefined) payload.lines = a.lines;
  return rtCommand<Commands["pane:peek"]["data"]>("pane:peek", payload, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 });
}

/** The spawn waits on claude starting, so its budget is minutes, not seconds. */
export function paneSpawn(
  a: Commands["pane:spawn"]["payload"],
  o: RtClientOptions = {},
): Promise<RtResponse<Commands["pane:spawn"]["data"]>> {
  const payload: Record<string, unknown> = { cwd: a.cwd };
  for (const k of ["account", "model", "effort", "prompt", "workspace"] as const) if (a[k] !== undefined) payload[k] = a[k];
  return rtCommand<Commands["pane:spawn"]["data"]>("pane:spawn", payload, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 90_000 });
}

export function paneAccounts(o: RtClientOptions = {}): Promise<RtResponse<Commands["pane:accounts"]["data"]>> {
  return rtCommand<Commands["pane:accounts"]["data"]>("pane:accounts", {}, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 });
}

export function paneDirectories(a: Commands["pane:directories"]["payload"], o: RtClientOptions = {}): Promise<RtResponse<Commands["pane:directories"]["data"]>> {
  const payload: Record<string, unknown> = {};
  if (a.q !== undefined) payload.q = a.q;
  return rtCommand<Commands["pane:directories"]["data"]>("pane:directories", payload, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 });
}

export function chatInvite(
  a: Commands["chat:invite"]["payload"],
  o: RtClientOptions = {},
): Promise<RtResponse<Commands["chat:invite"]["data"]>> {
  const payload: Record<string, unknown> = { paneId: a.paneId, room: a.room, from: a.from };
  if (a.note !== undefined) payload.note = a.note;
  if (a.callerPane !== undefined) payload.callerPane = a.callerPane;
  return rtCommand<Commands["chat:invite"]["data"]>("chat:invite", payload, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 30_000 });
}

/** A working target holds the connection through its prompt wait, so the budget matches chatInvite's 30s. */
export function paneSend(
  a: Commands["pane:send"]["payload"],
  o: RtClientOptions = {},
): Promise<RtResponse<Commands["pane:send"]["data"]>> {
  const payload: Record<string, unknown> = { paneId: a.paneId, text: a.text };
  if (a.callerPane !== undefined) payload.callerPane = a.callerPane;
  return rtCommand<Commands["pane:send"]["data"]>("pane:send", payload, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 30_000 });
}

/** Brings a herdr pane to the front. The daemon routes this to the tray, which
    owns the herdr focus and the native terminal-window raise. */
export function paneFocus(
  a: Commands["pane:focus"]["payload"],
  o: RtClientOptions = {},
): Promise<RtResponse<Commands["pane:focus"]["data"]>> {
  const payload: Record<string, unknown> = { paneId: a.paneId };
  if (a.callerWorkspace !== undefined) payload.callerWorkspace = a.callerWorkspace;
  return rtCommand<Commands["pane:focus"]["data"]>("pane:focus", payload, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 });
}

// ─── Gates (BOARD-20/21 gate facility) ─────────────────────────────────────

export function gateOpen(
  a: Commands["gate:open"]["payload"],
  o: RtClientOptions = {},
): Promise<RtResponse<Commands["gate:open"]["data"]>> {
  const payload: Record<string, unknown> = { subject: a.subject, kind: a.kind, questions: a.questions };
  for (const k of ["meta", "agent", "pane", "nudge", "context", "origin"] as const) if (a[k] !== undefined) payload[k] = a[k];
  return rtCommand<Commands["gate:open"]["data"]>("gate:open", payload, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 });
}

export function gateAnswer(
  a: Commands["gate:answer"]["payload"],
  o: RtClientOptions = {},
): Promise<RtResponse<Commands["gate:answer"]["data"]>> {
  return rtCommand<Commands["gate:answer"]["data"]>("gate:answer", { id: a.id, answers: a.answers, by: a.by }, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 });
}

/** Daemon clamps its own wait to 240s (gates-store.ts); the client abort
    must outlive that cap, same +10s buffer as commands/events.ts's
    IPC_TIMEOUT_MS over DAEMON_WAIT_MS. */
export function gateWait(
  a: Commands["gate:wait"]["payload"],
  o: RtClientOptions = {},
): Promise<RtResponse<Commands["gate:wait"]["data"]>> {
  const payload: Record<string, unknown> = { id: a.id };
  if (a.waitMs !== undefined) payload.waitMs = a.waitMs;
  return rtCommand<Commands["gate:wait"]["data"]>("gate:wait", payload, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 250_000 });
}

export function gateList(
  a: Commands["gate:list"]["payload"],
  o: RtClientOptions = {},
): Promise<RtResponse<Commands["gate:list"]["data"]>> {
  const payload: Record<string, unknown> = {};
  for (const k of ["open", "subjectPrefix", "kind", "limit", "cursor"] as const) if (a[k] !== undefined) payload[k] = a[k];
  return rtCommand<Commands["gate:list"]["data"]>("gate:list", payload, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 });
}

export function gatePark(
  a: Commands["gate:park"]["payload"],
  o: RtClientOptions = {},
): Promise<RtResponse<Commands["gate:park"]["data"]>> {
  return rtCommand<Commands["gate:park"]["data"]>("gate:park", { id: a.id }, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 });
}

export function gateClose(
  a: Commands["gate:close"]["payload"],
  o: RtClientOptions = {},
): Promise<RtResponse<Commands["gate:close"]["data"]>> {
  return rtCommand<Commands["gate:close"]["data"]>("gate:close", { id: a.id, reason: a.reason }, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 });
}

export function gateSubscribe(
  a: Commands["gate:subscribe"]["payload"],
  o: RtClientOptions = {},
): Promise<RtResponse<Commands["gate:subscribe"]["data"]>> {
  return rtCommand<Commands["gate:subscribe"]["data"]>("gate:subscribe", { subjectPrefix: a.subjectPrefix, session: a.session }, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 });
}

export function gateUnsubscribe(
  a: Commands["gate:unsubscribe"]["payload"],
  o: RtClientOptions = {},
): Promise<RtResponse<Commands["gate:unsubscribe"]["data"]>> {
  return rtCommand<Commands["gate:unsubscribe"]["data"]>("gate:unsubscribe", { id: a.id }, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 });
}

export function gateSubscriptions(
  a: Commands["gate:subscriptions"]["payload"],
  o: RtClientOptions = {},
): Promise<RtResponse<Commands["gate:subscriptions"]["data"]>> {
  const payload: Record<string, unknown> = {};
  for (const k of ["session", "live"] as const) if (a[k] !== undefined) payload[k] = a[k];
  return rtCommand<Commands["gate:subscriptions"]["data"]>("gate:subscriptions", payload, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 });
}

// ─── Herd (shepherd run registry) ───────────────────────────────────────────

/** Provisions the room, workspace and subscription before it answers, so it
    gets the same 60s budget as a spawn rather than the 10s default. */
export function herdStart(
  a: Commands["herd:start"]["payload"],
  o: RtClientOptions = {},
): Promise<RtResponse<Commands["herd:start"]["data"]>> {
  const payload: Record<string, unknown> = { name: a.name, repo: a.repo, session: a.session };
  if (a.hidden !== undefined) payload.hidden = a.hidden;
  return rtCommand<Commands["herd:start"]["data"]>("herd:start", payload, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 60_000 });
}

/** Worktree provision plus agent launch; the 10s default cannot cover it. */
export function herdSpawn(
  a: Commands["herd:spawn"]["payload"],
  o: RtClientOptions = {},
): Promise<RtResponse<Commands["herd:spawn"]["data"]>> {
  const payload: Record<string, unknown> = { herd: a.herd, job: a.job };
  for (const k of ["brief", "dir", "model", "effort", "account", "disposable"] as const) if (a[k] !== undefined) payload[k] = a[k];
  return rtCommand<Commands["herd:spawn"]["data"]>("herd:spawn", payload, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 60_000 });
}

export function herdAsk(
  a: Commands["herd:ask"]["payload"],
  o: RtClientOptions = {},
): Promise<RtResponse<Commands["herd:ask"]["data"]>> {
  const payload: Record<string, unknown> = { herd: a.herd, job: a.job, session: a.session, questions: a.questions };
  for (const k of ["pane", "context"] as const) if (a[k] !== undefined) payload[k] = a[k];
  return rtCommand<Commands["herd:ask"]["data"]>("herd:ask", payload, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 });
}

export function herdMilestone(
  a: Commands["herd:milestone"]["payload"],
  o: RtClientOptions = {},
): Promise<RtResponse<Commands["herd:milestone"]["data"]>> {
  const payload: Record<string, unknown> = { herd: a.herd, job: a.job, session: a.session, artifact: a.artifact };
  for (const k of ["pane", "summary"] as const) if (a[k] !== undefined) payload[k] = a[k];
  return rtCommand<Commands["herd:milestone"]["data"]>("herd:milestone", payload, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 });
}

export function herdAnswer(
  a: Commands["herd:answer"]["payload"],
  o: RtClientOptions = {},
): Promise<RtResponse<Commands["herd:answer"]["data"]>> {
  return rtCommand<Commands["herd:answer"]["data"]>("herd:answer", { gate: a.gate }, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 });
}

/** A disposable job's report also closes its pane, one herdr CLI call under the runner's own 15s budget. */
export function herdReport(
  a: Commands["herd:report"]["payload"],
  o: RtClientOptions = {},
): Promise<RtResponse<Commands["herd:report"]["data"]>> {
  return rtCommand<Commands["herd:report"]["data"]>("herd:report", { herd: a.herd, job: a.job, body: a.body }, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 30_000 });
}

export function herdGates(
  a: Commands["herd:gates"]["payload"],
  o: RtClientOptions = {},
): Promise<RtResponse<Commands["herd:gates"]["data"]>> {
  return rtCommand<Commands["herd:gates"]["data"]>("herd:gates", { herd: a.herd }, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 });
}

export function herdStatus(
  a: Commands["herd:status"]["payload"],
  o: RtClientOptions = {},
): Promise<RtResponse<Commands["herd:status"]["data"]>> {
  return rtCommand<Commands["herd:status"]["data"]>("herd:status", { herd: a.herd }, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 });
}

export function herdList(
  a: Commands["herd:list"]["payload"] = {},
  o: RtClientOptions = {},
): Promise<RtResponse<Commands["herd:list"]["data"]>> {
  const payload: Record<string, unknown> = {};
  if (a.all !== undefined) payload.all = a.all;
  return rtCommand<Commands["herd:list"]["data"]>("herd:list", payload, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 });
}

export function herdResume(
  a: Commands["herd:resume"]["payload"],
  o: RtClientOptions = {},
): Promise<RtResponse<Commands["herd:resume"]["data"]>> {
  return rtCommand<Commands["herd:resume"]["data"]>("herd:resume", { herd: a.herd, session: a.session }, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 });
}

/** Closes a herdr pane, one CLI call under the runner's own 15s budget. */
export function herdClose(
  a: Commands["herd:close"]["payload"],
  o: RtClientOptions = {},
): Promise<RtResponse<Commands["herd:close"]["data"]>> {
  return rtCommand<Commands["herd:close"]["data"]>("herd:close", { herd: a.herd, job: a.job }, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 30_000 });
}

/** Three sequential herdr CLI calls (pane get, tab create, pane run), each under the runner's own 15s budget. */
export function herdAttend(
  a: Commands["herd:attend"]["payload"],
  o: RtClientOptions = {},
): Promise<RtResponse<Commands["herd:attend"]["data"]>> {
  return rtCommand<Commands["herd:attend"]["data"]>("herd:attend", { herd: a.herd, job: a.job, callerWorkspace: a.callerWorkspace }, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 60_000 });
}

/** Closes panes, disposes worktrees and archives the room in one pass; the
    worktree disposals alone can outrun a spawn's budget. */
export function herdWrapUp(
  a: Commands["herd:wrap-up"]["payload"],
  o: RtClientOptions = {},
): Promise<RtResponse<Commands["herd:wrap-up"]["data"]>> {
  const payload: Record<string, unknown> = { herd: a.herd };
  for (const k of ["closePanes", "dispose", "deleteJobDirs", "archiveRoom"] as const) if (a[k] !== undefined) payload[k] = a[k];
  return rtCommand<Commands["herd:wrap-up"]["data"]>("herd:wrap-up", payload, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 120_000 });
}

/** Runs `herdr session stop`, one CLI call under the runner's own 15s budget. */
export function herdStopHidden(
  _a: Commands["herd:stop-hidden"]["payload"],
  o: RtClientOptions = {},
): Promise<RtResponse<Commands["herd:stop-hidden"]["data"]>> {
  return rtCommand<Commands["herd:stop-hidden"]["data"]>("herd:stop-hidden", {}, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 30_000 });
}

// ─── Background server (daemon-owned headless herdr session) ──────────────

/** May spawn `herdr server` and wait for it to bind; budget matches bg-service's own 10s readyTimeoutMs plus margin. */
export function bgEnsure(
  a: Commands["bg:ensure"]["payload"] = {},
  o: RtClientOptions = {},
): Promise<RtResponse<Commands["bg:ensure"]["data"]>> {
  const payload: Record<string, unknown> = {};
  if (a.claim !== undefined) payload.claim = a.claim;
  return rtCommand<Commands["bg:ensure"]["data"]>("bg:ensure", payload, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 15_000 });
}

/** Never ensures/spawns; a plain read of the current state. */
export function bgStatus(o: RtClientOptions = {}): Promise<RtResponse<Commands["bg:status"]["data"]>> {
  return rtCommand<Commands["bg:status"]["data"]>("bg:status", {}, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 });
}

/** Asks the daemon to stop the background server; refuses (ok:false) while any claim is live, naming the owners. */
export function bgStop(o: RtClientOptions = {}): Promise<RtResponse<Commands["bg:stop"]["data"]>> {
  return rtCommand<Commands["bg:stop"]["data"]>("bg:stop", {}, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 30_000 });
}

export function bgRelease(
  a: Commands["bg:release"]["payload"],
  o: RtClientOptions = {},
): Promise<RtResponse<Commands["bg:release"]["data"]>> {
  return rtCommand<Commands["bg:release"]["data"]>("bg:release", { claim: a.claim }, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 });
}
