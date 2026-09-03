/**
 * rt chat CLI (RT-48).
 *
 * runChat/runChatRaw invoke the `chat` export in-process against a temp
 * HOME, backed by a real (not stubbed) chat daemon: a Bun.serve unix socket
 * bound at the HOME's default rt.sock, dispatching to the REAL
 * createChatHandlers over a per-test state.db. This exercises the
 * actual join/member-count/unread rules, not a canned reply map.
 *
 * HERDR_PANE_ID is deliberately cleared for every test: this suite may
 * itself run inside a real herdr pane, and leaving it set would let
 * handle derivation spawn `herdr pane get` against the live session —
 * nondeterministic and slow. See commands/chat.ts's resolveHandle order.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { execSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { chat, __test__ } from "../chat.ts";
import { createChatHandlers } from "../../lib/daemon/handlers/chat.ts";
import { getStateDb, closeStateDb, rememberPaneHandle, type RegistryDeps } from "../../lib/state/index.ts";
import type { InboxBinding } from "../../lib/claude-registry.ts";
import { sessionFilePath } from "../../lib/chat-session.ts";
import { AGENT_NAMES } from "../../lib/chat-names.ts";
import { setSetting } from "../../packages/rt-client/src/settings/write.ts";
import { drainNotifications, peekNotifications } from "../../lib/notifier.ts";
import { fakeHerdr, HerdrFakeError } from "../../lib/herdr/__tests__/fake-herdr.ts";

// ─── in-process CLI + fake daemon harness ───────────────────────────────────

let home = "";
let origHome: string | undefined;
let origPaneId: string | undefined;
let origSessionId: string | undefined;
let origBackoff: string | undefined;
let server: ReturnType<typeof Bun.serve> | null = null;
// Real child processes spawned by a test (e.g. a stdin-fed `post`); reaped in
// afterEach so a stray one can't outlive its test.
const children: Array<ReturnType<typeof Bun.spawn>> = [];
// Scripted replies for a command, consulted before the real handlers (for
// commands whose real handler has side effects a unit test must not trigger:
// chat:invite would actually type into a herdr pane). Reset every test.
let canned: Record<string, unknown> = {};
// Every command this fake daemon dispatched, in order, for asserting exactly
// what a verb sent the daemon.
let seen: Array<{ cmd: string; payload: unknown }> = [];
// Overrides the registry probe behind buddyStatus for one test at a time
// (undefined uses the real resolver). Bun's os.homedir() does not follow a
// runtime process.env.HOME change, so a fake ~/.claude/sessions file is not
// reachable from here — this seam is the only way a CLI-level test can make
// a handle read "live".
let registryDeps: RegistryDeps | undefined;

beforeEach(() => {
  origHome = process.env.HOME;
  origPaneId = process.env.HERDR_PANE_ID;
  origSessionId = process.env.CLAUDE_CODE_SESSION_ID;
  origBackoff = process.env.RT_CHAT_BACKOFF_MS;
  delete process.env.HERDR_PANE_ID;
  // This suite runs inside a real Claude Code session; a leaked id would sign
  // tests in against the developer's own session file. Every test below that
  // needs a session id passes --session explicitly.
  delete process.env.CLAUDE_CODE_SESSION_ID;
  // Keep the daemon-unreachable backoff short so the exit-69 path is fast.
  process.env.RT_CHAT_BACKOFF_MS = "150";

  home = realpathSync(mkdtempSync(join(tmpdir(), "rt-chat-cli-")));
  process.env.HOME = home;

  const sockDir = join(home, ".mattstack", "rt");
  mkdirSync(sockDir, { recursive: true });

  canned = {};
  seen = [];
  registryDeps = undefined;

  server = Bun.serve({
    unix: join(sockDir, "rt.sock"),
    async fetch(req) {
      const cmd = new URL(req.url).pathname.slice(1);
      const payload = req.method === "POST" ? await req.json() : {};
      seen.push({ cmd, payload });
      if (cmd in canned) return Response.json(canned[cmd]);
      const handlers = createChatHandlers({ db: getStateDb(), emitEvent: () => 0, registryDeps }) as unknown as Record<string, (p: unknown) => Promise<unknown>>;
      const handler = handlers[cmd];
      if (!handler) return Response.json({ ok: false, error: `unknown command: ${cmd}` });
      return Response.json(await handler(payload));
    },
  });
});

afterEach(async () => {
  for (const child of children) {
    try { child.kill(); } catch { /* already gone */ }
  }
  await Promise.all(children.map((c) => c.exited));
  children.length = 0;
  server?.stop(true);
  server = null;
  closeStateDb();
  if (home) rmSync(home, { recursive: true, force: true });
  process.env.HOME = origHome;
  if (origPaneId === undefined) delete process.env.HERDR_PANE_ID;
  else process.env.HERDR_PANE_ID = origPaneId;
  if (origSessionId === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
  else process.env.CLAUDE_CODE_SESSION_ID = origSessionId;
  if (origBackoff === undefined) delete process.env.RT_CHAT_BACKOFF_MS;
  else process.env.RT_CHAT_BACKOFF_MS = origBackoff;
});


/**
 * Mirrors commands/__tests__/runs.test.ts's runExpectingCleanExit: mocks
 * process.exit to throw a sentinel so a `fail()` path never kills the real
 * test process, and reads the spies' recorded calls before mockRestore()
 * clears them.
 */
