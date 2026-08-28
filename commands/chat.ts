/**
 * rt chat — group chat for agents and their human, over the rt daemon.
 *
 *   rt chat join <room> [--as <h>] [--wake-on mention|all|none]
 *   rt chat leave <room>
 *   rt chat archive <room> [--reopen]              park a room for everyone; a post revives it
 *   rt chat post <room> <<'EOF' ... EOF          the body on stdin; <text> for a one-liner
 *   rt chat read [room] [--limit 20] [--full] [--since <dur>]
 *   rt chat read <room> --last <n>                 newest N regardless of cursor, then marks read
 *   rt chat rooms
 *   rt chat who [room]
 *   rt chat mark [room]
 *   rt chat sign-in [--as <h>] [--status <text>] [--no-room] [--room <name>] [--session <id>]
 *   rt chat sign-in --pane <id> [--as <h>] [--status <text>]   sign in a herdr pane's session, no CLAUDE_CODE_SESSION_ID needed
 *   rt chat sign-out [--quiet] [--session <id>]
 *   rt chat sign-out --pane <id> [--quiet]         sign out a herdr pane's session daemon-side, no CLAUDE_CODE_SESSION_ID needed
 *   rt chat away <text> [--session <id>]           rt chat back [--session <id>]
 *   rt chat buddies [--json]                       the roster; bare `who` aliases it
 *   rt chat dm <handle> <<'EOF' ... EOF           same body rules as post
 *   rt chat invite <pane> --room <room> [--note <text>]   types /chat:join into a herdr pane
 *
 * Delivery is automatic: a signed-in agent's messages arrive straight in its
 * Claude session inbox (the daemon's socket push), so there is no tail to
 * arm and no pulse heartbeat to fire on every prompt.
 *
 * Identity resolution is CLIENT-SIDE (see resolveHandle): HERDR_PANE_ID and
 * the cwd's repo only exist in this process, never in the daemon, so the
 * resolved handle travels in every payload. `post`/`read`/`join` re-resolve
 * on every invocation — see resolveHandle's doc comment for why there is no
 * branch component.
 *
 * Spec: docs/superpowers/specs/2026-08-23-rt-chat-design.md
 */

import { readFileSync } from "fs";
import { execSync } from "child_process";
import { homedir, hostname } from "os";
import { basename } from "path";

import { loadRepoIndex } from "../lib/repo-index.ts";
import { repoLabel } from "../lib/repo-arg.ts";
import { findGitRoot, repoAliasForPath, resolveMainWorktreePath } from "../lib/repo-for-cwd.ts";
import { slugifyChatName as slugify } from "../lib/chat-room-name.ts";
import { roomForIdentity, deriveRoomForCwd } from "../lib/chat-room.ts";
import { getCurrentBranch, getRepoRoot } from "../lib/git.ts";
import { getRepoIdentityForRoot } from "../lib/repo.ts";
import { parseIdentity } from "../lib/settings/identity.ts";
import { getSetting } from "../lib/settings/resolve.ts";
import { isValidChatName } from "../lib/state/index.ts";
import { shellQuote } from "../lib/herdr-launch.ts";
import {
  currentSessionId,
  deleteChatSession,
  isValidSessionId,
  readChatSession,
  writeChatSession,
} from "../lib/chat-session.ts";
import { chatViewerUrl, readChatViewerUrlSetting } from "../lib/chat-viewer-url.ts";
import { parseDuration } from "./events.ts";
import {
  chatArchive,
  chatAway,
  chatBack,
  chatBuddies,
  chatDm,
  chatInvite,
  chatJoin,
  chatLeave,
  chatMark,
  chatMessages,
  chatPost,
  chatRead,
  chatRooms,
  chatSignIn,
  chatSignOut,
  chatWho,
} from "../packages/rt-client/src/index.ts";
import type {
  BuddyStatus,
  ChatMember,
  ChatMessage,
  PresenceRow,
  RoomSummary,
  RtResponse,
  WakeMode,
} from "../packages/rt-client/src/index.ts";

// ─── arg parsing (commands/events.ts conventions) ────────────────────────────

const FLAGS_WITH_VALUES = new Set(["--as", "--wake-on", "--limit", "--since", "--room", "--sock", "--session", "--status", "--file", "--last", "--note", "--pane"]);

function positional(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      if (FLAGS_WITH_VALUES.has(a)) i++; // skip the flag's value slot
      continue;
    }
    return a;
  }
  return undefined;
}

/** Every positional token, in order, skipping flags and their value slots. */
function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      if (FLAGS_WITH_VALUES.has(a)) i++; // skip the flag's value slot
      continue;
    }
    out.push(a);
  }
  return out;
}

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

/** `--sock` as RtClientOptions, or `{}` when unset. */
function sockOpts(args: string[]): { sockPath?: string } {
  const sockPath = flagValue(args, "--sock");
  return sockPath ? { sockPath } : {};
}

function fail(msg: string): never {
  console.error(`rt chat: ${msg}`);
  process.exit(1);
}

const NAME_RULE = "must match ^[a-z0-9._-]+$";

/** Rejects with the reason rather than silently normalizing (Global Constraint). */
function requireValidName(kind: string, name: string): void {
  if (!isValidChatName(name)) fail(`invalid ${kind} "${name}" — ${NAME_RULE}`);
}

/** sign-in/sign-out only — every other verb's session-id use (resolveHandle) goes through readChatSession, which degrades an invalid id to "no session" rather than failing. */
function requireValidSessionId(id: string): void {
  if (!isValidSessionId(id)) fail(`invalid session id "${id}" — must match ^[A-Za-z0-9._-]+$`);
}

