import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { readManifestBindings } from "../../lib/skills/sources.ts";
import { skillsBind, skillsCompile } from "../skills.ts";

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function makePackDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "rt-skills-bind-pack-")));
}

function writeStubs(packDir: string, verbs: Record<string, { engine: string; description: string }>): void {
  writeFile(join(packDir, "pack", "stubs.jsonc"), JSON.stringify({ verbs }));
}

const WATCH_CI_SKILL_MD = `---
name: watch-ci
description: "Watch CI"
type: pipeline-step
slots:
  domain:
    contract: "watch-ci-domain@1"
---

Watch CI.
`;

function fillSkillMd(name: string, provides: string): string {
  return `---\nname: ${name}\ndescription: "Fill ${name}"\nmetadata:\n  provides: "${provides}"\n---\n\nFill ${name}.\n`;
}

function manifestText(domainBinding: string | null): string {
  const bindingsBody = domainBinding
    ? `    /* block comment about watch-ci */\n    "mattstack:watch-ci": {\n      "domain": "${domainBinding}"\n    }`
    : `    /* block comment about watch-ci */\n    "mattstack:watch-ci": {}`;
  return [
    "// skills.jsonc -- provenance header",
    "{",
    "  // bindings comment",
    '  "bindings": {',
    bindingsBody,
    "  }",
    "}",
    "",
  ].join("\n");
}

/**
 * Mirrors lib/skills/__tests__/fixtures/compile-native's real stage-plan
 * engine: a slotted pipeline-step whose stage-consumes ("ticket") is
 * satisfiable from PIPELINE_SEED, so a single-stage pipeline chain validates.
 */
const STAGE_PLAN_SKILL_MD = `---
name: stage-plan
description: "stage-plan"
type: pipeline-step
slots:
  domain: { contract: "plan-domain@1", required: false }
metadata:
  stage: plan
  stage-consumes: ticket
  stage-produces: approach
---

{{stage.fields}}
{{slot:domain}}
`;

/**
 * A pack with one roster verb (so fullRoster.length > 0 and resolve() honors
 * --manifest) plus a pipeline stage with its own slot, bindable by name
 * alongside the roster verb.
 */
function makeStageFixture(): { packDir: string; mattstackDir: string; manifestPath: string } {
  const packDir = makePackDir();
  writeStubs(packDir, { "watch-ci": { engine: "watch-ci", description: "Watch CI" } });

  const mattstackDir = realpathSync(mkdtempSync(join(tmpdir(), "rt-skills-bind-stage-mattstack-")));
  writeFile(join(mattstackDir, "plugins", "mattstack", ".claude-plugin", "plugin.json"), JSON.stringify({ version: "1.0.0" }));
  writeFile(join(mattstackDir, "plugins", "mattstack", "skills", "pipeline", "watch-ci", "SKILL.md"), WATCH_CI_SKILL_MD);
  writeFile(join(mattstackDir, "plugins", "mattstack", "attachments", "pipeline", "stage-plan", "SKILL.md"), STAGE_PLAN_SKILL_MD);

  writeFile(join(mattstackDir, "plugins", "acme", ".claude-plugin", "plugin.json"), JSON.stringify({ version: "1.0.0" }));
  writeFile(join(mattstackDir, "plugins", "acme", "skills", "plan-policy", "SKILL.md"), fillSkillMd("plan-policy", "plan-domain@1"));

  const manifestDir = realpathSync(mkdtempSync(join(tmpdir(), "rt-skills-bind-stage-manifest-")));
  const manifestPath = join(manifestDir, "skills.jsonc");
  writeFile(manifestPath, `{\n  "pipelines": { "feature": ["mattstack:stage-plan"] },\n  "bindings": {}\n}\n`);

  return { packDir, mattstackDir, manifestPath };
}

const ORCHESTRATOR_SKILL_MD = `---
name: work
description: "Run the work pipeline"
type: pipeline-step
---

{{work-type}}
{{pipeline.stages}}
`;

/** allowed-tools nothing else in the fixture declares, so its presence in a compiled SKILL.md proves that file was actually rebuilt. */
const PLAN_POLICY_WITH_TOOL_SKILL_MD = `---
name: plan-policy
description: "Fill plan-policy"
metadata:
  provides: "plan-domain@1"
allowed-tools:
  - "Bash(plan-policy-tool:*)"
---

Fill plan-policy.
`;

