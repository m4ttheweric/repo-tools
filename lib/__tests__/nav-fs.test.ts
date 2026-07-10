import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { listEntries, deepList } from "../nav-fs.ts";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "nav-fs-test-"));
  mkdirSync(join(root, "beta"));
  mkdirSync(join(root, "Alpha"));
  mkdirSync(join(root, ".hidden-dir"));
  writeFileSync(join(root, "b.txt"), "b");
  writeFileSync(join(root, "A.txt"), "a");
  writeFileSync(join(root, ".dotfile"), "d");
  // deep tree for deepList tests
  mkdirSync(join(root, "beta", "nested"));
  writeFileSync(join(root, "beta", "nested", "deep.txt"), "x");
  mkdirSync(join(root, ".git", "objects"), { recursive: true });
  writeFileSync(join(root, ".git", "config"), "x");
  writeFileSync(join(root, ".hidden-dir", "inside.txt"), "x");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("listEntries", () => {
  test("hides dotfiles by default and sorts case-insensitively", () => {
    const { folders, files } = listEntries(root, false);
    expect(folders).toEqual(["Alpha", "beta"]);
    expect(files).toEqual(["A.txt", "b.txt"]);
  });

  test("includes dotfiles when showHidden is true", () => {
    const { folders, files } = listEntries(root, true);
    expect(folders).toEqual([".git", ".hidden-dir", "Alpha", "beta"]);
    expect(files).toEqual([".dotfile", "A.txt", "b.txt"]);
  });

  test("returns empty listing for unreadable dir", () => {
    expect(listEntries(join(root, "nope"), false)).toEqual({ folders: [], files: [] });
  });
});

describe("deepList (fallback walk)", () => {
  const noFd = () => null;

  test("returns relative paths recursively, dotfiles hidden", () => {
    const { folders, files } = deepList(root, { showHidden: false }, noFd);
    expect(folders).toContain("beta/nested");
    expect(files).toContain("beta/nested/deep.txt");
    expect(files).not.toContain(".dotfile");
    expect(folders).not.toContain(".hidden-dir");
  });

  test("showHidden includes dotfiles but always skips .git", () => {
    const { folders, files } = deepList(root, { showHidden: true }, noFd);
    expect(files).toContain(".hidden-dir/inside.txt");
    expect(folders.some((f) => f.startsWith(".git"))).toBe(false);
    expect(files.some((f) => f.startsWith(".git"))).toBe(false);
  });

  test("respects maxResults cap", () => {
    const { folders, files } = deepList(root, { showHidden: true, maxResults: 3 }, noFd);
    expect(folders.length + files.length).toBeLessThanOrEqual(3);
  });

  test("respects maxDepth", () => {
    const { files } = deepList(root, { showHidden: false, maxDepth: 1 }, noFd);
    expect(files).not.toContain("beta/nested/deep.txt");
  });
});

describe("deepList (fd path)", () => {
  let fakeFdPath: string;

  beforeAll(() => {
    fakeFdPath = join(root, "fake-fd.sh");
    // Fake fd: prints 5 lines for --type d and 5 for --type f, regardless of
    // maxResults, so the fd branch must trim to the total cap itself.
    writeFileSync(
      fakeFdPath,
      [
        "#!/bin/sh",
        'if echo "$@" | grep -q -- "--type d"; then',
        "  for i in 1 2 3 4 5; do echo \"dir$i\"; done",
        'elif echo "$@" | grep -q -- "--type f"; then',
        "  for i in 1 2 3 4 5; do echo \"file$i\"; done",
        "fi",
        "",
      ].join("\n"),
    );
    chmodSync(fakeFdPath, 0o755);
  });

  test("enforces maxResults as a total cap, folders first", () => {
    const { folders, files } = deepList(
      root,
      { showHidden: false, maxResults: 6 },
      () => fakeFdPath,
    );
    expect(folders.length + files.length).toBeLessThanOrEqual(6);
    expect(folders.length).toBe(5);
    expect(files.length).toBe(1);
  });
});
