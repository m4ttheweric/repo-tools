import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pruneLinksFrom, reconcileSkillLinks } from "../link.ts";

let root: string;
let skillsDir: string;
let claudeDir: string;

function addSkill(dirName: string, frontmatterName: string | null): string {
  const dir = join(skillsDir, dirName);
  mkdirSync(dir, { recursive: true });
  const fm = frontmatterName === null ? "---\ndescription: nameless\n---\n" : `---\nname: ${frontmatterName}\ndescription: test skill\n---\n`;
  writeFileSync(join(dir, "SKILL.md"), `${fm}\nBody.\n`);
  return dir;
}

function kinds(result: ReturnType<typeof reconcileSkillLinks>): Record<string, string> {
  return Object.fromEntries(result.actions.map((a) => [a.name, a.kind]));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rt-skills-link-"));
  skillsDir = join(root, "repo", "skills");
  claudeDir = join(root, "home", ".claude", "skills");
  mkdirSync(skillsDir, { recursive: true });
});

describe("reconcileSkillLinks", () => {
  test("creates a symlink named by frontmatter, pointing at the skill dir", () => {
    const dir = addSkill("rt-settings", "rt:settings");
    const result = reconcileSkillLinks({ skillsDir, claudeSkillsDir: claudeDir });
    expect(kinds(result)).toEqual({ "rt:settings": "create" });
    expect(result.changed).toBe(true);
    expect(realpathSync(join(claudeDir, "rt:settings"))).toBe(realpathSync(dir));
  });

  test("an already-correct link reports ok and changes nothing", () => {
    const dir = addSkill("rt-settings", "rt:settings");
    mkdirSync(claudeDir, { recursive: true });
    symlinkSync(dir, join(claudeDir, "rt:settings"));
    const result = reconcileSkillLinks({ skillsDir, claudeSkillsDir: claudeDir });
    expect(kinds(result)).toEqual({ "rt:settings": "ok" });
    expect(result.changed).toBe(false);
  });

  test("dry run reports create without touching disk", () => {
    addSkill("rt-settings", "rt:settings");
    const result = reconcileSkillLinks({ skillsDir, claudeSkillsDir: claudeDir, dryRun: true });
    expect(kinds(result)).toEqual({ "rt:settings": "create" });
    expect(() => lstatSync(join(claudeDir, "rt:settings"))).toThrow();
  });

  test("prunes a link into this skills dir whose target is gone; leaves foreign links alone", () => {
    addSkill("rt-keep", "rt:keep");
    mkdirSync(claudeDir, { recursive: true });
    symlinkSync(join(realpathSync(skillsDir), "rt-deleted"), join(claudeDir, "rt:deleted"));
    symlinkSync(join(root, "elsewhere", "some-skill"), join(claudeDir, "other:skill"));
    const result = reconcileSkillLinks({ skillsDir, claudeSkillsDir: claudeDir });
    expect(kinds(result)).toEqual({ "rt:keep": "create", "rt:deleted": "prune" });
    expect(() => lstatSync(join(claudeDir, "rt:deleted"))).toThrow();
    expect(readlinkSync(join(claudeDir, "other:skill"))).toContain("elsewhere");
  });

  test("a foreign symlink squatting a wanted name is a conflict and untouched", () => {
    addSkill("rt-settings", "rt:settings");
    mkdirSync(claudeDir, { recursive: true });
    const foreign = join(root, "elsewhere", "rt-settings");
    mkdirSync(foreign, { recursive: true });
    symlinkSync(foreign, join(claudeDir, "rt:settings"));
    const result = reconcileSkillLinks({ skillsDir, claudeSkillsDir: claudeDir });
    expect(kinds(result)).toEqual({ "rt:settings": "conflict" });
    expect(realpathSync(join(claudeDir, "rt:settings"))).toBe(realpathSync(foreign));
  });

  test("a real directory squatting a wanted name is a conflict and untouched", () => {
    addSkill("rt-settings", "rt:settings");
    mkdirSync(join(claudeDir, "rt:settings"), { recursive: true });
    const result = reconcileSkillLinks({ skillsDir, claudeSkillsDir: claudeDir });
    expect(kinds(result)).toEqual({ "rt:settings": "conflict" });
    expect(lstatSync(join(claudeDir, "rt:settings")).isDirectory()).toBe(true);
  });

  test("repoints a link that targets a renamed dir inside this skills dir", () => {
    const dir = addSkill("rt-settings-v2", "rt:settings");
    mkdirSync(claudeDir, { recursive: true });
    symlinkSync(join(realpathSync(skillsDir), "rt-settings-old"), join(claudeDir, "rt:settings"));
    const result = reconcileSkillLinks({ skillsDir, claudeSkillsDir: claudeDir });
    expect(kinds(result)).toEqual({ "rt:settings": "relink" });
    expect(realpathSync(join(claudeDir, "rt:settings"))).toBe(realpathSync(dir));
  });

  test("skips dirs without a usable frontmatter name and dirs without SKILL.md", () => {
    addSkill("rt-nameless", null);
    mkdirSync(join(skillsDir, "not-a-skill"), { recursive: true });
    const result = reconcileSkillLinks({ skillsDir, claudeSkillsDir: claudeDir });
    expect(result.actions).toEqual([
      expect.objectContaining({ kind: "skip", name: "rt-nameless" }),
    ]);
    expect(result.changed).toBe(false);
  });

  test("a name with a path separator is skipped, never linked", () => {
    addSkill("rt-evil", "../escape");
    const result = reconcileSkillLinks({ skillsDir, claudeSkillsDir: claudeDir });
    expect(result.actions[0]!.kind).toBe("skip");
    expect(() => lstatSync(join(claudeDir, "..", "escape"))).toThrow();
  });

  test("duplicate frontmatter names: first dir wins, second is skipped", () => {
    addSkill("rt-a", "rt:dup");
    addSkill("rt-b", "rt:dup");
    const result = reconcileSkillLinks({ skillsDir, claudeSkillsDir: claudeDir });
    const byKind = result.actions.map((a) => a.kind).sort();
    expect(byKind).toEqual(["create", "skip"]);
  });
});

