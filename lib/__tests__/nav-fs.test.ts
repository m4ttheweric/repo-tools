import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { listEntries } from "../nav-fs.ts";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "nav-fs-test-"));
  mkdirSync(join(root, "beta"));
  mkdirSync(join(root, "Alpha"));
  mkdirSync(join(root, ".hidden-dir"));
  writeFileSync(join(root, "b.txt"), "b");
  writeFileSync(join(root, "A.txt"), "a");
  writeFileSync(join(root, ".dotfile"), "d");
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
    expect(folders).toEqual([".hidden-dir", "Alpha", "beta"]);
    expect(files).toEqual([".dotfile", "A.txt", "b.txt"]);
  });

  test("returns empty listing for unreadable dir", () => {
    expect(listEntries(join(root, "nope"), false)).toEqual({ folders: [], files: [] });
  });
});
