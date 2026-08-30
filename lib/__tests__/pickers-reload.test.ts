/**
 * Finding 1 regression: `rt cd --emit-rows` (the reload command) emits REPO
 * rows, so only a repo-list picker may bind ctrl-r to it. The worktree picker
 * (`pickWorktreeWithSwitch`) must never receive `reloadCommand`, or its ctrl-r
 * would replace worktree rows with repo rows.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as linearModule from "../linear.ts";
import { buildFilterableSelectArgs } from "../fzf-select.ts";
import type { KnownRepo } from "../repo-index.ts";

// Captured before any mock.module call — mock.module mutates the live
// namespace object in place, so restoring with the ORIGINAL binding (not a
// re-import) is what undoes it for every other test file sharing this process.
const realFzfSelect = await import("../fzf-select.ts");

const CD_RELOAD_COMMAND = "rt cd --emit-rows";

let home: string;
let realHome: string | undefined;
let capturedOpts: Array<Record<string, unknown>>;

beforeEach(() => {
  realHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "rt-pickers-reload-"));
  process.env.HOME = home;
  spyOn(linearModule, "loadSecrets").mockResolvedValue({ linearApiKey: undefined, gitlabToken: undefined } as any);

  capturedOpts = [];
  mock.module("../fzf-select.ts", () => ({
    ...realFzfSelect,
    filterableSelect: async (opts: Record<string, unknown>) => {
      capturedOpts.push(opts);
      const options = opts.options as Array<{ value: string }>;
      return options[0]?.value ?? null;
    },
  }));
});

afterEach(() => {
  mock.module("../fzf-select.ts", () => realFzfSelect);
  mock.restore();
  process.env.HOME = realHome;
  rmSync(home, { recursive: true, force: true });
});

function repoFixture(name: string, path: string): KnownRepo {
  return {
    repoName: name,
    worktrees: [{ path, branch: "main", isBare: false }],
    dataDir: "/d",
  };
}

describe("worktree picker vs repo picker: reloadCommand forwarding", () => {
  test("pickWorktreeWithSwitch (no reloadCommand, matching the fixed cd.ts call) never binds ctrl-r", async () => {
    const { pickWorktreeWithSwitch } = await import("../pickers.ts");

    const repo = repoFixture("solo", "/a");
    await pickWorktreeWithSwitch(repo, "/a", { stderr: true });

    expect(capturedOpts.length).toBe(1);
    expect(capturedOpts[0]!.reloadCommand).toBeUndefined();

    const args = buildFilterableSelectArgs(capturedOpts[0] as any);
    expect(args.some((a) => a.startsWith("--bind=ctrl-r"))).toBe(false);
    expect(args.some((a) => String(a).includes("ctrl-r: refresh"))).toBe(false);
  });

  test("pickFromAllRepos (repo picker, as called from cd.ts) binds ctrl-r to rt cd --emit-rows", async () => {
    const { pickFromAllRepos } = await import("../pickers.ts");

    const repos = [repoFixture("repo-a", "/a"), repoFixture("repo-b", "/b")];
    await pickFromAllRepos(repos, { stderr: true, reloadCommand: CD_RELOAD_COMMAND });

    expect(capturedOpts.length).toBe(1);
    expect(capturedOpts[0]!.reloadCommand).toBe(CD_RELOAD_COMMAND);

    const args = buildFilterableSelectArgs(capturedOpts[0] as any);
    expect(args).toContain(`--bind=ctrl-r:reload(${CD_RELOAD_COMMAND})`);
    expect(args.some((a) => String(a).includes("ctrl-r: refresh"))).toBe(true);
  });
});
