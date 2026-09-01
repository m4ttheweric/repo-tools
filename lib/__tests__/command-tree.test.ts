import { describe, test, expect, afterEach, mock, spyOn } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { dispatch, walkTree, showPicker, BACK, type CommandContext, type CommandNode } from "../command-tree.ts";
import { installFakePick, type PickFakeStep } from "../ui/pick-fake.ts";
import type { KnownRepo, RepoIdentity } from "../repo.ts";

// mock.module mutates the live "../repo.ts" namespace object IN PLACE, so
// `realRepoModule.getKnownRepos` itself becomes the mock the moment it's
// installed — restoring with `() => realRepoModule` would restore the mock
// to itself. Capture the individual overridden bindings before any
// mock.module("../repo.ts", ...) call in this file.
const realRepoModule = await import("../repo.ts");
const realGetKnownRepos = realRepoModule.getKnownRepos;
const realPickWorktreeFromRepo = realRepoModule.pickWorktreeFromRepo;
const realGetRepoIdentity = realRepoModule.getRepoIdentity;

const noop = async () => {};

const TREE: Record<string, CommandNode> = {
  branch: {
    description: "branch ops",
    subcommands: {
      switch: { description: "switch branch", handler: noop, aliases: ["sw"] },
      clean: { description: "clean branches", handler: noop },
    },
  },
  daemon: {
    description: "daemon ops",
    aliases: ["d"],
    subcommands: {
      logs: {
        description: "log viewer",
        subcommands: {
          tail: { description: "tail logs", handler: noop },
        },
      },
    },
  },
  cd: { description: "navigate", handler: noop },
};

describe("walkTree", () => {
  test("empty path returns the root tree", () => {
    expect(walkTree(TREE, [])).toBe(TREE);
  });

  test("walks one level to a branch node's subcommands", () => {
    expect(walkTree(TREE, ["branch"])).toBe(TREE.branch!.subcommands!);
  });

  test("walks nested levels", () => {
    expect(walkTree(TREE, ["daemon", "logs"])).toBe(
      TREE.daemon!.subcommands!.logs!.subcommands!,
    );
  });

  test("resolves aliases along the path", () => {
    expect(walkTree(TREE, ["d", "logs"])).toBe(
      TREE.daemon!.subcommands!.logs!.subcommands!,
    );
  });

  test("returns null for an unknown segment", () => {
    expect(walkTree(TREE, ["nope"])).toBeNull();
    expect(walkTree(TREE, ["daemon", "nope"])).toBeNull();
  });

  test("returns null when the path ends on a leaf", () => {
    expect(walkTree(TREE, ["cd"])).toBeNull();
    expect(walkTree(TREE, ["daemon", "logs", "tail"])).toBeNull();
  });
});