describe("pruneLinksFrom", () => {
  test("removes links pointing into a source dir that is gone (an uninstalled app)", () => {
    const dir = addSkill("track", "gitq:track");
    reconcileSkillLinks({ skillsDir, claudeSkillsDir: claudeDir });
    expect(lstatSync(join(claudeDir, "gitq:track")).isSymbolicLink()).toBe(true);

    rmSync(dir, { recursive: true, force: true });
    rmSync(skillsDir, { recursive: true, force: true });

    const result = pruneLinksFrom({ skillsDir, claudeSkillsDir: claudeDir });
    expect(kinds(result)).toEqual({ "gitq:track": "prune" });
    expect(result.changed).toBe(true);
    expect(existsSync(join(claudeDir, "gitq:track"))).toBe(false);
  });

  test("leaves another app's links alone", () => {
    addSkill("track", "gitq:track");
    reconcileSkillLinks({ skillsDir, claudeSkillsDir: claudeDir });
    const otherDir = join(root, "other", "skills", "add-app");
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(join(otherDir, "SKILL.md"), "---\nname: deck:add-app\n---\n");
    symlinkSync(otherDir, join(claudeDir, "deck:add-app"));

    const result = pruneLinksFrom({ skillsDir: join(root, "gone", "skills"), claudeSkillsDir: claudeDir });
    expect(result.actions).toEqual([]);
    expect(result.changed).toBe(false);
    expect(lstatSync(join(claudeDir, "gitq:track")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(claudeDir, "deck:add-app")).isSymbolicLink()).toBe(true);
  });

  test("a dry run reports without unlinking", () => {
    addSkill("track", "gitq:track");
    reconcileSkillLinks({ skillsDir, claudeSkillsDir: claudeDir });
    rmSync(skillsDir, { recursive: true, force: true });

    const result = pruneLinksFrom({ skillsDir, claudeSkillsDir: claudeDir, dryRun: true });
    expect(kinds(result)).toEqual({ "gitq:track": "prune" });
    expect(lstatSync(join(claudeDir, "gitq:track")).isSymbolicLink()).toBe(true);
  });
});
