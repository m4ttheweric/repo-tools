/**
 * workspace-sync unit tests.
 *
 * Covers deep-merge semantics of syncWorkspaceFile (preserveKeys round-trip),
 * worktree discovery fallback when `git worktree list` fails, and the
 * ensureGitExclude/removeGitExclude round-trip against a real temp git repo.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  syncWorkspaceFile,
  getWorktreePaths,
  ensureGitExclude,
  removeGitExclude,
} from "../workspace-sync.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "rt-ws-sync-test-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ── syncWorkspaceFile ────────────────────────────────────────────────────────

describe("syncWorkspaceFile — deep merge with preserveKeys", () => {
  test("non-preserved keys take source value, preserved keys retain target", () => {
    const source = join(tmp, "src.code-workspace");
    const targetA = join(tmp, "a.code-workspace");
    const targetB = join(tmp, "b.code-workspace");

    writeFileSync(source, JSON.stringify({
      folders: [{ path: "." }],
      settings: {
        "editor.fontSize": 14,
        "peacock.color": "#111111",
      },
    }));
    writeFileSync(targetA, JSON.stringify({
      folders: [{ path: "old" }],
      settings: {
        "editor.fontSize": 99,
        "peacock.color": "#aaaaaa",
      },
    }));
    writeFileSync(targetB, JSON.stringify({
      folders: [{ path: "old-b" }],
      settings: {
        "editor.fontSize": 12,
        "peacock.color": "#bbbbbb",
      },
    }));

    const logs: string[] = [];
    const result = syncWorkspaceFile(
      source,
      [source, targetA, targetB],
      ["peacock.color"],
      (m) => logs.push(m),
    );

    expect(result.synced).toBe(2);

    const a = JSON.parse(readFileSync(targetA, "utf8"));
    expect(a.settings["editor.fontSize"]).toBe(14); // non-preserved → source
    expect(a.settings["peacock.color"]).toBe("#aaaaaa"); // preserved → target

    const b = JSON.parse(readFileSync(targetB, "utf8"));
    expect(b.settings["editor.fontSize"]).toBe(14);
    expect(b.settings["peacock.color"]).toBe("#bbbbbb");

    // Result includes per-target color summary
    expect(result.results.map((r) => r.color).sort()).toEqual(["#aaaaaa", "#bbbbbb"]);
  });

  test("no-op when target content already matches merged output (mtime unchanged)", async () => {
    // Regression: without this guard, every sync round bumps mtime, which
    // VS Code reloads as a workspace change and creates a feedback loop via
    // the daemon's fs.watch watchers.
    const source = join(tmp, "src.code-workspace");
    const target = join(tmp, "t.code-workspace");

    const sourceContent = {
      folders: [{ path: "." }],
      settings: { "editor.fontSize": 14, "peacock.color": "#111111" },
    };
    writeFileSync(source, JSON.stringify(sourceContent));

    // Seed target with canonical post-sync form (source content + target's own peacock).
    const canonical = { ...sourceContent, settings: { ...sourceContent.settings, "peacock.color": "#aaaaaa" } };
    writeFileSync(target, JSON.stringify(canonical, null, 2) + "\n");

    const mtimeBefore = statSync(target).mtimeMs;
    // Bun.sleep ensures any actual write would bump mtime detectably.
    await Bun.sleep(20);

    const result = syncWorkspaceFile(source, [source, target], ["peacock.color"]);

    expect(result.synced).toBe(0);
    expect(result.results).toEqual([]);
    expect(statSync(target).mtimeMs).toBe(mtimeBefore);
  });

  test("skips nonexistent targets silently (no throw)", () => {
    const source = join(tmp, "src.code-workspace");
    writeFileSync(source, JSON.stringify({ settings: { foo: 1 } }));

    const missing = join(tmp, "does-not-exist.code-workspace");
    const result = syncWorkspaceFile(source, [missing], []);
    expect(result.synced).toBe(0);
    expect(result.results).toEqual([]);
  });

  test("malformed JSON source logs error and returns { synced: 0 }", () => {
    const source = join(tmp, "bad.code-workspace");
    writeFileSync(source, "this is not json {{{");

    const target = join(tmp, "t.code-workspace");
    writeFileSync(target, JSON.stringify({ settings: {} }));

    const logs: string[] = [];
    const result = syncWorkspaceFile(source, [target], [], (m) => logs.push(m));

    expect(result.synced).toBe(0);
    expect(result.results).toEqual([]);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0]).toContain("sync failed");
  });
});

// ── getWorktreePaths ────────────────────────────────────────────────────────

describe("getWorktreePaths", () => {
  test("falls back to [repoPath] when `git worktree list` fails", () => {
    // tmp is not a git repo → `git worktree list` fails → fallback to [tmp]
    const paths = getWorktreePaths(tmp);
    expect(paths).toEqual([tmp]);
  });

  test("returns real worktree listing inside an initialized git repo", async () => {
    const proc = Bun.spawn(["git", "init", "-q", tmp], { stdout: "pipe", stderr: "pipe" });
    await proc.exited;

    const paths = getWorktreePaths(tmp);
    expect(paths.length).toBeGreaterThanOrEqual(1);
    // Path comparison tolerates macOS /private/ symlink prefix
    const firstIncludes = paths[0]!.endsWith(tmp) || tmp.endsWith(paths[0]!);
    expect(firstIncludes).toBe(true);
  });
});

// ── ensureGitExclude / removeGitExclude ─────────────────────────────────────

describe("ensureGitExclude / removeGitExclude round-trip", () => {
  test("add → verify present → remove → verify absent", async () => {
    const proc = Bun.spawn(["git", "init", "-q", tmp], { stdout: "pipe", stderr: "pipe" });
    await proc.exited;

    const fileName = "project.code-workspace";
    ensureGitExclude(tmp, fileName);

    const excludePath = join(tmp, ".git", "info", "exclude");
    expect(existsSync(excludePath)).toBe(true);
    let contents = readFileSync(excludePath, "utf8");
    expect(contents.split("\n").some((l) => l.trim() === fileName)).toBe(true);

    // ensure is idempotent — no duplicate entry
    ensureGitExclude(tmp, fileName);
    contents = readFileSync(excludePath, "utf8");
    const matches = contents.split("\n").filter((l) => l.trim() === fileName);
    expect(matches.length).toBe(1);

    // now remove and verify
    removeGitExclude(tmp, fileName);
    const afterRemove = readFileSync(excludePath, "utf8");
    expect(afterRemove.split("\n").some((l) => l.trim() === fileName)).toBe(false);
  });

  test("removeGitExclude on missing exclude file is a no-op", () => {
    // No .git at all — should silently return without throwing.
    expect(() => removeGitExclude(tmp, "whatever.code-workspace")).not.toThrow();
  });

  test("ensureGitExclude creates info/exclude if missing", async () => {
    const proc = Bun.spawn(["git", "init", "-q", tmp], { stdout: "pipe", stderr: "pipe" });
    await proc.exited;

    // Delete the auto-created exclude and its parent to force creation
    const infoDir = join(tmp, ".git", "info");
    rmSync(infoDir, { recursive: true, force: true });
    expect(existsSync(infoDir)).toBe(false);

    ensureGitExclude(tmp, "synced.code-workspace");

    const excludePath = join(infoDir, "exclude");
    expect(existsSync(excludePath)).toBe(true);
    const contents = readFileSync(excludePath, "utf8");
    expect(contents).toContain("synced.code-workspace");
  });
});
