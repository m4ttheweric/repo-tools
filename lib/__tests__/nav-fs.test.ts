import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import {
  listEntries, deepList, shellQuote, buildPreviewCommand, buildImagePreviewSnippet,
  buildHelpHeaderCommand, renderHelpHeader,
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

describe("buildHelpHeaderCommand", () => {
  const hints = ["enter: open", "ctrl-k: actions", "ctrl-o: editor", "esc: quit"];

  test("flows hints into more columns as width grows", () => {
    const cmd = buildHelpHeaderCommand(hints, false);
    // 40 cols → 36 usable → 2 columns of the ~15-char hints
    const narrow = renderHelpHeader(cmd, 40).split("\n");
    expect(narrow).toEqual(["enter: open       ctrl-o: editor", "ctrl-k: actions   esc: quit"]);
    // 80 cols → all four hints fit on one line
    const wide = renderHelpHeader(cmd, 80).split("\n");
    expect(wide.length).toBe(1);
    for (const h of hints) expect(wide[0]).toContain(h);
  });

  test("previewOn halves the available width", () => {
    const cmd = buildHelpHeaderCommand(hints, true);
    // 80 cols with preview → same 36 usable as 40 cols without
    const lines = renderHelpHeader(cmd, 80).split("\n");
    expect(lines.length).toBe(2);
  });

  test("degrades to a single column when nothing fits", () => {
    const cmd = buildHelpHeaderCommand(hints, false);
    expect(renderHelpHeader(cmd, 10).split("\n")).toEqual(hints);
  });

  test("lines never exceed the usable width", () => {
    const cmd = buildHelpHeaderCommand(hints, false);
    for (const line of renderHelpHeader(cmd, 40).split("\n")) {
      expect(line.length).toBeLessThanOrEqual(36);
    }
  });
});

// fzf runs preview commands with `$SHELL -c`, so these snippets must behave
// identically under sh and zsh. The two disagree about word splitting, and
// relying on it once shipped a real bug: `-f kitty` stored in one variable
// and passed unquoted became two arguments under sh but one under zsh, so
// chafa failed with "Output format given as '-s'" for every zsh user while
// an sh-only test suite stayed green.
for (const SHELL of ["sh", "zsh"] as const) {
  describe(`buildPreviewCommand (${SHELL})`, () => {
    test("references the fzf value placeholder and both fallbacks", () => {
      const cmd = buildPreviewCommand("/tmp/base");
      expect(cmd).toContain("{1}");
      expect(cmd).toContain("ls -1AF");
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
      const r = spawnSync(SHELL, ["-c", cmd], { encoding: "utf8" });
      expect(r.stdout).toContain("PREVIEW_OK");
      rmSync(dir, { recursive: true, force: true });
    });

    test("snippet previews a directory listing", () => {
      const dir = mkdtempSync(join(tmpdir(), "nav-preview-"));
      mkdirSync(join(dir, "sub"));
      writeFileSync(join(dir, "sub", "marker-file.txt"), "x");
      const cmd = buildPreviewCommand(dir).replace("{1}", shellQuote("d:sub"));
      const r = spawnSync(SHELL, ["-c", cmd], { encoding: "utf8" });
      expect(r.stdout).toContain("marker-file.txt");
      rmSync(dir, { recursive: true, force: true });
    });

    test("routes image extensions to the image branch, case-insensitively", () => {
      const cmd = buildPreviewCommand("/tmp/base");
      // POSIX case classes, not a `file --mime` subprocess
      expect(cmd).toContain("*.[pP][nN][gG]");
      expect(cmd).toContain("*.[sS][vV][gG]");
      expect(cmd).not.toContain("--mime");
    });

    test("directory and text branches are unchanged", () => {
      const cmd = buildPreviewCommand("/tmp/base");
      expect(cmd).toContain("eza -a1 --color=always");
      expect(cmd).toContain("ls -1AF");
      expect(cmd).toContain("bat --color=always --style=numbers");
      expect(cmd).toContain("head -c 65536");
    });
  });

  describe(`buildImagePreviewSnippet (${SHELL})`, () => {
    const PNG_B64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAKklEQVR42mP8z8BQz0AEYBxVSF+" +
      "FjP+RwH8GBgYmYhSyMIykRfooZBxNPQCk2Qb9Cm7DIQAAAABJRU5ErkJggg==";

    /**
     * Fake renderers on a scratch PATH, each recording its own argv. Asserting
     * on what our snippet actually invoked beats asserting on substrings of the
     * snippet text, which stayed green through two real bugs.
     */
    function fakeBin(names: string[]): { dir: string; args: Record<string, string> } {
      const dir = mkdtempSync(join(tmpdir(), "nav-img-bin-"));
      const args: Record<string, string> = {};
      for (const n of names) {
        const file = join(dir, `${n}.args`);
        args[n] = file;
        const shim = join(dir, n);
        // Records argv AND emits a byte on stdout: the snippet only accepts
        // kitten's output when the file it wrote is non-empty.
        writeFileSync(
          shim,
          `#!/bin/sh\nprintf '%s\\n' "$*" > ${file}\necho RENDERED-${n}\n`,
        );
        chmodSync(shim, 0o755);
      }
      return { dir, args };
    }

    function runSnippet(binDir: string, env: Record<string, string>): void {
      const imgDir = mkdtempSync(join(tmpdir(), "nav-img-base-"));
      writeFileSync(join(imgDir, "pic.png"), Buffer.from(PNG_B64, "base64"));
      const cmd = buildPreviewCommand(imgDir).replace("{1}", shellQuote("f:pic.png"));
      spawnSync(SHELL, ["-c", cmd], {
        encoding: "utf8",
        env: { PATH: `${binDir}:/usr/bin:/bin`, TERM: "xterm-256color", ...env },
      });
      rmSync(imgDir, { recursive: true, force: true });
    }

    test("never lets chafa probe the tty", () => {
      expect(buildImagePreviewSnippet()).toContain("--probe off");
    });

    test("sizes from the fzf preview env vars", () => {
      const snip = buildImagePreviewSnippet();
      expect(snip).toContain("FZF_PREVIEW_COLUMNS");
      expect(snip).toContain("FZF_PREVIEW_LINES");
    });

    test("chafa is pinned to symbols, never a graphics protocol", () => {
      const snip = buildImagePreviewSnippet();
      // chafa has no unicode-placeholder support, so any protocol it emits is
      // drawn at the cursor and wiped by fzf's next redraw, leaving a blank
      // pane. Character art is the most it can produce that survives.
      expect(snip).toContain("-f symbols");
      expect(snip).not.toContain("-f kitty");
      expect(snip).not.toContain("-f iterm");
      expect(snip).not.toContain('-f "$fmt"');
    });

    test("kitty-protocol terminal with kitten installed uses kitten, not chafa", () => {
      const { dir, args } = fakeBin(["kitten", "chafa"]);
      runSnippet(dir, { TERM_PROGRAM: "ghostty" });
      expect(existsSync(args.kitten!)).toBe(true);
      expect(readFileSync(args.kitten!, "utf8")).toContain("--unicode-placeholder");
      expect(existsSync(args.chafa!)).toBe(false);
      rmSync(dir, { recursive: true, force: true });
    });

    test("kitty-protocol terminal without kitten falls to chafa symbols", () => {
      const { dir, args } = fakeBin(["chafa"]);
      runSnippet(dir, { TERM_PROGRAM: "ghostty" });
      expect(readFileSync(args.chafa!, "utf8")).toContain("-f symbols");
    });

    test("kitten that fails falls back to character art, not an error", () => {
      // kitten asks the terminal for pixel dimensions, and inside a preview
      // pane that query can go unanswered. Before this fallback existed the
      // pane showed "Terminal does not support reporting screen sizes".
      const dir = mkdtempSync(join(tmpdir(), "nav-img-bin-"));
      const chafaArgs = join(dir, "chafa.args");
      writeFileSync(join(dir, "kitten"), "#!/bin/sh\necho 'Error: no screen sizes' >&2\nexit 1\n");
      chmodSync(join(dir, "kitten"), 0o755);
      writeFileSync(
        join(dir, "chafa"),
        `#!/bin/sh\nprintf '%s\\n' "$*" > ${chafaArgs}\necho RENDERED-chafa\n`,
      );
      chmodSync(join(dir, "chafa"), 0o755);

      const imgDir = mkdtempSync(join(tmpdir(), "nav-img-base-"));
      writeFileSync(join(imgDir, "pic.png"), Buffer.from(PNG_B64, "base64"));
      const cmd = buildPreviewCommand(imgDir).replace("{1}", shellQuote("f:pic.png"));
      const r = spawnSync(SHELL, ["-c", cmd], {
        encoding: "utf8",
        env: {
          PATH: `${dir}:/usr/bin:/bin`,
          TERM: "xterm-256color",
          TERM_PROGRAM: "ghostty",
        },
      });

      expect(readFileSync(chafaArgs, "utf8")).toContain("-f symbols");
      expect(r.stdout).toContain("RENDERED-chafa");
      expect(r.stdout).not.toContain("no screen sizes");
      rmSync(dir, { recursive: true, force: true });
      rmSync(imgDir, { recursive: true, force: true });
    });

    test("iTerm2 uses imgcat and leaves chafa alone", () => {
      const { dir, args } = fakeBin(["imgcat", "chafa"]);
      runSnippet(dir, { TERM_PROGRAM: "iTerm.app" });
      expect(existsSync(args.imgcat!)).toBe(true);
      expect(existsSync(args.chafa!)).toBe(false);
      rmSync(dir, { recursive: true, force: true });
    });

    test("iTerm2 never takes the kitten branch even when kitten exists", () => {
      // kitten emits kitty protocol, which iTerm2 cannot render.
      const { dir, args } = fakeBin(["kitten", "chafa"]);
      runSnippet(dir, { TERM_PROGRAM: "iTerm.app" });
      expect(existsSync(args.kitten!)).toBe(false);
      expect(readFileSync(args.chafa!, "utf8")).toContain("-f symbols");
      rmSync(dir, { recursive: true, force: true });
    });

    test("unrecognized terminal falls to chafa symbols", () => {
      const { dir, args } = fakeBin(["chafa"]);
      runSnippet(dir, {});
      expect(readFileSync(args.chafa!, "utf8")).toContain("-f symbols");
    });

    test("falls back to `file` when no renderer is installed", () => {
      const imgDir = mkdtempSync(join(tmpdir(), "nav-img-none-"));
      writeFileSync(join(imgDir, "pic.png"), Buffer.from(PNG_B64, "base64"));
      const cmd = buildPreviewCommand(imgDir).replace("{1}", shellQuote("f:pic.png"));
      const r = spawnSync(SHELL, ["-c", cmd], {
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin", TERM: "xterm-256color" },
      });
      expect(r.stdout).toContain("PNG image data");
      rmSync(imgDir, { recursive: true, force: true });
    });

    test("a directory named like an image still previews as a directory", () => {
      const d = mkdtempSync(join(tmpdir(), "nav-img-dir-"));
      mkdirSync(join(d, "shots.png"));
      writeFileSync(join(d, "shots.png", "inside.txt"), "x");
      const cmd = buildPreviewCommand(d).replace("{1}", shellQuote("d:shots.png"));
      const r = spawnSync(SHELL, ["-c", cmd], {
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin", TERM: "xterm-256color" },
      });
      expect(r.stdout).toContain("inside.txt");
      rmSync(d, { recursive: true, force: true });
    });
  });

}

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
