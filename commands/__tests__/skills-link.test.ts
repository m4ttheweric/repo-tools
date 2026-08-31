import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolveSkillsDir } from "../skills-link.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rt-skills-link-cmd-"));
});

describe("resolveSkillsDir", () => {
  test("a repo checkout resolves to <repoRoot>/skills", () => {
    const skills = join(root, "repo", "skills");
    mkdirSync(skills, { recursive: true });
    expect(resolveSkillsDir({ repoRoot: () => join(root, "repo") })).toEqual({ dir: skills });
  });

  test("--from wins over the repo, so a bundled dir needs no checkout", () => {
    const bundled = join(root, "Helpers", "skills", "gitq");
    mkdirSync(bundled, { recursive: true });
    const repoSkills = join(root, "repo", "skills");
    mkdirSync(repoSkills, { recursive: true });
    expect(resolveSkillsDir({ from: bundled, repoRoot: () => join(root, "repo") })).toEqual({ dir: bundled });
  });

  test("--from is honored outside any git repo", () => {
    const bundled = join(root, "Helpers", "skills", "deck");
    mkdirSync(bundled, { recursive: true });
    expect(resolveSkillsDir({ from: bundled, repoRoot: () => null })).toEqual({ dir: bundled });
  });

  test("--from is resolved to an absolute path", () => {
    const bundled = join(root, "rel");
    mkdirSync(bundled, { recursive: true });
    const got = resolveSkillsDir({ from: bundled + "/.", repoRoot: () => null });
    expect(got).toEqual({ dir: bundled });
  });

  test("a missing --from dir is an error naming the dir", () => {
    const missing = join(root, "nope");
    const got = resolveSkillsDir({ from: missing, repoRoot: () => null });
    expect(got).toEqual({ error: `${missing} does not exist` });
  });

  test("a --from that is a file, not a directory, is an error", () => {
    const file = join(root, "SKILL.md");
    writeFileSync(file, "x");
    expect(resolveSkillsDir({ from: file, repoRoot: () => null })).toEqual({ error: `${file} is not a directory` });
  });

  test("outside a git repo with no --from, the error names --from as the way out", () => {
    const got = resolveSkillsDir({ repoRoot: () => null });
    expect(got).toEqual({ error: "not inside a git repo — run it from the repo whose skills/ you want linked, or pass --from <dir>" });
  });

  test("a repo with no skills/ dir is an error", () => {
    mkdirSync(join(root, "repo"), { recursive: true });
    const got = resolveSkillsDir({ repoRoot: () => join(root, "repo") });
    expect(got).toEqual({ error: `${join(root, "repo", "skills")} does not exist — this repo has no skills/ directory` });
  });
});
