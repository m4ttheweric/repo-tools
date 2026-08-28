/**
 * chat:* — daemon handlers for `rt chat` (RT-48 Task 6).
 * Thin validation + delegation; lib/state/chat-store.ts (and, for presence,
 * lib/state/presence-store.ts / dm-store.ts) owns every rule.
 */

import type { Database } from "bun:sqlite";
import {
  isValidChatName,
  joinRoom,
  leaveRoom,
  mergeMentions,
  postMessage,
  readUnread,
  peekUnread,
  listMessages,
  markRead,
  markDelivered,
  pendingMessages,
  unreadWakingCount,
  listRooms,
  archiveRoom,
  roomDefaultWake,
  listMembers,
  armMember,
  touchMember,
  disarmMember,
  dmRoomFor,
  dmParticipants,
  listDms,
  signIn,
  signOut,
  setAway,
  pulseSession,
  listBuddies,
  presenceForHandle,
  presenceForSession,
  assertSessionOwnsHandle,
  assertSessionSignedIn,
  buddyStatus,
  presenceThresholds,
} from "../../state/index.ts";
import { CHAT_NOTIFICATION_CATEGORY, notifyEnabled } from "../../notifier.ts";
import { chatViewerUrl, readChatViewerUrlSetting } from "../../chat-viewer-url.ts";
import { getSetting } from "../../settings/resolve.ts";
import { herdrRequest } from "../../herdr/client.ts";
import { injectIntoPane, herdrError } from "../inject.ts";
import type { HerdrSnapshot } from "./pane.ts";
import { resolveInbox, inboxAlive } from "../../claude-registry.ts";
import { deliverToInbox, renderDeliveries } from "../inbox.ts";
import { repoForCwd, branchForCwd } from "../../repo-for-cwd.ts";
import { deriveRoomForCwd } from "../../chat-room.ts";
import { runCapture } from "../../subprocess.ts";
import { lazyChildLogger } from "../../daemon-logger.ts";
import type { Commands } from "../../../packages/rt-client/src/commands.ts";
import type { CommandResult, TypedHandlers } from "./types.ts";

export type InboxDeps = { resolve: typeof resolveInbox; deliver: typeof deliverToInbox };
const defaultInboxDeps: InboxDeps = { resolve: resolveInbox, deliver: deliverToInbox };
const log = lazyChildLogger("chat");

const CHAT_COMMANDS = [
  "chat:join",
  "chat:leave",
  "chat:post",
  "chat:read",
  "chat:rooms",
  "chat:who",
  "chat:mark",
  "chat:messages",
  "chat:arm",
  "chat:touch",
  "chat:disarm",
  "chat:unread-waking",
  "chat:sign-in",
  "chat:sign-out",
  "chat:away",
  "chat:back",
  "chat:buddies",
  "chat:pulse",
  "chat:dm",
  "chat:invite",
  "chat:archive",
  "chat:dm-open",
] as const;

/** Collapses the repeated try/catch every presence-assertion call site needs into one line: null on success, the refusal's message on throw. */
function assertionError(fn: () => void): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * A resolver miss, a signed-out recipient, a dead binding, and an ok:false
 * send are all the same outcome here: no cursor advance. A later post to the
 * same recipient tries again and, via pendingMessages, catches up everything
 * still behind the cursor at that point -- not just its own message -- so a
 * failed send never drops a body permanently. This function does not defend
 * against a concurrent call for the same (room, handle): two overlapping
 * calls would both read the same pre-advance pending range and duplicate it
 * into two frames. Callers must go through deliverSerialized, never call
 * this directly from postAndNotify.
 */
async function deliverPost(
  db: Database,
  deps: InboxDeps,
  recipient: string,
  msg: { room: string; dm: boolean; id: number },
): Promise<void> {
  const presence = presenceForHandle(recipient, db);
  if (!presence || presence.signedOutAt !== undefined) return;
  const binding = deps.resolve(presence.sessionId);
  if (!binding || !inboxAlive(binding)) return;
  const pending = pendingMessages(msg.room, recipient, msg.id, db);
  if (pending.length === 0) return;
  const content = renderDeliveries(pending.map((m) => ({ room: msg.room, dm: msg.dm, handle: m.handle, body: m.body })));
  const result = await deps.deliver(binding.socketPath, content);
  if (result.ok) markDelivered(msg.room, recipient, msg.id, db);
}

