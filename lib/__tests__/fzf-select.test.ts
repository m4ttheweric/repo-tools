/**
 * buildFzfRows: the tab-delimited row builder extracted out of
 * filterableSelect. Output must stay byte-identical to the pre-extraction
 * inline builder, since fzf's --delimiter/--with-nth/--nth parsing depends on
 * the exact tab layout and ANSI sequences.
 */

import { describe, expect, test } from "bun:test";
import { buildFilterableSelectArgs, buildFzfRows, type SelectOption } from "../fzf-select.ts";
import { T, toAnsiFg } from "../tui/palette.ts";

const q = (message: string) => `${toAnsiFg(T.pink)}${message}\x1b[0m\n`;

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
    expect(args).toContain(`--header=${q("Pick a repo")}enter: select  |: OR  !: exclude`);
  });

  test("with reloadCommand: adds the ctrl-r reload bind and header suffix", () => {
    const args = buildFilterableSelectArgs({ message: "Pick a repo", reloadCommand: "rt cd --emit-rows" });
    expect(args).toContain("--bind=ctrl-r:reload(rt cd --emit-rows)");
    expect(args).toContain(`--header=${q("Pick a repo")}enter: select  |: OR  !: exclude  ctrl-r: refresh`);
  });

  test("with backLabel and reloadCommand: both header suffixes appear", () => {
    const args = buildFilterableSelectArgs({
      message: "worktrees",
      backLabel: "Switch to a different repo",
      reloadCommand: "rt cd --emit-rows",
    });
    expect(args).toContain(
      `--header=${q("worktrees")}enter: select  |: OR  !: exclude  ctrl-up: back  ctrl-r: refresh`,
    );
    expect(args).toContain("--bind=ctrl-r:reload(rt cd --emit-rows)");
  });

  test("absent reloadCommand produces the exact same args regardless of call order", () => {
    const withoutReload = buildFilterableSelectArgs({ message: "Pick a repo", exact: true });
    const explicitlyUndefined = buildFilterableSelectArgs({ message: "Pick a repo", exact: true, reloadCommand: undefined });
    expect(withoutReload).toEqual(explicitlyUndefined);
    expect(withoutReload.some((a) => a.startsWith("--bind=ctrl-r"))).toBe(false);
  });
});
