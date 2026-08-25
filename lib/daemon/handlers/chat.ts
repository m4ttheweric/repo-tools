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
  listMessages,
  markRead,
  unreadWakingCount,
  listRooms,
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
import { getSetting } from "../../settings/resolve.ts";
import type { Commands } from "../../../packages/rt-client/src/commands.ts";
import type { CommandResult, TypedHandlers } from "./types.ts";

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
 * The row must commit before either emit fires, or a woken agent reads the
 * wake pointer and finds no message yet. Shared by chat:post and chat:dm so
 * the desk-notify check (mentions merged the same way postMessage merges
 * them for storage) never diverges between the two entry points.
 */
function postAndNotify(
  db: Database,
  emitEvent: (topic: string, payload?: unknown) => unknown,
  args: { room: string; handle: string; body: string; mentions?: string[] },
): { id: number; recipients: string[] } | undefined {
  const { room, handle, body, mentions } = args;
  const posted = postMessage({ room, handle, body, mentions }, db);
  if (!posted) return undefined;
  emitEvent(`chat/${room}/msg`, { id: posted.id });
  for (const recipient of posted.recipients) {
    emitEvent(`chat/wake/${recipient}`, { id: posted.id, room });
  }
  // Independent of chat_members / wake_on: agents create rooms via
  // join-creates, so the human is typically not a member yet, and a
  // member with wake_on='none' must still get a desk alert.
  const humanHandle = getSetting<string>("chat.humanHandle").value;
  const allMentions = mergeMentions(body, mentions);
  if (humanHandle && allMentions.includes(humanHandle)) {
    const dm = dmParticipants(room, db);
    const title = dm ? `DM from ${handle}` : `#${room}`;
    notifyEnabled(
      CHAT_NOTIFICATION_CATEGORY,
      title,
      `${handle}: ${body}`,
      undefined,
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

export function createChatHandlers(opts: {
  db: Database;
  emitEvent: (topic: string, payload?: unknown) => unknown;
}): Pick<TypedHandlers, (typeof CHAT_COMMANDS)[number]> & { db: Database } {
  const { db, emitEvent } = opts;

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
      const posted = postAndNotify(db, emitEvent, { room, handle, body, mentions });
      if (!posted) return { ok: false, error: "chat: post failed (retry budget exhausted)" };
      return { ok: true, data: posted };
    },

    "chat:read": async (payload: Commands["chat:read"]["payload"]): Promise<CommandResult<"chat:read">> => {
      const { handle, room, limit, sinceMs } = payload;
      const rooms = readUnread({ handle, room, limit: limit ?? 20, sinceMs }, db);
      return { ok: true, data: { rooms } };
    },

    "chat:rooms": async (payload: Commands["chat:rooms"]["payload"]): Promise<CommandResult<"chat:rooms">> => {
      const rooms = listRooms(payload.handle, db).map((room) => {
        const dm = dmParticipants(room.room, db);
        return dm ? { ...room, kind: "dm" as const, participants: dm } : room;
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
        // read stale. joinedAt as the lastSeenAt floor keeps a member who
        // joined but never touched/armed from reading as instantly offline.
        const memberLastSeenAt = member.lastSeenAt ?? member.joinedAt;
        const status = presence
          ? buddyStatus(presence, now, th)
          : buddyStatus({ lastSeenAt: memberLastSeenAt, tailSeenAt: memberLastSeenAt, armedAt: member.armedAt }, now, th);
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
      touchMember(payload.handle, db);
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
      const { sessionId, baseHandle, cwd, repo, branch, pane, statusText } = payload;
      if (!isValidChatName(baseHandle)) return { ok: false, error: `invalid handle "${baseHandle}"` };
      const data = signIn({ sessionId, baseHandle, cwd, repo, branch, pane, statusText }, db);
      return { ok: true, data };
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
      let room: string;
      try {
        ({ room } = dmRoomFor(from, to, humanHandle, db));
      } catch (dmErr) {
        return { ok: false, error: dmErr instanceof Error ? dmErr.message : String(dmErr) };
      }
      // Recipient travels in `mentions`, not the body, so the transcript
      // shows the text as typed and the desk still notifies when `to` is
      // the human.
      const posted = postAndNotify(db, emitEvent, { room, handle: from, body, mentions: [to] });
      if (!posted) return { ok: false, error: "chat: dm failed (retry budget exhausted)" };
      return { ok: true, data: { room, id: posted.id, recipients: posted.recipients } };
    },
  };
}
