import { describe, test, expect } from "bun:test";
import { HOME_BOUNDARY, renderHomeGitignore } from "../boundary.ts";

describe("HOME_BOUNDARY", () => {
  test("declares exactly the ruled hygiene set — no local/ line", () => {
    expect(HOME_BOUNDARY.ignored).toEqual([".DS_Store", "*.sock", "*.tmp"]);
  });
});

describe("renderHomeGitignore", () => {
  test("renders one pattern per line, trailing newline", () => {
    expect(renderHomeGitignore()).toBe(".DS_Store\n*.sock\n*.tmp\n");
  });

  test("does not ignore user/local/ — machine profiles must stay tracked", () => {
    const lines = renderHomeGitignore()
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines.some((l) => l.includes("local"))).toBe(false);
  });
});