function chainKey(room: string, handle: string): string {
  return `${room}:${handle}`;
}

/**
 * Runs `task` serialized per `key`: a delivery landing while an earlier one
 * for the same key is still in flight must wait for it rather than run
 * concurrently -- for message delivery that would read pendingMessages
 * against the same pre-advance cursor and duplicate a frame. The
 * predecessor's failure is swallowed before chaining, so one failure never
 * blocks the next. The map entry is deleted once nothing is chained behind
 * it, so a quiet key leaves no permanent entry.
 */
function serializeDelivery(chains: Map<string, Promise<void>>, key: string, task: () => Promise<void>): Promise<void> {
  const prior = chains.get(key) ?? Promise.resolve();
  const result = prior.catch(() => {}).then(() => task());
  const swallowed = result.catch(() => {});
  chains.set(key, swallowed);
  void swallowed.finally(() => {
    if (chains.get(key) === swallowed) chains.delete(key);
  });
  return result;
}

function deliverSerialized(
  chains: Map<string, Promise<void>>,
  db: Database,
  deps: InboxDeps,
  recipient: string,
  msg: { room: string; dm: boolean; id: number },
): Promise<void> {
  return serializeDelivery(chains, chainKey(msg.room, recipient), () => deliverPost(db, deps, recipient, msg));
}

// Not a real room -- isValidChatName forbids '_' -- so this key can never
// collide with a genuine (room, handle) delivery chain. Deliberately its OWN
// chain, not the joined room's: the welcome is never ordered against a post
// delivery to the same recipient, only against another welcome for the same
// handle (a fast sign-out/sign-in pair) -- there is no correctness
// requirement that "you're signed in" land before or after a room message
// that happens to arrive the same tick, unlike two posts to the same room,
// which must not race past pendingMessages' shared cursor.
const WELCOME_CHAIN_ROOM = "__welcome__";
const WELCOME_CATCHUP_LIMIT = 10;

/**
 * Mirrors deliverPost's contract: an unresolvable/dead binding or a failed
 * send is silently skipped and, critically, never advances a cursor.
 * `catchupCursors` is the caller's peek of what the welcome's catch-up
 * section actually shows (peekUnread, not readUnread -- see renderWelcome's
 * caller) -- only a confirmed-delivered welcome may mark that range read, or
 * a welcome that never arrived would still have "shown" it.
 */
async function deliverWelcomeOnce(
  db: Database,
  deps: InboxDeps,
  sessionId: string,
  handle: string,
  content: string,
  catchupCursors: Array<{ room: string; upToId: number }>,
): Promise<void> {
  const binding = deps.resolve(sessionId);
  if (!binding || !inboxAlive(binding)) return;
  const result = await deps.deliver(binding.socketPath, content);
  if (!result.ok) return;
  for (const { room, upToId } of catchupCursors) markDelivered(room, handle, upToId, db);
}

function deliverWelcome(
  db: Database,
  chains: Map<string, Promise<void>>,
  deps: InboxDeps,
  sessionId: string,
  handle: string,
  content: string,
  catchupCursors: Array<{ room: string; upToId: number }>,
): Promise<void> {
  return serializeDelivery(chains, chainKey(WELCOME_CHAIN_ROOM, handle), () =>
    deliverWelcomeOnce(db, deps, sessionId, handle, content, catchupCursors),
  );
}

/**
 * The frame a freshly signed-in member gets, once, in place of the manual
 * "arm your tail" instruction: it explains that delivery is automatic and
 * carries whatever unread was already waiting in the rooms sign-in found the
 * handle already a member of. `catchup` entries with no lines (nothing
 * unread in that room) are skipped. The reply contract is two lines, not
 * one: `rt chat post <room>` and `rt chat dm <handle>` take different first
 * arguments, so one merged `<#room|@handle>` form does not actually parse.
 */
export function renderWelcome(handle: string, rooms: string[], catchup: Array<{ room: string; lines: string[] }>): string {
  const lines: string[] = [
    `You're signed in to rt chat as ${handle}.`,
    rooms.length ? `Rooms: ${rooms.map((r) => `#${r}`).join(", ")}` : "Rooms: none yet.",
    "Messages will arrive in your context automatically; you never need to poll or arm anything.",
    'Reply in a room with: rt chat post <room> "..."',
    'Reply privately with: rt chat dm <handle> "..."',
    "rt chat read shows a room's history.",
    "See the rt:chat skill for the full etiquette.",
  ];
  for (const entry of catchup) {
    const capped = entry.lines.slice(0, WELCOME_CATCHUP_LIMIT);
    if (capped.length === 0) continue;
    lines.push(`#${entry.room} catch-up:`);
    for (const line of capped) lines.push(`  ${line}`);
  }
  return lines.join("\n");
}

