/**
 * rt chat CLI (RT-48 Task 7).
 *
 * runChat/runChatRaw invoke the `chat` export in-process against a temp
 * HOME, backed by a real (not stubbed) chat daemon: a Bun.serve unix socket
 * bound at the HOME's default rt.sock, dispatching to the REAL
 * createChatHandlers (Task 6) over a per-test state.db. This exercises the
 * actual join/member-count/unread rules, not a canned reply map.
 *
 * HERDR_PANE_ID is deliberately cleared for every test: this suite may
 * itself run inside a real herdr pane, and leaving it set would let
 * handle derivation spawn `herdr pane get` against the live session —
 * nondeterministic and slow. See commands/chat.ts's resolveHandle order.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { chat, __test__ } from "../chat.ts";
import { createChatHandlers } from "../../lib/daemon/handlers/chat.ts";
import { getStateDb, closeStateDb } from "../../lib/state/index.ts";

// ─── in-process CLI + fake daemon harness ───────────────────────────────────

let home = "";
let origHome: string | undefined;
let origPaneId: string | undefined;
let origBackoff: string | undefined;
let server: ReturnType<typeof Bun.serve> | null = null;
// Real child processes (spawnChat); reaped in afterEach so a stray tail can't
// outlive its test.
const children: Array<ReturnType<typeof Bun.spawn>> = [];

beforeEach(() => {
  origHome = process.env.HOME;
  origPaneId = process.env.HERDR_PANE_ID;
  origBackoff = process.env.RT_CHAT_BACKOFF_MS;
  delete process.env.HERDR_PANE_ID;
  // Keep the daemon-unreachable backoff short so the exit-69 path is fast.
  process.env.RT_CHAT_BACKOFF_MS = "150";

  home = realpathSync(mkdtempSync(join(tmpdir(), "rt-chat-cli-")));
  process.env.HOME = home;

  const sockDir = join(home, ".mattstack", "rt");
  mkdirSync(sockDir, { recursive: true });

  server = Bun.serve({
    unix: join(sockDir, "rt.sock"),
    async fetch(req) {
      const cmd = new URL(req.url).pathname.slice(1);
      const payload = req.method === "POST" ? await req.json() : {};
      // The tail drives the events bus directly; the CLI-verb harness has no
      // real bus, so stub just enough for a spawned tail to arm and block.
      if (cmd === "events:head") return Response.json({ ok: true, data: { cursor: 0 } });
      if (cmd === "events:wait") {
        await Bun.sleep(300); // empty long-poll round; the tail loops and stays alive
        return Response.json({ ok: true, data: { events: [], cursor: 0 } });
      }
      const handlers = createChatHandlers({ db: getStateDb(), emitEvent: () => 0 }) as unknown as Record<string, (p: unknown) => Promise<unknown>>;
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
  if (origBackoff === undefined) delete process.env.RT_CHAT_BACKOFF_MS;
  else process.env.RT_CHAT_BACKOFF_MS = origBackoff;
});

/**
 * A REAL `rt chat …` process against the same temp HOME, so its pidfile lands
 * in the same rt dir and its `ps args` identify it as an rt chat tail (the
 * liveness+identity check the double-arm guard relies on). Runs cli.ts under
 * bun — there is no compiled binary in unit tests.
 */
