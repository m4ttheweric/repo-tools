/**
 * lib/pickers.ts on the rt-ui picker: the repo picker's ctrl-r reload (an
 * in-process event, not fzf's shell-exec `reload()` bind) and the worktree
 * picker's progressive enrichment (cheap rows first, segment rows pushed in
 * once enrichBranches resolves).
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { installFakePick, type PickFakeStep } from "../ui/pick-fake.ts";
import * as linearModule from "../linear.ts";
import * as enrichModule from "../enrich.ts";
import type { EnrichedBranch } from "../enrich.ts";
import type { KnownRepo } from "../repo-index.ts";

let home: string;
let realHome: string | undefined;
let fake: ReturnType<typeof installFakePick> | undefined;

beforeEach(() => {
  realHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "rt-pickers-"));
  process.env.HOME = home;
  spyOn(linearModule, "loadSecrets").mockResolvedValue({ linearApiKey: undefined, gitlabToken: undefined } as any);
});

afterEach(() => {
  fake?.restore();
  fake = undefined;
  mock.restore();
  process.env.HOME = realHome;
  rmSync(home, { recursive: true, force: true });
});

function resultStep(result: Partial<{ action: string; value: string | null; query: string }>): PickFakeStep {
  return { kind: "result", result: { action: "select", value: null, query: "", ...result } };
}

function repoFixture(name: string, path: string, branch = "main"): KnownRepo {
  return { repoName: name, worktrees: [{ path, branch, isBare: false }], dataDir: "/d" };
}

describe("pickFromAllRepos: ctrl-r reload", () => {
  test("registers a ctrl-r event action only when onReload is given", async () => {
    const { pickFromAllRepos } = await import("../pickers.ts");
    fake = installFakePick([resultStep({ action: "select", value: "repo-a" })]);

    await pickFromAllRepos([repoFixture("repo-a", "/a"), repoFixture("repo-b", "/b")]);

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.request.actions ?? []).toHaveLength(0);
  });

  test("ctrl-r re-lists repos in-process and pushes fresh rows without closing the picker", async () => {
    const { pickFromAllRepos } = await import("../pickers.ts");

    const repoA = repoFixture("repo-a", "/a");
    const repoB = repoFixture("repo-b", "/b");
    const repoC = repoFixture("repo-c", "/c");
    let reloadCalls = 0;
    const onReload = () => {
      reloadCalls++;
      return [repoA, repoB, repoC];
    };

    fake = installFakePick([
      { kind: "event", event: { action: "reload", value: null, query: "" } },
      resultStep({ action: "select", value: "repo-b" }),
    ]);

    const result = await pickFromAllRepos([repoA, repoB], { onReload });

    expect(result).toBe("/b");
    expect(reloadCalls).toBe(1);

    const call = fake.calls[0]!;
    expect(call.request.actions).toContainEqual(
      expect.objectContaining({ id: "reload", key: "ctrl-r", event: true }),
    );
    // The picker never closed for the event — exactly one live update, still
    // the same call (no second runPick session was spawned).
    expect(fake.calls).toHaveLength(1);
    expect(call.updates).toHaveLength(1);
    expect(call.updates[0]!.rows).toHaveLength(3);
  });

  test("an unrelated event is ignored (no update pushed)", async () => {
    const { pickFromAllRepos } = await import("../pickers.ts");
    const repoA = repoFixture("repo-a", "/a");
    const repoB = repoFixture("repo-b", "/b");
    let reloadCalls = 0;

    fake = installFakePick([
      { kind: "event", event: { action: "some-other-action", value: null, query: "" } },
      resultStep({ action: "select", value: "repo-a" }),
    ]);

    await pickFromAllRepos([repoA, repoB], { onReload: () => { reloadCalls++; return [repoA, repoB]; } });

    expect(reloadCalls).toBe(0);
    expect(fake.calls[0]!.updates).toHaveLength(0);
  });
});

describe("pickWorktreeWithSwitch: never gets a reload action", () => {
  test("has no ctrl-r action registered (reload is repo-picker-only)", async () => {
    const { pickWorktreeWithSwitch } = await import("../pickers.ts");
    const repo: KnownRepo = {
      repoName: "solo",
      worktrees: [
        { path: "/a/wt1", branch: "main", isBare: false },
        { path: "/a/wt2", branch: "feature", isBare: false },
      ],
      dataDir: "/d",
    };

    fake = installFakePick([resultStep({ action: "select", value: "/a/wt1" })]);
    await pickWorktreeWithSwitch(repo, "/a/wt1");

    // The back action ("Switch to a different repo") is legitimate; ctrl-r
    // reload is not — that's the repo picker's action, never the worktree
    // picker's.
    const actionIds = (fake.calls[0]!.request.actions ?? []).map((a) => a.id);
    expect(actionIds).not.toContain("reload");
  });
});

describe("pickWorktreeWithSwitch: progressive enrichment", () => {
  test("opens with cheap dirName·branch rows, then pushes enriched segment rows once enrichBranches resolves", async () => {
    let resolveEnrich!: (v: EnrichedBranch[]) => void;
    const enrichPromise = new Promise<EnrichedBranch[]>((res) => { resolveEnrich = res; });
    const enrichSpy = spyOn(enrichModule, "enrichBranches").mockReturnValue(enrichPromise);

    const { pickWorktreeWithSwitch } = await import("../pickers.ts");
    const repo: KnownRepo = {
      repoName: "solo",
      worktrees: [
        { path: "/a/wt1", branch: "eng-123-fix-thing", isBare: false },
        { path: "/a/wt2", branch: "feature", isBare: false },
      ],
      dataDir: "/d",
    };

    fake = installFakePick([resultStep({ action: "select", value: "/a/wt1" })]);
    const donePromise = pickWorktreeWithSwitch(repo, "/a/wt2");

    // Cheap rows are on the wire from the very first runPick call -- no
    // await for enrichment stands between "picker opens" and "rows visible".
    // filterableSelect's own dynamic `import("./pick-wrappers.ts")` needs a
    // few microtask turns before runPick actually fires; enrichBranches is
    // still parked on our controlled promise the whole time, so this can't
    // race ahead into the enriched state.
    for (let i = 0; i < 20 && fake.calls.length === 0; i++) await Promise.resolve();
    const call = fake.calls[0]!;
    expect(call.request.rows).toHaveLength(2);
    const cheap = call.request.rows.find((r) => r.value === "/a/wt1")!;
    expect(cheap.left.map((s) => s.text).join("")).toBe("wt1 · eng-123-fix-thing");
    expect(call.updates).toHaveLength(0);

    const enriched: EnrichedBranch[] = [
      { path: "/a/wt1", dirName: "wt1", branch: "eng-123-fix-thing", linearId: "ENG-123", ticket: null, mr: null },
      { path: "/a/wt2", dirName: "wt2", branch: "feature", linearId: null, ticket: null, mr: null },
    ];
    resolveEnrich(enriched);

    await donePromise;
    // The update landed by the time the picker resolved (both promise chains
    // are microtask-only -- no real I/O once enrichBranches is stubbed).
    expect(call.updates).toHaveLength(1);
    const updatedRows = call.updates[0]!.rows!;
    const wt1Row = updatedRows.find((r) => r.value === "/a/wt1")!;
    expect(wt1Row.right).toEqual([{ text: "ENG-123", tone: "dimmer" }]);
    const wt2Row = updatedRows.find((r) => r.value === "/a/wt2")!;
    // currentPath ("/a/wt2") gets the right-pinned "(current)" marker appended.
    expect(wt2Row.right).toEqual([{ text: "[Local Only]", tone: "faint" }, { text: "  " }, { text: "(current)", tone: "faint" }]);

    expect(enrichSpy).toHaveBeenCalledTimes(1);
    expect(enrichSpy.mock.calls[0]![2]).toEqual({ silent: true });
  });
});
