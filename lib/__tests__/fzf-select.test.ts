/**
 * buildFzfRows: the tab-delimited row builder extracted out of
 * filterableSelect. Output must stay byte-identical to the pre-extraction
 * inline builder, since fzf's --delimiter/--with-nth/--nth parsing depends on
 * the exact tab layout and ANSI sequences.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { buildFilterableSelectArgs, buildFzfRows, fzfHeightArgs, type SelectOption } from "../fzf-select.ts";
import { T, toAnsiFg, toHex } from "../tui/palette.ts";

const q = (message: string) => `--header=${toAnsiFg(T.pink)}${message}\x1b[0m`;

/**
 * fzfHeightArgs: `--height=-3` (fzf's native "terminal height minus N" form)
 * is what keeps the breadcrumb `renderHeader` prints above the picker
 * onscreen, at launch AND after a resize, since fzf recomputes it from the
 * live terminal size on every SIGWINCH rather than fzf-select.ts precomputing
 * a fixed line count. Verified with a pty + VT-emulator harness against a
 * 74-item list in 15/24/44 row terminals, including a live resize from 44 to
 * 15 rows mid-picker: the breadcrumb stayed onscreen in every case. `~90%` is
 * kept only as the fallback for terminals too small to spare the reserve.
 */
describe("fzfHeightArgs", () => {
  const originalStdoutRows = process.stdout.rows;
  const originalStderrRows = process.stderr.rows;

  afterEach(() => {
    delete process.env.RT_FZF_ALT_SCREEN;
    Object.defineProperty(process.stdout, "rows", { value: originalStdoutRows, configurable: true });
    Object.defineProperty(process.stderr, "rows", { value: originalStderrRows, configurable: true });
  });

  const setRows = (rows: number | undefined) => {
    Object.defineProperty(process.stdout, "rows", { value: rows, configurable: true });
    Object.defineProperty(process.stderr, "rows", { value: rows, configurable: true });
  };

  test("default (inline) picker reserves 3 rows for the breadcrumb via fzf's native height-minus-N form", () => {
    delete process.env.RT_FZF_ALT_SCREEN;
    setRows(44);
    expect(fzfHeightArgs()).toEqual(["--height=-3"]);
  });

  test("small terminal (rows <= 8) falls back to ~90%: a 3-row reserve would leave fzf's own chrome no room", () => {
    setRows(8);
    expect(fzfHeightArgs()).toEqual(["--height=~90%"]);
  });

  test("undefined rows (not a TTY) falls back to ~90%", () => {
    setRows(undefined);
    expect(fzfHeightArgs()).toEqual(["--height=~90%"]);
  });

  test("RT_FZF_ALT_SCREEN drops height args for the e2e harness's fullscreen mode", () => {
    setRows(44);
    process.env.RT_FZF_ALT_SCREEN = "1";
    expect(fzfHeightArgs()).toEqual([]);
  });
});

describe("buildFzfRows", () => {
  test("plain options: value, bold label padded to the widest label, dim hint", () => {
    const options: SelectOption[] = [
      { value: "repo-tools", label: "repo-tools", hint: "3 worktrees" },
      { value: "gitq", label: "gitq", hint: "" },
    ];

    const expected = [
      "repo-tools\t\x1b[1mrepo-tools\x1b[22m\t  \x1b[2m3 worktrees\x1b[22m",
      "gitq\t\x1b[1mgitq\x1b[22m      \t  ",
    ].join("\n");

    expect(buildFzfRows(options)).toBe(expected);
  });

  test("colored option: color wraps label+pad, hint stays unstyled, reset appended at the end", () => {
    const options: SelectOption[] = [
      { value: "ghost", label: "ghost-repo", hint: "missing", color: "\x1b[2m" },
    ];

    const expected = "ghost\t\x1b[2m\x1b[1mghost-repo\x1b[22m\x1b[2m\t  missing\x1b[0m";

    expect(buildFzfRows(options)).toBe(expected);
  });

  test("mixed colored and uncolored rows share one label width and join with newlines", () => {
    const options: SelectOption[] = [
      { value: "a", label: "aa", hint: "hint-a" },
      { value: "b", label: "bbbb", hint: "hint-b", color: "\x1b[36m" },
    ];

    const expected = [
      "a\t\x1b[1maa\x1b[22m  \t  \x1b[2mhint-a\x1b[22m",
      "b\t\x1b[36m\x1b[1mbbbb\x1b[22m\x1b[36m\t  hint-b\x1b[0m",
    ].join("\n");

    expect(buildFzfRows(options)).toBe(expected);
  });
});

/**
 * buildFilterableSelectArgs: the fzf argument assembly extracted out of
 * filterableSelect so Task 6's ctrl-r reload bind/header suffix is
 * unit-testable without spawning fzf. Byte-identical to the pre-extraction
 * inline array whenever `reloadCommand` is absent is the load-bearing
 * guarantee here: other filterableSelect callers must see zero change.
 */
describe("buildFilterableSelectArgs", () => {
  test("without reloadCommand: no ctrl-r bind, header unchanged", () => {
    const args = buildFilterableSelectArgs({ message: "Pick a repo" });
    expect(args.some((a) => a.startsWith("--bind=ctrl-r"))).toBe(false);
    expect(args).toContain(q("Pick a repo"));
    expect(args).toContain("--footer=enter: select  |: OR  !: exclude");
  });

  test("with reloadCommand: adds the ctrl-r reload bind and header suffix", () => {
    const args = buildFilterableSelectArgs({ message: "Pick a repo", reloadCommand: "rt cd --emit-rows" });
    expect(args).toContain("--bind=ctrl-r:reload(rt cd --emit-rows)");
    expect(args).toContain("--footer=enter: select  |: OR  !: exclude  ctrl-r: refresh");
  });

  test("with backLabel and reloadCommand: both header suffixes appear", () => {
    const args = buildFilterableSelectArgs({
      message: "worktrees",
      backLabel: "Switch to a different repo",
      reloadCommand: "rt cd --emit-rows",
    });
    expect(args).toContain(
      "--footer=enter: select  |: OR  !: exclude  ctrl-up: back  ctrl-r: refresh",
    );
    expect(args).toContain("--bind=ctrl-r:reload(rt cd --emit-rows)");
  });

  test("absent reloadCommand produces the exact same args regardless of call order", () => {
    const withoutReload = buildFilterableSelectArgs({ message: "Pick a repo", exact: true });
    const explicitlyUndefined = buildFilterableSelectArgs({ message: "Pick a repo", exact: true, reloadCommand: undefined });
    expect(withoutReload).toEqual(explicitlyUndefined);
    expect(withoutReload.some((a) => a.startsWith("--bind=ctrl-r"))).toBe(false);
  });

  test("scrollbar is a thick neutral glyph, independent of the pink border", () => {
    const args = buildFilterableSelectArgs({ message: "Pick a repo" });
    expect(args).toContain("--scrollbar=▐");
    expect(args).toContain(
      `--color=border:${toHex(T.pink)},scrollbar:${toHex(T.dim)},footer-border:${toHex(T.faint)}`,
    );
  });
});