/**
 * Herdr's own `pane:list` join (lib/daemon/handlers/pane.ts) reads
 * `agent_session.value` for its "which session is this pane" answer; sign-in
 * `--pane` needs the exact same fact, so it takes the identical snapshot
 * shape rather than growing a second reader. Pure (no herdr call): the
 * caller fetches the snapshot itself, so a herdr-unreachable failure and a
 * "found the pane, no claude session" miss stay distinguishable instead of
 * collapsing into one null.
 */
function findPaneSession(snapshot: HerdrSnapshot, paneId: string): { sessionId: string; cwd?: string } | null {
  const pane = snapshot.panes.find((p) => p.pane_id === paneId);
  if (!pane || pane.agent_session?.kind !== "id") return null;
  return { sessionId: pane.agent_session.value, cwd: pane.foreground_cwd ?? pane.cwd };
}

/**
 * The row must commit before the viewer's `chat/<room>/msg` emit fires, or a
 * viewer reading the event finds no message yet. Shared by chat:post and
 * chat:dm so the desk-notify check (mentions merged the same way postMessage
 * merges them for storage) never diverges between the two entry points.
 * Recipient delivery is deferred a microtask past this function's return:
 * presenceForHandle plus a full registry scan run per recipient, and a
 * queued call lets chat:post's response get built before that work starts,
 * rather than paying it inline on the request path.
 */
function postAndNotify(
  db: Database,
  emitEvent: (topic: string, payload?: unknown) => unknown,
  args: { room: string; handle: string; body: string; mentions?: string[] },
  inboxDeps: InboxDeps = defaultInboxDeps,
  deliveryChains: Map<string, Promise<void>> = new Map(),
): { id: number; recipients: string[] } | undefined {
  const { room, handle, body, mentions } = args;
  const posted = postMessage({ room, handle, body, mentions }, db);
  if (!posted) return undefined;
  emitEvent(`chat/${room}/msg`, { id: posted.id });
  const dm = dmParticipants(room, db);
  for (const recipient of posted.recipients) {
    queueMicrotask(() => {
      deliverSerialized(deliveryChains, db, inboxDeps, recipient, { room, dm: dm !== null, id: posted.id }).catch((err) => {
        log.warn({ err, room, recipient, id: posted.id }, "chat: inbox delivery failed");
      });
    });
  }
  // Independent of chat_members / wake_on: agents create rooms via
  // join-creates, so the human is typically not a member yet, and a
  // member with wake_on='none' must still get a desk alert.
  const humanHandle = getSetting<string>("chat.humanHandle").value;
  const allMentions = mergeMentions(body, mentions);
  if (humanHandle && allMentions.includes(humanHandle)) {
    const title = dm ? `DM from ${handle}` : `#${room}`;
    // The click target: the viewer at this exact message, when the viewer is
    // configured. The tray opens `url` on a default click for any category.
    notifyEnabled(
      CHAT_NOTIFICATION_CATEGORY,
      title,
      `${handle}: ${body}`,
      chatViewerUrl(readChatViewerUrlSetting(), room, posted.id),
      undefined,
      `chat:${posted.id}`,
    );
  }
  return posted;
}

/**
 * Three disjoint buckets that sum to the true unread total: `dms` is the
 * waking count over DM rooms; `mentions` is the mention count over non-DM
 * rooms; `rooms` is non-DM waking count minus those same mentions, floored
 * at 0 (a self-mention can otherwise make a room's mention count exceed its
 * waking count).
 */
function unreadSummaryFor(handle: string, db: Database): { dms: number; mentions: number; rooms: number } {
  const dmRooms = new Set(listDms(handle, db).map((d) => d.room));
  let dms = 0;
  let mentions = 0;
  let nonDmWaking = 0;
  for (const w of unreadWakingCount(handle, db)) {
    if (dmRooms.has(w.room)) {
      dms += w.count;
    } else {
      nonDmWaking += w.count;
      mentions += w.mentions;
    }
  }
  return { dms, mentions, rooms: Math.max(0, nonDmWaking - mentions) };
}

