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
  mkdirSync,
  mkdtempSync,
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
let server: ReturnType<typeof Bun.serve> | null = null;

beforeEach(() => {
  origHome = process.env.HOME;
  origPaneId = process.env.HERDR_PANE_ID;
  delete process.env.HERDR_PANE_ID;

  home = realpathSync(mkdtempSync(join(tmpdir(), "rt-chat-cli-")));
  process.env.HOME = home;

  const sockDir = join(home, ".mattstack", "rt");
  mkdirSync(sockDir, { recursive: true });

  server = Bun.serve({
    unix: join(sockDir, "rt.sock"),
    async fetch(req) {
      const cmd = new URL(req.url).pathname.slice(1);
      const payload = req.method === "POST" ? await req.json() : {};
      const handlers = createChatHandlers({ db: getStateDb(), emitEvent: () => 0 }) as unknown as Record<string, (p: unknown) => Promise<unknown>>;
      const handler = handlers[cmd];
      if (!handler) return Response.json({ ok: false, error: `unknown command: ${cmd}` });
      return Response.json(await handler(payload));
    },
  });
});

afterEach(() => {
  server?.stop(true);
  server = null;
  closeStateDb();
  if (home) rmSync(home, { recursive: true, force: true });
  process.env.HOME = origHome;
  if (origPaneId === undefined) delete process.env.HERDR_PANE_ID;
  else process.env.HERDR_PANE_ID = origPaneId;
});

/**
 * Mirrors commands/__tests__/runs.test.ts's runExpectingCleanExit: mocks
 * process.exit to throw a sentinel so a `fail()` path never kills the real
 * test process, and reads the spies' recorded calls before mockRestore()
 * clears them.
 */
async function runChatRaw(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
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
