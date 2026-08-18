import { describe, test, expect, beforeEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, dirname, join } from "path";
import {
  TRASH_PREFIX,
  reapTrashDir,
  reapTrashInRoots,
  trashPathFor,
  trashTree,
} from "../trash.ts";

function capturingLog(): { log: { warn: (...args: unknown[]) => void }; warns: unknown[][] } {
  const warns: unknown[][] = [];
  return { log: { warn: (...args: unknown[]) => warns.push(args) }, warns };
}

/** A directory standing in for a worktree, with one file inside it. */
function makeTree(root: string, name: string): string {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "file.txt"), "content\n");
  return path;
}

describe("worktree trash", () => {
  let root: string;

  beforeEach(() => {
    // realpathSync: /var -> /private/var on macOS (Global Constraints)
    root = realpathSync(mkdtempSync(join(tmpdir(), "rttrash-")));
  });

  describe("trashPathFor", () => {
    test("is a sibling of the tree, prefixed and stamped", () => {
      const path = trashPathFor(join(root, "hotel"), "hotel", 1_700_000_000_000);
      expect(dirname(path)).toBe(root);
      expect(basename(path)).toBe(`${TRASH_PREFIX}hotel-1700000000000`);
    });

    test("rejects a name containing a path separator", () => {
      expect(() => trashPathFor(join(root, "x"), "x/../../outside")).toThrow(
        /single path component/,
      );
      expect(() => trashPathFor(join(root, "x"), "x\\y")).toThrow(/single path component/);
      expect(() => trashPathFor(join(root, "x"), "")).toThrow(/single path component/);
    });

    test("two disposals of the same name never collide", () => {
      const a = trashPathFor(join(root, "hotel"), "hotel", 1);
      const b = trashPathFor(join(root, "hotel"), "hotel", 2);
      expect(a).not.toBe(b);
    });
  });

  describe("trashTree", () => {
    test("moves the tree out of the way, contents intact", async () => {
      const tree = makeTree(root, "hotel");

      const result = await trashTree(tree, "hotel");
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");

      expect(existsSync(tree)).toBe(false);
      expect(existsSync(result.trashPath)).toBe(true);
      expect(readFileSync(join(result.trashPath, "file.txt"), "utf8")).toBe("content\n");
      expect(basename(result.trashPath).startsWith(TRASH_PREFIX)).toBe(true);
    });

    test("a separator-containing name reports the failure without renaming", async () => {
      const tree = makeTree(root, "sierra");
      const result = await trashTree(tree, "sierra/../escape");
      expect(result.ok).toBe(false);
      expect(existsSync(tree)).toBe(true);
    });

    test("a path that cannot be renamed reports the failure instead of throwing", async () => {
      const result = await trashTree(join(root, "never-existed"), "never-existed");
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect((result.err as NodeJS.ErrnoException).code).toBe("ENOENT");
    });
  });

  describe("reapTrashDir", () => {
    test("deletes the trash directory and everything under it", async () => {
      const tree = makeTree(root, "hotel");
      mkdirSync(join(tree, "node_modules", "dep"), { recursive: true });
      writeFileSync(join(tree, "node_modules", "dep", "index.js"), "//\n");
      const result = await trashTree(tree, "hotel");
      if (!result.ok) throw new Error("expected ok");

      const { log, warns } = capturingLog();
      await reapTrashDir(result.trashPath, log);

      expect(existsSync(result.trashPath)).toBe(false);
      expect(warns.length).toBe(0);
    });

    test("refuses a path that is not a trash directory", async () => {
      const tree = makeTree(root, "hotel");
      const { log, warns } = capturingLog();

      await reapTrashDir(tree, log);

      expect(existsSync(tree)).toBe(true);
      expect(warns.length).toBe(1);
    });
  });

  describe("reapTrashInRoots", () => {
    test("reaps every trash dir across roots and leaves real trees alone", async () => {
      const other = realpathSync(mkdtempSync(join(tmpdir(), "rttrash-other-")));
      const live = makeTree(root, "hotel");
      const stale1 = makeTree(root, `${TRASH_PREFIX}india-1`);
      const stale2 = makeTree(root, `${TRASH_PREFIX}juliet-2`);
      const stale3 = makeTree(other, `${TRASH_PREFIX}kilo-3`);

      const { log, warns } = capturingLog();
      const reaped = await reapTrashInRoots([root, other], log);

      expect(reaped).toBe(3);
      expect(existsSync(stale1)).toBe(false);
      expect(existsSync(stale2)).toBe(false);
      expect(existsSync(stale3)).toBe(false);
      expect(existsSync(live)).toBe(true);
      expect(warns.length).toBe(0);
    });

    test("a root that does not exist is not an error", async () => {
      const { log, warns } = capturingLog();
      expect(await reapTrashInRoots([join(root, "nope")], log)).toBe(0);
      expect(warns.length).toBe(0);
    });

    test("a root that cannot be read (not just missing) is warned about", async () => {
      const file = join(root, "not-a-dir");
      writeFileSync(file, "");
      const { log, warns } = capturingLog();
      expect(await reapTrashInRoots([file], log)).toBe(0);
      expect(warns.length).toBe(1);
      expect(warns[0]?.[0]).toMatchObject({ root: file });
    });

    test("the same root listed twice is swept once", async () => {
      makeTree(root, `${TRASH_PREFIX}lima-1`);
      const { log } = capturingLog();
      expect(await reapTrashInRoots([root, root], log)).toBe(1);
    });
  });
});
