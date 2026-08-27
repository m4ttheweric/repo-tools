/**
 * rt chat — group chat for agents and their human, over the rt daemon.
 *
 *   rt chat join <room> [--as <h>] [--wake-on mention|all|none]
 *   rt chat leave <room>
 *   rt chat post <room> <<'EOF' ... EOF          the body on stdin; <text> for a one-liner
 *   rt chat read [room] [--limit 20] [--full] [--since <dur>]
 *   rt chat rooms
 *   rt chat who [room]
 *   rt chat mark [room]
 *   rt chat tail                                   Task 8
 *   rt chat sign-in [--as <h>] [--status <text>] [--no-room] [--room <name>] [--session <id>]
 *   rt chat sign-out [--quiet] [--session <id>]
 *   rt chat away <text> [--session <id>]           rt chat back [--session <id>]
 *   rt chat buddies [--json]                       the roster; bare `who` aliases it
 *   rt chat dm <handle> <<'EOF' ... EOF           same body rules as post
 *   rt chat pulse [--json] [--session <id>]        hook-facing heartbeat; never fails
 *
 * Identity resolution is CLIENT-SIDE (see resolveHandle): HERDR_PANE_ID and
 * the cwd's repo only exist in this process, never in the daemon, so the
 * resolved handle travels in every payload. `post`/`read`/`join` re-resolve
 * on every invocation — see resolveHandle's doc comment for why there is no
 * branch component.
 *
 * Spec: docs/superpowers/specs/2026-08-23-rt-chat-design.md
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { homedir, hostname } from "os";
import { basename, dirname, join, resolve as resolvePath } from "path";

import { loadRepoIndex } from "../lib/repo-index.ts";
import { repoLabel } from "../lib/repo-arg.ts";
import { getCurrentBranch, getRepoRoot } from "../lib/git.ts";
import { getRepoIdentityForRoot } from "../lib/repo.ts";
import { parseIdentity, type RepoIdentity } from "../lib/settings/identity.ts";
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
import { pickAgentName } from "../lib/chat-names.ts";
import { chatViewerUrl, readChatViewerUrlSetting } from "../lib/chat-viewer-url.ts";
import { planSessionRename, type RenamePlan } from "../lib/chat-rename.ts";
import { parseDuration } from "./events.ts";
import {
  chatArm,
  chatAway,
  chatBack,
  chatBuddies,
  chatDisarm,
  chatDm,
  chatJoin,
  chatLeave,
  chatMark,
  chatPost,
  chatPulse,
  chatRead,
  chatRooms,
  chatSignIn,
  chatSignOut,
  chatTouch,
  chatUnreadWaking,
  chatWho,
  eventsHead,
  rtCommand,
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

const FLAGS_WITH_VALUES = new Set(["--as", "--wake-on", "--limit", "--since", "--room", "--sock", "--session", "--status", "--file"]);

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
// NO BRANCH COMPONENT: a tail resolves its handle once and holds it for the
// whole session, while post/read/join re-resolve on every call. A
// branch-bearing handle would drift on a mid-session branch switch, leaving
// the tail deaf on its own current identity. A directory cannot drift.
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
// order (failing during exactly the outage the tail's backoff exists to
// survive), would outlive its task (a recycled worktree slot inherits the
// previous occupant's identity), and two rows for one cwd have no defined
// tie-break.

function slugify(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return slug || "x";
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Nearest ancestor directory holding a `.git` entry — a plain walk, never a git spawn. */
function findGitRoot(start: string): string | null {
  let dir = start;
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The MAIN worktree path for `worktreeRoot`: itself when `.git` is a real
 * directory, or — for a linked worktree — the repo its `.git` FILE's
 * `gitdir: <main>/.git/worktrees/<slot>` pointer names, parsed by hand
 * (never `git worktree list`). Null when the pointer is stale or foreign
 * (a worktree whose gitdir survived a home-directory move errors with
 * "fatal: not a git repository" under real git) — this is why the
 * resolution order has a position AFTER the repo-name rung: dropping
 * straight to `<user>-<host>` here would give one shared handle to every
 * broken directory on the machine.
 */
function resolveMainWorktreePath(worktreeRoot: string): string | null {
  const gitPath = join(worktreeRoot, ".git");
  let stat;
  try {
    stat = statSync(gitPath);
  } catch {
    return null;
  }
  if (stat.isDirectory()) return worktreeRoot;
  if (!stat.isFile()) return null;

  let content: string;
  try {
    content = readFileSync(gitPath, "utf8");
  } catch {
    return null;
  }
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(content);
  if (!match) return null;
  const gitdir = match[1]!.startsWith("/") ? match[1]! : resolvePath(worktreeRoot, match[1]!);

  // "<main>/.git/worktrees/<slot>" → <main>, three levels up.
  const mainPath = dirname(dirname(dirname(gitdir)));
  if (!existsSync(mainPath) || !existsSync(join(mainPath, ".git"))) return null;
  return mainPath;
}

/**
 * Reverse lookup: which repos.json alias names `mainWorktreePath`. Index is an
 * explicit param so the derivation stays testable without a real HOME
 * (carry-forward fixture test). Index keys are serialized identities after the
 * RT-62 re-key (`remote:host%2Fpath`) — a wire form whose `%` and `:` the
 * handle charset forbids — so the alias is the key's display label, never the
 * key itself (repoLabel passes a legacy name-keyed row through unchanged).
 */
function repoAliasForPath(mainWorktreePath: string, index: Record<string, string>): string | null {
  const target = safeRealpath(mainWorktreePath);
  for (const [name, path] of Object.entries(index)) {
    if (safeRealpath(path) === target) return repoLabel(name);
  }
  return null;
}

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
 * signed in as (a repeat sign-in keeps its name) → a free first name.
 * `taken` is the live buddy list, so the draw avoids a name in use; the
 * daemon's `-2` suffixing remains the backstop for a race.
 */
function resolveSignInBaseHandle(args: string[], sessionId: string, taken: Iterable<string>): string {
  const explicit = flagValue(args, "--as");
  if (explicit) {
    requireValidName("handle", explicit);
    return explicit;
  }
  const fromSetting = readChatHandleSetting();
  if (fromSetting) return fromSetting;
  const prior = readChatSession(sessionId);
  if (prior && typeof prior.baseHandle === "string" && isValidChatName(prior.baseHandle)) return prior.baseHandle;
  return pickAgentName(taken);
}

function readChatHandleSetting(): string | undefined {
  try {
    const resolved = getSetting<string>("chat.handle");
    return typeof resolved.value === "string" && resolved.value ? resolved.value : undefined;
  } catch {
    return undefined;
  }
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

// ─── the repository room (sign-in) ───────────────────────────────────────────
//
// Room naming is display, never a store key — unlike handle derivation, which
// must never leak the serialized identity's `%2F`/`:`, a room name only needs
// the chat charset. remote-kind takes the identity's LAST segment (what
// people call the repo); path-kind takes the last TWO segments of the main
// worktree realpath, because one segment alone is the bare pool-slot name
// (`gamma`, `main`) — the same cross-repo collision handle derivation avoids.
// Both go through `slugify`, so the result always satisfies the room charset.

function roomForIdentity(id: RepoIdentity): string {
  if (id.kind === "remote") {
    const last = id.id.split("/").pop() ?? id.id;
    return slugify(last);
  }
  const segments = id.id.split("/").filter(Boolean);
  return slugify(segments.slice(-2).join("-"));
}

/**
 * Null when `cwd` isn't inside a git work tree at all — the gate is a real
 * `git rev-parse`, not a directory walk, so a scratch dir with a stray
 * `.git` file never derives a bogus room. The thin cwd → identity →
 * roomForIdentity composition, kept as its own function for the test seam;
 * `runSignIn` inlines the same three steps itself so it can reuse the
 * identity it already resolved for the display `repo` label rather than
 * re-deriving it here.
 */
function deriveRoomForCwd(cwd: string): string | null {
  const root = getRepoRoot(cwd);
  if (!root) return null;
  const identity = getRepoIdentityForRoot(root);
  if (!identity) return null;
  const parsed = parseIdentity(identity.identity);
  if (!parsed) return null;
  return roomForIdentity(parsed);
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

/** Best effort and bounded: a rename that fails or hangs must never fail the sign-in that already succeeded. */
async function runSessionRename(plan: RenamePlan): Promise<boolean> {
  try {
    const proc = Bun.spawn(plan.argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const timer = setTimeout(() => proc.kill(), 20_000);
    const code = await proc.exited;
    clearTimeout(timer);
    return code === 0;
  } catch {
    return false;
  }
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

// The spec's four statuses (Statuses table), computed server-side by
// buddyStatus and carried on every ChatMember/PresenceRow already — never
// recomputed here. "live" reads as "listening", matching the AIM mapping.
const STATUS_WORD: Record<BuddyStatus, string> = {
  live: "listening",
  idle: "idle",
  deaf: "deaf",
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

/** The status word plus the staleness detail the Statuses table's condition names for it — armed-but-silent is distinguished from an unarmed stale row, since they read as the same status but different causes. */
function buddyStatusWord(b: PresenceRow & { status: BuddyStatus }): string {
  switch (b.status) {
    case "live":
      return "listening";
    case "idle":
      return `idle ${relativeAgo(b.lastSeenAt)}`;
    case "deaf":
      return b.armedAt !== undefined
        ? `deaf ${relativeAgo(b.tailSeenAt ?? b.armedAt)} — armed but silent`
        : `deaf ${relativeAgo(b.lastSeenAt)}`;
    case "offline":
      return "offline";
  }
}

// Listening first, most-stale last — the order someone scanning the roster
// wants, not buddyStatus's own most-stale-first evaluation order (used to
// settle a single row's status, never to rank rows against each other).
const BUDDY_SECTIONS: BuddyStatus[] = ["live", "idle", "deaf", "offline"];

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
    const bullet = status === "idle" ? "○" : "●"; // filled = a tail is armed (live, or deaf-while-armed)
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

  // Kill the handle's tail ONLY when this was its last room. The pidfile and
  // the wake topic are per-handle (one tail serves every room), while leave is
  // per-room: killing while the handle is still in other rooms would deafen it
  // for those, and the "unless you ended it" re-arm rule would keep it deaf.
  const remaining = await chatRooms({ handle });
  if (remaining.ok && remaining.data && remaining.data.rooms.length === 0) {
    killChatTail(handle);
  }

  if (args.includes("--json")) {
    console.log(JSON.stringify({ ok: true }));
    return;
  }
  console.log(`✓ left #${room} (${handle})`);
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
  const sessionId = currentSessionId(args);
  if (!sessionId) fail("no session id — pass --session <id> or run under CLAUDE_CODE_SESSION_ID");
  requireValidSessionId(sessionId);

  const buddiesRes = flagValue(args, "--as") ? null : await chatBuddies().catch(() => null);
  const taken = buddiesRes?.ok && buddiesRes.data ? buddiesRes.data.buddies.map((b) => b.handle) : [];
  const baseHandle = resolveSignInBaseHandle(args, sessionId, taken);
  requireValidName("handle", baseHandle);

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

  const signInRes = await chatSignIn({ sessionId, baseHandle, cwd, repo, branch, pane, statusText });
  const { handle } = unwrap(signInRes, "sign-in");

  writeChatSession({ sessionId, handle, baseHandle, signedInAt: Date.now(), room: roomName ?? undefined });

  let joinedRoom: { name: string; memberCount: number } | null = null;
  if (roomName) {
    const joinRes = await chatJoin({ room: roomName, handle, cwd, pane });
    const joinData = unwrap(joinRes, "join");
    joinedRoom = { name: roomName, memberCount: joinData.memberCount };
  }

  const renamePlan = planSessionRename({ handle, sessionId, env: process.env, disabled: args.includes("--no-rename") });
  const renamed = renamePlan && (await runSessionRename(renamePlan)) ? renamePlan.via : null;

  if (args.includes("--json")) {
    console.log(JSON.stringify({ ok: true, handle, room: roomName, renamed }));
    return;
  }
  console.log(renderSignIn(handle, { repo, branch, pane }, root !== null, noRoomFlag, joinedRoom));
  if (renamed === "herdr") console.log(`your session is being renamed to ${handle} (lands when this turn ends)`);
  else if (renamed === "claude") console.log(`your session is now titled ${handle}`);
  console.log("arm your tail now: Monitor `rt chat tail`, persistent");
}

/**
 * Local cleanup (kill the tail, delete the session file) runs REGARDLESS of
 * the daemon result. A daemon-down sign-out that stopped here would strand
 * the session file: every verb would keep resolving position 0 to a handle
 * nothing can heartbeat, `--as` would stay refused, and — since this is also
 * the `SessionEnd` hook's command — `--quiet` would exit non-zero despite
 * the "must never fail a session shutdown" contract. A daemon failure is
 * still reported (non-quiet only); sign-out itself exits 0 either way.
 *
 * killChatTail falls back to the --as-first chain when there is no valid
 * local session (file corrupt or already gone) — a guess, but a safe one:
 * it is a no-op unless a live tail happens to hold that exact handle's
 * pidfile.
 *
 * A missing or malformed session id degrades to a silent no-op under
 * --quiet, same as the daemon-failure path below: this is the SessionEnd
 * hook's command, and it must never exit non-zero on a shutdown.
 */
async function runSignOut(args: string[]): Promise<void> {
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

  killChatTail(session ? session.handle : resolveBaseHandle(args));
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
 * away/back and pulse are session-keyed, not handle-keyed: they act on
 * whichever presence row this exact session owns, so a reclaimed session
 * refuses rather than silently touching a handle it no longer holds.
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

/** Re-derive `branch`/`repo` only when the cwd changed since the last pulse, or the last read is over a minute old — the git-spawning half of deriving deets, gated on the session file's own cache so most prompts cost one IPC round trip and nothing else. */
const BRANCH_RECHECK_MS = 60_000;

function shouldRereadBranch(session: ReturnType<typeof readChatSession>, cwd: string | undefined): boolean {
  if (!session) return true;
  if (session.lastCwd !== cwd) return true;
  if (session.lastBranchReadAt === undefined) return true;
  return Date.now() - session.lastBranchReadAt > BRANCH_RECHECK_MS;
}

/**
 * Hook-facing (`UserPromptSubmit`) and hard-bounded: the daemon call carries
 * `timeoutMs: 800` (the wrappers' 10s default would blow the hook's own
 * budget), and every failure below — timeout, daemon down, a refusal other
 * than reclaim — exits 0 with NOTHING printed. A hook that hangs or errors on
 * every prompt is worse than no hook at all. The one exception is a
 * reclaimed session: that notice is the whole point of pulsing, so it prints
 * (or, under --json, reports `{ reclaimed: true }`) and deletes the now-dead
 * session file, same as the tail's own reclaim exit.
 */
async function runPulse(args: string[]): Promise<void> {
  try {
    const json = args.includes("--json");
    const sessionId = currentSessionId(args);
    if (!sessionId || !isValidSessionId(sessionId)) return;

    const session = readChatSession(sessionId);
    const cwd = safeCwd();
    const pane = process.env.HERDR_PANE_ID;

    let repo: string | undefined;
    let branch: string | undefined;
    let branchReadNow: number | undefined;
    if (shouldRereadBranch(session, cwd)) {
      const root = cwd ? getRepoRoot(cwd) : null;
      if (root) {
        const identity = getRepoIdentityForRoot(root);
        if (identity) repo = repoLabel(identity.identity);
        branch = getCurrentBranch() ?? undefined;
      }
      branchReadNow = Date.now();
    }

    const res = await chatPulse({ sessionId, cwd, repo, branch, pane }, { timeoutMs: 800 });

    if (!res.ok || res.data === undefined) {
      if (res.error?.includes("handle reclaimed")) {
        deleteChatSession(sessionId);
        console.log(json ? JSON.stringify({ reclaimed: true }) : "your handle was reclaimed while you were away — sign in again");
      }
      return; // every other failure: silent, exit 0 — never fail the hook
    }

    if (session) {
      writeChatSession({
        ...session,
        lastCwd: cwd,
        lastBranchReadAt: branchReadNow ?? session.lastBranchReadAt,
      });
    }

    if (json) {
      console.log(JSON.stringify({ ok: true, unread: res.data.unread, status: res.data.status }));
    }
    // plain mode prints nothing — the hook, not this command, decides
    // whether to inject context from the unread summary and status.
  } catch {
    // pulse must never fail the hook, for any reason
  }
}

// ─── tail: the wake protocol ─────────────────────────────────────────────────
//
// A long-lived stream, launched under Claude Code's Monitor (persistent: true).
// Monitor turns each stdout line into one notification, so stdout carries
// EXACTLY one line per wake and every diagnostic goes to stderr. The step order
// below is the whole feature — see the spec's Wake protocol section.

/** rt dir holding the sock and the per-handle tail pidfiles (mirrors transport's defaultSock dir). */
function rtChatDir(): string {
  return join(process.env.HOME ?? homedir(), ".mattstack", "rt");
}

/** Pidfile is keyed on HANDLE ALONE: one tail serves every room the handle is in. */
function chatTailPidPath(handle: string): string {
  return join(rtChatDir(), `chat-tail-${handle}.pid`);
}

function readTailPid(pidPath: string): number | null {
  try {
    const pid = parseInt(readFileSync(pidPath, "utf8").trim(), 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/**
 * Alive AND actually an `rt chat tail`. A tail dies abnormally (session end,
 * sleep, SIGKILL, Monitor stopping it) without running cleanup, so a stale
 * pidfile — or one whose pid the OS recycled to an unrelated process — must not
 * refuse a re-arm. Recovery IS *stream ends → agent notified → agent re-arms*,
 * and a false "already armed" leaves the agent permanently deaf.
 */
/**
 * Whether a process's `ps args` line is an rt (or dev cli.ts) invocation
 * running `chat tail`, in that order. Stricter than "contains chat and tail
 * somewhere": the binary/script is anchored to a path boundary and the two
 * verbs must be adjacent, so a recycled PID whose unrelated args merely
 * mention both words does not read as a live tail and spuriously refuse an
 * agent's re-arm.
 */
function looksLikeRtChatTail(args: string): boolean {
  return /(?:^|\/)(?:rt|cli\.ts)\b[\s\S]*\bchat\s+tail\b/.test(args);
}

function isLiveChatTail(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check
  } catch {
    return false;
  }
  try {
    const args = execSync(`ps -p ${pid} -o args=`, { encoding: "utf8", stdio: "pipe" });
    return looksLikeRtChatTail(args);
  } catch {
    return false;
  }
}

/**
 * Claim the per-handle tail pidfile for this process. Returns null when
 * claimed, or the pid of a live `rt chat tail` that already holds it.
 *
 * Every write is an exclusive create ('wx'): only one racer wins, and O_EXCL
 * refuses a symlink outright, so a link planted at pidPath is never written
 * through. A stale pidfile is reclaimed by removing it and retrying the
 * exclusive create, never by overwriting in place — and it is only removed if
 * it is a regular file whose inode is unchanged since the staleness check, so
 * a racer that re-claimed the path meanwhile does not get its fresh pidfile
 * deleted from under it.
 */
function claimTailPidfile(pidPath: string): number | null {
  mkdirSync(dirname(pidPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(pidPath, String(process.pid), { flag: "wx" });
      return null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const seen = lstatSync(pidPath);
    if (!seen.isFile()) {
      throw new Error(`${pidPath} exists but is not a regular file — remove it to arm`);
    }
    const existing = readTailPid(pidPath);
    if (existing !== null && existing !== process.pid && isLiveChatTail(existing)) return existing;
    try {
      const now = lstatSync(pidPath);
      if (now.isFile() && now.ino === seen.ino && now.dev === seen.dev) rmSync(pidPath);
    } catch { /* already gone — the retry below settles it */ }
  }
  const holder = readTailPid(pidPath);
  if (holder !== null && holder !== process.pid && isLiveChatTail(holder)) return holder;
  throw new Error(`${pidPath} could not be claimed`);
}

/** SIGTERM the handle's tail if one is genuinely running, then drop the pidfile (leave's last-room path). */
function killChatTail(handle: string): void {
  const pidPath = chatTailPidPath(handle);
  const pid = readTailPid(pidPath);
  if (pid !== null && isLiveChatTail(pid)) {
    try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
  }
  try { rmSync(pidPath); } catch { /* already gone */ }
}

/** One line per wake, count-style; identical format for the catch-up and the stream. */
function wakeLine(room: string, count: number, url?: string): string {
  return `${count} new in #${room} — \`rt chat read\` to see it.${url ? ` ${url}` : ""}`;
}

/**
 * A test seam that opens a timing window: create the file the env var NAMES,
 * block until it is removed, give up after 2s. It names a PATH, never a
 * command — a seam that evaluated a shell string would be arbitrary code
 * execution in a shipped binary.
 */
async function testMarkerPause(envKey: string): Promise<void> {
  const path = process.env[envKey];
  if (!path) return;
  try { writeFileSync(path, String(process.pid)); } catch { return; }
  const deadline = Date.now() + 2_000;
  while (existsSync(path) && Date.now() < deadline) {
    await Bun.sleep(20);
  }
}

const TAIL_ROUND_MS = 15_000; // events:wait ceiling per round; also the chat:touch heartbeat cadence.

export async function chatTail(args: string[]): Promise<void> {
  // Monitor owns the lifetime (persistent: true). A tail that could time out
  // would end its own stream and read as a dead feed.
  if (args.includes("--timeout")) {
    console.error("rt chat: tail takes no --timeout — Monitor owns the tail's lifetime");
    process.exit(2);
  }

  const handle = resolveHandle(args);
  requireValidName("handle", handle);

  // Carried on every arm/touch/disarm call: without it the daemon has no way
  // to tell this tail's session apart from whichever session now holds the
  // handle, so a reclaimed handle would arm (and keep touching) clean.
  const sessionId = currentSessionId(args);

  const roomFilter = flagValue(args, "--room");
  if (roomFilter) requireValidName("room", roomFilter);

  const sockPath = flagValue(args, "--sock");
  const opts = sockPath ? { sockPath } : {};

  // Claim the pidfile BEFORE any daemon call, so a live duplicate is refused
  // even when the daemon is down. A stale/foreign pidfile is reclaimed.
  const pidPath = chatTailPidPath(handle);
  let livePid: number | null;
  try {
    livePid = claimTailPidfile(pidPath);
  } catch (err) {
    console.error(`rt chat: could not claim tail pidfile: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  if (livePid !== null) {
    console.error(`rt chat: already armed — a tail for ${handle} is already running (pid ${livePid})`);
    process.exit(3);
  }
  const cleanup = (): void => { try { rmSync(pidPath); } catch { /* already gone */ } };

  // A signal is a DELIBERATE stop (Monitor stopping the command, or leave on
  // the last room). Exit 0 — never 69 — so the daemon-down backoff cannot mask
  // it, and if the handle is now in zero rooms say so on one line.
  let shuttingDown = false;
  const onSignal = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      const rooms = await chatRooms({ handle }, opts);
      if (rooms.ok && rooms.data && rooms.data.rooms.length === 0) {
        console.log(`no longer in any room — #${handle} tail stopped. Do not re-arm.`);
      }
    } catch { /* daemon unreachable — still a deliberate stop */ }
    cleanup();
    process.exit(0);
  };
  process.on("SIGTERM", () => { void onSignal(); });
  process.on("SIGINT", () => { void onSignal(); });

  // A non-numeric override would make budgetMs NaN, so `Date.now() + NaN` is
  // NaN, the retry loop never runs, and the tail exits 69 on the first blip.
  const budgetRaw = Number(process.env.RT_CHAT_BACKOFF_MS);
  const budgetMs = Number.isFinite(budgetRaw) && budgetRaw >= 0 ? budgetRaw : 60_000;

  /**
   * The one daemon refusal that must short-circuit both callOrBackoff and the
   * touch loop below rather than retry/backoff/get-ignored: once the handle
   * is reclaimed, this pidfile is stale and there is nothing left to listen
   * for. A no-op for every other error.
   */
  function exitOnReclaim(error: string | undefined): void {
    if (!error?.includes("handle reclaimed")) return;
    console.log("handle reclaimed — sign in again");
    if (sessionId) deleteChatSession(sessionId);
    cleanup();
    process.exit(0);
  }

  // Daemon-unreachable is not silence: retry with bounded backoff (a mechanical
  // brake against a re-arm spin), diagnostics to stderr; when the budget is
  // exhausted, one stdout line, disarm, exit 69. A reclaimed handle skips all
  // of that via exitOnReclaim above.
  async function callOrBackoff<T>(fn: () => Promise<{ ok: boolean; data?: T; error?: string }>): Promise<T> {
    let res = await fn();
    if (res.ok && res.data !== undefined) return res.data;
    exitOnReclaim(res.error);
    const deadline = Date.now() + budgetMs;
    let delay = 250;
    while (Date.now() < deadline) {
      console.error(`rt chat: daemon unreachable, retrying in ${delay}ms…`);
      await Bun.sleep(delay);
      res = await fn();
      if (res.ok && res.data !== undefined) return res.data;
      exitOnReclaim(res.error);
      delay = Math.min(delay * 2, 10_000);
    }
    console.log("chat stream ended — the rt daemon is unreachable.");
    await chatDisarm({ handle, sessionId }, opts).catch(() => undefined);
    cleanup();
    process.exit(69);
  }

  // Step 1: snapshot the journal head → cursor C. This precedes the unread read
  // so a post landing before waiter registration still emits above C and is
  // replayed by the stream (the arm-race fix).
  const head = await callOrBackoff(() => eventsHead(opts));
  const C = head.cursor;
  const viewerBase = readChatViewerUrlSetting();

  // Step 2: arm (scoped to --room when given; all the handle's rooms otherwise).
  // sessionId travels here so a reclaimed handle is refused at arm time, not
  // just on the touch loop below.
  await callOrBackoff(() => chatArm({ handle, room: roomFilter, sessionId }, opts));

  await testMarkerPause("RT_CHAT_TEST_PRE_CATCHUP_MARKER");

  // Step 3: catch-up — one line per room with its real count, and the watermark
  // W = highest chat_messages id already seen. W (a chat_messages rowid) and C
  // (a journal rowid) live in different id spaces and guard opposite defects.
  const catchup = await callOrBackoff(() => chatUnreadWaking({ handle, room: roomFilter }, opts));
  let W = 0;
  for (const r of catchup.rooms) {
    if (roomFilter && r.room !== roomFilter) continue;
    if (r.count > 0) console.log(wakeLine(r.room, r.count, chatViewerUrl(viewerBase, r.room)));
    if (r.maxId > W) W = r.maxId;
  }

  await testMarkerPause("RT_CHAT_TEST_PRE_WAIT_MARKER");

  // Step 4: stream. events:wait with pattern chat/wake/<me> and after=C, cursor
  // threaded forward; one line per wake; chat:touch each round so presence
  // rides the loop. Skip any wake whose message id is at or below W — that
  // message was already delivered by the catch-up (the mirror hole the
  // streaming transport opened).
  const pattern = `chat/wake/${handle}`;
  let cursor = C;
  while (true) {
    const round = await callOrBackoff(() =>
      rtCommand<{ events: { id: number; topic: string; payload: { id: number; room: string } }[]; cursor: number }>(
        "events:wait",
        { pattern, after: cursor, waitMs: TAIL_ROUND_MS },
        { sockPath, timeoutMs: TAIL_ROUND_MS + 10_000 },
      ),
    );
    cursor = round.cursor;
    const touched = await chatTouch({ handle, room: roomFilter, sessionId }, opts).catch(
      (err) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }) as const,
    );
    if (!touched.ok) exitOnReclaim(touched.error);
    for (const e of round.events) {
      const msgId = e.payload?.id;
      const room = e.payload?.room;
      if (typeof msgId === "number" && msgId <= W) continue; // dup: already in the catch-up
      if (roomFilter && room !== roomFilter) continue; // --room: silently skip other rooms
      console.log(wakeLine(room, 1, chatViewerUrl(viewerBase, room, typeof msgId === "number" ? msgId : undefined)));
    }
  }
}

// ─── dispatcher ────────────────────────────────────────────────────────────────

const USAGE =
  "usage: rt chat <join|leave|post|read|rooms|who|mark|tail|sign-in|sign-out|away|back|buddies|dm|pulse> ...";

const VERBS: Record<string, (args: string[]) => Promise<void>> = {
  join: runJoin,
  leave: runLeave,
  post: runPost,
  read: runRead,
  rooms: runRooms,
  who: runWho,
  mark: runMark,
  tail: chatTail,
  "sign-in": runSignIn,
  "sign-out": runSignOut,
  away: runAway,
  back: runBack,
  buddies: runBuddies,
  dm: runDm,
  pulse: runPulse,
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
  tail: "stream wakes for this handle",
  "sign-in": "sign in and set presence",
  "sign-out": "sign out",
  away: "set an away status",
  back: "clear away status",
  buddies: "the presence roster",
  pulse: "heartbeat (hook-facing)",
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
  looksLikeRtChatTail,
  claimTailPidfile,
  roomForIdentity,
  deriveRoomForCwd,
};