/**
 * A public orchestrator verb ({{pipeline.stages}}) plus the slotted stage-plan
 * stage: an orchestrator's compiled allowed-tools unions every stage's bound
 * fills' allowed-tools (stageAllowedToolsFor), so binding the stage's slot
 * changes an input the orchestrator's own compiled output bakes in.
 */
function makeOrchestratorStageFixture(): { packDir: string; mattstackDir: string; manifestPath: string } {
  const packDir = makePackDir();
  writeStubs(packDir, { work: { engine: "work", description: "Run the work pipeline" } });
  writeFile(join(packDir, "pack", "surface.jsonc"), JSON.stringify({ public: ["work"] }));

  const mattstackDir = realpathSync(mkdtempSync(join(tmpdir(), "rt-skills-bind-orch-mattstack-")));
  writeFile(join(mattstackDir, "plugins", "mattstack", ".claude-plugin", "plugin.json"), JSON.stringify({ version: "1.0.0" }));
  writeFile(join(mattstackDir, "plugins", "mattstack", "attachments", "pipeline", "work", "SKILL.md"), ORCHESTRATOR_SKILL_MD);
  writeFile(join(mattstackDir, "plugins", "mattstack", "attachments", "pipeline", "stage-plan", "SKILL.md"), STAGE_PLAN_SKILL_MD);

  writeFile(join(mattstackDir, "plugins", "acme", ".claude-plugin", "plugin.json"), JSON.stringify({ version: "1.0.0" }));
  writeFile(join(mattstackDir, "plugins", "acme", "skills", "plan-policy", "SKILL.md"), PLAN_POLICY_WITH_TOOL_SKILL_MD);

  const manifestDir = realpathSync(mkdtempSync(join(tmpdir(), "rt-skills-bind-orch-manifest-")));
  const manifestPath = join(manifestDir, "skills.jsonc");
  writeFile(manifestPath, `{\n  "pipelines": { "feature": ["mattstack:stage-plan"] },\n  "bindings": {}\n}\n`);

  return { packDir, mattstackDir, manifestPath };
}

/**
 * Trivial one-slot pipeline-step engine ("watch-ci", slot "domain" ->
 * contract "watch-ci-domain@1") plus a fixture mattstack root carrying two
 * providing fills (v1, initially bound; v2, the bind target) and one fill
 * whose provides deliberately mismatches the slot's contract.
 */
function makeEngineFixture(domainBinding: string | null = "acme:watch-ci-domain-v1"): { mattstackDir: string; manifestPath: string } {
  const mattstackDir = realpathSync(mkdtempSync(join(tmpdir(), "rt-skills-bind-mattstack-")));
  writeFile(join(mattstackDir, "plugins", "mattstack", ".claude-plugin", "plugin.json"), JSON.stringify({ version: "1.0.0" }));
  writeFile(join(mattstackDir, "plugins", "mattstack", "skills", "pipeline", "watch-ci", "SKILL.md"), WATCH_CI_SKILL_MD);

  writeFile(join(mattstackDir, "plugins", "acme", ".claude-plugin", "plugin.json"), JSON.stringify({ version: "1.0.0" }));
  writeFile(join(mattstackDir, "plugins", "acme", "skills", "watch-ci-domain-v1", "SKILL.md"), fillSkillMd("watch-ci-domain-v1", "watch-ci-domain@1"));
  writeFile(join(mattstackDir, "plugins", "acme", "skills", "watch-ci-domain-v2", "SKILL.md"), fillSkillMd("watch-ci-domain-v2", "watch-ci-domain@1"));
  writeFile(join(mattstackDir, "plugins", "acme", "skills", "watch-ci-domain-wrong", "SKILL.md"), fillSkillMd("watch-ci-domain-wrong", "watch-ci-domain@2"));

  const manifestDir = realpathSync(mkdtempSync(join(tmpdir(), "rt-skills-bind-manifest-")));
  const manifestPath = join(manifestDir, "skills.jsonc");
  writeFile(manifestPath, manifestText(domainBinding));

  return { mattstackDir, manifestPath };
}

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
  // Bun ignores process.exitCode = undefined once truthy; 0 is the only value that clears it.
  process.exitCode = 0;
});

