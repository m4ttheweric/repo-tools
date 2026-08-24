import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
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
  test("work and stages compile with zero resolver references and zero placeholders", async () => {
    const { pack } = await build();
    const work = readFileSync(join(pack, "skills", "work", "SKILL.md"), "utf8");
    const plan = readFileSync(join(pack, "attachments", "stage-plan", "SKILL.md"), "utf8");
    for (const md of [work, plan]) {
      expect(md).not.toContain("resolve-args");
      expect(md).not.toContain("resolve-pipeline");
      expect(md).not.toContain("{{");
    }
    expect(work).toContain("<!-- part: step source=mattstack:work");
    expect(plan).toContain("<!-- part: slot:domain binding=");
    expect(plan).toContain("<!-- part: step source=mattstack:stage-plan");
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
});