function spawnChat(args: string[]): ReturnType<typeof Bun.spawn> {
  const cliPath = join(import.meta.dir, "..", "..", "cli.ts");
  const proc = Bun.spawn(["bun", "run", cliPath, "chat", ...args], {
    env: {
      HOME: home,
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      RT_SKIP_SETUP: "1",
      CI: "true",
      RT_CHAT_BACKOFF_MS: "150",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(proc);
  return proc;
}

/** Poll a predicate to a deadline (no daemon, no env — a pure wait). */
async function until(pred: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("until: predicate never became true");
    await Bun.sleep(25);
  }
}

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

// ─── Step 1 (brief) ──────────────────────────────────────────────────────────

describe("rt chat CLI", () => {
  test("join prints the member count so a typo is visible", async () => {
    const out = await runChat(["join", "buidl"]);
    expect(out).toContain("1 member");
    expect(out).toContain("you are alone here");
  });

  test("post prints nothing on success", async () => {
    await runChat(["join", "r"]);
    expect(await runChat(["post", "r", "hello"])).toBe("");
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

  test("mark advances the cursor and prints nothing", async () => {
    await runChat(["join", "r", "--as", "a"]);
    expect(await runChat(["mark", "r", "--as", "a"])).toBe("");
  });

  test("post's body is every word after the room, joined back with spaces", async () => {
    await runChat(["join", "r", "--as", "a"]);
    await runChat(["join", "r", "--as", "b"]);
    expect(await runChat(["post", "r", "hello", "world"])).toBe(""); // prints nothing — Global Constraint
    const read = JSON.parse(await runChat(["read", "r", "--as", "b", "--json"]));
    expect(read.rooms[0].messages[0].body).toBe("hello world");
  });

  test("post with --as consumes the flag as the handle, not into the body", async () => {
    // resolveHandle reads --as from anywhere in args; the body must strip it
    // the same way, or the flag is spliced into the posted message text.
    await runChat(["join", "r", "--as", "poster"]);
    await runChat(["join", "r", "--as", "listener"]);
    expect(await runChat(["post", "r", "@listener", "ping", "--as", "poster"])).toBe("");
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

  test("leave drops membership so rooms no longer lists it", async () => {
    await runChat(["join", "r", "--as", "solo"]);
    await runChat(["leave", "r", "--as", "solo"]);
    const rooms = JSON.parse(await runChat(["rooms", "--json", "--as", "solo"]));
    expect(rooms.rooms).toEqual([]);
  });
});

// ─── Task 8: the tail (wake protocol) ───────────────────────────────────────

describe("rt chat tail", () => {
  const rtDir = () => join(home, ".mattstack", "rt");
  const hasTailPidfile = () =>
    existsSync(rtDir()) && readdirSync(rtDir()).some((f) => f.startsWith("chat-tail-"));

  test("tail exits 69 when the daemon is unreachable, rather than hanging", async () => {
    const { code } = await runChatRaw(["tail"], { sock: "/nonexistent.sock" });
    expect(code).toBe(69);
  });

  test("tail takes no --timeout", async () => {
    // Monitor owns the lifetime via persistent: true. A tail that could time
    // out would end its own stream and look like a dead feed.
    const { code, stderr } = await runChatRaw(["tail", "--timeout", "1s"]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("--timeout");
  });

  test("tail refuses to double-arm", async () => {
    await runChat(["join", "r"]);
    const first = spawnChat(["tail"]);
    // Wait for the spawned tail to actually claim its pidfile; without this the
    // second invocation would race past the (not-yet-written) lock and block.
    await until(hasTailPidfile);
    const { code, stderr } = await runChatRaw(["tail"]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("already armed");
    first.kill();
  }, 15_000);

  test("every stdout write in the tail path is exactly one line", async () => {
    // Under Monitor each stdout line is one notification, so a multi-line write
    // floods the agent's context. Diagnostics must go to stderr.
    const src = await Bun.file(join(import.meta.dir, "..", "chat.ts")).text();
    const tailFn = src.slice(src.indexOf("async function chatTail"));
    const logs = tailFn.match(/console\.log\([^)]*\)/g) ?? [];
    expect(logs.every((l) => !l.includes("\\n"))).toBe(true);
  });
});

// ─── carry-forward: fixture-based derivation test (controller mandate) ─────
//
// Task 2's plan block orphaned a fixture-based derivation test; its coverage
// is carried here. Builds real temp worktree structures (a `.git` FILE with
// a hand-written `gitdir:` pointer — never a real git spawn, matching
// commands/chat.ts's own resolution) plus a fixture repo index, and asserts
// DISTINCT, repo-naming handles for a pool slot, the main worktree, and a
// broken worktree. The failure this guards: a bare slot name like "main" or
// "beta" colliding machine-wide across every repo that has a slot by that
// name.

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

describe("pidfile identity — only a real rt chat tail reads as live", () => {
  test("matches rt and dev cli.ts invocations of `chat tail`", () => {
    expect(__test__.looksLikeRtChatTail("/Users/m/.mattstack/rt/bin/rt chat tail --as listener")).toBe(true);
    expect(__test__.looksLikeRtChatTail("bun run /repo/cli.ts chat tail")).toBe(true);
  });

  test("does not match a recycled PID whose unrelated args merely mention both words", () => {
    // The failure this guards: a false-positive here refuses an agent's re-arm
    // with "already armed" and leaves it permanently deaf.
    expect(__test__.looksLikeRtChatTail("/usr/bin/some-tool --mode chat --action tail")).toBe(false);
    expect(__test__.looksLikeRtChatTail("/opt/chat-tail-daemon --serve")).toBe(false);
    expect(__test__.looksLikeRtChatTail("rt chat read")).toBe(false);
    expect(__test__.looksLikeRtChatTail("vim tail-of-a-chat.log")).toBe(false);
  });
});
