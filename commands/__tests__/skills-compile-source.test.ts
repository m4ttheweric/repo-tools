import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { skillsCompile } from "../skills.ts";
import { HEADER_COMMENT } from "../../lib/skills/compile.ts";

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

const WRAP_UP_SOURCE = `---
name: wrap-up
description: "Use when wrapping up a session."
type: pipeline-step
---
Ask one structured question, then stop.
`;

/**
 * The pack IS the mattstack plugin (self identity), so the verb's engine
 * source is read from the pack's own attachments/<verb>/SKILL.md while the
 * public door compiles into skills/<verb>/. Those two paths are each other's
 * "other side" in the layout.
 */
function makeSelfPack(): { packDir: string; mattstackDir: string; manifestPath: string } {
  const packDir = realpathSync(mkdtempSync(join(tmpdir(), "rt-skills-self-pack-")));
  writeFile(join(packDir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "mattstack", version: "9.9.9" }));
  writeFile(join(packDir, "pack", "stubs.jsonc"), `{
  "verbs": {
    "wrap-up": { "engine": "wrap-up", "description": "Use when wrapping up a session." }
  }
}
`);
  writeFile(join(packDir, "attachments", "wrap-up", "SKILL.md"), WRAP_UP_SOURCE);

  const mattstackDir = realpathSync(mkdtempSync(join(tmpdir(), "rt-skills-self-mattstack-")));
  writeFile(join(mattstackDir, "plugins", "mattstack", ".claude-plugin", "plugin.json"), JSON.stringify({ version: "1.2.0" }));

  const manifestPath = join(realpathSync(mkdtempSync(join(tmpdir(), "rt-skills-self-manifest-"))), "skills.jsonc");
  writeFile(manifestPath, `{ "bindings": {} }\n`);
  return { packDir, mattstackDir, manifestPath };
}

let logSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  process.exitCode = 0;
});

describe("skillsCompile keeps a pack's own engine source", () => {
  test("a hand-written attachments/<verb>/SKILL.md survives compiling <verb> as public", async () => {
    const { packDir, mattstackDir, manifestPath } = makeSelfPack();
    const source = join(packDir, "attachments", "wrap-up", "SKILL.md");

    await skillsCompile([
      "--team", "mattstack",
      "--pack-dir", packDir,
      "--mattstack-dir", mattstackDir,
      "--manifest", manifestPath,
      "--verb", "wrap-up",
    ]);

    expect(existsSync(source)).toBe(true);
    expect(readFileSync(source, "utf8")).toBe(WRAP_UP_SOURCE);
    const compiled = readFileSync(join(packDir, "skills", "wrap-up", "SKILL.md"), "utf8");
    expect(compiled).toContain(HEADER_COMMENT);
  });

  test("a prior compile on the other side is still removed", async () => {
    const { packDir, mattstackDir, manifestPath } = makeSelfPack();
    const priorCompile = join(packDir, "attachments", "stale-door", "SKILL.md");
    writeFile(priorCompile, `---\nname: stale-door\n---\n${HEADER_COMMENT}\nold output\n`);
    writeFile(join(packDir, "attachments", "stale-door-src", "SKILL.md"), WRAP_UP_SOURCE.replace(/wrap-up/g, "stale-door-src"));
    writeFile(join(packDir, "pack", "stubs.jsonc"), `{
  "verbs": {
    "stale-door": { "engine": "stale-door-src", "description": "Use when testing stale cleanup." }
  }
}
`);

    await skillsCompile([
      "--team", "mattstack",
      "--pack-dir", packDir,
      "--mattstack-dir", mattstackDir,
      "--manifest", manifestPath,
      "--verb", "stale-door",
    ]);

    expect(existsSync(priorCompile)).toBe(false);
    expect(existsSync(join(packDir, "skills", "stale-door", "SKILL.md"))).toBe(true);
  });
});
