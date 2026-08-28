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
  archiveRoom,
  roomArchivedAt,
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
import { herdrRequest, waitTimeout } from "../../herdr/client.ts";
import { herdrError } from "./pane.ts";
import { lazyChildLogger } from "../../daemon-logger.ts";
import type { Commands } from "../../../packages/rt-client/src/commands.ts";
import type { CommandResult, TypedHandlers } from "./types.ts";

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

/** Generous, not tight: bounds a single message body without constraining any real conversation. */
const MAX_BODY_BYTES = 64 * 1024;

function isValidBody(body: unknown): body is string {
  return typeof body === "string" && body.length > 0 && Buffer.byteLength(body, "utf8") <= MAX_BODY_BYTES;
}

/** Rooms `handle` already belongs to whose name is a prefix/suffix of the typo'd one — the common shape of a "deck" vs "deck-main" miss. */
function closestRoomNames(typo: string, handle: string, db: Database): string[] {
  const known = listRooms(handle, db, { includeArchived: true }).map((r) => r.room);
  return known.filter((r) => r.startsWith(typo) || typo.startsWith(r)).slice(0, 3);
}

/**
 * `limit: -1` reaches `ORDER BY id ASC LIMIT ?`, where SQLite treats a
 * negative LIMIT as unlimited, so a viewer/agent bug returns and
 * JSON-serializes an entire (100k-row) room on the event loop; a
 * non-numeric limit hits a datatype-mismatch SQLite error instead.
 * Mirrors the events handler's `num()` coercion pattern.
 */
const MAX_CHAT_LIMIT = 500;

function clampLimit(v: unknown, fallback: number): number {
  if (v == null || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), 1), MAX_CHAT_LIMIT);
}

/** An unchecked value here lands on chat_members (and, on a join-creates, chat_room_defaults for every future joiner) and is silently treated as mention-only — never "none", never "all", never reported. */
const VALID_WAKE_ON = ["mention", "all", "none"] as const;

