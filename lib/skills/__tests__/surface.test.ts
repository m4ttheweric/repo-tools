import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { skillsCompile } from "../../../commands/skills.ts";
import { compileSkill } from "../compile.ts";
import { readSurface } from "../sources.ts";
import type { AttachmentSource, StepSource, VerbDef } from "../types.ts";

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

describe("readSurface", () => {
  test("parses a comment-bearing surface.jsonc", () => {
    const packDir = realpathSync(mkdtempSync(join(tmpdir(), "rt-skills-surface-pack-")));
    const surfaceJsonc = `// surface.jsonc -- names this pack's public skills/ directories.
{
  "public": [
    "watch-ci",
    // hand-authored skill, not a compiled verb
    "cvi-gates"
  ]
}
`;
    writeFile(join(packDir, "pack", "surface.jsonc"), surfaceJsonc);

    const surface = readSurface(packDir);

    expect(surface).toEqual({ public: ["watch-ci", "cvi-gates"] });
  });

  test("returns null when surface.jsonc is absent", () => {
    const packDir = realpathSync(mkdtempSync(join(tmpdir(), "rt-skills-surface-pack-")));

    expect(readSurface(packDir)).toBeNull();
  });
});

describe("compileSkill with internalRoster", () => {
  const verb: VerbDef = { name: "watch-ci", engine: "watch-ci-engine", description: "Watch CI" };
  const roster = new Set(["mattstack:watch-ci", "claimview:watch-ci-domain"]);

  test("a body token naming an internal skill produces an errors entry with fix options; a public token does not", () => {
    const step: StepSource = {
      name: "watch-ci",
      plugin: "mattstack",
      version: "1.0.0",
      dir: "/plugins/mattstack/skills/pipeline/watch-ci",
      body: "This step defers to claimview:cvi-gates for the internal check and to claimview:watch-ci-domain for the public one.",
      slots: {},
      allowedTools: [],
      scriptFiles: [],
    };
    const internalRoster = new Set(["claimview:cvi-gates"]);

    const result = compileSkill(verb, step, {}, roster, { internalRoster });

    expect(result.errors).toEqual([
      "body references claimview:cvi-gates which is surface-internal; inline it, reference it by path, or list it in surface.jsonc's public array",
    ]);
  });

  test("no internalRoster entries: errors is empty", () => {
    const step: StepSource = {
      name: "watch-ci",
      plugin: "mattstack",
      version: "1.0.0",
      dir: "/plugins/mattstack/skills/pipeline/watch-ci",
      body: "This step defers to claimview:watch-ci-domain.",
      slots: {},
      allowedTools: [],
      scriptFiles: [],
    };

    const result = compileSkill(verb, step, {}, roster);

    expect(result.errors).toEqual([]);
  });

  test("a fill whose binding is internal-listed inlines despite registered=true, with a printed note", () => {
    const stepWithSlot: StepSource = {
      name: "watch-ci",
      plugin: "mattstack",
      version: "1.0.0",
      dir: "/plugins/mattstack/skills/pipeline/watch-ci",
      body: "Poll CI.",
      slots: { domain: { contract: "watch-ci-domain@1", required: true } },
      allowedTools: [],
      scriptFiles: [],
    };
    const registeredInternalFill: AttachmentSource = {
      binding: "claimview:cvi-gates",
      plugin: "claimview",
      version: "0.3.0",
      dir: "/plugins/claimview/skills/cvi-gates",
      body: "Domain rules inlined from cvi-gates.",
      provides: "watch-ci-domain@1",
      allowedTools: [],
      extraFiles: [],
      registered: true,
    };
    const internalRoster = new Set(["claimview:cvi-gates"]);

    const result = compileSkill(verb, stepWithSlot, { domain: registeredInternalFill }, roster, {
      internalRoster,
    });

    const skillFile = result.files[0];
    if (!skillFile || !("content" in skillFile)) throw new Error("expected files[0] to have content");

    expect(skillFile.content).toContain("Domain rules inlined from cvi-gates.");
    expect(skillFile.content).not.toContain("invoke that skill when this flow needs it");
    expect(result.warnings).toContain("note: claimview:cvi-gates is surface-internal; inlined");
  });

  test("a fill whose binding is NOT internal-listed still references, not inlines, when registered=true", () => {
    const stepWithSlot: StepSource = {
      name: "watch-ci",
      plugin: "mattstack",
      version: "1.0.0",
      dir: "/plugins/mattstack/skills/pipeline/watch-ci",
      body: "Poll CI.",
      slots: { domain: { contract: "watch-ci-domain@1", required: true } },
      allowedTools: [],
      scriptFiles: [],
    };
    const registeredPublicFill: AttachmentSource = {
      binding: "claimview:cvi-gates",
      plugin: "claimview",
      version: "0.3.0",
      dir: "/plugins/claimview/skills/cvi-gates",
      body: "Domain rules for cvi-gates.",
      provides: "watch-ci-domain@1",
      allowedTools: [],
      extraFiles: [],
      registered: true,
    };

    const result = compileSkill(verb, stepWithSlot, { domain: registeredPublicFill }, roster, {
      internalRoster: new Set(),
    });

    const skillFile = result.files[0];
    if (!skillFile || !("content" in skillFile)) throw new Error("expected files[0] to have content");

    expect(skillFile.content).toContain("invoke that skill when this flow needs it");
    expect(skillFile.content).not.toContain("Domain rules for cvi-gates.");
    expect(result.warnings).not.toContain("note: claimview:cvi-gates is surface-internal; inlined");
  });
});

