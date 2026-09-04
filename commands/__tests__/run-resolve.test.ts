import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { __test__ as pickTest, type PickHandle } from "../../lib/ui/pick.ts";
import type { PickRequest, PickResult } from "../../lib/ui/protocol.ts";
import { updateRepoIndex } from "../../lib/repo-index.ts";
import { RunAborted, resolveRun } from "../run.ts";

test("RunAborted carries the exit code the picker would have used", () => {
  const e = new RunAborted(1, "cancelled");
  expect(e).toBeInstanceOf(Error);
  expect(e.code).toBe(1);
  expect(e.message).toBe("cancelled");
});

test("resolveRun with no known repos and no context resolves cancelled, never exits the process", async () => {
  // The picker chain's first gate is the repo index; with an empty index it
  // used to process.exit(1). Now it must come back as a cancellation.
  const res = await resolveRun([], { identity: undefined } as never);
  expect(res.kind).toBe("cancelled");
  if (res.kind === "cancelled") expect(res.code).toBe(1);
});

// ─── Back-navigation out of a cwd-resolved context ───────────────────────────

/** One scripted PickResult per runPick call, in order. Local to this file: lib/ui/pick-fake.ts's installFakePick replays its whole script on every call, which cannot express "first picker, then the next one". */
function installSequentialPick(results: Array<Omit<PickResult, "t">>): { calls: PickRequest[]; restore: () => void } {
  const calls: PickRequest[] = [];
  let i = 0;
  pickTest.setImpl((req) => {
    calls.push(req);
    const r = results[i] ?? results[results.length - 1]!;
    i++;
    return {
      update() {},
      modal: async () => null,
      result: Promise.resolve({ t: "result", ...r }),
    } satisfies PickHandle;
  });
  return { calls, restore: () => pickTest.setImpl(undefined) };
}

/** A repo getKnownRepos' single-worktree fast path accepts: a real .git DIRECTORY with a HEAD ref, no git subprocess needed. Nested under a caller-owned container because getKnownRepos scans each known repo's PARENT for unregistered siblings -- fixtures placed directly in tmpdir make that scan enumerate every stale test repo the machine has ever left there (83k, ~70s, on the machine this was written). */
function makeRepoFixture(container: string, name: string, pkgNames: string[]): string {
  const root = join(container, name);
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name, workspaces: ["packages/*"] }));
  for (const pkg of pkgNames) {
    const dir = join(root, "packages", pkg);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: pkg, scripts: { dev: "vite" } }));
  }
  return root;
}

test("ctrl-up out of the package picker on a single-worktree resolved repo goes up to the repo picker, not back into the same package picker", async () => {
  // `rt run` from a repo root resolves that repo from cwd and opens the
  // package picker directly, skipping repo and worktree. ctrl-up there fell
  // through to the full picker chain, which re-derived the same repo and its
  // only worktree and re-rendered the picker just dismissed... a dead level
  // that made "back" look like it flashed and did nothing until pressed twice.
  const container = mkdtempSync(join(tmpdir(), "rt-run-back-"));
  const root = makeRepoFixture(container, "fixture", ["a", "b"]);
  const other = makeRepoFixture(container, "other", ["c", "d"]);
  const identity = `test-back-repo-${Date.now()}`;
  updateRepoIndex(identity, root);
  updateRepoIndex(`${identity}-other`, other);

  const fake = installSequentialPick([
    { action: "ctrl-up", value: null, query: "" }, // 0: package picker, press back
    { action: "cancel", value: null, query: "" }, // 1: whatever comes next, bail out
  ]);

  try {
    const ctx = {
      identity: { repoName: "back-fixture", identity, repoRoot: root, dataDir: "", remoteUrl: "", baseUrl: "" },
    } as never;
    const res = await resolveRun([], ctx);

    expect(res.kind).toBe("cancelled");
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]!.message).toContain("Select package");
    expect(fake.calls[1]!.message).toBe("Select repo");
  } finally {
    fake.restore();
    rmSync(container, { recursive: true, force: true });
  }
});
