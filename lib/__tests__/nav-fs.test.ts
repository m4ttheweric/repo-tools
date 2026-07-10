import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { listEntries, deepList, shellQuote, buildPreviewCommand } from "../nav-fs.ts";

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
  mkdirSync(join(root, "beta", "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(root, "beta", "node_modules", "pkg", "index.js"), "x");
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

  test("always skips node_modules", () => {
    const { folders, files } = deepList(root, { showHidden: true }, noFd);
    expect(folders.some((f) => f.includes("node_modules"))).toBe(false);
    expect(files.some((f) => f.includes("node_modules"))).toBe(false);
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

describe("shellQuote", () => {
  test("wraps in single quotes and escapes embedded single quotes", () => {
    expect(shellQuote("plain")).toBe("'plain'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});

describe("buildPreviewCommand", () => {
  test("references the fzf value placeholder and both fallbacks", () => {
    const cmd = buildPreviewCommand("/tmp/base");
    expect(cmd).toContain("{1}");
    expect(cmd).toContain("ls -la");
    expect(cmd).toContain("head -c");
  });

  test("snippet previews a file with spaces and quotes in the path", () => {
    const dir = mkdtempSync(join(tmpdir(), "nav-preview-"));
    const tricky = "it's a dir";
    mkdirSync(join(dir, tricky));
    writeFileSync(join(dir, tricky, "hello world.txt"), "PREVIEW_OK");
    // Simulate fzf: replace {1} with the shell-quoted value column
    const cmd = buildPreviewCommand(join(dir, tricky)).replace(
      "{1}",
      shellQuote("f:hello world.txt"),
    );
    const r = spawnSync("sh", ["-c", cmd], { encoding: "utf8" });
    expect(r.stdout).toContain("PREVIEW_OK");
    rmSync(dir, { recursive: true, force: true });
  });

  test("snippet previews a directory listing", () => {
    const dir = mkdtempSync(join(tmpdir(), "nav-preview-"));
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "marker-file.txt"), "x");
    const cmd = buildPreviewCommand(dir).replace("{1}", shellQuote("d:sub"));
    const r = spawnSync("sh", ["-c", cmd], { encoding: "utf8" });
    expect(r.stdout).toContain("marker-file.txt");
    rmSync(dir, { recursive: true, force: true });
  });
});