function unwrap<T>(res: RtResponse<T>, label: string): T {
  if (!res.ok || res.data === undefined) fail(res.error ?? `${label} failed`);
  return res.data;
}

// ─── handle derivation ────────────────────────────────────────────────────────
//
// Order: the session file (signed in) → --as → chat.handle (user scope) →
// herdr pane title (HERDR_PANE_ID) → <rt-repo-name>-<cwd-basename> → cwd
// relative to $HOME → <user>-<host>. Position 0 wins over --as for every
// verb but sign-in, which resolves its base handle through the --as-first
// chain below BEFORE any session file exists — see resolveBaseHandle.
//
// Sign-in itself stops after chat.handle and draws a first name from
// lib/chat-names.ts instead (see resolveSignInBaseHandle): the pane title
// of every Claude pane is the same "Claude Code", and a directory handle
// is nothing a human would call an agent by. The directory chain stays
// for the unsigned path, where a name that changed on every call would
// scatter one session's posts across many authors.
//
// NO BRANCH COMPONENT: sign-in resolves its handle once and holds it for the
// whole session (the session file), while post/read/join re-resolve on every
// call. A branch-bearing handle would drift on a mid-session branch switch,
// desyncing the signed-in presence row from the identity those later calls
// would resolve. A directory cannot drift.
//
// The repo name comes from rt's index (loadRepoIndex, a FILE read — never a
// git spawn, see commands/settings-keys.ts's "async — never a sync spawn"
// rule), keyed by the MAIN worktree path. Two directory-derived drafts both
// computed wrong on real pools: "acme/gamma" IS the main worktree, so
// using its own directory name as the repo would make every sibling slot's
// repo "gamma" (wrong, and it renames every agent on the machine if the
// pool is rebuilt with a different slot as main); "workforest-fixture/main"
// reducing to bare "main" is the machine-wide pidfile collision this design
// eliminates. No collapse rule either — redundancy (ugly-and-unique) beats a
// pretty-and-colliding fallback.
//
// Deliberately NOT resolved through an existing chat_members row for this
// cwd: that would be the only daemon-dependent step in an otherwise local
// order (failing during exactly the outage every other step here survives),
// would outlive its task (a recycled worktree slot inherits the previous
// occupant's identity), and two rows for one cwd have no defined tie-break.

/** `<alias>-<cwd-basename>`, or null when `cwd` isn't inside any indexed repo (or the git pointer is broken). */
function deriveRepoDirHandle(cwd: string, index: Record<string, string>): string | null {
  const worktreeRoot = findGitRoot(cwd) ?? cwd;
  const mainPath = resolveMainWorktreePath(worktreeRoot);
  if (!mainPath) return null;
  const alias = repoAliasForPath(mainPath, index);
  if (!alias) return null;
  return slugify(`${alias}-${basename(cwd)}`);
}

function repoDirHandle(cwd: string): string | null {
  let index: Record<string, string>;
  try {
    index = loadRepoIndex();
  } catch {
    return null;
  }
  return deriveRepoDirHandle(cwd, index);
}

