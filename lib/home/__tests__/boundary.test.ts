import { describe, test, expect } from "bun:test";
import { HOME_BOUNDARY, renderHomeGitignore } from "../boundary.ts";

/**
 * Minimal gitignore-semantics matcher for the patterns this module emits.
 * Models the one distinction that matters here: a pattern containing a "/"
 * anywhere but the very end (a leading slash, or a slash in the middle) is
 * anchored to the root and only matches there; a pattern with no such slash
 * matches its directory/file name at ANY depth. Not a general gitignore
 * engine — just enough to prove renderHomeGitignore() draws the boundary at
 * the depth the spec describes.
 */
function isAnchored(pattern: string): boolean {
  const withoutTrailingSlash = pattern.endsWith("/") ? pattern.slice(0, -1) : pattern;
  return withoutTrailingSlash.includes("/");
}

function gitignorePatterns(gitignore: string): string[] {
  return gitignore
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/** `*` never crosses a `/` — enough glob support for this module's own patterns (`*.sock`, `user/secrets/*.tmp`). */
function globToRegExp(body: string): RegExp {
  const escaped = body.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`);
}

function isIgnored(patterns: string[], path: string): boolean {
  const segments = path.split("/");
  const base = segments[segments.length - 1]!;
  const dirSegments = segments.slice(0, -1);

  return patterns.some((pattern) => {
    const anchored = isAnchored(pattern);
    const body = pattern.startsWith("/") ? pattern.slice(1) : pattern;

    if (body.endsWith("/")) {
      const dir = body.slice(0, -1);
      return anchored ? path === dir || path.startsWith(`${dir}/`) : dirSegments.includes(dir);
    }
    const regex = globToRegExp(body);
    return anchored ? regex.test(path) : regex.test(base);
  });
}

describe("HOME_BOUNDARY", () => {
  test("declares exactly the ruled ignore set, root-anchored for single-segment dirs", () => {
    expect(HOME_BOUNDARY.ignored).toEqual([
      "/rt/",
      "/deck/",
      "/shepherdr/",
      "/repos/",
      "/ci-attendants/",
      "/work/",
      "/teams/",
      "user/local/",
      "settings.local.jsonc",
      "user/secrets/*.tmp",
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
    "repos/assured-dev/config.json",
    "ci-attendants/foo",
    "work/scratch",
    "teams/claimview/mattstack/settings.jsonc",
    "user/local/attic.tar",
    "settings.local.jsonc",
    ".DS_Store",
    "user/.DS_Store",
    "deck-api.sock",
    "user/secrets/rt.json.tmp",
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

  test("root-anchored dir patterns do not match the same name at depth", () => {
    expect(isIgnored(patterns, "rt/x")).toBe(true);
    expect(isIgnored(patterns, "user/rt/x")).toBe(false);
  });
});
