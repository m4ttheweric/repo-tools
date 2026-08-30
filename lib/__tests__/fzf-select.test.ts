/**
 * buildFzfRows: the tab-delimited row builder extracted out of
 * filterableSelect. Output must stay byte-identical to the pre-extraction
 * inline builder, since fzf's --delimiter/--with-nth/--nth parsing depends on
 * the exact tab layout and ANSI sequences.
 */

import { describe, expect, test } from "bun:test";
import { buildFzfRows, type SelectOption } from "../fzf-select.ts";

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