function cwdRelativeHandle(cwd: string, home: string): string {
  let rel: string;
  if (cwd === home) rel = "home";
  else if (cwd.startsWith(`${home}/`)) rel = cwd.slice(home.length + 1);
  else rel = cwd.replace(/^\/+/, "");
  return slugify(rel.replace(/\//g, "-"));
}

function userHostHandle(): string {
  const user = process.env.USER ?? process.env.LOGNAME ?? "user";
  return slugify(`${user}-${hostname()}`);
}

/** herdr pane title via HERDR_PANE_ID — a sync `herdr` spawn, same convention as lib/herdr-launch.ts; degrades to null on any failure (missing herdr, stale pane, non-JSON). */
function herdrPaneHandle(): string | null {
  const paneId = process.env.HERDR_PANE_ID;
  if (!paneId) return null;
  try {
    const raw = execSync(`herdr pane get ${shellQuote(paneId)}`, { encoding: "utf8", stdio: "pipe" });
    const parsed = JSON.parse(raw);
    const title: string | undefined = parsed?.result?.pane?.terminal_title_stripped ?? parsed?.result?.pane?.terminal_title;
    return title ? slugify(title) : null;
  } catch {
    return null;
  }
}

/**
 * Sign-in's chain: `--as` → chat.handle → the base this session already
 * signed in as (a repeat sign-in keeps its name) → undefined, which asks the
 * daemon to draw a first name (it holds the buddy list and the
 * least-recently-used ledger, so the draw is made where both live).
 */
function resolveSignInBaseHandle(args: string[], sessionId: string | undefined): string | undefined {
  const explicit = flagValue(args, "--as");
  if (explicit) {
    requireValidName("handle", explicit);
    return explicit;
  }
  const fromSetting = readChatHandleSetting();
  if (fromSetting) return fromSetting;
  const prior = readChatSession(sessionId);
  if (prior && typeof prior.baseHandle === "string" && isValidChatName(prior.baseHandle)) return prior.baseHandle;
  return undefined;
}

function readChatHandleSetting(): string | undefined {
  try {
    const resolved = getSetting<string>("chat.handle");
    return typeof resolved.value === "string" && resolved.value ? resolved.value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `--pane` sign-in's baseHandle chain is `--as` only, never chat.handle: that
 * setting names the INVOKING process's own preferred handle, and this
 * process isn't the one signing in -- a different pane's session is. Falling
 * through to it would hand the invoker's name to whatever pane happened to
 * be signed in this way, silently colliding the two. No "prior session"
 * fallback either, for the same reason: this process has no session of its
 * own to have a prior handle for.
 */
function resolvePaneBaseHandle(args: string[]): string | undefined {
  const explicit = flagValue(args, "--as");
  if (explicit) {
    requireValidName("handle", explicit);
    return explicit;
  }
  return undefined;
}

/** The --as-first chain (positions 1-6): what sign-in assigns a baseHandle from, and what resolveHandle falls back to for an unsigned-in session. */
function resolveBaseHandle(args: string[]): string {
  const explicit = flagValue(args, "--as");
  if (explicit) {
    requireValidName("handle", explicit);
    return explicit;
  }

  const fromSetting = readChatHandleSetting();
  if (fromSetting) return fromSetting;

  const fromPane = herdrPaneHandle();
  if (fromPane) return fromPane;

  let cwd: string | null;
  try {
    cwd = process.cwd();
  } catch {
    cwd = null;
  }

  if (cwd) {
    const fromRepo = repoDirHandle(cwd);
    if (fromRepo) return fromRepo;
    return cwdRelativeHandle(cwd, process.env.HOME ?? homedir());
  }

  return userHostHandle();
}

/**
 * Position 0 (the session file) wins over every other position, for every
 * verb but sign-in itself (which calls resolveBaseHandle directly, before a
 * session file exists for this sign-in). `--as` alongside an active session
 * is refused rather than silently overridden — a second identity is exactly
 * the desync the base resolution order exists to prevent.
 */
function resolveHandle(args: string[]): string {
  const session = readChatSession(currentSessionId(args));
  if (session) {
    if (flagValue(args, "--as") !== undefined) {
      fail(`signed in as ${session.handle} — sign out to change identity (rt chat sign-out)`);
    }
    return session.handle;
  }

  return resolveBaseHandle(args);
}

function safeCwd(): string | undefined {
  try {
    return process.cwd();
  } catch {
    return undefined;
  }
}

// ─── rendering ────────────────────────────────────────────────────────────────

function pluralize(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function renderJoin(room: string, handle: string, data: { memberCount: number; unread: number }): string {
  const parts = [pluralize(data.memberCount, "member")];
  if (data.memberCount === 1) parts.push("you are alone here");
  else if (data.unread > 0) parts.push(`${data.unread} unread`);
  return `✓ joined #${room} as ${handle} — ${parts.join(", ")}`;
}

function renderSignIn(
  handle: string,
  ctx: { repo?: string; branch?: string; pane?: string },
  inRepo: boolean,
  noRoomFlag: boolean,
  room: { name: string; memberCount: number } | null,
): string {
  const parts = [`signed in as ${handle}`];
  if (ctx.repo) parts.push(ctx.repo);
  if (ctx.branch) parts.push(ctx.branch);
  if (ctx.pane) parts.push(`pane ${ctx.pane}`);
  if (room) {
    parts.push(`joined #${room.name} (${pluralize(room.memberCount, "member")})`);
  } else if (!inRepo) {
    parts.push("not in a repository");
    parts.push("no room joined");
  } else {
    parts.push(noRoomFlag ? "no room joined (--no-room)" : "no room joined");
  }
  return parts.join(" · ");
}

function relativeAgo(ms: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

/** A DM room's display name — the handler's `a ↔ b` pair, never the hashed `dm-<hash>` room id (that id is a store key, not something anyone should read). */
function roomHeading(r: RoomSummary): string {
  if (r.kind === "dm" && r.participants) return `${r.participants.a} ↔ ${r.participants.b}`;
  return `#${r.room}`;
}

/**
 * A room→heading lookup for `handle`'s own rooms, for verbs (`read`, `who`)
 * whose own response carries a bare room key with no participant pair.
 * Falls back to `#room` for any room `chat:rooms` doesn't return — the
 * daemon is unreachable, or `handle` isn't actually a member.
 */
async function dmHeadingsFor(handle: string): Promise<(room: string) => string> {
  const res = await chatRooms({ handle });
  const byRoom = new Map<string, string>();
  if (res.ok && res.data) {
    for (const r of res.data.rooms) byRoom.set(r.room, roomHeading(r));
  }
  return (room: string) => byRoom.get(room) ?? `#${room}`;
}

const DIRECT_SECTION_LABEL = "direct";

function renderRooms(rooms: RoomSummary[]): string {
  if (rooms.length === 0) return "(not a member of any room)";
  // Shared column widths across both sections, so a wide "a ↔ b" heading in
  // the direct section never desyncs the channel rows above it.
  const nameWidth = Math.max(...rooms.map((r) => roomHeading(r).length + 1));
  const renderRow = (r: RoomSummary): string => {
    const name = roomHeading(r).padEnd(nameWidth + 2);
    const members = pluralize(r.memberCount, "member").padEnd(12);
    const unread = r.unread === 0
      ? "—"
      : `${r.unread} unread${r.mentions > 0 ? ` (${pluralize(r.mentions, "mention")})` : ""}`;
    const last = r.lastPostedAt !== undefined ? `last ${relativeAgo(r.lastPostedAt)} ago` : "never posted";
    return `${name}${members}${unread.padEnd(22)}${last}`;
  };

  const channels = rooms.filter((r) => r.kind !== "dm").map(renderRow);
  const directs = rooms.filter((r) => r.kind === "dm").map(renderRow);
  const sections = [...channels];
  if (directs.length > 0) sections.push(DIRECT_SECTION_LABEL, ...directs);
  return sections.join("\n");
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function renderMessage(m: ChatMessage, full: boolean): string {
  const time = new Date(m.postedAt).toISOString().slice(11, 16);
  return `  [${time}] ${m.handle}: ${full ? m.body : truncate(m.body, 200)}`;
}

/**
 * `chat:read`'s own rows carry no participant pair, only the room key — so a
 * DM heading needs `headingFor`, sourced from a `chat:rooms` call the caller
 * makes once for every room in the response (falls back to `#room` for a
 * room `chat:rooms` doesn't recognize, same as `roomHeading`'s own default).
 */
function renderReadRooms(
  rooms: { room: string; messages: ChatMessage[] }[],
  full: boolean,
  headingFor: (room: string) => string = (room) => `#${room}`,
): string {
  if (rooms.length === 0) return "(no unread)";
  return rooms
    .map((r) => [headingFor(r.room), ...r.messages.map((m) => renderMessage(m, full))].join("\n"))
    .join("\n\n");
}

// The spec's three statuses (Statuses table), computed server-side by
// buddyStatus and carried on every ChatMember/PresenceRow already — never
// recomputed here. "live" reads as "listening", matching the AIM mapping.
const STATUS_WORD: Record<BuddyStatus, string> = {
  live: "listening",
  idle: "idle",
  offline: "offline",
};

/** `heading` is already formatted (`#room` or `roomHeading`'s `a ↔ b` pair) — chosen by the caller, which alone knows whether `room` resolved to a DM. */
function renderWhoSection(heading: string, members: ChatMember[]): string {
  const lines = members.map((m) => {
    const cwd = m.cwd ? `  ${m.cwd}` : "";
    const pane = m.pane ? `  [${m.pane}]` : "";
    const status = STATUS_WORD[m.status];
    return `  ${m.handle}  ${status}${cwd}${pane}`;
  });
  return [heading, ...(lines.length > 0 ? lines : ["  (no members)"])].join("\n");
}

// ─── the buddy list ─────────────────────────────────────────────────────────

function buddyDeets(b: PresenceRow): string {
  return [b.repo, b.branch, b.pane ? `pane ${b.pane}` : undefined].filter((s): s is string => Boolean(s)).join(" · ");
}

/** The status word plus the staleness detail for an idle row (a live or offline row needs none). */
function buddyStatusWord(b: PresenceRow & { status: BuddyStatus }): string {
  switch (b.status) {
    case "live":
      return "listening";
    case "idle":
      return `idle ${relativeAgo(b.lastSeenAt)}`;
    case "offline":
      return "offline";
  }
}

// Listening first, most-stale last — the order someone scanning the roster
// wants, not buddyStatus's own evaluation order (used to settle a single
// row's status, never to rank rows against each other).
const BUDDY_SECTIONS: BuddyStatus[] = ["live", "idle", "offline"];

function renderBuddies(buddies: Array<PresenceRow & { status: BuddyStatus }>): string {
  if (buddies.length === 0) return "(nobody signed in)";

  // Columns span every non-offline row (offline collapses to its own line,
  // so it never stretches the other rows' alignment). Each column's width is
  // the longest cell plus a fixed gap to the next column.
  const regular = buddies.filter((b) => b.status !== "offline");
  const handleWidth = Math.max(0, ...regular.map((b) => b.handle.length));
  const nameColWidth = handleWidth + 2 /* "● " */ + 2 /* gap */;
  const deetsWidth = Math.max(0, ...regular.map((b) => buddyDeets(b).length));
  const deetsColWidth = deetsWidth > 0 ? deetsWidth + 3 : 0;

  const lines: string[] = [];
  for (const status of BUDDY_SECTIONS) {
    const rows = buddies.filter((b) => b.status === status);
    if (rows.length === 0) continue;
    if (status === "offline") {
      const entries = rows.map((b) => `${b.handle} (${relativeAgo(b.signedOutAt ?? b.lastSeenAt)} ago)`).join(", ");
      lines.push(`  offline (last 24h): ${entries}`);
      continue;
    }
    const bullet = status === "idle" ? "○" : "●"; // filled = live
    for (const b of rows) {
      const name = `${bullet} ${b.handle}`.padEnd(nameColWidth);
      const deets = buddyDeets(b).padEnd(deetsColWidth);
      let line = `${name}${deets}${buddyStatusWord(b)}`;
      if (b.statusText) line += `   ${b.statusText}`;
      lines.push(line);
    }
  }
  return lines.join("\n");
}

// ─── verbs ────────────────────────────────────────────────────────────────────

async function runJoin(args: string[]): Promise<void> {
  const room = positional(args);
  if (!room) fail("usage: rt chat join <room> [--as <handle>] [--wake-on mention|all|none]");
  requireValidName("room", room);

  const handle = resolveHandle(args);
  requireValidName("handle", handle);

  const wakeOnRaw = flagValue(args, "--wake-on");
  let wakeOn: WakeMode | undefined;
  if (wakeOnRaw !== undefined) {
    if (wakeOnRaw !== "mention" && wakeOnRaw !== "all" && wakeOnRaw !== "none") {
      fail(`--wake-on must be mention, all, or none (got "${wakeOnRaw}")`);
    }
    wakeOn = wakeOnRaw;
  }

  const res = await chatJoin({ room, handle, wakeOn, cwd: safeCwd(), pane: process.env.HERDR_PANE_ID });
  const data = unwrap(res, "join");

  if (args.includes("--json")) {
    console.log(JSON.stringify({ ok: true, room, ...data }));
    return;
  }
  console.log(renderJoin(room, data.handle, data));
}

async function runLeave(args: string[]): Promise<void> {
  const room = positional(args);
  if (!room) fail("usage: rt chat leave <room>");
  requireValidName("room", room);

  const handle = resolveHandle(args);
  requireValidName("handle", handle);

  const res = await chatLeave({ room, handle });
  unwrap(res, "leave");

  if (args.includes("--json")) {
    console.log(JSON.stringify({ ok: true }));
    return;
  }
  console.log(`✓ left #${room} (${handle})`);
}

async function runArchive(args: string[]): Promise<void> {
  const room = positional(args);
  if (!room) fail("usage: rt chat archive <room> [--reopen]");
  requireValidName("room", room);

  const handle = resolveHandle(args);
  requireValidName("handle", handle);

  const archived = !args.includes("--reopen");
  const res = await chatArchive({ room, handle, archived });
  const data = unwrap(res, "archive");

  if (args.includes("--json")) {
    console.log(JSON.stringify({ ok: true, room: data.room, archivedAt: data.archivedAt }));
    return;
  }
  console.log(
    archived
      ? `archived #${room}: hidden from every member's rooms until someone posts into it`
      : `reopened #${room}`,
  );
}

/**
 * The body of a post or DM. Three sources, first match wins: `--file <path>`,
 * stdin (no text while stdin is not a terminal, which is what a heredoc looks
 * like, or an explicit lone `-`), else the positional words joined with
 * spaces. The heredoc is the canonical form: it is the one shape under which
 * an agent writes a message the way it writes a reply, and an argv body is
 * one line by construction.
 */
async function resolveBody(words: string[], args: string[], usage: string): Promise<string> {
  const file = flagValue(args, "--file");
  if (file !== undefined) {
    let text = "";
    try {
      text = normalizeBody(readFileSync(file, "utf8"));
    } catch {
      fail(`cannot read --file ${file}`);
    }
    if (!text) fail(`--file ${file} is empty`);
    return text;
  }
  const wantsStdin = (words.length === 1 && words[0] === "-") || (words.length === 0 && !process.stdin.isTTY);
  if (wantsStdin) {
    const text = normalizeBody(await readStdin());
    if (!text) fail(usage);
    return text;
  }
  const body = words.join(" ");
  if (!body) fail(usage);
  return body;
}

/** CRLF to LF, one trailing newline dropped: a heredoc always ends in one,
    and a CRLF-only file must read as empty, not as a lone `\r`. */
function normalizeBody(raw: string): string {
  return raw.replace(/\r\n/g, "\n").replace(/\n$/, "");
}

async function readStdin(): Promise<string> {
  return await new Response(Bun.stdin.stream()).text();
}

const WALL_CHARS = 500;

/**
 * A long body with no line break almost always means the message was
 * flattened into a quoted argv string. Refused with the heredoc form in the
 * message, because the hint at post time is the one that changes the next
 * post. `--as-is` is the override for the rare body that really is one line.
 */
function requireReadable(body: string, args: string[]): void {
  if (args.includes("--as-is")) return;
  if (body.length >= WALL_CHARS && !body.includes("\n")) {
    fail(
      `refusing a ${body.length}-character body with no line breaks.\n` +
        "Post the message from a heredoc so its paragraphs and lists survive:\n" +
        "  rt chat post <room> <<'EOF'\n  ...\n  EOF\n" +
        "(--as-is posts it anyway.)",
    );
  }
}

async function runPost(args: string[]): Promise<void> {
  // Body is the positional tokens after the room, flag-aware: `--as <handle>`
  // (and every other recognized flag) is resolved separately by resolveHandle,
  // so a bare args.slice(1).join(" ") would splice the flag back into the post.
  const rest = positionals(args);
  const room = rest[0];
  if (!room) fail("usage: rt chat post <room> <text | <<'EOF'> [--file <path>] [--as-is]");
  requireValidName("room", room);
  const body = await resolveBody(rest.slice(1), args, "usage: rt chat post <room> <text | <<'EOF'> [--file <path>] [--as-is]");
  requireReadable(body, args);

  const handle = resolveHandle(args);
  requireValidName("handle", handle);

  const res = await chatPost({ room, handle, body });
  const data = unwrap(res, "post");
  // Silent on success unless a viewer is configured: then the one line
  // printed is the link the pane driver clicks to read the message, which
  // is what lets the agent's own narration stay at a single line.
  const url = chatViewerUrl(readChatViewerUrlSetting(), room, data.id);
  if (args.includes("--json")) {
    console.log(JSON.stringify({ ok: true, id: data.id, recipients: data.recipients, url: url ?? null }));
    return;
  }
  if (url) console.log(`posted → ${url}`);
}

async function runRead(args: string[]): Promise<void> {
  const room = positional(args);
  if (room) requireValidName("room", room);

  const handle = resolveHandle(args);
  requireValidName("handle", handle);

  let limit = 20;
  const limitRaw = flagValue(args, "--limit");
  if (limitRaw !== undefined) {
    const n = Number(limitRaw);
    if (!Number.isFinite(n) || n <= 0) fail(`--limit must be a positive number (got "${limitRaw}")`);
    limit = n;
  }

  let sinceMs: number | undefined;
  const sinceRaw = flagValue(args, "--since");
  if (sinceRaw !== undefined) {
    const ms = parseDuration(sinceRaw);
    if (ms == null) fail(`--since: bad duration "${sinceRaw}" (use 30s, 5m, 500ms, or bare seconds)`);
    sinceMs = Date.now() - ms;
  }

  const lastRaw = flagValue(args, "--last");
  if (lastRaw !== undefined) {
    if (sinceRaw !== undefined) fail("--last and --since are mutually exclusive");
    if (!room) fail("--last needs a room");
    const n = Number(lastRaw);
    if (!Number.isInteger(n) || n <= 0) fail(`--last must be a positive integer (got "${lastRaw}")`);
    // chat:messages orders newest-first, then reverses to oldest-first (same
    // top-to-bottom order a plain read renders), so no reverse here.
    const page = unwrap(await chatMessages({ room, limit: n }, sockOpts(args)), "read");
    unwrap(await chatMark({ handle, room }, sockOpts(args)), "mark");
    const rooms = [{ room, messages: page.messages }];
    if (args.includes("--json")) {
      console.log(JSON.stringify({ ok: true, rooms }));
      return;
    }
    const headingFor = await dmHeadingsFor(handle);
    console.log(renderReadRooms(rooms, args.includes("--full"), headingFor));
    return;
  }

  const res = await chatRead({ handle, room, limit, sinceMs });
  const data = unwrap(res, "read");

  if (args.includes("--json")) {
    console.log(JSON.stringify({ ok: true, rooms: data.rooms }));
    return;
  }
  const headingFor = await dmHeadingsFor(handle);
  console.log(renderReadRooms(data.rooms, args.includes("--full"), headingFor));
}

async function runRooms(args: string[]): Promise<void> {
  const handle = resolveHandle(args);
  requireValidName("handle", handle);

  const res = await chatRooms({ handle });
  const data = unwrap(res, "rooms");

  if (args.includes("--json")) {
    console.log(JSON.stringify({ ok: true, rooms: data.rooms }));
    return;
  }
  console.log(renderRooms(data.rooms));
}

/** Bare `who` (no room) aliases `buddies` — the roster, not this handle's own room memberships (superseded by presence: "who's around" is a fleet question, not a per-room one). `who <room>` is unchanged, now presence-joined. */
async function runWho(args: string[]): Promise<void> {
  const room = positional(args);
  if (!room) {
    await runBuddies(args);
    return;
  }
  requireValidName("room", room);

  const res = await chatWho({ room });
  const members = unwrap(res, `who (#${room})`).members;

  if (args.includes("--json")) {
    console.log(JSON.stringify({ ok: true, rooms: [{ room, members }] }));
    return;
  }
  const handle = resolveHandle(args);
  const headingFor = await dmHeadingsFor(handle);
  console.log(renderWhoSection(headingFor(room), members));
}

async function runBuddies(args: string[]): Promise<void> {
  const res = await chatBuddies();
  const data = unwrap(res, "buddies");

  if (args.includes("--json")) {
    console.log(JSON.stringify({ ok: true, buddies: data.buddies }));
    return;
  }
  console.log(renderBuddies(data.buddies));
}

async function runMark(args: string[]): Promise<void> {
  const room = positional(args);
  if (room) requireValidName("room", room);

  const handle = resolveHandle(args);
  requireValidName("handle", handle);

  const res = await chatMark({ handle, room });
  unwrap(res, "mark");

  if (args.includes("--json")) console.log(JSON.stringify({ ok: true }));
  // else: advance the cursor without printing
}

/**
 * Find-or-create the DM room and post — the recipient travels in `mentions`
 * (never prepended to the body), matching join+post's own body-splice guard:
 * the transcript reads exactly as typed and the desk still notifies when the
 * recipient is the human.
 */
async function runDm(args: string[]): Promise<void> {
  const rest = positionals(args);
  const to = rest[0];
  if (!to) fail("usage: rt chat dm <handle> <text | <<'EOF'> [--file <path>] [--as-is]");
  requireValidName("handle", to);
  const body = await resolveBody(rest.slice(1), args, "usage: rt chat dm <handle> <text | <<'EOF'> [--file <path>] [--as-is]");
  requireReadable(body, args);

  const from = resolveHandle(args);
  requireValidName("handle", from);

  const res = await chatDm({ from, to, body, sessionId: currentSessionId(args) });
  const data = unwrap(res, "dm");

  if (args.includes("--json")) {
    console.log(JSON.stringify({ ok: true, ...data }));
    return;
  }
  // prints nothing on success — Global Constraint, same as post
}

/**
 * `from` prefers the signed-in session's own handle over the human default:
 * an agent inviting from a signed-in session should show up as itself, not
 * as "matt", in the target pane's /chat:join note.
 */
async function runInvite(args: string[]): Promise<void> {
  const paneId = positional(args);
  if (!paneId) fail("usage: rt chat invite <pane> --room <room> [--note <text>]");
  const room = flagValue(args, "--room");
  if (!room) fail("--room is required");
  requireValidName("room", room);
  const note = flagValue(args, "--note");
  const session = readChatSession(currentSessionId(args));
  const from = session?.handle ?? getSetting<string>("chat.humanHandle").value;
  const callerPane = process.env.HERDR_PANE_ID;
  const res = await chatInvite({ paneId, room, note, from, callerPane }, sockOpts(args));
  const data = unwrap(res, "invite");
  if (args.includes("--json")) {
    console.log(JSON.stringify({ ok: true, ...data }));
    return;
  }
  console.log(data.delivered === "refused" ? `${paneId}: refused: ${data.reason ?? "unknown"}` : `${paneId}: ${data.delivered}`);
}

// ─── sign-in / sign-out (presence) ───────────────────────────────────────────

/**
 * baseHandle resolves through resolveSignInBaseHandle, where the session
 * file counts only as "the name this session already had"; the daemon
 * assigns the final (possibly suffixed) handle. The room is derived BEFORE
 * the sign-in call, since it
 * depends only on cwd + the identity codec, and is written into the session
 * file alongside the assigned handle so a later chatJoin failure still
 * leaves a session file that agrees with what was actually attempted.
 *
 * getRepoRoot/getRepoIdentityForRoot/parseIdentity run ONCE here — reusing
 * the parsed identity for both the display `repo` label and the room name,
 * rather than also calling `deriveRoomForCwd` (which repeats all three) —
 * each of those is a real `git` spawn plus an index write.
 */
async function runSignIn(args: string[]): Promise<void> {
  const paneFlag = flagValue(args, "--pane");
  if (paneFlag) {
    await runSignInViaPane(args, paneFlag);
    return;
  }

  const sessionId = currentSessionId(args);
  if (!sessionId) fail("no session id — pass --session <id> or run under CLAUDE_CODE_SESSION_ID");
  requireValidSessionId(sessionId);

  const requestedBase = resolveSignInBaseHandle(args, sessionId);
  if (requestedBase !== undefined) requireValidName("handle", requestedBase);

  const cwd = safeCwd();
  const root = cwd ? getRepoRoot(cwd) : null;
  const identity = root ? getRepoIdentityForRoot(root) : null;
  const parsedIdentity = identity ? parseIdentity(identity.identity) : null;
  const repo = identity ? repoLabel(identity.identity) : undefined;
  const branch = root ? getCurrentBranch() ?? undefined : undefined;
  const pane = process.env.HERDR_PANE_ID;
  const statusText = flagValue(args, "--status");

  const noRoomFlag = args.includes("--no-room");
  let roomName: string | null = null;
  if (!noRoomFlag) {
    const explicitRoom = flagValue(args, "--room");
    if (explicitRoom) {
      requireValidName("room", explicitRoom);
      roomName = explicitRoom;
    } else if (parsedIdentity) {
      roomName = roomForIdentity(parsedIdentity);
    }
  }

  const signInRes = await chatSignIn({ sessionId, baseHandle: requestedBase, cwd, repo, branch, pane, statusText });
  const { handle, baseHandle } = unwrap(signInRes, "sign-in");

  writeChatSession({ sessionId, handle, baseHandle, signedInAt: Date.now(), room: roomName ?? undefined });

  let joinedRoom: { name: string; memberCount: number } | null = null;
  if (roomName) {
    const joinRes = await chatJoin({ room: roomName, handle, cwd, pane });
    const joinData = unwrap(joinRes, "join");
    joinedRoom = { name: roomName, memberCount: joinData.memberCount };
  }

  if (args.includes("--json")) {
    console.log(JSON.stringify({ ok: true, handle, room: roomName }));
    return;
  }
  console.log(renderSignIn(handle, { repo, branch, pane }, root !== null, noRoomFlag, joinedRoom));
}

/**
 * Signs another pane's Claude session in on its behalf: the daemon resolves
 * `paneId` to a session id via herdr, so this process needs neither
 * CLAUDE_CODE_SESSION_ID nor a repo underfoot -- this process's OWN cwd is
 * never consulted. The daemon still derives cwd/repo/branch/room and joins a
 * room, just from the TARGET pane's cwd (via herdr), not from this one, and
 * through the SAME deriveRoomForCwd/roomForIdentity codec this file's own
 * sign-in uses (lib/chat-room.ts) -- so the room a pane-signed-in agent
 * lands in never diverges from the one a normally-signed-in agent for the
 * same repo would. `--room`/`--no-room` still work: they travel through
 * unchanged and the daemon honors them the same way it honors its own
 * derivation. The resolved sessionId and room travel back in the response
 * so this process can write the session file for the pane it just signed
 * in, same as a normal sign-in writes its own. The welcome frame
 * (daemon-side) is that pane's own notice of what it just joined.
 */
async function runSignInViaPane(args: string[], paneId: string): Promise<void> {
  const requestedBase = resolvePaneBaseHandle(args);
  const statusText = flagValue(args, "--status");
  const noRoomFlag = args.includes("--no-room");
  const explicitRoom = flagValue(args, "--room");
  if (explicitRoom) requireValidName("room", explicitRoom);

  const signInRes = await chatSignIn({
    baseHandle: requestedBase,
    pane: paneId,
    viaPane: true,
    statusText,
    room: explicitRoom,
    noRoom: noRoomFlag,
  });
  const { handle, baseHandle, sessionId, room } = unwrap(signInRes, "sign-in");

  writeChatSession({ sessionId, handle, baseHandle, signedInAt: Date.now(), room: room ?? undefined });

  if (args.includes("--json")) {
    console.log(JSON.stringify({ ok: true, handle, room }));
    return;
  }
  console.log(`signed in as ${handle} · pane ${paneId} · ${room ? `joined #${room}` : "no room joined"}`);
}

/**
 * Local cleanup (delete the session file) runs REGARDLESS of the daemon
 * result. A daemon-down sign-out that stopped here would strand the session
 * file: every verb would keep resolving position 0 to a handle nothing can
 * heartbeat, `--as` would stay refused, and — since this is also the
 * `SessionEnd` hook's command — `--quiet` would exit non-zero despite the
 * "must never fail a session shutdown" contract. A daemon failure is still
 * reported (non-quiet only); sign-out itself exits 0 either way.
 *
 * A missing or malformed session id degrades to a silent no-op under
 * --quiet, same as the daemon-failure path below: this is the SessionEnd
 * hook's command, and it must never exit non-zero on a shutdown.
 */
async function runSignOut(args: string[]): Promise<void> {
  const paneFlag = flagValue(args, "--pane");
  if (paneFlag) {
    await runSignOutViaPane(args, paneFlag);
    return;
  }

  const quiet = args.includes("--quiet");
  const sessionId = currentSessionId(args);
  if (!sessionId) {
    if (quiet) return;
    fail("no session id — pass --session <id> or run under CLAUDE_CODE_SESSION_ID");
  }
  if (!isValidSessionId(sessionId)) {
    if (quiet) return;
    fail(`invalid session id "${sessionId}" — must match ^[A-Za-z0-9._-]+$`);
  }

  const session = readChatSession(sessionId);
  // Bounded well under the SessionEnd hook's 5s budget, so a slow/wedged
  // daemon can't eat the budget local cleanup (below) still needs to run.
  const res = await chatSignOut({ sessionId }, { timeoutMs: 3000 });

  deleteChatSession(sessionId);

  if (!res.ok && !quiet) {
    console.error(`rt chat: sign-out: daemon error (${res.error ?? "sign-out failed"}) — local state cleaned up anyway`);
  }

  if (args.includes("--json")) {
    if (quiet) return;
    const payload: Record<string, unknown> = { ok: true };
    if (!res.ok) payload.daemonError = res.error ?? "sign-out failed";
    console.log(JSON.stringify(payload));
  } else if (!quiet) {
    console.log(session ? `✓ signed out (${session.handle})` : "✓ signed out");
  }
}

/**
 * Signs another pane's Claude session out on its behalf, mirroring
 * runSignInViaPane: the daemon resolves `paneId` to a session id via herdr,
 * so this branch never calls currentSessionId(args) -- an inherited
 * CLAUDE_CODE_SESSION_ID (this process's own, foreign to the target pane)
 * must never substitute for the pane's session, or --pane sign-out would
 * sign the WRONG session out. The daemon's RESOLVED sessionId, not
 * anything local, is what gets deleted here -- the same file the target
 * pane's own sign-out would delete.
 */
async function runSignOutViaPane(args: string[], paneId: string): Promise<void> {
  const res = await chatSignOut({ pane: paneId, viaPane: true }, { timeoutMs: 3000 });
  const { sessionId } = unwrap(res, "sign-out");

  const session = readChatSession(sessionId);
  deleteChatSession(sessionId);

  if (args.includes("--json")) {
    console.log(JSON.stringify({ ok: true }));
    return;
  }
  console.log(session ? `✓ signed out (${session.handle}) · pane ${paneId}` : `✓ signed out · pane ${paneId}`);
}

/**
 * away/back are session-keyed, not handle-keyed: they act on whichever
 * presence row this exact session owns, so a reclaimed session refuses
 * rather than silently touching a handle it no longer holds.
 */
async function runAway(args: string[]): Promise<void> {
  const text = positionals(args).join(" ");
  if (!text) fail("usage: rt chat away <text>");

  const sessionId = currentSessionId(args);
  if (!sessionId) fail("no session id — pass --session <id> or run under CLAUDE_CODE_SESSION_ID");

  const res = await chatAway({ sessionId, text });
  unwrap(res, "away");

  if (args.includes("--json")) {
    console.log(JSON.stringify({ ok: true }));
    return;
  }
  console.log(`✓ away: ${text}`);
}

async function runBack(args: string[]): Promise<void> {
  const sessionId = currentSessionId(args);
  if (!sessionId) fail("no session id — pass --session <id> or run under CLAUDE_CODE_SESSION_ID");

  const res = await chatBack({ sessionId });
  unwrap(res, "back");

  if (args.includes("--json")) {
    console.log(JSON.stringify({ ok: true }));
    return;
  }
  console.log("✓ back");
}

// ─── dispatcher ────────────────────────────────────────────────────────────────

const USAGE =
  "usage: rt chat <join|leave|archive|post|read|rooms|who|mark|sign-in|sign-out|away|back|buddies|dm|invite> ...";

const VERBS: Record<string, (args: string[]) => Promise<void>> = {
  join: runJoin,
  leave: runLeave,
  archive: runArchive,
  post: runPost,
  read: runRead,
  rooms: runRooms,
  who: runWho,
  mark: runMark,
  "sign-in": runSignIn,
  "sign-out": runSignOut,
  away: runAway,
  back: runBack,
  buddies: runBuddies,
  dm: runDm,
  invite: runInvite,
};

const VERB_HINTS: Record<string, string> = {
  read: "show recent messages",
  post: "send a message to a room",
  dm: "send a direct message to a handle",
  rooms: "list rooms",
  who: "who is in a room",
  join: "join a room",
  leave: "leave a room",
  mark: "mark a room read",
  archive: "park a room (post revives it)",
  "sign-in": "sign in and set presence",
  "sign-out": "sign out",
  away: "set an away status",
  back: "clear away status",
  buddies: "the presence roster",
};

async function pickChatVerb(): Promise<string | null> {
  const { filterableSelect } = await import("../lib/rt-render.tsx");
  return filterableSelect({
    message: "rt chat",
    options: Object.keys(VERBS).map((v) => ({ value: v, label: v, hint: VERB_HINTS[v] ?? "" })),
  });
}

export async function chat(args: string[]): Promise<void> {
  let [verb, ...rest] = args;
  if (!verb) {
    // Non-TTY / --json callers (agents, scripts) keep the usage error and exit
    // code; only an interactive terminal gets the verb picker.
    if (process.stdin.isTTY && !args.includes("--json") && !process.env.RT_BATCH) {
      const picked = await pickChatVerb();
      if (!picked) process.exit(0);
      verb = picked;
    } else {
      fail(USAGE);
    }
  }
  const handler = VERBS[verb];
  if (!handler) fail(`unknown verb "${verb}" — ${USAGE}`);
  await handler(rest);
}

// ─── test seam ───────────────────────────────────────────────────────────────

export const __test__ = {
  slugify,
  findGitRoot,
  resolveMainWorktreePath,
  repoAliasForPath,
  deriveRepoDirHandle,
  cwdRelativeHandle,
  userHostHandle,
  roomForIdentity,
  deriveRoomForCwd,
};
