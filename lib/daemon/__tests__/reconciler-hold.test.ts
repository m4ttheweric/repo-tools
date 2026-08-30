/**
 * The hold `repos:locate` runs inside: a reconcile pass that observed a healed
 * index path against un-rewritten registry paths prunes every registry row as
 * "no matching worktree", taking the pool's claim state with it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { mkdtempSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Logger } from "pino";
import { writeJson } from "../../json-store.ts";
import { repoDataDir, rtDir } from "../../rt-paths.ts";
import { closeStateDb } from "../../state/index.ts";
import { loadRegistry, saveRegistry, type TreeRecord } from "../../worktree/registry.ts";
import { withTreeLock } from "../../worktree/locks.ts";
import { createWorktreeHandlers } from "../handlers/worktree.ts";
import { createWorktreeReconciler } from "../worktree-reconciler.ts";
import { fakeStore } from "./fake-cache-store.ts";

const silentLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger;

/** An empty index makes each pass a no-op with real awaits — enough to observe pass boundaries without any git. */
function harness(order: string[]) {
  return createWorktreeReconciler({
    cache: { entries: {} },
    repoIndex: () => {
      order.push("pass");
      return {};
    },
    emit: () => {},
    log: silentLog,
  });
}

async function settle(reconciler: { passInFlight: () => boolean }): Promise<void> {
  for (let i = 0; i < 200 && reconciler.passInFlight(); i++) await Bun.sleep(5);
}

