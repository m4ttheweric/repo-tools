import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "fs";
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

  test("falls back to a root-level surface.jsonc when pack/ has none", () => {
    const packDir = realpathSync(mkdtempSync(join(tmpdir(), "rt-skills-surface-pack-")));
    writeFile(join(packDir, "surface.jsonc"), `{ "public": ["editing-skills"] }\n`);

    expect(readSurface(packDir)).toEqual({ public: ["editing-skills"] });
  });

  test("pack/surface.jsonc wins over a root-level copy", () => {
    const packDir = realpathSync(mkdtempSync(join(tmpdir(), "rt-skills-surface-pack-")));
    writeFile(join(packDir, "pack", "surface.jsonc"), `{ "public": ["from-pack"] }\n`);
    writeFile(join(packDir, "surface.jsonc"), `{ "public": ["from-root"] }\n`);

    expect(readSurface(packDir)).toEqual({ public: ["from-pack"] });
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
      srcPath: "skills/pipeline/watch-ci/SKILL.md",
      bodyStartLine: 8,
      body: "This step defers to claimview:cvi-gates for the internal check and to claimview:watch-ci-domain for the public one.",
      slots: {},
      allowedTools: [],
      stepFiles: [],
    };
    const internalRoster = new Set(["claimview:cvi-gates"]);

    const result = compileSkill(verb, step, {}, roster, { internalRoster });

    expect(result.errors).toEqual([
      "body references claimview:cvi-gates which is surface-internal; inline it, reference it by path, or list it in surface.jsonc's public array",
    ]);
  });

  test("a description token naming an internal skill produces a description-labeled errors entry", () => {
    const dirtyVerb: VerbDef = {
      name: "watch-ci",
      engine: "watch-ci-engine",
      description: "Watch CI; for a gut check use claimview:cvi-gates first.",
    };
    const step: StepSource = {
      name: "watch-ci",
      plugin: "mattstack",
      version: "1.0.0",
      dir: "/plugins/mattstack/skills/pipeline/watch-ci",
      srcPath: "skills/pipeline/watch-ci/SKILL.md",
      bodyStartLine: 8,
      body: "Clean body.",
      slots: {},
      allowedTools: [],
      stepFiles: [],
    };
    const internalRoster = new Set(["claimview:cvi-gates"]);

    const result = compileSkill(dirtyVerb, step, {}, roster, { internalRoster });

    expect(result.errors).toEqual([
      "description references claimview:cvi-gates which is surface-internal; inline it, reference it by path, or list it in surface.jsonc's public array",
    ]);
  });

  test("no internalRoster entries: errors is empty", () => {
    const step: StepSource = {
      name: "watch-ci",
      plugin: "mattstack",
      version: "1.0.0",
      dir: "/plugins/mattstack/skills/pipeline/watch-ci",
      srcPath: "skills/pipeline/watch-ci/SKILL.md",
      bodyStartLine: 8,
      body: "This step defers to claimview:watch-ci-domain.",
      slots: {},
      allowedTools: [],
      stepFiles: [],
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
      srcPath: "skills/pipeline/watch-ci/SKILL.md",
      bodyStartLine: 8,
      body: "Poll CI.",
      slots: { domain: { contract: "watch-ci-domain@1", required: true } },
      allowedTools: [],
      stepFiles: [],
    };
    const registeredInternalFill: AttachmentSource = {
      binding: "claimview:cvi-gates",
      plugin: "claimview",
      version: "0.3.0",
      dir: "/plugins/claimview/skills/cvi-gates",
      srcPath: "skills/cvi-gates/SKILL.md",
      bodyStartLine: 8,
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
      srcPath: "skills/pipeline/watch-ci/SKILL.md",
      bodyStartLine: 8,
      body: "Poll CI.",
      slots: { domain: { contract: "watch-ci-domain@1", required: true } },
      allowedTools: [],
      stepFiles: [],
    };
    const registeredPublicFill: AttachmentSource = {
      binding: "claimview:cvi-gates",
      plugin: "claimview",
      version: "0.3.0",
      dir: "/plugins/claimview/skills/cvi-gates",
      srcPath: "skills/cvi-gates/SKILL.md",
      bodyStartLine: 8,
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

const DANGLING_STEP_SKILL_MD = `---
name: dangling-step
description: "References a retired door"
type: pipeline-step
---

Defers to claimview:old-verb for cleanup.
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
  writeFile(join(mattstackPluginDir, "skills", "pipeline", "dangling-step", "SKILL.md"), DANGLING_STEP_SKILL_MD);
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

  test("a retired stub verb with no dir on disk still seeds the internal roster: dangling references error", async () => {
    const mattstackDir = makeMattstackDir();
    const stubs = `{
  "verbs": {
    "dangling": { "engine": "dangling-step", "description": "Dangling." },
    "old-verb": { "engine": "old-verb", "description": "Retired." }
  }
}
`;
    const surfaceJsonc = `{ "public": ["dangling"] }\n`;
    const packDir = makePackDir(stubs, surfaceJsonc);
    const manifestPath = makeManifest("claimview");

    const errors: string[] = [];
    const errSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    const exitSpy = spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    try {
      await expect(
        skillsCompile([
          "--team", "claimview",
          "--pack-dir", packDir,
          "--mattstack-dir", mattstackDir,
          "--manifest", manifestPath,
        ]),
      ).rejects.toThrow("process.exit called");

      expect(errors.join("\n")).toContain("claimview:old-verb");
      expect(errors.join("\n")).toContain("surface-internal");
    } finally {
      errSpy.mockRestore();
      exitSpy.mockRestore();
    }
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

/**
 * computeInternalRoster reads <packDir>/skills/ while loadAttachment resolves
 * "<team>:X" bindings against the plugin root claude resolves for that team --
 * in production those are the same physical tree (the pack IS the installed
 * plugin). The tests above never exercise that: makeMattstackDir/makePackDir
 * keep the pack dir and the team's plugin dir separate. These fixtures make
 * plugins/claimview/ BOTH --pack-dir and the resolved "claimview" plugin
 * root, so a real end-to-end skillsCompile run is exercised.
 */
const CVI_GATES_SKILL_MD = `---
name: cvi-gates
description: "Domain gating rules"
metadata:
  provides: "watch-ci-domain@1"
---

Domain rules inlined from cvi-gates for the transition window.
`;

const WATCH_CI_WITH_SLOT_SKILL_MD = `---
name: watch-ci
description: "Watch CI until it goes green"
type: pipeline-step
slots:
  domain: { contract: "watch-ci-domain@1", required: true }
---

Poll CI.
`;

const GATE_CHECK_SKILL_MD = `---
name: gate-check
description: "Gate check"
type: pipeline-step
---

This step defers to claimview:cvi-gates for domain judgment.
`;

function makeManifestAt(bindingsJson: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rt-skills-surface-int-manifest-")));
  const path = join(dir, "skills.jsonc");
  writeFile(path, `// GENERATED -- provenance: claimview@claimview\n{ "bindings": ${bindingsJson} }\n`);
  return path;
}

async function runExpectingCleanExit(
  fn: () => Promise<void>,
): Promise<{ exitCode: number | undefined; errors: string[] }> {
  const errors: string[] = [];
  const exitSpy = spyOn(process, "exit").mockImplementation(() => {
    throw new Error("process.exit sentinel");
  });
  const errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
  try {
    await fn();
    return { exitCode: undefined, errors };
  } catch {
    const exitCode = exitSpy.mock.calls.at(-1)?.[0] as number | undefined;
    return { exitCode, errors };
  } finally {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  }
}

describe("computeInternalRoster integration (pack dir doubles as plugin root)", () => {
  test("a registered-but-not-yet-public fill inlines end to end, notes, and is flagged misplaced", async () => {
    const mattstackDir = realpathSync(mkdtempSync(join(tmpdir(), "rt-skills-surface-int-")));

    const claimviewDir = join(mattstackDir, "plugins", "claimview");
    writeFile(join(claimviewDir, ".claude-plugin", "plugin.json"), JSON.stringify({ version: "0.3.0" }));
    writeFile(
      join(claimviewDir, "pack", "stubs.jsonc"),
      `{ "verbs": { "watch-ci": { "engine": "watch-ci", "description": "Watch CI." } } }\n`,
    );
    writeFile(join(claimviewDir, "pack", "surface.jsonc"), `{ "public": ["watch-ci"] }\n`);
    writeFile(join(claimviewDir, "skills", "cvi-gates", "SKILL.md"), CVI_GATES_SKILL_MD);

    const mattstackPluginDir = join(mattstackDir, "plugins", "mattstack");
    writeFile(join(mattstackPluginDir, ".claude-plugin", "plugin.json"), JSON.stringify({ version: "1.2.0" }));
    writeFile(
      join(mattstackPluginDir, "skills", "pipeline", "watch-ci", "SKILL.md"),
      WATCH_CI_WITH_SLOT_SKILL_MD,
    );

    const manifestPath = makeManifestAt('{ "mattstack:watch-ci": { "domain": "claimview:cvi-gates" } }');

    await skillsCompile([
      "--team", "claimview",
      "--pack-dir", claimviewDir,
      "--mattstack-dir", mattstackDir,
      "--manifest", manifestPath,
      "--verb", "watch-ci",
    ]);

    const content = readFileSync(join(claimviewDir, "skills", "watch-ci", "SKILL.md"), "utf8");
    expect(content).toContain("Domain rules inlined from cvi-gates for the transition window.");
    expect(content).not.toContain("invoke that skill when this flow needs it");

    expect(logs).toContain("  note: claimview:cvi-gates is surface-internal; inlined");
    // cvi-gates is still physically under skills/ and isn't in surface.public --
    // it compiles (inlined) AND is flagged for the move surface apply would do.
    expect(logs).toContain("misplaced: cvi-gates (run rt skills surface apply, or move it)");
    expect(process.exitCode).toBe(1);
  });

  test("a body reference to an internal skill aborts that verb via the errors channel, cleanly, with no partial write", async () => {
    const mattstackDir = realpathSync(mkdtempSync(join(tmpdir(), "rt-skills-surface-int-")));

    const claimviewDir = join(mattstackDir, "plugins", "claimview");
    writeFile(join(claimviewDir, ".claude-plugin", "plugin.json"), JSON.stringify({ version: "0.3.0" }));
    writeFile(
      join(claimviewDir, "pack", "stubs.jsonc"),
      `{ "verbs": { "gate-check": { "engine": "gate-check", "description": "Gate check." } } }\n`,
    );
    writeFile(join(claimviewDir, "pack", "surface.jsonc"), `{ "public": ["gate-check"] }\n`);
    writeFile(join(claimviewDir, "skills", "cvi-gates", "SKILL.md"), CVI_GATES_SKILL_MD);

    const mattstackPluginDir = join(mattstackDir, "plugins", "mattstack");
    writeFile(join(mattstackPluginDir, ".claude-plugin", "plugin.json"), JSON.stringify({ version: "1.2.0" }));
    writeFile(join(mattstackPluginDir, "skills", "pipeline", "gate-check", "SKILL.md"), GATE_CHECK_SKILL_MD);

    const manifestPath = makeManifestAt("{}");

    const { exitCode, errors } = await runExpectingCleanExit(() =>
      skillsCompile([
        "--team", "claimview",
        "--pack-dir", claimviewDir,
        "--mattstack-dir", mattstackDir,
        "--manifest", manifestPath,
        "--verb", "gate-check",
      ]),
    );

    expect(exitCode).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toStartWith("rt skills: ");
    expect(errors[0]).toContain("gate-check");
    expect(errors[0]).toContain("claimview:cvi-gates");
    expect(errors[0]).toContain("surface-internal");
    expect(existsSync(join(claimviewDir, "skills", "gate-check"))).toBe(false);
  });

  test("post-move steady state: a skill already under attachments/ still seeds the internal roster; a body reference errors", async () => {
    const mattstackDir = realpathSync(mkdtempSync(join(tmpdir(), "rt-skills-surface-int-")));

    const claimviewDir = join(mattstackDir, "plugins", "claimview");
    writeFile(join(claimviewDir, ".claude-plugin", "plugin.json"), JSON.stringify({ version: "0.3.0" }));
    writeFile(
      join(claimviewDir, "pack", "stubs.jsonc"),
      `{ "verbs": { "gate-check": { "engine": "gate-check", "description": "Gate check." } } }\n`,
    );
    writeFile(join(claimviewDir, "pack", "surface.jsonc"), `{ "public": ["gate-check"] }\n`);
    // cvi-gates already moved by a prior `surface apply` -- lives under
    // attachments/, not skills/, and is absent from surface.public.
    writeFile(join(claimviewDir, "attachments", "cvi-gates", "SKILL.md"), CVI_GATES_SKILL_MD);

    const mattstackPluginDir = join(mattstackDir, "plugins", "mattstack");
    writeFile(join(mattstackPluginDir, ".claude-plugin", "plugin.json"), JSON.stringify({ version: "1.2.0" }));
    writeFile(join(mattstackPluginDir, "skills", "pipeline", "gate-check", "SKILL.md"), GATE_CHECK_SKILL_MD);

    const manifestPath = makeManifestAt("{}");

    const { exitCode, errors } = await runExpectingCleanExit(() =>
      skillsCompile([
        "--team", "claimview",
        "--pack-dir", claimviewDir,
        "--mattstack-dir", mattstackDir,
        "--manifest", manifestPath,
        "--verb", "gate-check",
      ]),
    );

    expect(exitCode).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toStartWith("rt skills: ");
    expect(errors[0]).toContain("gate-check");
    expect(errors[0]).toContain("claimview:cvi-gates");
    expect(errors[0]).toContain("surface-internal");
    expect(existsSync(join(claimviewDir, "skills", "gate-check"))).toBe(false);
  });
});
