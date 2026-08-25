import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeStateDb, setKvValue } from "../../state/index.ts";
import { loadRepoIndex } from "../../repo-index.ts";
import { saveRegistry } from "../../worktree/registry.ts";
import { deriveRepoIdentity, serializeIdentity } from "../../settings/identity.ts";
import { createReposHandlers } from "../handlers/repos.ts";

describe("repos:locate", () => {
  const origHome = process.env.HOME;
  let home: string;
  let scratch: string;
  let order: string[];
  let events: { topic: string; payload: unknown }[];
  let handlers: ReturnType<typeof createReposHandlers>;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-repos-handler-home-")));
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "rt-repos-handler-repos-")));
    process.env.HOME = home;
    closeStateDb();
    order = [];
    events = [];
    handlers = createReposHandlers({
      withReconcilerHeld: async (fn) => {
        order.push("hold-start");
        try {
          return await fn();
        } finally {
          order.push("hold-end");
        }
      },
      refreshWatchedRepos: () => order.push("refresh"),
      emitEvent: (topic, payload) => {
        order.push(`emit:${topic}`);
        events.push({ topic, payload });
      },
    });
  });

  afterEach(() => {
    process.env.HOME = origHome;
    closeStateDb();
    rmSync(home, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });

  async function movedRepo(name: string): Promise<{ identity: string; from: string; to: string }> {
    const dir = join(scratch, name);
    mkdirSync(dir, { recursive: true });
    execSync("git init -q -b main", { cwd: dir, stdio: "pipe" });
    execSync(`git remote add origin https://gitlab.com/g/${name}.git`, { cwd: dir, stdio: "pipe" });
    execSync("git -c user.email=t@t -c user.name=t commit --allow-empty -q -m init", { cwd: dir, stdio: "pipe" });
    const from = realpathSync(dir);
    const identity = serializeIdentity(await deriveRepoIdentity(from));
    setKvValue("repo-index", identity, from);
    saveRegistry(identity, [{ name: "main", path: from, kind: "main", branch: "main", createdAt: "2026-01-01T00:00:00.000Z" }]);
    const to = join(scratch, `${name}-moved`);
    renameSync(from, to);
    return { identity, from, to };
  }

  test("a missing newPath is rejected", async () => {
    expect(await handlers["repos:locate"]({})).toEqual({ ok: false, error: "newPath-required" });
  });

  test("a non-identity repo key is rejected, not name-resolved", async () => {
    const res = await handlers["repos:locate"]({ newPath: scratch, repo: "repo-tools" });
    expect(res).toEqual({ ok: false, error: "repo-unknown" });
    expect(order).toEqual([]);
  });

  test("applies inside the hold, refreshes watchers, then emits repo:moved", async () => {
    const { identity, from, to } = await movedRepo("alpha");

    const res = await handlers["repos:locate"]({ newPath: to });

    expect(res.ok).toBe(true);
    expect(loadRepoIndex()[identity]).toBe(to);
    expect(order).toEqual(["hold-start", "refresh", "emit:repo:moved", "hold-end"]);
    expect(events[0]!.payload).toEqual({ identity, from, to });
  });

  test("dryRun returns the plan and writes nothing", async () => {
    const { identity, from, to } = await movedRepo("beta");

    const res = await handlers["repos:locate"]({ newPath: to, dryRun: true });

    expect(res.ok).toBe(true);
    expect(res.data.dryRun).toBe(true);
    expect(res.data.plan.identity).toBe(identity);
    expect(loadRepoIndex()[identity]).toBe(from);
    expect(events).toEqual([]);
  });

  test("a refusal comes back as a typed error, and nothing is emitted", async () => {
    const plain = join(scratch, "plain");
    mkdirSync(plain);

    const res = await handlers["repos:locate"]({ newPath: plain });

    expect(res.ok).toBe(false);
    expect(res.error).toContain("not-a-git-repo");
    expect(events).toEqual([]);
  });
});