describe("withReconcilerHeld", () => {
  const origHome = process.env.HOME;
  let home: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-hold-home-")));
    process.env.HOME = home;
    closeStateDb();
  });

  afterEach(async () => {
    process.env.HOME = origHome;
    closeStateDb();
    rmSync(home, { recursive: true, force: true });
  });

  test("a pass already in flight finishes before the held fn runs", async () => {
    const order: string[] = [];
    const reconciler = harness(order);

    reconciler.kick();
    await reconciler.withReconcilerHeld(async () => {
      order.push("fn");
    });

    expect(order).toEqual(["pass", "fn"]);
  });

  test("a kick during the hold starts no pass until the fn settles", async () => {
    const order: string[] = [];
    const reconciler = harness(order);

    await reconciler.withReconcilerHeld(async () => {
      reconciler.kick();
      await Bun.sleep(10);
      expect(order).toEqual([]);
      order.push("fn-done");
    });

    await settle(reconciler);
    expect(order).toEqual(["fn-done", "pass"]);
  });

  test("two holders serialize", async () => {
    const order: string[] = [];
    const reconciler = harness(order);

    await Promise.all([
      reconciler.withReconcilerHeld(async () => {
        order.push("a-start");
        await Bun.sleep(10);
        order.push("a-end");
      }),
      reconciler.withReconcilerHeld(async () => {
        order.push("b-start");
        await Bun.sleep(1);
        order.push("b-end");
      }),
    ]);

    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  test("a throwing fn releases the hold", async () => {
    const order: string[] = [];
    const reconciler = harness(order);

    await expect(
      reconciler.withReconcilerHeld(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    reconciler.kick();
    await settle(reconciler);
    expect(order).toEqual(["pass"]);
  });

  test("the fn's value comes back to the caller", async () => {
    const reconciler = harness([]);
    expect(await reconciler.withReconcilerHeld(async () => 42)).toBe(42);
  });
});

/**
 * worktree:adopt and worktree:freshen run their rewrite inside the same hold
 * repos:locate uses: a reconciler pass reading the registry mid-rewrite would
 * prune or reclassify rows the handler has not gotten to yet.
 */
describe("worktree:adopt and worktree:freshen under the reconciler hold", () => {
  const origHome = process.env.HOME;
  let home: string;
  const repoName = "remote:acme";

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-hold-wt-home-")));
    process.env.HOME = home;
    closeStateDb();
    writeJson(join(rtDir(), "worktrees.json"), { enabled: true, killProcesses: false });
  });

  afterEach(async () => {
    process.env.HOME = origHome;
    closeStateDb();
    rmSync(home, { recursive: true, force: true });
  });

  function sh(cmd: string, cwd?: string): string {
    return execSync(cmd, { cwd, shell: "/bin/zsh", encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  }

  /** A repo on `main` with one commit and a bare clone wired up as origin. */
  function makeRepo(): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "rt-hold-wt-")));
    sh("git init -b main && git -c user.email=t@t -c user.name=t commit --allow-empty -m init", dir);
    const bare = realpathSync(mkdtempSync(join(tmpdir(), "rt-hold-wt-bare-")));
    sh(`git clone --bare ${dir} ${bare}/o.git && git -C ${dir} remote add origin ${bare}/o.git && git -C ${dir} fetch origin`);
    return dir;
  }

  /** Register a real on-deck worktree (git + registry) without paying createTree. */
  function seedOnDeck(repo: string, name: string, readyAt: string): TreeRecord {
    const path = join(repo, ".worktrees", name);
    sh(`git worktree add -b on-deck/${name} ${path} origin/main`, repo);
    const rec: TreeRecord = {
      name, path,
      kind: "ephemeral",
      state: "on-deck",
      branch: `on-deck/${name}`,
      createdAt: readyAt,
      readyAt,
    };
    const trees = loadRegistry(repoName);
    trees.push(rec);
    saveRegistry(repoName, trees);
    return rec;
  }

  test("worktree:adopt rewrites its rows under the hold, and no longer takes the #adopt tree lock", async () => {
    const order: string[] = [];
    const reconciler = harness(order);

    const repo = makeRepo();
    const parked = join(repo, ".worktrees", "parked");
    sh(`git worktree add -b parking-lot/1 ${parked} origin/main`, repo);
    writeJson(join(repoDataDir(repoName), "parking-lot.json"), { [parked]: { branch: "parking-lot/1" } });
    writeJson(join(rtDir(), "parking-lot-state.json"), { transitions: [] });

    let kicked = false;
    const probe: { legacyLockAttempt: Promise<"busy" | "ok"> | null } = { legacyLockAttempt: null };
    const h = createWorktreeHandlers(
      { cache: fakeStore(), repoIndex: () => ({ [repoName]: repo }), log: silentLog },
      {
        emit: (type: string) => {
          order.push(`emit:${type}`);
          // Fires mid-adopt, from inside disposeTree's own emit: the moment
          // this runs is the moment the OLD code held `${repoPath}#adopt` for
          // the whole handler body, so a concurrent attempt on that same key
          // came back "busy" there. It must come back free now.
          if (!kicked) {
            kicked = true;
            reconciler.kick();
            // Deterministic proof: kick() sets `inFlight` synchronously the
            // moment it starts a pass, and only skips that when `hold` is
            // already truthy. Finding no pass in flight here proves adopt's
            // rewrite is itself running inside the hold.
            expect(reconciler.passInFlight()).toBe(false);
            probe.legacyLockAttempt = withTreeLock(`${repo}#adopt`, async () => "ok" as const);
          }
        },
        kick: reconciler.kick,
        creationInFlight: () => null,
        withReconcilerHeld: reconciler.withReconcilerHeld,
      },
    );

    const res: any = await h["worktree:adopt"]!({ repoName });

    expect(res.ok).toBe(true);
    expect(await probe.legacyLockAttempt).toBe("ok");

    // The queued kick eventually runs once adopt releases the hold.
    await settle(reconciler);
    expect(order).toContain("pass");
  });

  test("worktree:freshen runs under the hold: a kick queued mid-freshen starts no pass until it settles", async () => {
    const order: string[] = [];
    const reconciler = harness(order);

    const repo = makeRepo();
    const rec = seedOnDeck(repo, "alpha", new Date().toISOString());
    sh("git -c user.email=t@t -c user.name=t commit --allow-empty -m advance && git push -q origin main", repo);

    let kicked = false;
    const h = createWorktreeHandlers(
      { cache: fakeStore(), repoIndex: () => ({ [repoName]: repo }), log: silentLog },
      {
        emit: (type: string) => {
          order.push(`emit:${type}`);
          if (!kicked && type === "worktree:freshened") {
            kicked = true;
            reconciler.kick();
            // Deterministic proof: kick() sets `inFlight` synchronously the
            // moment it starts a pass, and only skips that when `hold` is
            // already truthy. Finding no pass in flight here proves freshen's
            // run is itself happening inside the hold.
            expect(reconciler.passInFlight()).toBe(false);
          }
        },
        kick: reconciler.kick,
        creationInFlight: () => null,
        withReconcilerHeld: reconciler.withReconcilerHeld,
      },
    );

    const res: any = await h["worktree:freshen"]!({ repoName, tree: "alpha" });

    expect(res.ok).toBe(true);
    expect(res.data.ran).toEqual([rec.name]);
    expect(order).toContain("emit:worktree:freshened");

    // The queued kick eventually runs once freshen releases the hold.
    await settle(reconciler);
    expect(order).toContain("pass");
  });
});