async function runExpectingCleanExit(fn: () => Promise<void>): Promise<{ exitCode: number | undefined; errors: string[] }> {
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

describe("skillsBind", () => {
  test("valid bind changes bindings.<engineRef>.<slot> and recompiles", async () => {
    const packDir = makePackDir();
    writeStubs(packDir, { "watch-ci": { engine: "watch-ci", description: "Watch CI" } });
    const { mattstackDir, manifestPath } = makeEngineFixture();

    await skillsBind([
      "watch-ci", "domain", "acme:watch-ci-domain-v2",
      "--pack", "t", "--pack-dir", packDir, "--mattstack-dir", mattstackDir, "--manifest", manifestPath,
    ]);

    const bindings = readManifestBindings(manifestPath);
    expect(bindings["mattstack:watch-ci"]?.domain).toBe("acme:watch-ci-domain-v2");

    const skillMd = readFileSync(join(packDir, "skills", "watch-ci", "SKILL.md"), "utf8");
    expect(skillMd).toContain("acme:watch-ci-domain-v2");
  });

  test("comments in the manifest survive the write", async () => {
    const packDir = makePackDir();
    writeStubs(packDir, { "watch-ci": { engine: "watch-ci", description: "Watch CI" } });
    const { mattstackDir, manifestPath } = makeEngineFixture();

    await skillsBind([
      "watch-ci", "domain", "acme:watch-ci-domain-v2",
      "--pack", "t", "--pack-dir", packDir, "--mattstack-dir", mattstackDir, "--manifest", manifestPath,
    ]);

    const written = readFileSync(manifestPath, "utf8");
    expect(written).toContain("// skills.jsonc -- provenance header");
    expect(written).toContain("// bindings comment");
    expect(written).toContain("/* block comment about watch-ci */");
  });

  test("unknown verb: clean error, exit 1, writes nothing", async () => {
    const packDir = makePackDir();
    writeStubs(packDir, { "watch-ci": { engine: "watch-ci", description: "Watch CI" } });
    const { mattstackDir, manifestPath } = makeEngineFixture();
    const before = readFileSync(manifestPath, "utf8");

    const { exitCode, errors } = await runExpectingCleanExit(() =>
      skillsBind([
        "no-such-verb", "domain", "acme:watch-ci-domain-v2",
        "--pack", "t", "--pack-dir", packDir, "--mattstack-dir", mattstackDir, "--manifest", manifestPath,
      ]),
    );

    expect(exitCode).toBe(1);
    expect(errors[0]).toStartWith("rt skills: ");
    expect(errors[0]).toContain("no-such-verb");
    expect(readFileSync(manifestPath, "utf8")).toBe(before);
    // Rejection is before any compile: no artifact is left behind either.
    expect(existsSync(join(packDir, "skills", "watch-ci"))).toBe(false);
  });

  test("unknown slot: clean error naming the real slots, exit 1, writes nothing", async () => {
    const packDir = makePackDir();
    writeStubs(packDir, { "watch-ci": { engine: "watch-ci", description: "Watch CI" } });
    const { mattstackDir, manifestPath } = makeEngineFixture();
    const before = readFileSync(manifestPath, "utf8");

    const { exitCode, errors } = await runExpectingCleanExit(() =>
      skillsBind([
        "watch-ci", "no-such-slot", "acme:watch-ci-domain-v2",
        "--pack", "t", "--pack-dir", packDir, "--mattstack-dir", mattstackDir, "--manifest", manifestPath,
      ]),
    );

    expect(exitCode).toBe(1);
    expect(errors[0]).toStartWith("rt skills: ");
    expect(errors[0]).toContain("no-such-slot");
    expect(errors[0]).toContain("domain");
    expect(readFileSync(manifestPath, "utf8")).toBe(before);
    expect(existsSync(join(packDir, "skills", "watch-ci"))).toBe(false);
  });

  test("fill whose provides does not match the slot's contract: clean error, exit 1, writes nothing", async () => {
    const packDir = makePackDir();
    writeStubs(packDir, { "watch-ci": { engine: "watch-ci", description: "Watch CI" } });
    const { mattstackDir, manifestPath } = makeEngineFixture();
    const before = readFileSync(manifestPath, "utf8");

    const { exitCode, errors } = await runExpectingCleanExit(() =>
      skillsBind([
        "watch-ci", "domain", "acme:watch-ci-domain-wrong",
        "--pack", "t", "--pack-dir", packDir, "--mattstack-dir", mattstackDir, "--manifest", manifestPath,
      ]),
    );

    expect(exitCode).toBe(1);
    expect(errors[0]).toStartWith("rt skills: ");
    expect(errors[0]).toContain("watch-ci-domain@2");
    expect(errors[0]).toContain("watch-ci-domain@1");
    expect(readFileSync(manifestPath, "utf8")).toBe(before);
    expect(existsSync(join(packDir, "skills", "watch-ci"))).toBe(false);
  });

  test("--dry-run writes nothing", async () => {
    const packDir = makePackDir();
    writeStubs(packDir, { "watch-ci": { engine: "watch-ci", description: "Watch CI" } });
    const { mattstackDir, manifestPath } = makeEngineFixture();
    const before = readFileSync(manifestPath, "utf8");

    await skillsBind([
      "watch-ci", "domain", "acme:watch-ci-domain-v2", "--dry-run",
      "--pack", "t", "--pack-dir", packDir, "--mattstack-dir", mattstackDir, "--manifest", manifestPath,
    ]);

    expect(readFileSync(manifestPath, "utf8")).toBe(before);
    expect(existsSync(join(packDir, "skills", "watch-ci"))).toBe(false);
    expect(logs.some((l) => l.includes("acme:watch-ci-domain-v1") && l.includes("acme:watch-ci-domain-v2"))).toBe(true);
  });

  test("binding a previously-unbound slot (new key) works", async () => {
    const packDir = makePackDir();
    writeStubs(packDir, { "watch-ci": { engine: "watch-ci", description: "Watch CI" } });
    const { mattstackDir, manifestPath } = makeEngineFixture(null);

    await skillsBind([
      "watch-ci", "domain", "acme:watch-ci-domain-v2",
      "--pack", "t", "--pack-dir", packDir, "--mattstack-dir", mattstackDir, "--manifest", manifestPath,
    ]);

    const bindings = readManifestBindings(manifestPath);
    expect(bindings["mattstack:watch-ci"]?.domain).toBe("acme:watch-ci-domain-v2");
    const written = readFileSync(manifestPath, "utf8");
    expect(written).toContain("/* block comment about watch-ci */");
  });
});

describe("skillsBind: pipeline stages", () => {
  test("binds a stage's slot under bindings[\"mattstack:<stage>\"]", async () => {
    const { packDir, mattstackDir, manifestPath } = makeStageFixture();

    await skillsBind([
      "stage-plan", "domain", "acme:plan-policy",
      "--pack", "t", "--pack-dir", packDir, "--mattstack-dir", mattstackDir, "--manifest", manifestPath,
    ]);

    const bindings = readManifestBindings(manifestPath);
    expect(bindings["mattstack:stage-plan"]?.domain).toBe("acme:plan-policy");
  });

  test("--dry-run on a stage prints <stage>.<slot>: (unbound) -> <fill> and writes nothing", async () => {
    const { packDir, mattstackDir, manifestPath } = makeStageFixture();
    const before = readFileSync(manifestPath, "utf8");

    await skillsBind([
      "stage-plan", "domain", "acme:plan-policy", "--dry-run",
      "--pack", "t", "--pack-dir", packDir, "--mattstack-dir", mattstackDir, "--manifest", manifestPath,
    ]);

    expect(readFileSync(manifestPath, "utf8")).toBe(before);
    expect(logs).toContain("stage-plan.domain: (unbound) -> acme:plan-policy");
  });

  test("a slot the stage does not declare still errors with the known-slots list", async () => {
    const { packDir, mattstackDir, manifestPath } = makeStageFixture();
    const before = readFileSync(manifestPath, "utf8");

    const { exitCode, errors } = await runExpectingCleanExit(() =>
      skillsBind([
        "stage-plan", "no-such-slot", "acme:plan-policy",
        "--pack", "t", "--pack-dir", packDir, "--mattstack-dir", mattstackDir, "--manifest", manifestPath,
      ]),
    );

    expect(exitCode).toBe(1);
    expect(errors[0]).toStartWith("rt skills: ");
    expect(errors[0]).toContain("no-such-slot");
    expect(errors[0]).toContain("domain");
    expect(readFileSync(manifestPath, "utf8")).toBe(before);
  });

  test("a name matching neither a roster verb nor a pipeline stage: clean error listing both spaces", async () => {
    const { packDir, mattstackDir, manifestPath } = makeStageFixture();

    const { exitCode, errors } = await runExpectingCleanExit(() =>
      skillsBind([
        "no-such-name", "domain", "acme:plan-policy",
        "--pack", "t", "--pack-dir", packDir, "--mattstack-dir", mattstackDir, "--manifest", manifestPath,
      ]),
    );

    expect(exitCode).toBe(1);
    expect(errors[0]).toStartWith("rt skills: ");
    expect(errors[0]).toContain('"no-such-name" is neither a roster verb nor a pipeline stage');
    expect(errors[0]).toContain("verbs: watch-ci");
    expect(errors[0]).toContain("stages: stage-plan");
  });

  test("a name in both spaces resolves as the roster verb (lookup order)", async () => {
    const { packDir, mattstackDir, manifestPath } = makeStageFixture();
    writeStubs(packDir, {
      "watch-ci": { engine: "watch-ci", description: "Watch CI" },
      "stage-plan": { engine: "watch-ci", description: "Also a roster verb" },
    });
    writeFile(
      join(mattstackDir, "plugins", "acme", "skills", "watch-ci-domain-v1", "SKILL.md"),
      fillSkillMd("watch-ci-domain-v1", "watch-ci-domain@1"),
    );

    await skillsBind([
      "stage-plan", "domain", "acme:watch-ci-domain-v1", "--dry-run",
      "--pack", "t", "--pack-dir", packDir, "--mattstack-dir", mattstackDir, "--manifest", manifestPath,
    ]);

    // watch-ci's engine (not stage-plan's) is the one loaded when a name collides:
    // its slot is "domain" with contract "watch-ci-domain@1", satisfied by this fill.
    expect(logs).toContain("stage-plan.domain: (unbound) -> acme:watch-ci-domain-v1");
  });

  test("binding a stage's slot recompiles the whole pack, updating the orchestrator's baked-in allowed-tools", async () => {
    const { packDir, mattstackDir, manifestPath } = makeOrchestratorStageFixture();
    await skillsCompile(["--pack", "t", "--pack-dir", packDir, "--mattstack-dir", mattstackDir, "--manifest", manifestPath]);

    const orchestratorPath = join(packDir, "skills", "work", "SKILL.md");
    expect(readFileSync(orchestratorPath, "utf8")).not.toContain("plan-policy-tool");

    await skillsBind([
      "stage-plan", "domain", "acme:plan-policy",
      "--pack", "t", "--pack-dir", packDir, "--mattstack-dir", mattstackDir, "--manifest", manifestPath,
    ]);

    expect(readFileSync(orchestratorPath, "utf8")).toContain("Bash(plan-policy-tool:*)");
    const stageSkillMd = readFileSync(join(packDir, "attachments", "stage-plan", "SKILL.md"), "utf8");
    expect(stageSkillMd).toContain("acme:plan-policy");
  });

  test("--dry-run on a stage recompiles nothing (orchestrator file untouched)", async () => {
    const { packDir, mattstackDir, manifestPath } = makeOrchestratorStageFixture();
    await skillsCompile(["--pack", "t", "--pack-dir", packDir, "--mattstack-dir", mattstackDir, "--manifest", manifestPath]);

    const orchestratorPath = join(packDir, "skills", "work", "SKILL.md");
    const before = readFileSync(orchestratorPath, "utf8");
    const mtimeBefore = statSync(orchestratorPath).mtimeMs;

    await skillsBind([
      "stage-plan", "domain", "acme:plan-policy", "--dry-run",
      "--pack", "t", "--pack-dir", packDir, "--mattstack-dir", mattstackDir, "--manifest", manifestPath,
    ]);

    expect(readFileSync(orchestratorPath, "utf8")).toBe(before);
    expect(statSync(orchestratorPath).mtimeMs).toBe(mtimeBefore);
  });

  test("rebinding a stage slot twice prints old -> new and the manifest ends with the second binding", async () => {
    const { packDir, mattstackDir, manifestPath } = makeStageFixture();
    writeFile(
      join(mattstackDir, "plugins", "acme", "skills", "plan-policy-v2", "SKILL.md"),
      fillSkillMd("plan-policy-v2", "plan-domain@1"),
    );

    await skillsBind([
      "stage-plan", "domain", "acme:plan-policy",
      "--pack", "t", "--pack-dir", packDir, "--mattstack-dir", mattstackDir, "--manifest", manifestPath,
    ]);
    await skillsBind([
      "stage-plan", "domain", "acme:plan-policy-v2",
      "--pack", "t", "--pack-dir", packDir, "--mattstack-dir", mattstackDir, "--manifest", manifestPath,
    ]);

    expect(logs).toContain("stage-plan.domain: acme:plan-policy -> acme:plan-policy-v2");
    const bindings = readManifestBindings(manifestPath);
    expect(bindings["mattstack:stage-plan"]?.domain).toBe("acme:plan-policy-v2");
  });
});
