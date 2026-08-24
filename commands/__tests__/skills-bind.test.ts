import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { readManifestBindings } from "../../lib/skills/sources.ts";
import { skillsBind } from "../skills.ts";

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
 * Trivial one-slot pipeline-step engine ("watch-ci", slot "domain" ->
 * contract "watch-ci-domain@1") plus a fixture mattstack root carrying two
 * providing fills (v1, initially bound; v2, the bind target) and one fill
 * whose provides deliberately mismatches the slot's contract.
 */
function makeEngineFixture(domainBinding: string | null = "claimview:watch-ci-domain-v1"): { mattstackDir: string; manifestPath: string } {
  const mattstackDir = realpathSync(mkdtempSync(join(tmpdir(), "rt-skills-bind-mattstack-")));
  writeFile(join(mattstackDir, "plugins", "mattstack", ".claude-plugin", "plugin.json"), JSON.stringify({ version: "1.0.0" }));
  writeFile(join(mattstackDir, "plugins", "mattstack", "skills", "pipeline", "watch-ci", "SKILL.md"), WATCH_CI_SKILL_MD);

  writeFile(join(mattstackDir, "plugins", "claimview", ".claude-plugin", "plugin.json"), JSON.stringify({ version: "1.0.0" }));
  writeFile(join(mattstackDir, "plugins", "claimview", "skills", "watch-ci-domain-v1", "SKILL.md"), fillSkillMd("watch-ci-domain-v1", "watch-ci-domain@1"));
  writeFile(join(mattstackDir, "plugins", "claimview", "skills", "watch-ci-domain-v2", "SKILL.md"), fillSkillMd("watch-ci-domain-v2", "watch-ci-domain@1"));
  writeFile(join(mattstackDir, "plugins", "claimview", "skills", "watch-ci-domain-wrong", "SKILL.md"), fillSkillMd("watch-ci-domain-wrong", "watch-ci-domain@2"));

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
      "watch-ci", "domain", "claimview:watch-ci-domain-v2",
      "--pack", "t", "--pack-dir", packDir, "--mattstack-dir", mattstackDir, "--manifest", manifestPath,
    ]);

    const bindings = readManifestBindings(manifestPath);
    expect(bindings["mattstack:watch-ci"]?.domain).toBe("claimview:watch-ci-domain-v2");

    const skillMd = readFileSync(join(packDir, "skills", "watch-ci", "SKILL.md"), "utf8");
    expect(skillMd).toContain("claimview:watch-ci-domain-v2");
  });

  test("comments in the manifest survive the write", async () => {
    const packDir = makePackDir();
    writeStubs(packDir, { "watch-ci": { engine: "watch-ci", description: "Watch CI" } });
    const { mattstackDir, manifestPath } = makeEngineFixture();

    await skillsBind([
      "watch-ci", "domain", "claimview:watch-ci-domain-v2",
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
        "no-such-verb", "domain", "claimview:watch-ci-domain-v2",
        "--pack", "t", "--pack-dir", packDir, "--mattstack-dir", mattstackDir, "--manifest", manifestPath,
      ]),
    );

    expect(exitCode).toBe(1);
    expect(errors[0]).toStartWith("rt skills: ");
    expect(errors[0]).toContain("no-such-verb");
    expect(readFileSync(manifestPath, "utf8")).toBe(before);
  });

  test("unknown slot: clean error naming the real slots, exit 1, writes nothing", async () => {
    const packDir = makePackDir();
    writeStubs(packDir, { "watch-ci": { engine: "watch-ci", description: "Watch CI" } });
    const { mattstackDir, manifestPath } = makeEngineFixture();
    const before = readFileSync(manifestPath, "utf8");

    const { exitCode, errors } = await runExpectingCleanExit(() =>
      skillsBind([
        "watch-ci", "no-such-slot", "claimview:watch-ci-domain-v2",
        "--pack", "t", "--pack-dir", packDir, "--mattstack-dir", mattstackDir, "--manifest", manifestPath,
      ]),
    );

    expect(exitCode).toBe(1);
    expect(errors[0]).toStartWith("rt skills: ");
    expect(errors[0]).toContain("no-such-slot");
    expect(errors[0]).toContain("domain");
    expect(readFileSync(manifestPath, "utf8")).toBe(before);
  });

  test("fill whose provides does not match the slot's contract: clean error, exit 1, writes nothing", async () => {
    const packDir = makePackDir();
    writeStubs(packDir, { "watch-ci": { engine: "watch-ci", description: "Watch CI" } });
    const { mattstackDir, manifestPath } = makeEngineFixture();
    const before = readFileSync(manifestPath, "utf8");

    const { exitCode, errors } = await runExpectingCleanExit(() =>
      skillsBind([
        "watch-ci", "domain", "claimview:watch-ci-domain-wrong",
        "--pack", "t", "--pack-dir", packDir, "--mattstack-dir", mattstackDir, "--manifest", manifestPath,
      ]),
    );

    expect(exitCode).toBe(1);
    expect(errors[0]).toStartWith("rt skills: ");
    expect(errors[0]).toContain("watch-ci-domain@2");
    expect(errors[0]).toContain("watch-ci-domain@1");
    expect(readFileSync(manifestPath, "utf8")).toBe(before);
  });

  test("--dry-run writes nothing", async () => {
    const packDir = makePackDir();
    writeStubs(packDir, { "watch-ci": { engine: "watch-ci", description: "Watch CI" } });
    const { mattstackDir, manifestPath } = makeEngineFixture();
    const before = readFileSync(manifestPath, "utf8");

    await skillsBind([
      "watch-ci", "domain", "claimview:watch-ci-domain-v2", "--dry-run",
      "--pack", "t", "--pack-dir", packDir, "--mattstack-dir", mattstackDir, "--manifest", manifestPath,
    ]);

    expect(readFileSync(manifestPath, "utf8")).toBe(before);
    expect(existsSync(join(packDir, "skills", "watch-ci"))).toBe(false);
    expect(logs.some((l) => l.includes("claimview:watch-ci-domain-v1") && l.includes("claimview:watch-ci-domain-v2"))).toBe(true);
  });

  test("binding a previously-unbound slot (new key) works", async () => {
    const packDir = makePackDir();
    writeStubs(packDir, { "watch-ci": { engine: "watch-ci", description: "Watch CI" } });
    const { mattstackDir, manifestPath } = makeEngineFixture(null);

    await skillsBind([
      "watch-ci", "domain", "claimview:watch-ci-domain-v2",
      "--pack", "t", "--pack-dir", packDir, "--mattstack-dir", mattstackDir, "--manifest", manifestPath,
    ]);

    const bindings = readManifestBindings(manifestPath);
    expect(bindings["mattstack:watch-ci"]?.domain).toBe("claimview:watch-ci-domain-v2");
    const written = readFileSync(manifestPath, "utf8");
    expect(written).toContain("/* block comment about watch-ci */");
  });
});