describe("showPicker", () => {
  let fake: ReturnType<typeof installFakePick> | undefined;

  afterEach(() => {
    fake?.restore();
    fake = undefined;
  });

  function resultStep(result: Partial<{ action: string; value: string | null; query: string }>): PickFakeStep {
    return { kind: "result", result: { action: "select", value: null, query: "", ...result } };
  }

  const PICKER_TREE: Record<string, CommandNode> = {
    provision: {
      description: "provision a worktree",
      handler: noop,
      args: [{ name: "Branch", type: "text" }],
    },
    list: { description: "list worktrees", handler: noop },
  };

  test("select returns {command, withArgs:false}", async () => {
    fake = installFakePick([resultStep({ action: "select", value: "list" })]);
    const picked = await showPicker(PICKER_TREE, ["rt", "worktree"]);
    expect(picked).toEqual({ command: "list", withArgs: false });
  });

  test("alt-enter/with-args returns {command, withArgs:true}", async () => {
    fake = installFakePick([resultStep({ action: "with-args", value: "provision" })]);
    const picked = await showPicker(PICKER_TREE, ["rt", "worktree"]);
    expect(picked).toEqual({ command: "provision", withArgs: true });
  });

  test("ctrl-up returns BACK", async () => {
    fake = installFakePick([resultStep({ action: "back", value: null })]);
    const picked = await showPicker(PICKER_TREE, ["rt", "worktree"]);
    expect(picked).toBe(BACK);
  });

  test("cancel returns null", async () => {
    fake = installFakePick([resultStep({ action: "cancel", value: null })]);
    const picked = await showPicker(PICKER_TREE, ["rt", "worktree"]);
    expect(picked).toBeNull();
  });

  test("passes the breadcrumb through to the request untouched", async () => {
    fake = installFakePick([resultStep({ action: "select", value: "list" })]);
    await showPicker(PICKER_TREE, ["rt", "worktree"]);
    expect(fake.calls[0]!.request.breadcrumb).toEqual(["rt", "worktree"]);
  });

  test("rows render the node name bold and its description dim", async () => {
    fake = installFakePick([resultStep({ action: "select", value: "list" })]);
    await showPicker(PICKER_TREE, ["rt", "worktree"]);
    const rows = fake.calls[0]!.request.rows;
    const listRow = rows.find((r) => r.value === "list")!;
    expect(listRow.left[0]).toMatchObject({ bold: true });
    expect(listRow.left[0]!.text).toContain("list");
    expect(listRow.left[1]).toMatchObject({ tone: "dim" });
    expect(listRow.left[1]!.text).toContain("list worktrees");
  });

  test("sets withArgs on rows that can take args and leaves it off on those that cannot", async () => {
    fake = installFakePick([resultStep({ action: "select", value: "list" })]);
    await showPicker(PICKER_TREE, ["rt", "worktree"]);
    const rows = fake.calls[0]!.request.rows;
    expect(rows.find((r) => r.value === "provision")!.withArgs).toBe(true);
    expect(rows.find((r) => r.value === "list")!.withArgs).toBeUndefined();
  });

  test("registers the with-args action only when some node declares args", async () => {
    fake = installFakePick([resultStep({ action: "select", value: "list" })]);
    await showPicker(PICKER_TREE, ["rt", "worktree"]);
    expect(fake.calls[0]!.request.actions).toContainEqual({
      id: "with-args", label: "with args", key: "alt-enter", scope: "item", group: "pick",
    });

    fake.restore();
    const noArgsTree: Record<string, CommandNode> = { list: { description: "list worktrees", handler: noop } };
    fake = installFakePick([resultStep({ action: "select", value: "list" })]);
    await showPicker(noArgsTree, ["rt", "worktree"]);
    expect(fake.calls[0]!.request.actions?.some((a) => a.id === "with-args")).toBe(false);
  });

  test("registers the ctrl-up-bound back action at every depth: footerHidden at the root, visible below it", async () => {
    fake = installFakePick([resultStep({ action: "select", value: "list" })]);
    await showPicker(PICKER_TREE, ["rt"]);
    // At the root the back action stays bound (ctrl-up still cancels) but
    // footerHidden keeps it out of the keybar legend.
    expect(fake.calls[0]!.request.actions).toContainEqual({
      id: "back", label: "back", key: "ctrl-up", scope: "global", footerHidden: true,
    });

    fake.restore();
    fake = installFakePick([resultStep({ action: "select", value: "list" })]);
    await showPicker(PICKER_TREE, ["rt", "worktree"]);
    expect(fake.calls[0]!.request.actions).toContainEqual({
      id: "back", label: "back", key: "ctrl-up", scope: "global",
    });
    // depth>1 keeps the visible back label: footerHidden never rides the wire.
    const back = fake.calls[0]!.request.actions!.find((a) => a.id === "back")!;
    expect(back.footerHidden).toBeUndefined();
  });

  // The old fzf-backed showPicker captured ctrl-up unconditionally and, at
  // the root (nowhere to go back to), treated it as an outright cancel --
  // same as Esc -- rather than a no-op. The Go picker drops any key with no
  // bound action, so the root case depends on showPicker mapping the
  // "back" result to null itself rather than on depth-gated registration.
  test("ctrl-up at the root cancels (returns null), matching the old exit-on-ctrl-up-at-root behavior", async () => {
    fake = installFakePick([resultStep({ action: "back", value: null })]);
    const picked = await showPicker(PICKER_TREE, ["rt"]);
    expect(picked).toBeNull();
  });
});

