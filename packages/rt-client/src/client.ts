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
  RoomSummary,
  BuddyStatus,
  PresenceRow,
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
  a: { room: string; handle: string; body: string; mentions?: string[] },
  o: RtClientOptions = {},
): Promise<RtResponse<{ id: number; recipients: string[] }>> {
  const payload: Record<string, unknown> = { room: a.room, handle: a.handle, body: a.body };
  if (a.mentions !== undefined) payload.mentions = a.mentions;
  return rtCommand<{ id: number; recipients: string[] }>("chat:post", payload, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 });
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
  a: { handle: string },
  o: RtClientOptions = {},
): Promise<RtResponse<{ rooms: RoomSummary[] }>> {
  return rtCommand<{ rooms: RoomSummary[] }>("chat:rooms", { handle: a.handle }, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 });
}

export function chatWho(
  a: { room: string },
  o: RtClientOptions = {},
): Promise<RtResponse<{ members: ChatMember[] }>> {
  return rtCommand<{ members: ChatMember[] }>("chat:who", { room: a.room }, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 });
}

export function chatMark(
  a: { handle: string; room?: string },
  o: RtClientOptions = {},
): Promise<RtResponse<Record<string, never>>> {
  const payload: Record<string, unknown> = { handle: a.handle };
  if (a.room !== undefined) payload.room = a.room;
  return rtCommand<Record<string, never>>("chat:mark", payload, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 });
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

export function chatArm(
  a: { handle: string; room?: string; sessionId?: string },
  o: RtClientOptions = {},
): Promise<RtResponse<Record<string, never>>> {
  const payload: Record<string, unknown> = { handle: a.handle };
  if (a.room !== undefined) payload.room = a.room;
  if (a.sessionId !== undefined) payload.sessionId = a.sessionId;
  return rtCommand<Record<string, never>>("chat:arm", payload, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 });
}

export function chatTouch(
  a: { handle: string; sessionId?: string },
  o: RtClientOptions = {},
): Promise<RtResponse<Record<string, never>>> {
  const payload: Record<string, unknown> = { handle: a.handle };
  if (a.sessionId !== undefined) payload.sessionId = a.sessionId;
  return rtCommand<Record<string, never>>("chat:touch", payload, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 });
}

export function chatDisarm(
  a: { handle: string; sessionId?: string },
  o: RtClientOptions = {},
): Promise<RtResponse<Record<string, never>>> {
  const payload: Record<string, unknown> = { handle: a.handle };
  if (a.sessionId !== undefined) payload.sessionId = a.sessionId;
  return rtCommand<Record<string, never>>("chat:disarm", payload, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 });
}

export function chatUnreadWaking(
  a: { handle: string; room?: string },
  o: RtClientOptions = {},
): Promise<RtResponse<{ rooms: { room: string; count: number; mentions: number; maxId: number }[] }>> {
  const payload: Record<string, unknown> = { handle: a.handle };
  if (a.room !== undefined) payload.room = a.room;
  return rtCommand<{ rooms: { room: string; count: number; mentions: number; maxId: number }[] }>("chat:unread-waking", payload, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 });
}

// ─── Presence ──────────────────────────────────────────────────────────

export function chatSignIn(
  a: { sessionId: string; baseHandle: string; cwd?: string; repo?: string; branch?: string; pane?: string; statusText?: string },
  o: RtClientOptions = {},
): Promise<RtResponse<{ handle: string; reclaimed: boolean }>> {
  const payload: Record<string, unknown> = { sessionId: a.sessionId, baseHandle: a.baseHandle };
  if (a.cwd !== undefined) payload.cwd = a.cwd;
  if (a.repo !== undefined) payload.repo = a.repo;
  if (a.branch !== undefined) payload.branch = a.branch;
  if (a.pane !== undefined) payload.pane = a.pane;
  if (a.statusText !== undefined) payload.statusText = a.statusText;
  return rtCommand<{ handle: string; reclaimed: boolean }>("chat:sign-in", payload, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 });
}

export function chatSignOut(
  a: { sessionId: string },
  o: RtClientOptions = {},
): Promise<RtResponse<Record<string, never>>> {
  return rtCommand<Record<string, never>>("chat:sign-out", { sessionId: a.sessionId }, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 });
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

export function chatPulse(
  a: { sessionId: string; cwd?: string; repo?: string; branch?: string; pane?: string },
  o: RtClientOptions = {},
): Promise<RtResponse<{ unread: { dms: number; mentions: number; rooms: number }; status: BuddyStatus }>> {
  const payload: Record<string, unknown> = { sessionId: a.sessionId };
  if (a.cwd !== undefined) payload.cwd = a.cwd;
  if (a.repo !== undefined) payload.repo = a.repo;
  if (a.branch !== undefined) payload.branch = a.branch;
  if (a.pane !== undefined) payload.pane = a.pane;
  return rtCommand<{ unread: { dms: number; mentions: number; rooms: number }; status: BuddyStatus }>(
    "chat:pulse",
    payload,
    { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 },
  );
}

export function chatDm(
  a: { from: string; to: string; body: string; sessionId?: string },
  o: RtClientOptions = {},
): Promise<RtResponse<{ room: string; id: number; recipients: string[] }>> {
  const payload: Record<string, unknown> = { from: a.from, to: a.to, body: a.body };
  if (a.sessionId !== undefined) payload.sessionId = a.sessionId;
  return rtCommand<{ room: string; id: number; recipients: string[] }>("chat:dm", payload, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 });
}

export function eventsHead(o: RtClientOptions = {}): Promise<RtResponse<{ cursor: number }>> {
  return rtCommand<{ cursor: number }>("events:head", {}, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 });
}
