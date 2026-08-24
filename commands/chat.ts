/**
 * rt chat — group chat for agents and their human, over the rt daemon.
 *
 *   rt chat join <room> [--as <h>] [--wake-on mention|all|none]
 *   rt chat leave <room>
 *   rt chat post <room> <text>                    prints NOTHING on success
 *   rt chat read [room] [--limit 20] [--full] [--since <dur>]
 *   rt chat rooms
 *   rt chat who [room]
 *   rt chat mark [room]
 *   rt chat tail                                   Task 8
 *
 * Identity resolution is CLIENT-SIDE (see resolveHandle): HERDR_PANE_ID and
 * the cwd's repo only exist in this process, never in the daemon, so the
 * resolved handle travels in every payload. `post`/`read`/`join` re-resolve
 * on every invocation — see resolveHandle's doc comment for why there is no
 * branch component.
 *
 * Spec: docs/superpowers/specs/2026-08-23-rt-chat-design.md
 */

import { existsSync, readFileSync, realpathSync, statSync } from "fs";
import { execSync } from "child_process";
import { homedir, hostname } from "os";
import { basename, dirname, join, resolve as resolvePath } from "path";

import { loadRepoIndex } from "../lib/repo-index.ts";
import { getSetting } from "../lib/settings/resolve.ts";
import { isValidChatName } from "../lib/state/index.ts";
import { shellQuote } from "../lib/herdr-launch.ts";
import { parseDuration } from "./events.ts";
import {
  chatJoin,
  chatLeave,
  chatMark,
  chatPost,
  chatRead,
  chatRooms,
  chatWho,
} from "../packages/rt-client/src/index.ts";
import type {
  ChatMember,
  ChatMessage,
  RoomSummary,
  RtResponse,
  WakeMode,
} from "../packages/rt-client/src/index.ts";

// ─── arg parsing (commands/events.ts conventions) ────────────────────────────

const FLAGS_WITH_VALUES = new Set(["--as", "--wake-on", "--limit", "--since"]);

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

function unwrap<T>(res: RtResponse<T>, label: string): T {
  if (!res.ok || res.data === undefined) fail(res.error ?? `${label} failed`);
  return res.data;
}

// ─── handle derivation ────────────────────────────────────────────────────────
//
// Order: --as → chat.handle (user scope) → herdr pane title (HERDR_PANE_ID)
// → <rt-repo-name>-<cwd-basename> → cwd relative to $HOME → <user>-<host>.
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

/** Reverse lookup: which repos.json alias names `mainWorktreePath`. Index is an explicit param so the derivation stays testable without a real HOME (carry-forward fixture test). */
function repoAliasForPath(mainWorktreePath: string, index: Record<string, string>): string | null {
  const target = safeRealpath(mainWorktreePath);
  for (const [name, path] of Object.entries(index)) {
    if (safeRealpath(path) === target) return name;
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

function readChatHandleSetting(): string | undefined {
  try {
    const resolved = getSetting<string>("chat.handle");
    return typeof resolved.value === "string" && resolved.value ? resolved.value : undefined;
  } catch {
    return undefined;
  }
}

function resolveHandle(args: string[]): string {
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

function relativeAgo(ms: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

function renderRooms(rooms: RoomSummary[]): string {
  if (rooms.length === 0) return "(not a member of any room)";
  const nameWidth = Math.max(...rooms.map((r) => r.room.length + 1));
  return rooms
    .map((r) => {
      const name = `#${r.room}`.padEnd(nameWidth + 2);
      const members = pluralize(r.memberCount, "member").padEnd(12);
      const unread = r.unread === 0
        ? "—"
        : `${r.unread} unread${r.mentions > 0 ? ` (${pluralize(r.mentions, "mention")})` : ""}`;
      const last = r.lastPostedAt !== undefined ? `last ${relativeAgo(r.lastPostedAt)} ago` : "never posted";
      return `${name}${members}${unread.padEnd(22)}${last}`;
    })
    .join("\n");
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function renderMessage(m: ChatMessage, full: boolean): string {
  const time = new Date(m.postedAt).toISOString().slice(11, 16);
  return `  [${time}] ${m.handle}: ${full ? m.body : truncate(m.body, 200)}`;
}

function renderReadRooms(rooms: { room: string; messages: ChatMessage[] }[], full: boolean): string {
  if (rooms.length === 0) return "(no unread)";
  return rooms
    .map((r) => [`#${r.room}`, ...r.messages.map((m) => renderMessage(m, full))].join("\n"))
    .join("\n\n");
}

function memberStatus(m: ChatMember): string {
  if (m.armedAt) return "listening";
  if (m.lastSeenAt !== undefined) return Date.now() - m.lastSeenAt < 5 * 60_000 ? "idle" : "away";
  return "away";
}

function renderWhoSection(room: string, members: ChatMember[]): string {
  const lines = members.map((m) => {
    const cwd = m.cwd ? `  ${m.cwd}` : "";
    const pane = m.pane ? `  [${m.pane}]` : "";
    return `  ${m.handle}  ${memberStatus(m)}${cwd}${pane}`;
  });
  return [`#${room}`, ...(lines.length > 0 ? lines : ["  (no members)"])].join("\n");
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

async function runPost(args: string[]): Promise<void> {
  const room = args[0];
  if (!room) fail("usage: rt chat post <room> <text>");
  requireValidName("room", room);
  const body = args.slice(1).join(" ");
  if (!body) fail("usage: rt chat post <room> <text>");

  const handle = resolveHandle(args);
  requireValidName("handle", handle);

  const res = await chatPost({ room, handle, body });
  unwrap(res, "post");
  // prints nothing on success — Global Constraint
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
  console.log(renderReadRooms(data.rooms, args.includes("--full")));
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

async function runWho(args: string[]): Promise<void> {
  const room = positional(args);
  if (room) requireValidName("room", room);

  let rooms: string[];
  if (room) {
    rooms = [room];
  } else {
    const handle = resolveHandle(args);
    requireValidName("handle", handle);
    const res = await chatRooms({ handle });
    rooms = unwrap(res, "who").rooms.map((r) => r.room);
  }

  const sections: { room: string; members: ChatMember[] }[] = [];
  for (const r of rooms) {
    const res = await chatWho({ room: r });
    sections.push({ room: r, members: unwrap(res, `who (#${r})`).members });
  }

  if (args.includes("--json")) {
    console.log(JSON.stringify({ ok: true, rooms: sections }));
    return;
  }
  if (sections.length === 0) {
    console.log("(not a member of any room)");
    return;
  }
  console.log(sections.map((s) => renderWhoSection(s.room, s.members)).join("\n\n"));
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

// ─── dispatcher ────────────────────────────────────────────────────────────────

const USAGE = "usage: rt chat <join|leave|post|read|rooms|who|mark|tail> ...";

const VERBS: Record<string, (args: string[]) => Promise<void>> = {
  join: runJoin,
  leave: runLeave,
  post: runPost,
  read: runRead,
  rooms: runRooms,
  who: runWho,
  mark: runMark,
};

export async function chat(args: string[]): Promise<void> {
  const [verb, ...rest] = args;
  if (!verb) fail(USAGE);
  if (verb === "tail") fail("rt chat tail is not implemented yet");
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
};
