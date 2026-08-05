import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import {
  listEntries, deepList, shellQuote, buildPreviewCommand, buildImagePreviewSnippet,
  buildHelpHeaderCommand, renderHelpHeader,
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

describe("buildPreviewCommand", () => {
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

describe("buildImagePreviewSnippet", () => {
  test("never lets chafa probe the tty and always pins a format", () => {
    const snip = buildImagePreviewSnippet();
    expect(snip).toContain("--probe off");
    expect(snip).toContain("-f kitty");
    expect(snip).toContain("-f iterm");
  });

  test("sizes from the fzf preview env vars", () => {
    const snip = buildImagePreviewSnippet();
    expect(snip).toContain("FZF_PREVIEW_COLUMNS");
    expect(snip).toContain("FZF_PREVIEW_LINES");
  });

  test("falls back to `file` when no renderer is installed", () => {
    const dir = mkdtempSync(join(tmpdir(), "nav-img-"));
    // 8x8 PNG
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAKklEQVR42mP8z8BQz0AEYBxVSF+" +
        "FjP+RwH8GBgYmYhSyMIykRfooZBxNPQCk2Qb9Cm7DIQAAAABJRU5ErkJggg==",
      "base64",
    );
    writeFileSync(join(dir, "pic.png"), png);
    const cmd = buildPreviewCommand(dir).replace("{1}", shellQuote("f:pic.png"));
    // Empty PATH additions: only /usr/bin and /bin, so no chafa/kitten/imgcat
    const r = spawnSync("sh", ["-c", cmd], {
      encoding: "utf8",
      env: { ...process.env, PATH: "/usr/bin:/bin" },
    });
    expect(r.stdout).toContain("PNG image data");
    rmSync(dir, { recursive: true, force: true });
  });

  test("a directory named like an image still previews as a directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "nav-img-dir-"));
    mkdirSync(join(dir, "shots.png"));
    writeFileSync(join(dir, "shots.png", "inside.txt"), "x");
    const cmd = buildPreviewCommand(dir).replace("{1}", shellQuote("d:shots.png"));
    const r = spawnSync("sh", ["-c", cmd], {
      encoding: "utf8",
      env: { ...process.env, PATH: "/usr/bin:/bin" },
    });
    expect(r.stdout).toContain("inside.txt");
    rmSync(dir, { recursive: true, force: true });
  });

  // These two run the real chafa binary (guarded by Bun.which) rather than just
  // asserting on the snippet text, so a deleted or broken format-selection
  // branch would actually fail them instead of passing on substring matches.
  test("recognized terminal: chafa is pinned to the kitty graphics protocol", () => {
    if (!Bun.which("chafa")) return;
    const dir = mkdtempSync(join(tmpdir(), "nav-img-fmt-"));
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAKklEQVR42mP8z8BQz0AEYBxVSF+" +
        "FjP+RwH8GBgYmYhSyMIykRfooZBxNPQCk2Qb9Cm7DIQAAAABJRU5ErkJggg==",
      "base64",
    );
    writeFileSync(join(dir, "pic.png"), png);
    const cmd = buildPreviewCommand(dir).replace("{1}", shellQuote("f:pic.png"));
    // Env built from scratch (no ...process.env): TERM_PROGRAM=ghostty is the
    // only recognized-terminal signal present, so this proves our own env-var
    // match pins the format rather than chafa's independent detection.
    const r = spawnSync("sh", ["-c", cmd], {
      encoding: "utf8",
      env: {
        PATH: "/opt/homebrew/bin:/usr/bin:/bin",
        TERM: "xterm-256color",
        TERM_PROGRAM: "ghostty",
      },
    });
    expect(r.stdout).toContain("\x1b_G");
    rmSync(dir, { recursive: true, force: true });
  });

  test("unrecognized terminal: format is left to chafa's own detection, which degrades to symbol art", () => {
    if (!Bun.which("chafa")) return;
    const dir = mkdtempSync(join(tmpdir(), "nav-img-fmt-"));
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAKklEQVR42mP8z8BQz0AEYBxVSF+" +
        "FjP+RwH8GBgYmYhSyMIykRfooZBxNPQCk2Qb9Cm7DIQAAAABJRU5ErkJggg==",
      "base64",
    );
    writeFileSync(join(dir, "pic.png"), png);
    const cmd = buildPreviewCommand(dir).replace("{1}", shellQuote("f:pic.png"));
    // Clean env: only PATH and TERM. No TERM_PROGRAM, KITTY_WINDOW_ID,
    // GHOSTTY_*, TERMINFO, or __CFBundleIdentifier, so neither our hardcoded
    // list nor chafa's own env-based detection has anything to recognize.
    const r = spawnSync("sh", ["-c", cmd], {
      encoding: "utf8",
      env: {
        PATH: "/opt/homebrew/bin:/usr/bin:/bin",
        TERM: "xterm-256color",
      },
    });
    expect(r.stdout).not.toContain("\x1b_G");
    rmSync(dir, { recursive: true, force: true });
  });
});