/** One line, because Claude Code dispatches a slash command from the first line only. */
export function inviteText(room: string, from: string, note?: string): string {
  const head = `/chat:join ${room}`;
  const body = note?.replace(/\s*[\r\n\u2028\u2029]+\s*/g, " ").trim();
  return body ? `${head} note from ${from}: ${body}` : head;
}

export function createChatHandlers(opts: {
  db: Database;
  emitEvent: (topic: string, payload?: unknown) => unknown;
  herdr?: typeof herdrRequest;
  inboxDeps?: InboxDeps;
  /** repo/branch/room derivation for `--pane` sign-in (lib/repo-for-cwd.ts, the same index-based, no-sync-git-spawn source pane.ts's own paneRow uses). */
  repoIndex?: () => Record<string, string>;
  exec?: typeof runCapture;
}): Pick<TypedHandlers, (typeof CHAT_COMMANDS)[number]> & { db: Database } {
  const { db, emitEvent } = opts;
  const herdr = opts.herdr ?? herdrRequest;
  const inboxDeps = opts.inboxDeps ?? defaultInboxDeps;
  const repoIndex = opts.repoIndex ?? (() => ({}));
  const exec = opts.exec ?? runCapture;
  // One chain map per handler instance (one daemon, one db): shared across
  // every chat:post/chat:dm call so deliverSerialized actually serializes.
  const deliveryChains = new Map<string, Promise<void>>();

  return {
    db,

    "chat:join": async (payload: Commands["chat:join"]["payload"]): Promise<CommandResult<"chat:join">> => {
      const { room, handle, wakeOn, cwd, pane } = payload;
      if (!isValidChatName(handle)) return { ok: false, error: `invalid handle "${handle}"` };
      if (!isValidChatName(room)) return { ok: false, error: `invalid room "${room}"` };
      try {
        const data = joinRoom({ room, handle, wakeOn, cwd, pane }, db);
        return { ok: true, data };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    "chat:leave": async (payload: Commands["chat:leave"]["payload"]): Promise<CommandResult<"chat:leave">> => {
      leaveRoom(payload.room, payload.handle, db);
      return { ok: true, data: {} };
    },

    "chat:post": async (payload: Commands["chat:post"]["payload"]): Promise<CommandResult<"chat:post">> => {
      const { room, handle, body, mentions } = payload;
      const invalidMention = mentions?.find((m) => !isValidChatName(m));
      if (invalidMention !== undefined) return { ok: false, error: `invalid handle "${invalidMention}"` };
      const posted = postAndNotify(db, emitEvent, { room, handle, body, mentions }, inboxDeps, deliveryChains);
      if (!posted) return { ok: false, error: "chat: post failed (retry budget exhausted)" };
      return { ok: true, data: posted };
    },

    "chat:read": async (payload: Commands["chat:read"]["payload"]): Promise<CommandResult<"chat:read">> => {
      const { handle, room, limit, sinceMs } = payload;
      const rooms = readUnread({ handle, room, limit: limit ?? 20, sinceMs }, db);
      return { ok: true, data: { rooms } };
    },

    "chat:rooms": async (payload: Commands["chat:rooms"]["payload"]): Promise<CommandResult<"chat:rooms">> => {
      const rooms = listRooms(payload.handle, db, { includeArchived: payload.includeArchived === true }).map((room) => {
        const defaultWake = roomDefaultWake(room.room, db);
        const withDefault = defaultWake ? { ...room, defaultWake } : room;
        const dm = dmParticipants(room.room, db);
        return dm ? { ...withDefault, kind: "dm" as const, participants: dm } : withDefault;
      });
      return { ok: true, data: { rooms } };
    },

    "chat:who": async (payload: Commands["chat:who"]["payload"]): Promise<CommandResult<"chat:who">> => {
      const now = Date.now();
      const th = presenceThresholds();
      const dm = dmParticipants(payload.room, db);
      let rows = listMembers(payload.room, db);
      if (dm) {
        const humanHandle = getSetting<string>("chat.humanHandle").value;
        // The silent wake_on=none row dm-store adds for the human is not a
        // DM participant — drop it, unless he's one of the two named ones.
        if (humanHandle !== dm.a && humanHandle !== dm.b) {
          rows = rows.filter((member) => member.handle !== humanHandle);
        }
      }
      const members = rows.map((member) => {
        const presence = presenceForHandle(member.handle, db);
        // Presence takes priority: pulse only ever heartbeats the presence
        // row, so a signed-in handle with no chat:touch yet would otherwise
        // read stale. joinedAt floors lastSeenAt only (keeps a member who
        // joined but never touched/armed from reading as instantly offline)
        // — it must NOT flow into tailSeenAt too, or a member who joined long
        // ago and only just armed reads deaf off its own join time instead of
        // its fresh armedAt.
        const memberLastSeenAt = member.lastSeenAt ?? member.joinedAt;
        const status = presence
          ? buddyStatus(presence, now, th)
          : buddyStatus({ lastSeenAt: memberLastSeenAt, tailSeenAt: member.lastSeenAt, armedAt: member.armedAt }, now, th);
        return { ...member, status };
      });
      return { ok: true, data: { members } };
    },

    "chat:mark": async (payload: Commands["chat:mark"]["payload"]): Promise<CommandResult<"chat:mark">> => {
      markRead(payload.handle, payload.room, db);
      return { ok: true, data: {} };
    },

    "chat:messages": async (payload: Commands["chat:messages"]["payload"]): Promise<CommandResult<"chat:messages">> => {
      const { room, before, limit } = payload;
      const messages = listMessages({ room, before, limit: limit ?? 50 }, db);
      return { ok: true, data: { messages } };
    },

    "chat:arm": async (payload: Commands["chat:arm"]["payload"]): Promise<CommandResult<"chat:arm">> => {
      const err = assertionError(() => assertSessionOwnsHandle(payload.handle, payload.sessionId, db));
      if (err) return { ok: false, error: err };
      armMember(payload.room, payload.handle, db);
      return { ok: true, data: {} };
    },

    "chat:touch": async (payload: Commands["chat:touch"]["payload"]): Promise<CommandResult<"chat:touch">> => {
      const err = assertionError(() => assertSessionOwnsHandle(payload.handle, payload.sessionId, db));
      if (err) return { ok: false, error: err };
      touchMember(payload.room, payload.handle, db);
      return { ok: true, data: {} };
    },

    "chat:disarm": async (payload: Commands["chat:disarm"]["payload"]): Promise<CommandResult<"chat:disarm">> => {
      const err = assertionError(() => assertSessionOwnsHandle(payload.handle, payload.sessionId, db));
      if (err) return { ok: false, error: err };
      disarmMember(payload.handle, db);
      return { ok: true, data: {} };
    },

    "chat:unread-waking": async (
      payload: Commands["chat:unread-waking"]["payload"],
    ): Promise<CommandResult<"chat:unread-waking">> => {
      const rooms = unreadWakingCount(payload.handle, db);
      return { ok: true, data: { rooms: payload.room ? rooms.filter((r) => r.room === payload.room) : rooms } };
    },

    "chat:sign-in": async (payload: Commands["chat:sign-in"]["payload"]): Promise<CommandResult<"chat:sign-in">> => {
      const { baseHandle, cwd, repo, branch, pane, statusText, viaPane, room: explicitRoom, noRoom } = payload;
      if (baseHandle !== undefined && !isValidChatName(baseHandle)) return { ok: false, error: `invalid handle "${baseHandle}"` };
      if (explicitRoom !== undefined && !isValidChatName(explicitRoom)) return { ok: false, error: `invalid room "${explicitRoom}"` };

      let sessionId = payload.sessionId;
      let signInCwd = cwd;
      let signInRepo = repo;
      let signInBranch = branch;
      // The room --pane sign-in joins on its own: derived from the TARGET
      // pane's cwd (never the invoking process's, which never resolves one
      // for --pane at all -- see commands/chat.ts's runSignInViaPane) through
      // the SAME deriveRoomForCwd/roomForIdentity codec the CLI's own sign-in
      // uses (lib/chat-room.ts), so a pane-signed-in and a normally-signed-in
      // agent for the same repo always land in the same room -- the
      // index-based repoForCwd label below is display-only (presence.repo)
      // and must not double as the room source, since it diverges from
      // roomForIdentity's path-kind rule on every pool-slot worktree. `--room`
      // overrides the derivation outright; `--no-room` skips it, same as a
      // pane with no repo cwd.
      let derivedRoom: string | null = null;

      if (viaPane) {
        if (!pane) return { ok: false, error: "chat: sign-in --pane requires a pane id" };
        const snap = await herdr<{ snapshot: HerdrSnapshot }>("session.snapshot", {});
        if (!snap.ok) return herdrError(snap);
        const resolved = findPaneSession(snap.result.snapshot, pane);
        if (!resolved) return { ok: false, error: `chat: no Claude session found for pane "${pane}"` };
        sessionId = resolved.sessionId;
        if (signInCwd === undefined) signInCwd = resolved.cwd;

        if (signInCwd) {
          if (signInRepo === undefined) signInRepo = repoForCwd(signInCwd, repoIndex()) ?? undefined;
          if (signInBranch === undefined) signInBranch = await branchForCwd(signInCwd, exec);
        }

        if (noRoom) derivedRoom = null;
        else if (explicitRoom) derivedRoom = explicitRoom;
        else if (signInCwd) derivedRoom = deriveRoomForCwd(signInCwd);
      }
      if (!sessionId) return { ok: false, error: "chat: sign-in requires a sessionId or --pane" };

      // No explicit baseHandle: prefer the name Claude Code's own registry
      // already knows this session by over drawing a fresh pool name, so a
      // repeat sign-in (or one resolved via --pane) lands on a familiar handle.
      let resolvedBase = baseHandle;
      if (resolvedBase === undefined) {
        const binding = inboxDeps.resolve(sessionId);
        if (binding?.name && isValidChatName(binding.name)) resolvedBase = binding.name;
      }

      const data = signIn({ sessionId, baseHandle: resolvedBase, cwd: signInCwd, repo: signInRepo, branch: signInBranch, pane, statusText }, db);

      if (derivedRoom) {
        try {
          joinRoom({ room: derivedRoom, handle: data.handle, cwd: signInCwd, pane }, db);
        } catch (err) {
          log.warn({ err, room: derivedRoom, handle: data.handle }, "chat: --pane sign-in could not join the derived room");
          derivedRoom = null;
        }
      }

      const rooms = listRooms(data.handle, db).map((r) => r.room);
      // A non-advancing peek, not readUnread: the welcome is composed BEFORE
      // delivery is attempted, and readUnread's cursor write happens
      // unconditionally at read time -- a failed or unresolvable welcome
      // would then have permanently skipped whatever it "showed". The
      // cursor only actually advances, per room, once deliverWelcomeOnce
      // confirms the frame was sent.
      const peeked = peekUnread({ handle: data.handle, limit: WELCOME_CATCHUP_LIMIT }, db);
      const catchup = peeked.map((r) => ({ room: r.room, lines: r.messages.map((m) => `${m.handle}: ${m.body}`) }));
      const catchupCursors = peeked.map((r) => ({ room: r.room, upToId: r.messages[r.messages.length - 1]!.id }));
      const welcomeContent = renderWelcome(data.handle, rooms, catchup);
      const welcomeSessionId = sessionId;
      queueMicrotask(() => {
        deliverWelcome(db, deliveryChains, inboxDeps, welcomeSessionId, data.handle, welcomeContent, catchupCursors).catch((err) => {
          log.warn({ err, handle: data.handle }, "chat: welcome delivery failed");
        });
      });

      return { ok: true, data: { ...data, sessionId, room: derivedRoom } };
    },

    // A missing row is the common case, not a refusal: SessionEnd fires for
    // every session and most never sign in.
    "chat:sign-out": async (payload: Commands["chat:sign-out"]["payload"]): Promise<CommandResult<"chat:sign-out">> => {
      const { sessionId } = payload;
      if (!presenceForSession(sessionId, db)) return { ok: true, data: {} };
      signOut(sessionId, undefined, db);
      return { ok: true, data: {} };
    },

    "chat:away": async (payload: Commands["chat:away"]["payload"]): Promise<CommandResult<"chat:away">> => {
      const err = assertionError(() => assertSessionSignedIn(payload.sessionId, db));
      if (err) return { ok: false, error: err };
      setAway(payload.sessionId, payload.text, db);
      return { ok: true, data: {} };
    },

    "chat:back": async (payload: Commands["chat:back"]["payload"]): Promise<CommandResult<"chat:back">> => {
      const err = assertionError(() => assertSessionSignedIn(payload.sessionId, db));
      if (err) return { ok: false, error: err };
      setAway(payload.sessionId, null, db);
      return { ok: true, data: {} };
    },

    "chat:buddies": async (): Promise<CommandResult<"chat:buddies">> => {
      return { ok: true, data: { buddies: listBuddies(Date.now(), db) } };
    },

    "chat:pulse": async (payload: Commands["chat:pulse"]["payload"]): Promise<CommandResult<"chat:pulse">> => {
      const { sessionId, cwd, repo, branch, pane } = payload;
      const err = assertionError(() => assertSessionSignedIn(sessionId, db));
      if (err) return { ok: false, error: err };
      const now = Date.now();
      // Heartbeat before computing unread: the session row must reflect
      // "here now" before status/unread are read back off it.
      pulseSession({ sessionId, cwd, repo, branch, pane, now }, db);
      const row = presenceForSession(sessionId, db)!;
      const status = buddyStatus(row, now);
      return { ok: true, data: { unread: unreadSummaryFor(row.handle, db), status } };
    },

    "chat:dm": async (payload: Commands["chat:dm"]["payload"]): Promise<CommandResult<"chat:dm">> => {
      const { from, to, body, sessionId } = payload;
      if (!isValidChatName(from)) return { ok: false, error: `invalid handle "${from}"` };
      if (!isValidChatName(to)) return { ok: false, error: `invalid handle "${to}"` };
      const err = assertionError(() => assertSessionOwnsHandle(from, sessionId, db));
      if (err) return { ok: false, error: err };
      const humanHandle = getSetting<string>("chat.humanHandle").value;
      if (!isValidChatName(humanHandle)) {
        return { ok: false, error: `chat: chat.humanHandle setting is empty or invalid ("${humanHandle}")` };
      }
      let room: string;
      try {
        ({ room } = dmRoomFor(from, to, humanHandle, db));
      } catch (dmErr) {
        return { ok: false, error: dmErr instanceof Error ? dmErr.message : String(dmErr) };
      }
      // Recipient travels in `mentions`, not the body, so the transcript
      // shows the text as typed and the desk still notifies when `to` is
      // the human.
      const posted = postAndNotify(db, emitEvent, { room, handle: from, body, mentions: [to] }, inboxDeps, deliveryChains);
      if (!posted) return { ok: false, error: "chat: dm failed (retry budget exhausted)" };
      return { ok: true, data: { room, id: posted.id, recipients: posted.recipients } };
    },

    "chat:invite": async (payload: Commands["chat:invite"]["payload"]): Promise<CommandResult<"chat:invite">> => {
      const { paneId, room, note, from, callerPane } = payload;
      if (!isValidChatName(room)) return { ok: false, error: `invalid room "${room}"` };
      if (!isValidChatName(from)) return { ok: false, error: `invalid handle "${from}"` };
      return injectIntoPane({ paneId, text: inviteText(room, from, note), callerPane, herdr });
    },

    "chat:archive": async (payload: Commands["chat:archive"]["payload"]): Promise<CommandResult<"chat:archive">> => {
      const { room, handle, archived } = payload;
      if (!isValidChatName(handle)) return { ok: false, error: `invalid handle "${handle}"` };
      if (!isValidChatName(room)) return { ok: false, error: `invalid room "${room}"` };
      if (typeof archived !== "boolean") return { ok: false, error: "archived must be true or false" };
      try {
        return { ok: true, data: archiveRoom(room, archived, db) };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    "chat:dm-open": async (payload: Commands["chat:dm-open"]["payload"]): Promise<CommandResult<"chat:dm-open">> => {
      const { from, to, sessionId } = payload;
      if (!isValidChatName(from)) return { ok: false, error: `invalid handle "${from}"` };
      if (!isValidChatName(to)) return { ok: false, error: `invalid handle "${to}"` };
      const err = assertionError(() => assertSessionOwnsHandle(from, sessionId, db));
      if (err) return { ok: false, error: err };
      const humanHandle = getSetting<string>("chat.humanHandle").value;
      if (!isValidChatName(humanHandle)) {
        return { ok: false, error: `chat: chat.humanHandle setting is empty or invalid ("${humanHandle}")` };
      }
      try {
        return { ok: true, data: dmRoomFor(from, to, humanHandle, db) };
      } catch (dmErr) {
        return { ok: false, error: dmErr instanceof Error ? dmErr.message : String(dmErr) };
      }
    },
  };
}
