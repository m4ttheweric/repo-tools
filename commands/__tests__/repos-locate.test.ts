/**
 * The CLI runs the local path here: under a throwaway HOME no daemon socket
 * exists, so `isDaemonRunning()` is false and the apply happens in-process —
 * which is exactly the "no daemon, nothing to race" branch.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeStateDb, setKvValue } from "../../lib/state/index.ts";
import { loadRepoIndex } from "../../lib/repo-index.ts";
import { saveRegistry, loadRegistry } from "../../lib/worktree/registry.ts";
import { deriveRepoIdentity, serializeIdentity } from "../../lib/settings/identity.ts";
import { reposLocate, type RegisterDeps } from "../repos.ts";

function testDeps(): RegisterDeps & { lines: string[] } {
  const lines: string[] = [];
  return { print: (s) => lines.push(s), lines };
}

async function runExpectingProcessExit(fn: () => Promise<void>): Promise<number | undefined> {
  const exitSpy = spyOn(process, "exit").mockImplementation(() => {
    throw new Error("process.exit sentinel");
  });
  try {
    await fn();
    return undefined;
  } catch {
    return exitSpy.mock.calls.at(-1)?.[0] as number | undefined;
  } finally {
    exitSpy.mockRestore();
  }
}

describe("reposLocate", () => {
  const origHome = process.env.HOME;
  let home: string;
  let scratch: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-locate-cli-home-")));
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "rt-locate-cli-repos-")));
    process.env.HOME = home;
    closeStateDb();
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

  test("locates a moved repo and says where it went", async () => {
    const { identity, from, to } = await movedRepo("alpha");
    const deps = testDeps();

    await reposLocate([to], {}, deps);

    expect(loadRepoIndex()[identity]).toBe(to);
    expect(loadRegistry(identity)[0]?.path).toBe(to);
    expect(deps.lines.join("\n")).toContain(from);
    expect(deps.lines.join("\n")).toContain(to);
  });

  test("--dry-run reports the plan and writes nothing", async () => {
    const { identity, from, to } = await movedRepo("beta");
    const deps = testDeps();

    await reposLocate([to, "--dry-run"], {}, deps);

    expect(loadRepoIndex()[identity]).toBe(from);
    expect(deps.lines.join("\n")).toContain("would move");
  });

  test("--json emits a contract envelope", async () => {
    const { identity, to } = await movedRepo("gamma");
    const deps = testDeps();

    await reposLocate([to, "--json"], {}, deps);

    const parsed = JSON.parse(deps.lines[0]!);
    expect(parsed.contract).toBe(1);
    expect(parsed.located.identity).toBe(identity);
    expect(parsed.located.to).toBe(to);
  });

  test("--repo resolves to an identity and is honoured", async () => {
    const { identity, to } = await movedRepo("delta");
    const deps = testDeps();

    await reposLocate([to, "--repo", identity], {}, deps);

    expect(loadRepoIndex()[identity]).toBe(to);
  });

  test("a refusal exits 2 with the typed message", async () => {
    const plain = join(scratch, "plain");
    mkdirSync(plain);
    const deps = testDeps();

    const code = await runExpectingProcessExit(() => reposLocate([plain], {}, deps));

    expect(code).toBe(2);
    expect(deps.lines.join("\n")).toContain("not a git repository");
  });

  test("an unknown flag is a usage error", async () => {
    const deps = testDeps();
    const code = await runExpectingProcessExit(() => reposLocate(["--nope"], {}, deps));
    expect(code).toBe(2);
    expect(deps.lines.join("\n")).toContain("usage: rt repos locate");
  });

  test("no path and no lost rows exits 1 saying so", async () => {
    const deps = testDeps();
    const code = await runExpectingProcessExit(() => reposLocate([], {}, deps));
    expect(code).toBe(1);
    expect(deps.lines.join("\n")).toContain("no indexed repo is missing");
  });

  test("no path, a lost row and no candidate lists the lost row and exits 1", async () => {
    setKvValue("repo-index", "remote:gitlab.com%2Fg%2Fghost", join(scratch, "ghost"));
    const deps = testDeps();

    const code = await runExpectingProcessExit(() => reposLocate([], {}, deps));

    expect(code).toBe(1);
    expect(deps.lines.join("\n")).toContain("remote:gitlab.com%2Fg%2Fghost");
  });
});