const WATCH_CI_SKILL_MD = `---
name: watch-ci
description: "Watch CI until it goes green"
type: pipeline-step
---

Poll the pipeline every 30s and report status.
`;

const OLD_VERB_SKILL_MD = `---
name: old-verb
description: "A retired verb"
type: pipeline-step
---

This verb is retired.
`;

const STRAY_SKILL_MD = `---
name: stray-skill
description: "Hand-authored skill not yet declared public"
---

Stray content.
`;

function makeMattstackDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rt-skills-surface-mattstack-")));
  const mattstackPluginDir = join(dir, "plugins", "mattstack");
  writeFile(join(mattstackPluginDir, ".claude-plugin", "plugin.json"), JSON.stringify({ version: "1.2.0" }));
  writeFile(join(mattstackPluginDir, "skills", "pipeline", "watch-ci", "SKILL.md"), WATCH_CI_SKILL_MD);
  writeFile(join(mattstackPluginDir, "skills", "pipeline", "old-verb", "SKILL.md"), OLD_VERB_SKILL_MD);
  return dir;
}

function makePackDir(stubsJsonc: string, surfaceJsonc: string | null): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rt-skills-surface-pack-")));
  writeFile(join(dir, "pack", "stubs.jsonc"), stubsJsonc);
  if (surfaceJsonc !== null) {
    writeFile(join(dir, "pack", "surface.jsonc"), surfaceJsonc);
  }
  return dir;
}

function makeManifest(team: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rt-skills-surface-manifest-")));
  const path = join(dir, "skills.jsonc");
  writeFile(
    path,
    `// GENERATED -- provenance: ${team}@${team}\n{\n  "bindings": {}\n}\n`,
  );
  return path;
}

const STUBS_TWO_VERBS = `{
  "verbs": {
    "watch-ci": { "engine": "watch-ci", "description": "Watch CI." },
    "old-verb": { "engine": "old-verb", "description": "Retired." }
  }
}
`;

let logSpy: ReturnType<typeof spyOn>;
let logs: string[];

beforeEach(() => {
  logs = [];
  logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  logSpy.mockRestore();
  // Bun's process.exitCode setter ignores undefined once set truthy -- 0 is
  // the only value that actually clears it between tests in this file.
  process.exitCode = 0;
});

describe("skillsCompile with a surface config", () => {
  test("skips a non-public verb, prints an internal line, and removes its compiled skills/ dir", async () => {
    const mattstackDir = makeMattstackDir();
    const surfaceJsonc = `{ "public": ["watch-ci"] }\n`;
    const packDir = makePackDir(STUBS_TWO_VERBS, surfaceJsonc);
    writeFile(join(packDir, "skills", "old-verb", "SKILL.md"), "stale compiled output\n");
    const manifestPath = makeManifest("t");

    await skillsCompile([
      "--team", "t",
      "--pack-dir", packDir,
      "--mattstack-dir", mattstackDir,
      "--manifest", manifestPath,
    ]);

    expect(logs).toContain("internal: old-verb (not compiled; roster entry retired)");
    expect(existsSync(join(packDir, "skills", "old-verb"))).toBe(false);
    expect(existsSync(join(packDir, "skills", "watch-ci", "SKILL.md"))).toBe(true);
  });

  test("placement verification flags a non-public dir left under skills/ and sets a nonzero exit", async () => {
    const mattstackDir = makeMattstackDir();
    const surfaceJsonc = `{ "public": ["watch-ci"] }\n`;
    const packDir = makePackDir(STUBS_TWO_VERBS, surfaceJsonc);
    writeFile(join(packDir, "skills", "stray-skill", "SKILL.md"), STRAY_SKILL_MD);
    const manifestPath = makeManifest("t");

    await skillsCompile([
      "--team", "t",
      "--pack-dir", packDir,
      "--mattstack-dir", mattstackDir,
      "--manifest", manifestPath,
    ]);

    expect(logs).toContain("misplaced: stray-skill (run rt skills surface apply, or move it)");
    expect(process.exitCode).toBe(1);
    // it never moves anything
    expect(existsSync(join(packDir, "skills", "stray-skill", "SKILL.md"))).toBe(true);
  });

  test("no surface.jsonc present: all verbs compile, no internal/misplaced lines, no exit code", async () => {
    const mattstackDir = makeMattstackDir();
    const packDir = makePackDir(STUBS_TWO_VERBS, null);
    const manifestPath = makeManifest("t");

    await skillsCompile([
      "--team", "t",
      "--pack-dir", packDir,
      "--mattstack-dir", mattstackDir,
      "--manifest", manifestPath,
    ]);

    expect(logs.some((l) => l.startsWith("internal:"))).toBe(false);
    expect(logs.some((l) => l.startsWith("misplaced:"))).toBe(false);
    expect(existsSync(join(packDir, "skills", "watch-ci", "SKILL.md"))).toBe(true);
    expect(existsSync(join(packDir, "skills", "old-verb", "SKILL.md"))).toBe(true);
    expect(process.exitCode).not.toBe(1);
  });
});
