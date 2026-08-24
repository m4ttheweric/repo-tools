/**
 * chat:* — daemon handlers for `rt chat` (RT-48 Task 6).
 * Thin validation + delegation; lib/state/chat-store.ts owns every rule.
 */

import type { Database } from "bun:sqlite";
import {
  isValidChatName,
  joinRoom,
  leaveRoom,
  parseMentions,
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
] as const;

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

    // The row must commit before either emit fires, or a woken agent reads
    // the wake pointer and finds no message yet.
    "chat:post": async (payload: Commands["chat:post"]["payload"]): Promise<CommandResult<"chat:post">> => {
      const { room, handle, body } = payload;
      const posted = postMessage({ room, handle, body }, db);
      if (!posted) return { ok: false, error: "chat: post failed (retry budget exhausted)" };
      emitEvent(`chat/${room}/msg`, { id: posted.id });
      for (const recipient of posted.recipients) {
        emitEvent(`chat/wake/${recipient}`, { id: posted.id, room });
      }
      // Independent of chat_members / wake_on: agents create rooms via
      // join-creates, so the human is typically not a member yet, and a
      // member with wake_on='none' must still get a desk alert.
      const humanHandle = getSetting<string>("chat.humanHandle").value;
      if (humanHandle && parseMentions(body).includes(humanHandle)) {
        notifyEnabled(
          CHAT_NOTIFICATION_CATEGORY,
          `#${room}`,
          `${handle}: ${body}`,
          undefined,
          undefined,
          `chat:${posted.id}`,
        );
      }
      return { ok: true, data: posted };
    },

    "chat:read": async (payload: Commands["chat:read"]["payload"]): Promise<CommandResult<"chat:read">> => {
      const { handle, room, limit, sinceMs } = payload;
      const rooms = readUnread({ handle, room, limit: limit ?? 20, sinceMs }, db);
      return { ok: true, data: { rooms } };
    },

    "chat:rooms": async (payload: Commands["chat:rooms"]["payload"]): Promise<CommandResult<"chat:rooms">> => {
      return { ok: true, data: { rooms: listRooms(payload.handle, db) } };
    },

    "chat:who": async (payload: Commands["chat:who"]["payload"]): Promise<CommandResult<"chat:who">> => {
      return { ok: true, data: { members: listMembers(payload.room, db) } };
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
      armMember(payload.room, payload.handle, db);
      return { ok: true, data: {} };
    },

    "chat:touch": async (payload: Commands["chat:touch"]["payload"]): Promise<CommandResult<"chat:touch">> => {
      touchMember(payload.handle, db);
      return { ok: true, data: {} };
    },

    "chat:disarm": async (payload: Commands["chat:disarm"]["payload"]): Promise<CommandResult<"chat:disarm">> => {
      disarmMember(payload.handle, db);
      return { ok: true, data: {} };
    },

    "chat:unread-waking": async (
      payload: Commands["chat:unread-waking"]["payload"],
    ): Promise<CommandResult<"chat:unread-waking">> => {
      const rooms = unreadWakingCount(payload.handle, db);
      return { ok: true, data: { rooms: payload.room ? rooms.filter((r) => r.room === payload.room) : rooms } };
    },
  };
}
