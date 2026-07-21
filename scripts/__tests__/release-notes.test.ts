import { test, expect } from "bun:test";
import { parseCommit, buildReleaseNotes } from "../lib/release-notes.ts";

test("parseCommit splits conventional-commit subjects", () => {
  expect(parseCommit("feat(tray): add red flicker guard")).toEqual({
    type: "feat", scope: "tray", subject: "feat(tray): add red flicker guard",
    description: "add red flicker guard",
  });
  expect(parseCommit("docs: rewrite intro")).toEqual({
    type: "docs", scope: null, subject: "docs: rewrite intro", description: "rewrite intro",
  });
  expect(parseCommit("random subject no prefix")).toEqual({
    type: "other", scope: null, subject: "random subject no prefix", description: "random subject no prefix",
  });
});

test("buildReleaseNotes groups by scope, orders sections, adds changelog link, drops release chores", () => {
  const commits = [
    "feat(tray): add red flicker guard",
    "fix(daemon): stop dropping first ps row",
    "feat(daemon): async runCapture helper",
    "docs(site): write guides",
    "chore(release): v2.4.0",
  ].map(parseCommit);
  const md = buildReleaseNotes(commits, "v2.4.0", "HEAD", "https://github.com/m4ttheweric/repo-tools");
  // release chore excluded (no Release section, no bullet for it) ... note the
  // base tag still legitimately appears in the Full Changelog compare link below,
  // so assert on the section/bullet, not the bare string "v2.4.0".
  expect(md).not.toContain("### Release");
  expect(md).not.toContain("- v2.4.0");
  // grouped headings present
  expect(md).toContain("### Daemon");
  expect(md).toContain("### Tray");
  expect(md).toContain("### Documentation");
  // a bullet uses the cleaned description
  expect(md).toContain("- add red flicker guard");
  // changelog compare link at the bottom
  expect(md).toContain("**Full Changelog**: https://github.com/m4ttheweric/repo-tools/compare/v2.4.0...HEAD");
  // Daemon (2 commits) sorts before Tray (1) is NOT required; but Daemon appears before Tray via preferred order
  expect(md.indexOf("### Daemon")).toBeLessThan(md.indexOf("### Tray"));
});
