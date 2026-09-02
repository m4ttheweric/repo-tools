import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  listEntries, shellQuote, startDirWatch,
  sortEntries, extensionOf, sortLabel, isDefaultSort, DEFAULT_SORT,
} from "../nav-fs.ts";

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

describe("shellQuote", () => {
  test("wraps in single quotes and escapes embedded single quotes", () => {
    expect(shellQuote("plain")).toBe("'plain'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});

describe("sortEntries", () => {
  // b is newest and largest, a is oldest and smallest, c sits between.
  const metas = [
    { name: "b.txt", mtimeMs: 300, birthtimeMs: 30, size: 300 },
    { name: "a.md", mtimeMs: 100, birthtimeMs: 10, size: 100 },
    { name: "c.txt", mtimeMs: 200, birthtimeMs: 20, size: 200 },
  ];

  test("name ascending is the default order", () => {
    expect(sortEntries(metas, { key: "name", reverse: false })).toEqual([
      "a.md", "b.txt", "c.txt",
    ]);
  });

  test("date modified puts newest first, and reverse flips it", () => {
    expect(sortEntries(metas, { key: "modified", reverse: false })).toEqual([
      "b.txt", "c.txt", "a.md",
    ]);
    expect(sortEntries(metas, { key: "modified", reverse: true })).toEqual([
      "a.md", "c.txt", "b.txt",
    ]);
  });

  test("date created puts newest first", () => {
    expect(sortEntries(metas, { key: "created", reverse: false })).toEqual([
      "b.txt", "c.txt", "a.md",
    ]);
  });

  test("size puts largest first, and reverse flips it", () => {
    expect(sortEntries(metas, { key: "size", reverse: false })).toEqual([
      "b.txt", "c.txt", "a.md",
    ]);
    expect(sortEntries(metas, { key: "size", reverse: true })).toEqual([
      "a.md", "c.txt", "b.txt",
    ]);
  });

  test("kind groups by extension, name breaking ties", () => {
    expect(sortEntries(metas, { key: "kind", reverse: false })).toEqual([
      "a.md", "b.txt", "c.txt",
    ]);
  });

  test("name is the tiebreak and is never reversed", () => {
    // All three share an mtime, so only the tiebreak decides, in both directions.
    const tied = metas.map((m) => ({ ...m, mtimeMs: 500 }));
    const forward = sortEntries(tied, { key: "modified", reverse: false });
    const reversed = sortEntries(tied, { key: "modified", reverse: true });
    expect(forward).toEqual(["a.md", "b.txt", "c.txt"]);
    expect(reversed).toEqual(forward);
  });

  test("does not mutate its input", () => {
    const before = metas.map((m) => m.name);
    sortEntries(metas, { key: "size", reverse: false });
    expect(metas.map((m) => m.name)).toEqual(before);
  });
});

describe("extensionOf", () => {
  test("returns the lowercased extension after the final dot", () => {
    expect(extensionOf("Photo.JPG")).toBe("jpg");
    expect(extensionOf("archive.tar.gz")).toBe("gz");
  });

  test("a dotfile has no extension", () => {
    expect(extensionOf(".gitignore")).toBe("");
    expect(extensionOf("README")).toBe("");
  });
});

describe("sortLabel / isDefaultSort", () => {
  test("describes the active sort and its direction", () => {
    expect(sortLabel({ key: "size", reverse: false })).toBe("Size, largest first");
    expect(sortLabel({ key: "size", reverse: true })).toBe("Size, smallest first");
    expect(sortLabel({ key: "modified", reverse: false })).toBe("Date Modified, newest first");
  });

  test("only name-ascending counts as default", () => {
    expect(isDefaultSort(DEFAULT_SORT)).toBe(true);
    expect(isDefaultSort({ key: "name", reverse: true })).toBe(false);
    expect(isDefaultSort({ key: "size", reverse: false })).toBe(false);
  });
});

describe("listEntries sorting", () => {
  test("folders stay above files under every sort", () => {
    const d = mkdtempSync(join(tmpdir(), "nav-sort-"));
    mkdirSync(join(d, "zzz-folder"));
    writeFileSync(join(d, "aaa-file.txt"), "x");
    // Default sort would put the file first if the groups were merged.
    for (const key of ["name", "modified", "created", "size", "kind"] as const) {
      const { folders, files } = listEntries(d, true, { key, reverse: false });
      expect(folders).toEqual(["zzz-folder"]);
      expect(files).toEqual(["aaa-file.txt"]);
    }
    rmSync(d, { recursive: true, force: true });
  });

  test("orders files by real size read from disk", () => {
    const d = mkdtempSync(join(tmpdir(), "nav-sort-size-"));
    writeFileSync(join(d, "small.txt"), "x");
    writeFileSync(join(d, "big.txt"), "x".repeat(5000));
    expect(listEntries(d, true, { key: "size", reverse: false }).files).toEqual([
      "big.txt", "small.txt",
    ]);
    expect(listEntries(d, true, { key: "size", reverse: true }).files).toEqual([
      "small.txt", "big.txt",
    ]);
    rmSync(d, { recursive: true, force: true });
  });

  test("omitting the sort argument preserves the historical name ordering", () => {
    // Its own directory rather than the shared `root`, which other tests in
    // this file add fixtures to.
    const d = mkdtempSync(join(tmpdir(), "nav-sort-default-"));
    mkdirSync(join(d, "beta"));
    mkdirSync(join(d, "Alpha"));
    writeFileSync(join(d, "b.txt"), "b");
    writeFileSync(join(d, "A.txt"), "a");
    const { folders, files } = listEntries(d, false);
    // Case-insensitive, folders before files: unchanged from before sorting existed.
    expect(folders).toEqual(["Alpha", "beta"]);
    expect(files).toEqual(["A.txt", "b.txt"]);
    rmSync(d, { recursive: true, force: true });
  });
});

describe("startDirWatch", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** Fake watch: hands the test a trigger() to fire listener events by hand. */
  function fakeWatch() {
    let listener: (() => void) | null = null;
    let closed = false;
    return {
      watch: (_dir: string, l: () => void) => {
        listener = l;
        return { close: () => { closed = true; } };
      },
      trigger: () => listener?.(),
      get closed() { return closed; },
    };
  }

  test("coalesces a burst of events into a single onChange call", async () => {
    const w = fakeWatch();
    let calls = 0;
    const h = startDirWatch({ dir: "/tmp", onChange: () => calls++, debounceMs: 10, deps: { watch: w.watch } });
    w.trigger(); w.trigger(); w.trigger();
    await sleep(40);
    expect(calls).toBe(1);
    h.stop();
  });

  test("fires again on a later, separate event", async () => {
    const w = fakeWatch();
    let calls = 0;
    const h = startDirWatch({ dir: "/tmp", onChange: () => calls++, debounceMs: 10, deps: { watch: w.watch } });
    w.trigger();
    await sleep(40);
    w.trigger();
    await sleep(40);
    expect(calls).toBe(2);
    h.stop();
  });

  test("stop() closes the watcher and suppresses a pending debounce", async () => {
    const w = fakeWatch();
    let calls = 0;
    const h = startDirWatch({ dir: "/tmp", onChange: () => calls++, debounceMs: 10, deps: { watch: w.watch } });
    w.trigger();
    h.stop();
    await sleep(40);
    expect(calls).toBe(0);
    expect(w.closed).toBe(true);
  });

  test("a failing watch registration reports through onError and does not throw", () => {
    const errors: unknown[] = [];
    const h = startDirWatch({
      dir: "/tmp",
      onChange: () => {},
      onError: (e) => errors.push(e),
      deps: { watch: () => { throw new Error("ENOSYS"); } },
    });
    expect(errors.length).toBe(1);
    expect(() => h.stop()).not.toThrow();
  });

  test("the real defaultWatch detects a file created in a real directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nav-fs-watch-real-"));
    let calls = 0;
    const h = startDirWatch({ dir, onChange: () => calls++ });

    writeFileSync(join(dir, "appeared.txt"), "hi");

    const start = Date.now();
    while (calls === 0 && Date.now() - start < 3000) {
      await sleep(50);
    }

    expect(calls).toBeGreaterThan(0);
    h.stop();
    rmSync(dir, { recursive: true, force: true });
  });
});
