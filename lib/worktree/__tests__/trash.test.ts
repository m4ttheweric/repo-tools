import { describe, test, expect, beforeEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, dirname, join } from "path";
import {
  RETENTION_MS,
  TRASH_PREFIX,
  reapExpiredTrash,
  reapTrashDir,
  reapTrashInRoots,
  retainedTrashRoot,
  retireTree,
  stripTrashDir,
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

  describe("retireTree", () => {
    let repo: string;

    beforeEach(() => {
      repo = realpathSync(mkdtempSync(join(tmpdir(), "rttrash-repo-")));
    });

    test("moves the tree into <repo>/.worktrees/.trash/<name>-<epoch>, contents intact", async () => {
      const tree = makeTree(root, "hotel");
      mkdirSync(join(tree, ".local-dev"), { recursive: true });
      writeFileSync(join(tree, ".local-dev", "spec.md"), "the plan\n");

      const result = await retireTree(tree, "hotel", repo);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");

      expect(result.retained).toBe(true);
      expect(existsSync(tree)).toBe(false);
      expect(dirname(result.trashPath)).toBe(retainedTrashRoot(repo));
      expect(basename(result.trashPath)).toMatch(/^hotel-\d+$/);
      expect(readFileSync(join(result.trashPath, ".local-dev", "spec.md"), "utf8")).toBe(
        "the plan\n",
      );
    });

    test("falls back to a sibling trash rename when the retention root is unusable", async () => {
      const tree = makeTree(root, "hotel");
      // A file where the .worktrees dir should be makes mkdir fail.
      writeFileSync(join(repo, ".worktrees"), "");

      const result = await retireTree(tree, "hotel", repo);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");

      expect(result.retained).toBe(false);
      expect(dirname(result.trashPath)).toBe(root);
      expect(basename(result.trashPath).startsWith(TRASH_PREFIX)).toBe(true);
      expect(existsSync(tree)).toBe(false);
    });

    test("a tree that cannot be renamed at all reports the failure", async () => {
      const result = await retireTree(join(root, "never-existed"), "never-existed", repo);
      expect(result.ok).toBe(false);
    });

    test("rejects a name containing a path separator", async () => {
      const tree = makeTree(root, "sierra");
      const result = await retireTree(tree, "sierra/../escape", repo);
      expect(result.ok).toBe(false);
      expect(existsSync(tree)).toBe(true);
    });

    // S078: `.worktrees/` was never added to info/exclude unless the tree
    // went through createTree first (e.g. `rt worktree adopt`'s disposals,
    // or any repo whose worktrees root differs from the default, skip that
    // call entirely) — the retention store then shows up as `?? .worktrees/`
    // in the user's own `git status`, and `git add -A` stages a whole second
    // copy of the source tree into it.
    test("retireTree excludes .worktrees/ from the repo's own git status, even without going through createTree first", async () => {
      Bun.spawnSync(["git", "init", "-q", repo]);
      Bun.spawnSync(["git", "-C", repo, "config", "user.email", "test@example.com"]);
      Bun.spawnSync(["git", "-C", repo, "config", "user.name", "Test"]);
      writeFileSync(join(repo, "README.md"), "hi\n");
      Bun.spawnSync(["git", "-C", repo, "add", "README.md"]);
      Bun.spawnSync(["git", "-C", repo, "commit", "-q", "-m", "init"]);

      const tree = makeTree(root, "hotel");
      const result = await retireTree(tree, "hotel", repo);
      expect(result.ok).toBe(true);

      const exclude = readFileSync(join(repo, ".git", "info", "exclude"), "utf8");
      expect(exclude).toContain(".worktrees/");

      const status = Bun.spawnSync(["git", "-C", repo, "status", "--porcelain"]).stdout.toString();
      expect(status).not.toContain(".worktrees");
    });
  });

  describe("stripTrashDir", () => {
    let repo: string;

    beforeEach(() => {
      repo = realpathSync(mkdtempSync(join(tmpdir(), "rttrash-repo-")));
    });

    test("deletes reinstallable dirs inside a retained tree, keeps everything else", async () => {
      const tree = makeTree(root, "hotel");
      for (const dir of ["node_modules/dep", "dist", "dist-esm", ".turbo", ".local-dev", "src"]) {
        mkdirSync(join(tree, dir), { recursive: true });
        writeFileSync(join(tree, dir.split("/")[0]!, "f.txt"), "x\n");
      }
      const result = await retireTree(tree, "hotel", repo);
      if (!result.ok) throw new Error("expected ok");

      const { log, warns } = capturingLog();
      await stripTrashDir(result.trashPath, log);

      expect(existsSync(join(result.trashPath, "node_modules"))).toBe(false);
      expect(existsSync(join(result.trashPath, "dist"))).toBe(false);
      expect(existsSync(join(result.trashPath, "dist-esm"))).toBe(false);
      expect(existsSync(join(result.trashPath, ".turbo"))).toBe(false);
      expect(existsSync(join(result.trashPath, ".local-dev"))).toBe(true);
      expect(existsSync(join(result.trashPath, "src"))).toBe(true);
      expect(existsSync(join(result.trashPath, "file.txt"))).toBe(true);
      expect(warns.length).toBe(0);
    });

    test("refuses a path that is not inside a .trash directory", async () => {
      const tree = makeTree(root, "hotel");
      mkdirSync(join(tree, "node_modules"), { recursive: true });

      const { log, warns } = capturingLog();
      await stripTrashDir(tree, log);

      expect(existsSync(join(tree, "node_modules"))).toBe(true);
      expect(warns.length).toBe(1);
    });
  });

  describe("reapExpiredTrash", () => {
    let repo: string;

    beforeEach(() => {
      repo = realpathSync(mkdtempSync(join(tmpdir(), "rttrash-repo-")));
    });

    test("deletes entries past retention, keeps younger ones", async () => {
      const now = 1_700_000_000_000;
      const trashRoot = retainedTrashRoot(repo);
      const old = makeTree(trashRoot, `hotel-${now - RETENTION_MS - 1}`);
      const fresh = makeTree(trashRoot, `india-${now - 1000}`);

      const { log, warns } = capturingLog();
      const reaped = await reapExpiredTrash(repo, log, now);

      expect(reaped).toBe(1);
      expect(existsSync(old)).toBe(false);
      expect(existsSync(fresh)).toBe(true);
      expect(warns.length).toBe(0);
    });

    test("a repo with no retention dir yet reaps nothing quietly", async () => {
      const { log, warns } = capturingLog();
      expect(await reapExpiredTrash(repo, log)).toBe(0);
      expect(warns.length).toBe(0);
    });

    test("an entry without a parseable epoch is kept and warned about", async () => {
      const stray = makeTree(retainedTrashRoot(repo), "not-rt-made");
      const { log, warns } = capturingLog();
      expect(await reapExpiredTrash(repo, log, Date.now())).toBe(0);
      expect(existsSync(stray)).toBe(true);
      expect(warns.length).toBe(1);
    });
  });

  describe("reapTrashDir on retained entries", () => {
    test("deletes an entry inside a .trash retention dir", async () => {
      const repo = realpathSync(mkdtempSync(join(tmpdir(), "rttrash-repo-")));
      const entry = makeTree(retainedTrashRoot(repo), "hotel-123");

      const { log, warns } = capturingLog();
      await reapTrashDir(entry, log);

      expect(existsSync(entry)).toBe(false);
      expect(warns.length).toBe(0);
    });
  });

  describe("reapTrashInRoots", () => {
    test("leaves the .trash retention dir alone", async () => {
      const trashRoot = join(root, ".trash");
      const kept = makeTree(trashRoot, "hotel-123");

      const { log } = capturingLog();
      expect(await reapTrashInRoots([root], log)).toBe(0);
      expect(existsSync(kept)).toBe(true);
    });

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
