import { describe, test, expect } from "bun:test";
import { HOME_BOUNDARY, renderHomeGitignore } from "../boundary.ts";

/**
 * Minimal gitignore-semantics matcher for the patterns this module emits
 * (trailing-slash directory prefixes, bare extension globs, bare filenames
 * matched by basename). Not a general gitignore engine — just enough to
 * prove renderHomeGitignore() draws the boundary the spec describes.
 */
function gitignorePatterns(gitignore: string): string[] {
  return gitignore
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function isIgnored(patterns: string[], path: string): boolean {
  const base = path.split("/").pop()!;
  return patterns.some((pattern) => {
    if (pattern.endsWith("/")) {
      const dir = pattern.slice(0, -1);
      return path === dir || path.startsWith(`${dir}/`);
    }
    if (pattern.startsWith("*.")) {
      return base.endsWith(pattern.slice(1));
    }
    return base === pattern || path === pattern;
  });
}

describe("HOME_BOUNDARY", () => {
  test("declares exactly the ruled ignore set", () => {
    expect(HOME_BOUNDARY.ignored).toEqual([
      "rt/",
      "deck/",
      "shepherdr/",
      "repos/",
      "ci-attendants/",
      "work/",
      "teams/",
      "user/local/",
      "settings.local.jsonc",
      "*.sock",
      ".DS_Store",
    ]);
  });

  test("declares the tracked declarative surfaces", () => {
    expect(HOME_BOUNDARY.tracked).toEqual([
      "user/",
      "skills.jsonc",
      "snapshot-owners.jsonc",
      "user/secrets/",
    ]);
  });
});

describe("renderHomeGitignore", () => {
  const patterns = gitignorePatterns(renderHomeGitignore());

  const ignoredCases = [
    "rt/state.db",
    "rt/rt.sock",
    "deck/settings.json",
    "shepherdr/jobs/1.json",
    "repos/acme-dev/config.json",
    "ci-attendants/foo",
    "work/scratch",
    "teams/acme/mattstack/settings.jsonc",
    "user/local/attic.tar",
    "settings.local.jsonc",
    ".DS_Store",
    "user/.DS_Store",
  ];

  const trackedCases = [
    "user/",
    "user/settings.jsonc",
    "skills.jsonc",
    "snapshot-owners.jsonc",
    "user/secrets/",
    "user/secrets/rt.json",
  ];

  for (const path of ignoredCases) {
    test(`ignores ${path}`, () => {
      expect(isIgnored(patterns, path)).toBe(true);
    });
  }

  for (const path of trackedCases) {
    test(`does not ignore ${path}`, () => {
      expect(isIgnored(patterns, path)).toBe(false);
    });
  }
});