// ─── dispatch's --repo flag scoping (RT-34 fix) ──────────────────────────────
//
// command-tree.ts's global `--repo <name>` extraction used to run
// unconditionally for every leaf node, before checking node.context, and
// silently discarded the flag+value whenever the node didn't declare
// context:"worktree" — e.g. the worktree-lifecycle verbs' own `--repo
// <registeredName>` payload flag would vanish before commands/worktree.ts
// ever saw it. The fix scopes the extraction to context:"worktree" nodes.
describe("dispatch --repo flag scoping", () => {
  // Real repo resolution (getKnownRepos/getRepoIdentity) reads ~/.mattstack/rt/repos.json
  // via bare os.homedir(), which — unlike lib/rt-paths.ts's call-time
  // `process.env.HOME ?? homedir()` — is resolved once at process start and
  // can't be redirected from inside a test. So the context:"worktree" case
  // mocks the three functions dispatch dynamically imports from "./repo.ts",
  // restored via mock.module in afterEach so nothing else in the process sees
  // the fake repo past this one test.
  afterEach(() => {
    mock.module("../repo.ts", () => ({
      ...realRepoModule,
      getKnownRepos: realGetKnownRepos,
      pickWorktreeFromRepo: realPickWorktreeFromRepo,
      getRepoIdentity: realGetRepoIdentity,
    }));
  });

  test('context:"worktree" node: --repo is stripped from args and resolved onto ctx.identity', async () => {
    const real = realRepoModule;
    // chdir to the CURRENT cwd (a real, always-existing directory) so
    // dispatch's real process.chdir() call is a harmless no-op — no fake
    // filesystem path needed, and no process-wide cwd side effect to undo.
    const fakeRepo: KnownRepo = {
      repoName: "acme",
      worktrees: [{ path: process.cwd(), branch: "main", isBare: false }],
      dataDir: "/fake/acme-data",
    };
    const fakeIdentity: RepoIdentity = {
      repoName: "acme",
      identity: "path:/fake/acme",
      repoRoot: process.cwd(),
      dataDir: "/fake/acme-data",
      remoteUrl: "",
      baseUrl: "",
    };
    mock.module("../repo.ts", () => ({
      ...real,
      getKnownRepos: () => [fakeRepo],
      pickWorktreeFromRepo: async () => null,
      getRepoIdentity: () => fakeIdentity,
    }));

    let capturedArgs: string[] | undefined;
    let capturedCtx: CommandContext | undefined;
    const tree: Record<string, CommandNode> = {
      cmd: {
        description: "test",
        context: "worktree",
        handler: async (args, ctx) => {
          capturedArgs = args;
          capturedCtx = ctx;
        },
      },
    };

    await dispatch(tree, ["cmd", "--repo", "acme", "--flag", "x"]);

    expect(capturedArgs).toEqual(["--flag", "x"]);
    expect(capturedCtx?.identity?.repoName).toBe("acme");
  });

  test('node without context: --repo survives untouched in its own args (no repo.ts mocking needed)', async () => {
    let capturedArgs: string[] | undefined;
    const tree: Record<string, CommandNode> = {
      cmd: {
        description: "test",
        handler: async (args) => {
          capturedArgs = args;
        },
      },
    };

    await dispatch(tree, ["cmd", "--repo", "foo", "--ticket", "bar"]);

    expect(capturedArgs).toEqual(["--repo", "foo", "--ticket", "bar"]);
  });

  // A `missing: true` row's single worktree is a dead path (its indexed
  // directory no longer exists) — resolving it by name must refuse with
  // missingRepoRefusal instead of chdir-ing into that path.
  test('context:"worktree" node: --repo <missing repo> refuses before any chdir', async () => {
    const real = realRepoModule;
    const missingRepo: KnownRepo = {
      repoName: "moved",
      worktrees: [{ path: "/nonexistent/gone", branch: "", isBare: false }],
      dataDir: "/fake/moved-data",
      missing: true,
    };
    mock.module("../repo.ts", () => ({
      ...real,
      getKnownRepos: () => [missingRepo],
      pickWorktreeFromRepo: async () => null,
      getRepoIdentity: () => null,
    }));

    const chdirSpy = spyOn(process, "chdir").mockImplementation(() => {});
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit sentinel");
    });

    const tree: Record<string, CommandNode> = {
      cmd: { description: "test", context: "worktree", handler: noop },
    };

    try {
      await expect(dispatch(tree, ["cmd", "--repo", "moved"])).rejects.toThrow("process.exit sentinel");
      expect(chdirSpy).not.toHaveBeenCalled();
      expect(exitSpy.mock.calls.at(-1)?.[0]).toBe(1);
      expect(errSpy.mock.calls.flat().join(" ")).toContain("rt repos locate");
    } finally {
      chdirSpy.mockRestore();
      errSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});

// ─── ANSI never reaches a pipe ───────────────────────────────────────────────

describe("screen control is terminal-only", () => {
  /**
   * Driven as a real subprocess with piped stdio, because the property under
   * test IS "what a non-TTY sees" — asserting it against an in-process stub
   * would prove nothing about the thing that broke: a CI clean-room run whose
   * error message was erased by a clear-screen sequence, leaving a remedy that
   * said "check the error above" pointing at output no longer there.
   */
  test("a leaf command emits no clear-screen or breadcrumb when stderr is a pipe", () => {
    const home = mkdtempSync(join(tmpdir(), "rt-ansi-test-"));
    try {
      const result = spawnSync("bun", ["run", "cli.ts", "version"], {
        cwd: join(import.meta.dir, "..", ".."),
        env: { ...process.env, HOME: home },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60_000,
      });
      const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      // The dispatcher's own chrome, which is what erased the error message.
      // A command colouring its OWN output is its business and not asserted here.
      expect(combined).not.toContain("\x1b[2J"); // clear screen
      expect(combined).not.toContain("\x1b[H"); // cursor home
      expect(combined).not.toContain("\u203a"); // the "rt › version" breadcrumb
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 90_000);
});
