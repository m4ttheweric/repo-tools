import { describe, test, expect, afterEach, mock } from "bun:test";
import { dispatch, walkTree, type CommandContext, type CommandNode } from "../command-tree.ts";
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
});
