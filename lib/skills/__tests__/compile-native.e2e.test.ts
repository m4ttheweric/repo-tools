import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { skillsCompile, skillsCheck } from "../../../commands/skills.ts";
import { runExpectingCleanExit } from "./helpers.ts";

const FIX = join(import.meta.dir, "fixtures", "compile-native");

async function build() {
  const root = mkdtempSync(join(tmpdir(), "rt-e2e-"));
  cpSync(FIX, root, { recursive: true });
  const pack = join(root, "pack");
  const ms = join(root, "mattstack-home");
  const manifest = join(ms, "repos", "my-repo", "skills.jsonc");
  await skillsCompile(["--pack-dir", pack, "--mattstack-dir", ms, "--manifest", manifest]);
  return { pack, ms, manifest };
}

describe("compile-native end to end", () => {
  test("work and every compiled stage compile with zero resolver references and zero placeholders", async () => {
    const { pack } = await build();
    const work = readFileSync(join(pack, "skills", "work", "SKILL.md"), "utf8");
    const stages = ["stage-plan", "stage-implement", "stage-ship"].map(
      (name) => [name, readFileSync(join(pack, "attachments", name, "SKILL.md"), "utf8")] as const,
    );

    for (const md of [work, ...stages.map(([, body]) => body)]) {
      expect(md).not.toContain("resolve-args");
      expect(md).not.toContain("resolve-pipeline");
      expect(md).not.toContain("{{");
    }
    expect(work).toContain("<!-- part: step source=mattstack:work");
    expect(work).toMatch(/--mattstack-sha \S+ --mattstack-dirty [01]/);
    for (const [name, body] of stages) {
      expect(body).toContain(`<!-- part: step source=mattstack:${name}`);
    }

    const plan = stages.find(([name]) => name === "stage-plan")![1];
    // The fill comes from the pack under compilation, at the pack's own version --
    // never from an installed copy of a previous release.
    expect(plan).toContain("<!-- part: slot:domain binding=acme:plan-policy version=0.1.0 path=attachments/plan-policy/SKILL.md");
    expect(existsSync(join(pack, "skills", "work", "scripts", "resolve-pipeline.sh"))).toBe(false);
  });

  test("rt skills check is clean immediately after compile", async () => {
    const { pack, ms, manifest } = await build();
    process.exitCode = 0;
    await skillsCheck(["--pack-dir", pack, "--mattstack-dir", ms, "--manifest", manifest]);
    expect(process.exitCode).toBe(0);
  });

  test("a broken chain refuses to compile", async () => {
    const root = mkdtempSync(join(tmpdir(), "rt-e2e-"));
    cpSync(FIX, root, { recursive: true });
    const manifest = join(root, "mattstack-home", "repos", "my-repo", "skills.jsonc");
    // stage-ship consumes commits; nothing produces it when stage-plan is alone before it
    const broken = readFileSync(manifest, "utf8").replace('"mattstack:stage-plan", "mattstack:stage-implement", "mattstack:stage-ship"', '"mattstack:stage-plan", "mattstack:stage-ship"');
    writeFileSync(manifest, broken);
    const { exitCode, errors } = await runExpectingCleanExit(() =>
      skillsCompile(["--pack-dir", join(root, "pack"), "--mattstack-dir", join(root, "mattstack-home"), "--manifest", manifest]),
    );
    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain('stage "stage-ship" consumes "commits"');
  });

  test("a path-breakout pipeline entry refuses to compile and never touches a directory outside packDir", async () => {
    const root = mkdtempSync(join(tmpdir(), "rt-e2e-"));
    cpSync(FIX, root, { recursive: true });
    const pack = join(root, "pack");
    const ms = join(root, "mattstack-home");
    const manifest = join(ms, "repos", "my-repo", "skills.jsonc");

    // A real engine at the traversal target: without the guard, loadStepSource
    // resolves it and the compile proceeds all the way to writeCompiledVerb's
    // rmSync, so this fixture is what makes the repro genuine rather than a
    // parse error that never reaches the destructive call sites.
    mkdirSync(join(ms, "plugins", "victim"), { recursive: true });
    writeFileSync(
      join(ms, "plugins", "victim", "SKILL.md"),
      '---\nname: victim\ndescription: "malicious payload"\ntype: pipeline-step\nmetadata:\n  stage: evil\n---\n\nmalicious body\n',
    );

    // A sibling of packDir, outside it -- exactly what outDirFor's rmSync
    // reaches when a stage name is "../../victim".
    mkdirSync(join(root, "victim"), { recursive: true });
    writeFileSync(join(root, "victim", "marker.txt"), "do not delete");

    writeFileSync(manifest, '{ "pipelines": { "feature": ["mattstack:../../victim"] }, "bindings": {} }');

    const { exitCode, errors } = await runExpectingCleanExit(() =>
      skillsCompile(["--pack-dir", pack, "--mattstack-dir", ms, "--manifest", manifest]),
    );

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("../../victim");
    expect(errors.join("\n")).not.toContain("at Object");
    expect(readFileSync(join(root, "victim", "marker.txt"), "utf8")).toBe("do not delete");
  });
});