function isValidWakeOn(v: unknown): v is (typeof VALID_WAKE_ON)[number] {
  return typeof v === "string" && (VALID_WAKE_ON as readonly string[]).includes(v);
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
  // The row is durable at this point. Every step below is best-effort: a
  // throw here (a full disk, an orphan daemon holding an events.db lock)
  // must never surface as a failed post — the caller would retry and post
  // the message twice — and one recipient's failure must not skip the wake
  // for the rest.
  try {
    emitEvent(`chat/${room}/msg`, { id: posted.id });
  } catch (err) {
    log.warn({ err, id: posted.id, room }, "chat: emit for the posted message threw; message is durable, this emit was not");
  }
  for (const recipient of posted.recipients) {
    try {
      emitEvent(`chat/wake/${recipient}`, { id: posted.id, room });
    } catch (err) {
      log.warn({ err, id: posted.id, room, recipient }, "chat: wake emit threw for one recipient; continuing to the rest");
    }
  }
  // Independent of chat_members / wake_on: agents create rooms via
  // join-creates, so the human is typically not a member yet, and a
  // member with wake_on='none' must still get a desk alert.
  const humanHandle = getSetting<string>("chat.humanHandle").value;
  const allMentions = mergeMentions(body, mentions);
  if (humanHandle && allMentions.includes(humanHandle)) {
    try {
      const dm = dmParticipants(room, db);
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
    } catch (err) {
      log.warn({ err, id: posted.id, room }, "chat: desk notify threw after a successful post");
    }
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

const INVITE_WAIT_MS = 5_000;

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
}): Pick<TypedHandlers, (typeof CHAT_COMMANDS)[number]> & { db: Database } {
  const { db, emitEvent } = opts;
  const herdr = opts.herdr ?? herdrRequest;

  return {
    db,

    "chat:join": async (payload: Commands["chat:join"]["payload"]): Promise<CommandResult<"chat:join">> => {
      const { room, handle, wakeOn, cwd, pane } = payload;
      if (!isValidChatName(handle)) return { ok: false, error: `invalid handle "${handle}"` };
      if (!isValidChatName(room)) return { ok: false, error: `invalid room "${room}"` };
      if (wakeOn !== undefined && !isValidWakeOn(wakeOn)) {
        return { ok: false, error: `invalid wakeOn "${wakeOn}"; must be one of ${VALID_WAKE_ON.join(", ")}` };
      }
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
      if (!isValidChatName(room)) return { ok: false, error: `invalid room "${room}"` };
      if (!isValidChatName(handle)) return { ok: false, error: `invalid handle "${handle}"` };
      if (!isValidBody(body)) return { ok: false, error: `body must be a non-empty string under ${MAX_BODY_BYTES} bytes` };
      if (mentions !== undefined && !Array.isArray(mentions)) return { ok: false, error: "mentions must be an array of handles" };
      const invalidMention = mentions?.find((m) => !isValidChatName(m));
      if (invalidMention !== undefined) return { ok: false, error: `invalid handle "${invalidMention}"` };
      // A typo'd room previously no-op'd through postMessage's REVIVE (a
      // no-op for a room with no chat_rooms row) and returned ok with no
      // recipients — unreachable except by the exact typo'd name.
      if (roomArchivedAt(room, db) === undefined) {
        const nearby = closestRoomNames(room, handle, db);
        return { ok: false, error: `unknown room "${room}"${nearby.length ? ` — did you mean: ${nearby.join(", ")}` : ""}` };
      }
      const posted = postAndNotify(db, emitEvent, { room, handle, body, mentions });
      if (!posted) return { ok: false, error: "chat: post failed (retry budget exhausted)" };
      return { ok: true, data: posted };
    },

    "chat:read": async (payload: Commands["chat:read"]["payload"]): Promise<CommandResult<"chat:read">> => {
      const { handle, room, limit, sinceMs } = payload;
      const rooms = readUnread({ handle, room, limit: clampLimit(limit, 20), sinceMs }, db);
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
      const messages = listMessages({ room, before, limit: clampLimit(limit, 50) }, db);
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
      const { sessionId, baseHandle, cwd, repo, branch, pane, statusText } = payload;
      // A missing/empty sessionId binds as NULL against session_id TEXT
      // PRIMARY KEY, which SQLite accepts silently: the row then holds the
      // UNIQUE handle, but the reclaim-by-session_id path can never match
      // it, so every later sign-in under this base handle 500s with a
      // UNIQUE constraint failure until prunePresence eventually removes it.
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        return { ok: false, error: "chat:sign-in requires a non-empty sessionId" };
      }
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
      if (!isValidBody(body)) return { ok: false, error: `body must be a non-empty string under ${MAX_BODY_BYTES} bytes` };
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
      const posted = postAndNotify(db, emitEvent, { room, handle: from, body, mentions: [to] });
      if (!posted) return { ok: false, error: "chat: dm failed (retry budget exhausted)" };
      return { ok: true, data: { room, id: posted.id, recipients: posted.recipients } };
    },

    "chat:invite": async (payload: Commands["chat:invite"]["payload"]): Promise<CommandResult<"chat:invite">> => {
      const { paneId, room, note, from, callerPane } = payload;
      if (!isValidChatName(room)) return { ok: false, error: `invalid room "${room}"` };
      if (!isValidChatName(from)) return { ok: false, error: `invalid handle "${from}"` };
      const refused = (reason: string): CommandResult<"chat:invite"> => ({ ok: true, data: { paneId, delivered: "refused", reason } });
      if (callerPane && callerPane === paneId) return refused("that is this pane");

      const probe = await herdr<{ agent: { agent: string; agent_status: string } }>("agent.get", { target: paneId });
      if (!probe.ok) {
        if (probe.code === "agent_not_found" || probe.code === "agent_target_ambiguous") return refused("not a claude pane");
        return herdrError(probe);
      }
      if (probe.result.agent.agent !== "claude") return refused("not a claude pane");
      const status = probe.result.agent.agent_status;
      if (status === "blocked") return refused("at a prompt");

      const text = inviteText(room, from, note);
      if (status === "working") {
        const queued = await herdr("agent.prompt", { target: paneId, text });
        if (!queued.ok) return queued.code === "agent_blocked" ? refused("at a prompt") : herdrError(queued);
        return { ok: true, data: { paneId, delivered: "queued" } };
      }

      const prompted = await herdr("agent.prompt", { target: paneId, text, wait: { until: ["working"], timeout_ms: INVITE_WAIT_MS } }, { timeoutMs: waitTimeout(INVITE_WAIT_MS) });
      if (prompted.ok) return { ok: true, data: { paneId, delivered: "accepted" } };
      if (prompted.code === "agent_blocked") return refused("at a prompt");
      if (prompted.code !== "timeout" && prompted.code !== "agent_prompt_stalled") return herdrError(prompted);

      // The Claude TUI can absorb the bundled Enter into the composer; one nudge, one more wait.
      await herdr("pane.send_keys", { pane_id: paneId, keys: ["enter"] });
      const nudged = await herdr("agent.wait", { target: paneId, until: ["working"], timeout_ms: INVITE_WAIT_MS }, { timeoutMs: waitTimeout(INVITE_WAIT_MS) });
      return { ok: true, data: { paneId, delivered: nudged.ok ? "accepted" : "queued" } };
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