async function runChatRaw(args: string[], opts: { sock?: string } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  if (opts.sock) args = [...args, "--sock", opts.sock];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const logSpy = spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    stdout.push(a.map(String).join(" "));
  });
  const errSpy = spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    stderr.push(a.map(String).join(" "));
  });
  const exitSpy = spyOn(process, "exit").mockImplementation(() => {
    throw new Error("process.exit sentinel");
  });

  let code = 0;
  try {
    await chat(args);
  } catch (err) {
    if (err instanceof Error && err.message === "process.exit sentinel") {
      code = (exitSpy.mock.calls.at(-1)?.[0] as number | undefined) ?? 1;
    } else {
      throw err;
    }
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

async function runChat(args: string[]): Promise<string> {
  const { code, stdout, stderr } = await runChatRaw(args);
  if (code !== 0) throw new Error(`chat ${args.join(" ")} exited ${code}: ${stderr}`);
  return stdout;
}

/**
 * `rt chat sign-in --session <id>`, then sets CLAUDE_CODE_SESSION_ID so
 * subsequent calls in the same test resolve position 0 without repeating
 * `--session` — exactly how a real Claude Code session's own Bash calls
 * resolve it (env var, with `--session` as the documented override).
 * afterEach's existing CLAUDE_CODE_SESSION_ID restore cleans this up.
 */
async function signInInProcess(
  opts: { as: string; session: string; room?: string; noRoom?: boolean },
): Promise<{ home: string; handle: string }> {
  const args = ["sign-in", "--as", opts.as, "--session", opts.session];
  if (opts.room) args.push("--room", opts.room);
  if (opts.noRoom) args.push("--no-room");
  const out = await runChat(args);
  const handle = /signed in as (\S+)/.exec(out)?.[1] ?? opts.as;
  process.env.CLAUDE_CODE_SESSION_ID = opts.session;
  return { home, handle };
}

/**
 * Ages `baseHandle`'s presence row past both reclaim thresholds (mirrors
 * lib/daemon/__tests__/chat-handlers.test.ts's own `last_seen_at -
 * 7200000` pattern) and signs a second session in under the same base — the
 * daemon's own "the first reclaimable row, by suffix order" rule then hands
 * the base handle straight back to the new session rather than suffixing.
 */
async function reclaimViaHandlers(baseHandle: string, newSessionId: string): Promise<void> {
  getStateDb().run("UPDATE chat_presence SET last_seen_at = last_seen_at - 7200000 WHERE base_handle = ?", [baseHandle]);
  await runChat(["sign-in", "--as", baseHandle, "--session", newSessionId, "--no-room"]);
}

// ─── Step 1 (brief) ──────────────────────────────────────────────────────────

describe("rt chat CLI", () => {
  test("join prints the member count so a typo is visible", async () => {
    const out = await runChat(["join", "buidl"]);
    expect(out).toContain("1 member");
    expect(out).toContain("you are alone here");
  });

  test("post reports who was woken; a room with only the author says nobody", async () => {
    await runChat(["join", "r"]);
    expect(await runChat(["post", "r", "hello"])).toBe(
      "on the record for 0 members, woke nobody: @handle or @here wakes someone, rt chat dm reaches one\nposted → https://chat.mattstack/r/r#m-1",
    );
  });

  test("an invalid room name is rejected with the reason", async () => {
    const { code, stderr } = await runChatRaw(["join", "Bad/Name"]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("[a-z0-9._-]");
  });

  test("--json emits a parseable object for every verb", async () => {
    await runChat(["join", "r"]);
    // The brief's literal `expect(() => JSON.parse(await runChat(...)))` is a
    // syntax error (`await` in a non-async arrow) — same assertion, fixed.
    const out = await runChat(["rooms", "--json"]);
    expect(() => JSON.parse(out)).not.toThrow();
  });
});

// ─── extra CLI-level coverage (not in the brief, but load-bearing) ──────────

describe("rt chat CLI — additional verb behavior", () => {
  test("join with --as uses the explicit handle instead of deriving one", async () => {
    const out = await runChat(["join", "r", "--as", "scout"]);
    expect(out).toContain("scout");
  });

  test("--as rejects an invalid handle the same way a bad room does", async () => {
    const { code, stderr } = await runChatRaw(["join", "r", "--as", "Bad Handle"]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("[a-z0-9._-]");
  });

  test("post prints the viewer link when chat.viewerUrl is set, and --json carries it", async () => {
    setSetting("chat.viewerUrl", "https://chat.example/", "user");
    await runChat(["join", "r", "--as", "a"]);
    const out = await runChat(["post", "r", "hello", "--as", "a"]);
    expect(out).toMatch(/\nposted → https:\/\/chat\.example\/r\/r#m-\d+$/);
    const json = JSON.parse(await runChat(["post", "r", "again", "--as", "a", "--json"]));
    expect(json).toMatchObject({ ok: true, recipients: expect.any(Array) });
    expect(json.url).toBe(`https://chat.example/r/r#m-${json.id}`);
  });

  test("mark advances the cursor and prints nothing", async () => {
    await runChat(["join", "r", "--as", "a"]);
    expect(await runChat(["mark", "r", "--as", "a"])).toBe("");
  });

  test("mark --upto advances only to that message, leaving later ones unread; a bad --upto is refused", async () => {
    await runChat(["join", "r", "--as", "a"]);
    await runChat(["join", "r", "--as", "b"]);
    await runChat(["post", "r", "one", "--as", "a", "--json"]);
    const two = JSON.parse(await runChat(["post", "r", "two", "--as", "a", "--json"]));
    await runChat(["post", "r", "three", "--as", "a", "--json"]);
    await runChat(["mark", "r", "--upto", String(two.id), "--as", "b"]);
    const read = JSON.parse(await runChat(["read", "r", "--as", "b", "--json"]));
    expect(read.rooms[0].messages.map((m: { body: string }) => m.body)).toEqual(["three"]);

    const bad = await runChatRaw(["mark", "r", "--upto", "0", "--as", "b"]);
    expect(bad.code).not.toBe(0);
  });

  test("post's body is every word after the room, joined back with spaces", async () => {
    await runChat(["join", "r", "--as", "a"]);
    await runChat(["join", "r", "--as", "b"]);
    expect(await runChat(["post", "r", "@b", "hello", "world"])).toBe("delivered to b\nposted → https://chat.mattstack/r/r#m-1");
    const read = JSON.parse(await runChat(["read", "r", "--as", "b", "--json"]));
    expect(read.rooms[0].messages[0].body).toBe("@b hello world");
  });

  test("an agent's post that names nobody tells the poster it woke nobody and how to wake someone", async () => {
    await runChat(["join", "r", "--as", "a"]);
    await runChat(["join", "r", "--as", "b"]);
    await runChat(["join", "r", "--as", "c"]);
    expect(await runChat(["post", "r", "status: lane at 60%", "--as", "a"])).toBe(
      "on the record for 2 members, woke nobody: @handle or @here wakes someone, rt chat dm reaches one\nposted → https://chat.mattstack/r/r#m-1",
    );
    await runChat(["join", "solo", "--as", "a"]);
    expect(await runChat(["post", "solo", "alone", "--as", "a"])).toBe(
      "on the record for 0 members, woke nobody: @handle or @here wakes someone, rt chat dm reaches one\nposted → https://chat.mattstack/r/solo#m-2",
    );
  });

  test("the human's post wakes every member without a mention", async () => {
    await runChat(["join", "r", "--as", "a"]);
    await runChat(["join", "r", "--as", "b"]);
    await runChat(["join", "r", "--as", "matt"]);
    expect(await runChat(["post", "r", "one of you: TLDR", "--as", "matt"])).toBe("delivered to a, b\nposted → https://chat.mattstack/r/r#m-1");
  });

  test("post --file reads the body from a file and keeps its line breaks", async () => {
    await runChat(["join", "r", "--as", "a"]);
    const path = join(home, "post.md");
    writeFileSync(path, "the ask first\n\n- one point\n- another\n");
    await runChat(["join", "r", "--as", "b"]);
    await runChat(["post", "r", "--file", path, "--as", "a"]);
    const out = JSON.parse(await runChat(["read", "r", "--as", "b", "--json"])) as {
      rooms: { messages: { body: string }[] }[];
    };
    const bodies = out.rooms.flatMap((r) => r.messages.map((m) => m.body));
    expect(bodies).toContain("the ask first\n\n- one point\n- another");
  });

  test("post --file refuses an empty file", async () => {
    await runChat(["join", "r", "--as", "a"]);
    const path = join(home, "empty.md");
    writeFileSync(path, "\n");
    const { code, stderr } = await runChatRaw(["post", "r", "--file", path, "--as", "a"]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("is empty");
    writeFileSync(path, "\r\n");
    expect((await runChatRaw(["post", "r", "--file", path, "--as", "a"])).stderr).toContain("is empty");
  });

  test("post --file normalizes CRLF line endings", async () => {
    await runChat(["join", "r", "--as", "a"]);
    await runChat(["join", "r", "--as", "b"]);
    const path = join(home, "crlf.md");
    writeFileSync(path, "lede\r\n\r\n- one\r\n");
    await runChat(["post", "r", "--file", path, "--as", "a"]);
    const out = JSON.parse(await runChat(["read", "r", "--as", "b", "--json"])) as {
      rooms: { messages: { body: string }[] }[];
    };
    expect(out.rooms.flatMap((r) => r.messages.map((m) => m.body))).toContain("lede\n\n- one");
  });

  test("post with no text reads the body from piped stdin, as a bare heredoc does", async () => {
    await runChat(["join", "r", "--as", "a"]);
    await runChat(["join", "r", "--as", "b"]);
    const cliPath = join(import.meta.dir, "..", "..", "cli.ts");
    const proc = Bun.spawn(["bun", "run", cliPath, "chat", "post", "r", "--as", "a"], {
      env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin", RT_SKIP_SETUP: "1", CI: "true" },
      stdin: Buffer.from("the lede\n\n- one point\n- another\n"),
      stdout: "pipe",
      stderr: "pipe",
    });
    children.push(proc);
    const code = await proc.exited;
    expect(code).toBe(0);
    const out = JSON.parse(await runChat(["read", "r", "--as", "b", "--json"])) as {
      rooms: { messages: { body: string }[] }[];
    };
    expect(out.rooms.flatMap((r) => r.messages.map((m) => m.body))).toContain("the lede\n\n- one point\n- another");
  });

  test("post refuses a long single-line body with the heredoc hint; --as-is overrides", async () => {
    await runChat(["join", "r", "--as", "a"]);
    const wall = "x".repeat(520);
    const { code, stderr } = await runChatRaw(["post", "r", wall, "--as", "a"]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("no line breaks");
    expect(stderr).toContain("<<'EOF'");
    expect(await runChat(["post", "r", wall, "--as", "a", "--as-is"])).toBe(
      "on the record for 0 members, woke nobody: @handle or @here wakes someone, rt chat dm reaches one\nposted → https://chat.mattstack/r/r#m-1",
    );
    const long = "y".repeat(300) + "\n" + "z".repeat(300);
    expect(await runChat(["post", "r", long, "--as", "a"])).toBe(
      "on the record for 0 members, woke nobody: @handle or @here wakes someone, rt chat dm reaches one\nposted → https://chat.mattstack/r/r#m-2",
    );
  });

  test("post with --as consumes the flag as the handle, not into the body", async () => {
    // resolveHandle reads --as from anywhere in args; the body must strip it
    // the same way, or the flag is spliced into the posted message text.
    await runChat(["join", "r", "--as", "poster"]);
    await runChat(["join", "r", "--as", "listener"]);
    expect(await runChat(["post", "r", "@listener", "ping", "--as", "poster"])).toBe("delivered to listener\nposted → https://chat.mattstack/r/r#m-1");
    const read = JSON.parse(await runChat(["read", "r", "--as", "listener", "--json"]));
    expect(read.rooms[0].messages[0].body).toBe("@listener ping");
    expect(read.rooms[0].messages[0].handle).toBe("poster");
  });

  test("who lists members of the given room", async () => {
    await runChat(["join", "r", "--as", "a"]);
    await runChat(["join", "r", "--as", "b"]);
    const out = await runChat(["who", "r"]);
    expect(out).toContain("a");
    expect(out).toContain("b");
  });

  async function postedId(): Promise<number> {
    for (const h of ["asker", "b", "c"]) await runChat(["join", "r", "--as", h]);
    await runChat(["post", "r", "one", "of", "you:", "TLDR", "--as", "asker"]);
    const read = JSON.parse(await runChat(["read", "r", "--as", "b", "--json"]));
    return read.rooms[0].messages[0].id as number;
  }

  test("claim: the winner is told so, every later claimant is told who holds it, and both exit 0", async () => {
    const id = await postedId();
    expect(await runChat(["claim", String(id), "--as", "b"])).toBe(`claimed #${id} → asker`);
    const lost = await runChatRaw(["claim", String(id), "--as", "c"]);
    expect(lost.code).toBe(0);
    expect(lost.stdout).toMatch(new RegExp(`^#${id} already claimed by b \\d+s ago \\(claimable again in [0-9ms ]+\\)$`));
    expect(await runChat(["claim", String(id), "--as", "b"])).toBe(`you already hold #${id}`);
  });

  test("claim --json carries the outcome discriminator for every branch", async () => {
    const id = await postedId();
    expect(JSON.parse(await runChat(["claim", String(id), "--as", "b", "--json"]))).toEqual({ ok: true, id, outcome: "claimed", author: "asker", room: "r" });
    const lost = JSON.parse(await runChat(["claim", String(id), "--as", "c", "--json"]));
    expect(lost).toMatchObject({ ok: true, id, outcome: "lost", holder: "b" });
    expect(typeof lost.expiresAt).toBe("number");
  });

  test("release: the holder or the author frees the id; anyone else exits 1 with the reason", async () => {
    const id = await postedId();
    await runChat(["claim", String(id), "--as", "b"]);
    const refused = await runChatRaw(["release", String(id), "--as", "c"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("neither the holder");
    expect(await runChat(["release", String(id), "--as", "b"])).toBe(`released #${id} (was held by b)`);
    await runChat(["claim", String(id), "--as", "c"]);
    expect(await runChat(["release", String(id), "--as", "asker"])).toBe(`released #${id} (was held by c)`);
  });

  test("claim and release refuse a non-id the same way ack does", async () => {
    const { code, stderr } = await runChatRaw(["claim", "m-412", "--as", "b"]);
    expect(code).toBe(1);
    expect(stderr).toContain("not a message id");
    expect((await runChatRaw(["release", "--as", "b"])).stderr).toContain("usage: rt chat release <messageId>");
  });

  test("leave drops membership so rooms no longer lists it", async () => {
    await runChat(["join", "r", "--as", "solo"]);
    await runChat(["leave", "r", "--as", "solo"]);
    const rooms = JSON.parse(await runChat(["rooms", "--json", "--as", "solo"]));
    expect(rooms.rooms).toEqual([]);
  });

  test("archive hides the room from rooms until reopened; --json reports the stamp", async () => {
    await runChat(["join", "r", "--as", "a"]);
    const out = JSON.parse(await runChat(["archive", "r", "--json", "--as", "a"]));
    expect(out.ok).toBe(true);
    expect(out.room).toBe("r");
    expect(typeof out.archivedAt).toBe("number");
    expect(JSON.parse(await runChat(["rooms", "--json", "--as", "a"])).rooms).toEqual([]);

    const plain = await runChat(["archive", "r", "--reopen", "--as", "a"]);
    expect(plain).toContain("reopened #r");
    expect(JSON.parse(await runChat(["rooms", "--json", "--as", "a"])).rooms.map((x: { room: string }) => x.room)).toEqual(["r"]);
  });

  test("archive refuses a room that does not exist with exit 1", async () => {
    const { code, stderr } = await runChatRaw(["archive", "ghost", "--as", "a"]);
    expect(code).toBe(1);
    expect(stderr).toContain("no such room");
  });
});

// ─── sign-in / sign-out (presence) ──────────────────────────────────────────
//
// The flag-splice guard is exercised through `post`, not `dm`: post already
// has a body-splice test above (for `--as`); this one covers the two flags
// FLAGS_WITH_VALUES adds for presence (`--session`, `--status`).

describe("rt chat CLI — sign-in / sign-out (presence)", () => {
  test("flag values never splice into a body: --session and --status are FLAGS_WITH_VALUES", async () => {
    await runChat(["join", "r", "--as", "x"]);
    await runChat(["post", "r", "hello there", "--session", "s1", "--status", "busy", "--as", "x"]);
    const read = JSON.parse(await runChat(["read", "r", "--as", "x", "--json"]));
    expect(read.rooms[0].messages[0].body).toBe("hello there");
  });

  test("position 0: a signed-in session resolves the assigned handle for every verb", async () => {
    await signInInProcess({ as: "x", session: "s1" });
    await runChat(["join", "r"]); // no --as, no --session: resolves from the session file
    await runChat(["post", "r", "hello"]); // same — the session file, not the cwd-derived handle
    expect(await runChat(["who", "r"])).toContain("x");
  });

  test("--as while signed in is refused with the reason", async () => {
    await signInInProcess({ as: "x", session: "s1" });
    const { code, stderr } = await runChatRaw(["post", "r", "hi", "--as", "y", "--session", "s1"]);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/signed in as x.*sign out/);
  });

  test("deriveRoomForCwd: remote-kind, path-kind, not-a-worktree", () => {
    expect(__test__.roomForIdentity({ kind: "remote", id: "gitlab.example.com/acme/Acme-Dev" })).toBe("acme-dev");
    expect(__test__.roomForIdentity({ kind: "path", id: "/Users/m/pool/gamma" })).toBe("pool-gamma");

    // findGitRoot gate: a real (non-symlinked) tmpdir outside any git work tree.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "rt-chat-noroom-")));
    try {
      expect(__test__.deriveRoomForCwd(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("sign-in prints the identity line; --no-room and --room work", async () => {
    const out = await runChat(["sign-in", "--as", "x", "--room", "warroom", "--session", "s1"]);
    expect(out).toMatch(/signed in as x/);
    expect(out).toMatch(/#warroom/);
  });

  test("sign-in without --as draws a first name from the pool and keeps it on a repeat sign-in", async () => {
    const first = await runChat(["sign-in", "--no-room", "--session", "s7"]);
    const handle = /signed in as (\S+)/.exec(first)?.[1] ?? "";
    expect(AGENT_NAMES).toContain(handle);
    const again = await runChat(["sign-in", "--no-room", "--session", "s7"]);
    expect(again).toMatch(new RegExp(`signed in as ${handle}\\b`));
  });

  test("a herdr pane redraws its earlier pool handle even after a fresh session signs in", async () => {
    process.env.HERDR_PANE_ID = "wAR:p3";
    const first = await runChat(["sign-in", "--no-room", "--session", "sp1"]);
    const handle = /signed in as (\S+)/.exec(first)?.[1] ?? "";
    expect(AGENT_NAMES).toContain(handle);
    await runChat(["sign-out", "--session", "sp1"]);
    const again = await runChat(["sign-in", "--no-room", "--session", "sp2"]);
    expect(again).toMatch(new RegExp(`signed in as ${handle}\\b`));
  });

  test("resolveSignInBaseHandle: a pane pin beats the pool draw but loses to chat.handle and --as", () => {
    process.env.HERDR_PANE_ID = "wAR:p3";
    rememberPaneHandle("wAR:p3", "max", getStateDb());
    expect(__test__.resolveSignInBaseHandle([], "sp-unit")).toBe("max");
    expect(__test__.resolveSignInBaseHandle(["--as", "kai"], "sp-unit")).toBe("kai");
    setSetting("chat.handle", "picked", "user");
    expect(__test__.resolveSignInBaseHandle([], "sp-unit")).toBe("picked");
  });

  test("sign-in never draws a name another live session holds", async () => {
    await runChat(["sign-in", "--as", "fred", "--no-room", "--session", "s8"]);
    for (let i = 0; i < 5; i++) {
      const out = await runChat(["sign-in", "--no-room", "--session", `s9-${i}`]);
      const handle = /signed in as (\S+)/.exec(out)?.[1] ?? "";
      expect(handle).not.toBe("fred");
      expect(handle).not.toMatch(/^fred-\d+$/);
    }
  });

  test("sign-in --json reports the handle and room, with no rename-related fields", async () => {
    const out = await runChat(["sign-in", "--no-room", "--session", "s10", "--json"]);
    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({ ok: true, room: null });
    expect(parsed).not.toHaveProperty("renamed");
    expect(parsed).not.toHaveProperty("title");
  });

  test("the session-rename module is gone: sign-in never spawns a rename subprocess", () => {
    expect(existsSync(join(import.meta.dir, "..", "..", "lib", "chat-rename.ts"))).toBe(false);
  });

  test("sign-in --pane works with no CLAUDE_CODE_SESSION_ID or --session, skipping git derivation", async () => {
    canned["chat:sign-in"] = { ok: true, data: { handle: "kai", baseHandle: "kai", reclaimed: false, sessionId: "pane-sess-1", room: null } };
    const out = await runChat(["sign-in", "--pane", "w1:p1"]);
    expect(out).toMatch(/signed in as kai/);
    const call = seen.find((s) => s.cmd === "chat:sign-in");
    expect(call?.payload).toMatchObject({ pane: "w1:p1", viaPane: true });
    const payload = call?.payload as Record<string, unknown>;
    expect(payload.sessionId).toBeUndefined();
    expect(payload.cwd).toBeUndefined();
    expect(payload.repo).toBeUndefined();
    expect(payload.branch).toBeUndefined();
  });

  test("sign-in --pane --json reports the handle and room from the response, and writes the session file under the daemon-resolved sessionId", async () => {
    canned["chat:sign-in"] = { ok: true, data: { handle: "kai", baseHandle: "kai", reclaimed: false, sessionId: "pane-sess-2", room: "build" } };
    const out = await runChat(["sign-in", "--pane", "w1:p1", "--json"]);
    expect(JSON.parse(out)).toEqual({ ok: true, handle: "kai", room: "build" });
    expect(existsSync(sessionFilePath("pane-sess-2"))).toBe(true);
    expect(JSON.parse(readFileSync(sessionFilePath("pane-sess-2"), "utf8"))).toMatchObject({
      sessionId: "pane-sess-2",
      handle: "kai",
      baseHandle: "kai",
      room: "build",
    });
  });

  test("sign-in --pane resolves the pane's Claude session via herdr, and that session's own later commands then resolve the daemon-assigned handle (finding g)", async () => {
    const uuid = "55555555-5555-5555-5555-555555555555";
    const { sock: herdrSock, stop } = fakeHerdr((method) => {
      if (method !== "session.snapshot") return new HerdrFakeError("invalid_request", method);
      return {
        snapshot: {
          workspaces: [],
          panes: [
            {
              pane_id: "w1:p1",
              workspace_id: "w1",
              tab_id: "w1:t1",
              agent: "claude",
              agent_status: "idle",
              agent_session: { source: "claude", agent: "claude", kind: "id", value: uuid },
            },
          ],
        },
      };
    });
    const origSock = process.env.HERDR_SOCKET_PATH;
    process.env.HERDR_SOCKET_PATH = herdrSock;
    try {
      const out = await runChat(["sign-in", "--pane", "w1:p1"]);
      const handle = /signed in as (\S+)/.exec(out)?.[1] ?? "";
      expect(handle).not.toBe("");
      expect(existsSync(sessionFilePath(uuid))).toBe(true);

      // The pane's OWN later commands (its CLAUDE_CODE_SESSION_ID is the
      // uuid the daemon resolved) must resolve position 0 to that handle,
      // not fall through resolveBaseHandle's cwd/pane fallbacks.
      process.env.CLAUDE_CODE_SESSION_ID = uuid;
      await runChat(["join", "r"]);
      expect(await runChat(["who", "r"])).toContain(handle);
    } finally {
      stop();
      if (origSock === undefined) delete process.env.HERDR_SOCKET_PATH;
      else process.env.HERDR_SOCKET_PATH = origSock;
    }
  });

  test("sign-in --pane never draws baseHandle from chat.handle: with the setting pinned, the daemon still draws from the pool", async () => {
    const uuid = "66666666-6666-6666-6666-666666666666";
    const { sock: herdrSock, stop } = fakeHerdr((method) => {
      if (method !== "session.snapshot") return new HerdrFakeError("invalid_request", method);
      return {
        snapshot: {
          workspaces: [],
          panes: [
            {
              pane_id: "w1:p1",
              workspace_id: "w1",
              tab_id: "w1:t1",
              agent: "claude",
              agent_status: "idle",
              agent_session: { source: "claude", agent: "claude", kind: "id", value: uuid },
            },
          ],
        },
      };
    });
    const origSock = process.env.HERDR_SOCKET_PATH;
    process.env.HERDR_SOCKET_PATH = herdrSock;
    setSetting("chat.handle", "invoker-name", "user");
    try {
      const out = await runChat(["sign-in", "--pane", "w1:p1"]);
      const handle = /signed in as (\S+)/.exec(out)?.[1] ?? "";
      expect(handle).not.toBe("invoker-name");
      expect(AGENT_NAMES).toContain(handle);
      const call = seen.find((s) => s.cmd === "chat:sign-in");
      expect((call?.payload as Record<string, unknown>).baseHandle).toBeUndefined();
    } finally {
      stop();
      setSetting("chat.handle", "", "user");
      if (origSock === undefined) delete process.env.HERDR_SOCKET_PATH;
      else process.env.HERDR_SOCKET_PATH = origSock;
    }
  });

  test("sign-in --pane --no-room forwards noRoom rather than silently ignoring it", async () => {
    canned["chat:sign-in"] = { ok: true, data: { handle: "kai", baseHandle: "kai", reclaimed: false, sessionId: "pane-sess-4", room: null } };
    const out = await runChat(["sign-in", "--pane", "w1:p1", "--no-room"]);
    expect(out).toMatch(/no room joined/);
    const call = seen.find((s) => s.cmd === "chat:sign-in");
    expect((call?.payload as Record<string, unknown>).noRoom).toBe(true);
    expect((call?.payload as Record<string, unknown>).room).toBeUndefined();
  });

  test("sign-in --pane --room forwards the explicit room rather than silently ignoring it", async () => {
    canned["chat:sign-in"] = { ok: true, data: { handle: "kai", baseHandle: "kai", reclaimed: false, sessionId: "pane-sess-5", room: "warroom" } };
    const out = await runChat(["sign-in", "--pane", "w1:p1", "--room", "warroom"]);
    expect(out).toMatch(/joined #warroom/);
    const call = seen.find((s) => s.cmd === "chat:sign-in");
    expect((call?.payload as Record<string, unknown>).room).toBe("warroom");
    expect((call?.payload as Record<string, unknown>).noRoom).toBe(false);
  });

  test("sign-in --pane --room rejects an invalid room name locally, before contacting the daemon", async () => {
    const { code, stderr } = await runChatRaw(["sign-in", "--pane", "w1:p1", "--room", "Bad Room"]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("[a-z0-9._-]");
    expect(seen.find((s) => s.cmd === "chat:sign-in")).toBeUndefined();
  });

  test("--no-room signs in without joining any room", async () => {
    const out = await runChat(["sign-in", "--as", "y", "--no-room", "--session", "s2"]);
    expect(out).toMatch(/signed in as y/);
    expect(out).not.toContain("joined #");
  });

  test("sign-out deletes the session file and disarms", async () => {
    await signInInProcess({ as: "x", session: "s1", noRoom: true });
    const sessionPath = join(home, ".mattstack", "rt", "chat", "sessions", "s1.json");
    expect(existsSync(sessionPath)).toBe(true);

    await runChat(["sign-out", "--session", "s1"]);
    expect(existsSync(sessionPath)).toBe(false);

    const row = getStateDb()
      .query("SELECT signed_out_at FROM chat_presence WHERE session_id = ?")
      .get("s1") as { signed_out_at: number | null } | null;
    expect(row?.signed_out_at).not.toBeNull();
  });

  test("sign-out with the daemon unreachable still cleans up locally and exits 0", async () => {
    await signInInProcess({ as: "x", session: "s1", noRoom: true });
    const sessionPath = join(home, ".mattstack", "rt", "chat", "sessions", "s1.json");
    expect(existsSync(sessionPath)).toBe(true);

    server?.stop(true);
    server = null;

    const { code, stderr } = await runChatRaw(["sign-out", "--session", "s1"]);
    expect(code).toBe(0);
    expect(existsSync(sessionPath)).toBe(false);
    expect(stderr).toContain("daemon");
  });

  test("sign-out --quiet prints nothing even when the daemon is unreachable", async () => {
    await signInInProcess({ as: "x", session: "s1", noRoom: true });

    server?.stop(true);
    server = null;

    const { code, stdout, stderr } = await runChatRaw(["sign-out", "--session", "s1", "--quiet"]);
    expect(code).toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toBe("");
  });

  test("sign-out with no known session id is a refused no-op, not a crash", async () => {
    const { code, stderr } = await runChatRaw(["sign-out"]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("session id");
  });

  test("sign-in without a session id (no --session, no CLAUDE_CODE_SESSION_ID) refuses rather than inventing one", async () => {
    const { code, stderr } = await runChatRaw(["sign-in", "--as", "x", "--no-room"]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("session id");
  });

  test("sign-out --json reports a daemonError field rather than a bare {ok:true} when the daemon leg failed", async () => {
    await signInInProcess({ as: "x", session: "s1", noRoom: true });
    server?.stop(true);
    server = null;

    const out = await runChat(["sign-out", "--session", "s1", "--json"]);
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(typeof parsed.daemonError).toBe("string");
  });

  test("sign-out --quiet with an invalid session id exits 0 silently, matching the missing-id case", async () => {
    const { code, stdout, stderr } = await runChatRaw(["sign-out", "--session", "bad/id", "--quiet"]);
    expect(code).toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toBe("");
  });

  test("sign-out --pane with an inherited foreign CLAUDE_CODE_SESSION_ID signs out the pane's session, not the env one", async () => {
    const uuid = "77777777-7777-7777-7777-777777777777";
    const { sock: herdrSock, stop } = fakeHerdr((method) => {
      if (method !== "session.snapshot") return new HerdrFakeError("invalid_request", method);
      return {
        snapshot: {
          workspaces: [],
          panes: [
            {
              pane_id: "w1:p1",
              workspace_id: "w1",
              tab_id: "w1:t1",
              agent: "claude",
              agent_status: "idle",
              agent_session: { source: "claude", agent: "claude", kind: "id", value: uuid },
            },
          ],
        },
      };
    });
    const origSock = process.env.HERDR_SOCKET_PATH;
    process.env.HERDR_SOCKET_PATH = herdrSock;
    try {
      // The target pane's own session, signed in for real so it has a
      // session file and a live presence row to tear down.
      await signInInProcess({ as: "pane-agent", session: uuid, noRoom: true });
      const paneSessionPath = join(home, ".mattstack", "rt", "chat", "sessions", `${uuid}.json`);
      expect(existsSync(paneSessionPath)).toBe(true);

      // This process inherits a DIFFERENT session id -- the exact hazard
      // --pane sign-out must ignore rather than sign out.
      await signInInProcess({ as: "foreign", session: "foreign-sess", noRoom: true });
      const foreignSessionPath = join(home, ".mattstack", "rt", "chat", "sessions", "foreign-sess.json");
      expect(existsSync(foreignSessionPath)).toBe(true);
      expect(process.env.CLAUDE_CODE_SESSION_ID).toBe("foreign-sess");

      await runChat(["sign-out", "--pane", "w1:p1"]);

      expect(existsSync(paneSessionPath)).toBe(false);
      expect(existsSync(foreignSessionPath)).toBe(true);

      const paneRow = getStateDb()
        .query("SELECT signed_out_at FROM chat_presence WHERE session_id = ?")
        .get(uuid) as { signed_out_at: number | null } | null;
      expect(paneRow?.signed_out_at).not.toBeNull();

      const foreignRow = getStateDb()
        .query("SELECT signed_out_at FROM chat_presence WHERE session_id = ?")
        .get("foreign-sess") as { signed_out_at: number | null } | null;
      expect(foreignRow?.signed_out_at).toBeNull();
    } finally {
      stop();
      if (origSock === undefined) delete process.env.HERDR_SOCKET_PATH;
      else process.env.HERDR_SOCKET_PATH = origSock;
    }
  });

  test("sign-out --pane against an old daemon (no sessionId in the reply) fails loudly rather than reporting a false success", async () => {
    canned["chat:sign-out"] = { ok: true, data: {} };
    const { code, stdout, stderr } = await runChatRaw(["sign-out", "--pane", "w1:p1"]);
    expect(code).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toContain("sign-out --pane needs a daemon that supports it");
  });
});

// ─── buddies, away/back, dm, pulse ──────────────────────────────────────────

describe("rt chat CLI — buddies, away, back, dm", () => {
  test("buddies renders sections listening → idle → offline and names the away text", async () => {
    await signInInProcess({ as: "live1", session: "slv", noRoom: true });
    await signInInProcess({ as: "idle1", session: "sid", noRoom: true });
    await signInInProcess({ as: "off1", session: "soff", noRoom: true });

    const now = Date.now();
    const db = getStateDb();
    db.run("UPDATE chat_presence SET status_text = ? WHERE handle = ?", ["rebasing #67", "idle1"]);
    db.run("UPDATE chat_presence SET signed_out_at = ? WHERE handle = ?", [now, "off1"]);

    // live1's session (sessionId "slv") resolves alive+busy; idle1's
    // (sessionId "sid") resolves alive but not busy. off1 gets no binding
    // at all, but its row is already signed out, which alone reads offline.
    const busyBinding: InboxBinding = { pid: process.pid, socketPath: "/fake.sock", status: "busy" };
    const idleBinding: InboxBinding = { pid: process.pid, socketPath: "/fake.sock", status: "idle" };
    const bindings = new Map<string, InboxBinding>([["slv", busyBinding], ["sid", idleBinding]]);
    registryDeps = { resolve: (sessionId) => bindings.get(sessionId) ?? null, alive: () => true, resolveAll: () => bindings };

    const out = await runChat(["buddies"]);

    const liveIdx = out.indexOf("live1");
    const idleIdx = out.indexOf("idle1");
    const offIdx = out.indexOf("off1");
    expect(liveIdx).toBeGreaterThanOrEqual(0);
    expect(idleIdx).toBeGreaterThan(liveIdx);
    expect(offIdx).toBeGreaterThan(idleIdx);

    expect(out).toMatch(/listening/); // live1
    expect(out).toMatch(/idle/); // idle1
    expect(out).toContain("rebasing #67"); // the away text
    // offline is collapsed to one line, however many offline buddies exist.
    expect(out.split("\n").filter((l) => l.includes("off1")).length).toBe(1);
  });

  test("bare who aliases buddies", async () => {
    await signInInProcess({ as: "x", session: "s1", noRoom: true });
    const out = await runChat(["who"]);
    expect(out).toContain("x");
    // No fake registryDeps: the default resolver finds nothing for this
    // test session id, which reads offline (unresolvable), not idle.
    expect(out).toMatch(/offline/);
  });

  test("away sets the status text (visible on buddies) and back clears it", async () => {
    await signInInProcess({ as: "x", session: "s1", noRoom: true });

    await runChat(["away", "brb", "lunch", "--session", "s1"]);
    const withAway = JSON.parse(await runChat(["buddies", "--json"]));
    expect(withAway.buddies[0]).toMatchObject({ statusText: "brb lunch" });

    await runChat(["back", "--session", "s1"]);
    const withoutAway = JSON.parse(await runChat(["buddies", "--json"]));
    expect(withoutAway.buddies[0].statusText).toBeUndefined();
  });

  test("away/back refuse without a session id rather than acting on a guessed handle", async () => {
    const away = await runChatRaw(["away", "brb"]);
    expect(away.code).not.toBe(0);
    expect(away.stderr).toContain("session id");

    const back = await runChatRaw(["back"]);
    expect(back.code).not.toBe(0);
    expect(back.stderr).toContain("session id");
  });

  test("dm posts and the desk notifies when the recipient is the human", async () => {
    drainNotifications();
    await signInInProcess({ as: "agent", session: "s1", noRoom: true });
    await runChat(["dm", "matt", "you", "there?", "--session", "s1"]);
    expect(peekNotifications()).toHaveLength(1);
  });

  test("dm prints nothing on success (plain), and --json reports the room/recipients", async () => {
    await signInInProcess({ as: "a", session: "s1", noRoom: true });
    await signInInProcess({ as: "b", session: "s2", noRoom: true });

    expect(await runChat(["dm", "b", "hi", "--session", "s1"])).toBe("");

    const out = await runChat(["dm", "b", "again", "--json", "--session", "s1"]);
    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({ ok: true, recipients: ["b"] });

    const rooms = JSON.parse(await runChat(["rooms", "--json", "--session", "s1"]));
    const dmRoom = rooms.rooms.find((r: { room: string }) => r.room === parsed.room);
    expect(dmRoom).toMatchObject({ kind: "dm" });
  });

  test("rooms lists a DM room in a direct section after channels, headed a ↔ b, never the hashed room id", async () => {
    await signInInProcess({ as: "a", session: "s1", noRoom: true });
    await signInInProcess({ as: "b", session: "s2", noRoom: true });
    await runChat(["join", "general", "--session", "s1"]);
    await runChat(["dm", "b", "hi", "--session", "s1"]);

    const out = await runChat(["rooms", "--session", "s1"]);
    expect(out).toContain("a ↔ b");
    expect(out).not.toContain("#dm-");

    const lines = out.split("\n");
    const channelIdx = lines.findIndex((l) => l.startsWith("#general"));
    const directIdx = lines.indexOf("direct");
    const dmIdx = lines.findIndex((l) => l.startsWith("a ↔ b"));
    expect(channelIdx).toBeGreaterThanOrEqual(0);
    expect(directIdx).toBeGreaterThan(channelIdx);
    expect(dmIdx).toBeGreaterThan(directIdx);
  });

  test("who on a DM room lists the two participants and never the human", async () => {
    await signInInProcess({ as: "a", session: "s1", noRoom: true });
    await signInInProcess({ as: "b", session: "s2", noRoom: true });
    await runChat(["dm", "b", "hi", "--session", "s1"]);
    const rooms = JSON.parse(await runChat(["rooms", "--json", "--session", "s1"]));
    const dmRoom = rooms.rooms.find((r: { kind?: string }) => r.kind === "dm").room;

    const out = await runChat(["who", dmRoom]);
    expect(out).toContain("a");
    expect(out).toContain("b");
    expect(out).not.toContain("matt");
  });

  test("who on a DM room renders the a ↔ b heading, never the hashed room id", async () => {
    await signInInProcess({ as: "a", session: "s1", noRoom: true });
    await signInInProcess({ as: "b", session: "s2", noRoom: true });
    await runChat(["dm", "b", "hi", "--session", "s1"]);
    const rooms = JSON.parse(await runChat(["rooms", "--json", "--session", "s1"]));
    const dmRoom = rooms.rooms.find((r: { kind?: string }) => r.kind === "dm").room;

    const out = await runChat(["who", dmRoom, "--session", "s1"]);
    expect(out).toContain("a ↔ b");
    expect(out).not.toContain(`#${dmRoom}`);
  });

  test("read renders a DM room's heading as a ↔ b, never the hashed room id", async () => {
    await signInInProcess({ as: "a", session: "s1", noRoom: true });
    await signInInProcess({ as: "b", session: "s2", noRoom: true });
    await runChat(["dm", "b", "hi", "--session", "s1"]);

    const out = await runChat(["read", "--session", "s2"]);
    expect(out).toContain("a ↔ b");
    expect(out).not.toContain("dm-");
  });
});

// ─── fixture-based derivation coverage ──────────────────────────────────────
//
// Builds real temp worktree structures (a `.git` FILE with a hand-written
// `gitdir:` pointer — never a real git spawn, matching commands/chat.ts's
// own resolution) plus a fixture repo index, and asserts DISTINCT,
// repo-naming handles for a pool slot, the main worktree, and a broken
// worktree. The failure this guards: a bare slot name like "main" or "beta"
// colliding machine-wide across every repo that has a slot by that name.

describe("chat handle derivation — worktree fixtures", () => {
  let root = "";

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "rt-chat-derive-")));
  });

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  /** A real main worktree: `.git` is an actual directory. */
  function makeMainWorktree(path: string): void {
    mkdirSync(join(path, ".git"), { recursive: true });
  }

  /** A linked worktree: `.git` is a FILE pointing at the main repo's `.git/worktrees/<slot>` — the real git layout, hand-written rather than spawned. */
  function makeLinkedWorktree(path: string, mainGitDir: string, slot: string): void {
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, ".git"), `gitdir: ${join(mainGitDir, "worktrees", slot)}\n`);
  }

  test("a pool slot and the main worktree resolve to distinct, repo-naming handles", () => {
    const mainPath = join(root, "acme", "gamma");
    const slotPath = join(root, "acme", "beta");
    makeMainWorktree(mainPath);
    makeLinkedWorktree(slotPath, join(mainPath, ".git"), "beta");

    const index = { "acme-dev": mainPath };

    const mainHandle = __test__.deriveRepoDirHandle(mainPath, index);
    const slotHandle = __test__.deriveRepoDirHandle(slotPath, index);

    expect(mainHandle).toBe("acme-dev-gamma");
    expect(slotHandle).toBe("acme-dev-beta");
    expect(mainHandle).not.toBe(slotHandle);
    // The failure this guards: a bare slot name (no repo prefix) colliding
    // machine-wide across every repo that happens to have a slot with the
    // same name.
    expect(mainHandle).not.toBe("gamma");
    expect(slotHandle).not.toBe("beta");
    expect(mainHandle!.startsWith("acme-dev-")).toBe(true);
    expect(slotHandle!.startsWith("acme-dev-")).toBe(true);
  });

  test("an identity-keyed index row yields the repo's display label, never the wire form (handle charset forbids % and :)", () => {
    const mainPath = join(root, "acme", "gamma-id");
    makeMainWorktree(mainPath);
    const index = { "remote:gitlab.com%2Facme%2Facme-dev": mainPath };

    const handle = __test__.deriveRepoDirHandle(mainPath, index);

    expect(handle).toBe("acme-dev-gamma-id");
    expect(handle).not.toContain("%");
    expect(handle).not.toContain(":");
  });

  test("no collapse rule: an alias that prefixes the worktree dir is not deduplicated", () => {
    // The historical failure this guards: a "collapse" step that stripped the
    // <repo>- prefix from <dir> when dir already began with repo. That is what
    // let a slot reduce to a bare, machine-wide-colliding name. Ugly-and-unique
    // beats pretty-and-colliding, so acme + acme-web stays acme-acme-web.
    const mainPath = join(root, "acme", "acme-web");
    makeMainWorktree(mainPath);
    const index = { acme: mainPath };
    const handle = __test__.deriveRepoDirHandle(mainPath, index);
    expect(handle).toBe("acme-acme-web");
    expect(handle).not.toBe("acme-web");
  });

  test("an unresolvable worktree (stale/foreign gitdir pointer) falls through to null, not a bare directory name", () => {
    const brokenPath = join(root, "workforest-fixture", "feature");
    // A gitdir pointer into a home directory that doesn't exist on this
    // machine — the real-world failure mode ("fatal: not a git repository").
    makeLinkedWorktree(brokenPath, "/Users/nobody-on-this-machine/dead-repo/.git", "feature");

    const index = { "workforest-fixture": join(root, "workforest-fixture", "main") };

    const handle = __test__.deriveRepoDirHandle(brokenPath, index);
    expect(handle).toBeNull();

    // The derivation's own fallback (position 5: cwd relative to $HOME) is
    // what the caller uses when this is null — verify it produces something
    // usable and NOT the naive bare-directory-name or <user>-<host> forms.
    const fallback = __test__.cwdRelativeHandle(brokenPath, root);
    expect(fallback).not.toBe("feature");
    expect(fallback).not.toBe(__test__.userHostHandle());
    expect(fallback.length).toBeGreaterThan(0);
  });

  test("resolveMainWorktreePath: a directory .git is its own main worktree", () => {
    const mainPath = join(root, "solo-repo");
    makeMainWorktree(mainPath);
    expect(__test__.resolveMainWorktreePath(mainPath)).toBe(mainPath);
  });

  test("resolveMainWorktreePath: a linked worktree resolves to the main worktree it points at", () => {
    const mainPath = join(root, "pool", "main");
    const slotPath = join(root, "pool", "slot-a");
    makeMainWorktree(mainPath);
    makeLinkedWorktree(slotPath, join(mainPath, ".git"), "slot-a");
    expect(__test__.resolveMainWorktreePath(slotPath)).toBe(mainPath);
  });

  test("findGitRoot walks up from a subdirectory to the worktree root", () => {
    const mainPath = join(root, "walkup-repo");
    makeMainWorktree(mainPath);
    const nested = join(mainPath, "src", "deep", "dir");
    mkdirSync(nested, { recursive: true });
    expect(__test__.findGitRoot(nested)).toBe(mainPath);
  });

  test("slugify never produces a name outside ^[a-z0-9._-]+$", () => {
    expect(__test__.slugify("Acme/Dev Gamma!!")).toMatch(/^[a-z0-9._-]+$/);
    expect(__test__.slugify("   ")).toMatch(/^[a-z0-9._-]+$/);
  });
});

// ─── Task 9: `rt chat read --last N` and `rt chat invite <pane>` ───────────

describe("rt chat CLI: read --last, invite", () => {
  test("read --last N shows the newest N messages regardless of the cursor, then marks read", async () => {
    await runChat(["join", "build", "--as", "alice"]);
    await runChat(["post", "build", "seed one", "--as", "alice"]);
    await runChat(["post", "build", "seed two", "--as", "alice"]);
    await runChat(["join", "build", "--as", "bob"]);
    const nothing = await runChat(["read", "build", "--as", "bob", "--json"]);
    expect(JSON.parse(nothing).rooms[0]?.messages ?? []).toHaveLength(0);
    const last = await runChat(["read", "build", "--last", "5", "--as", "bob", "--json"]);
    expect(JSON.parse(last).rooms[0].messages.map((m: { body: string }) => m.body)).toEqual(["seed one", "seed two"]);
    const again = await runChat(["read", "build", "--as", "bob", "--json"]);
    expect(JSON.parse(again).rooms[0]?.messages ?? []).toHaveLength(0);
  });

  test("read --last refuses --since and a non-positive N", async () => {
    await runChat(["join", "build", "--as", "alice"]);
    expect((await runChatRaw(["read", "build", "--last", "5", "--since", "5m", "--as", "alice"])).code).toBe(1);
    expect((await runChatRaw(["read", "build", "--last", "0", "--as", "alice"])).code).toBe(1);
  });

  test("read --last requires a room", async () => {
    expect((await runChatRaw(["read", "--last", "5", "--as", "alice"])).code).toBe(1);
  });

  test("invite sends the pane, room, note, the human handle when not signed in, and the caller pane", async () => {
    canned = { "chat:invite": { ok: true, data: { paneId: "w1:p1", delivered: "accepted" } } };
    process.env.HERDR_PANE_ID = "w9:p9";
    const out = await runChat(["invite", "w1:p1", "--room", "build", "--note", "take vite"]);
    expect(out).toContain("accepted");
    const sent = seen.find((s) => s.cmd === "chat:invite")!;
    expect(sent.payload).toEqual({ paneId: "w1:p1", room: "build", note: "take vite", from: "matt", callerPane: "w9:p9" });
  });

  test("invite uses the session's own handle when signed in, and reports refusals with exit 0", async () => {
    await runChat(["sign-in", "--as", "carol", "--session", "sess-c", "--no-room"]);
    canned = { "chat:invite": { ok: true, data: { paneId: "w1:p1", delivered: "refused", reason: "at a prompt" } } };
    const r = await runChatRaw(["invite", "w1:p1", "--room", "build", "--session", "sess-c"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("refused: at a prompt");
    expect((seen.find((s) => s.cmd === "chat:invite")!.payload as { from: string }).from).toBe("carol");
  });

  test("invite requires a pane and --room", async () => {
    expect((await runChatRaw(["invite"])).code).toBe(1);
    expect((await runChatRaw(["invite", "w1:p1"])).code).toBe(1);
  });
});
