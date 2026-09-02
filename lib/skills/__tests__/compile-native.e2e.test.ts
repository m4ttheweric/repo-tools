import { describe, expect, spyOn, test } from "bun:test";
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
    // build() copies the fixture to a temp dir with no git history, so the baked value is the pack's plugin.json version.
    expect(work).toContain("--pack-sha acme=0.1.0");
    for (const [name, body] of stages) {
      expect(body).toContain(`<!-- part: step source=mattstack:${name}`);
    }

    const plan = stages.find(([name]) => name === "stage-plan")![1];
    // The fill comes from the pack under compilation, at the pack's own version --
    // never from an installed copy of a previous release.
    expect(plan).toContain("<!-- part: slot:domain binding=acme:plan-policy version=0.1.0 path=attachments/plan-policy/SKILL.md");
    expect(plan).toContain("<!-- part: include:gitlab-note");
    expect(plan).toContain("note body");
    expect(existsSync(join(pack, "skills", "work", "scripts", "resolve-pipeline.sh"))).toBe(false);

    // The include's own extra files vendor under the compiling stage's parts
    // dir, and the rewritten body path is what actually resolves there --
    // not just a plausible-looking one.
    expect(existsSync(join(pack, "attachments", "stage-plan", "parts", "include-gitlab-note", "scripts", "note.sh"))).toBe(true);
    expect(plan).toContain(
      "${CLAUDE_SKILL_DIR}/../../attachments/stage-plan/parts/include-gitlab-note/scripts/note.sh",
    );
  });

  test("a surface-public stage is referenced at skills/, where it is emitted", async () => {
    const root = mkdtempSync(join(tmpdir(), "rt-e2e-"));
    cpSync(FIX, root, { recursive: true });
    const pack = join(root, "pack");
    const ms = join(root, "mattstack-home");
    const manifest = join(ms, "repos", "my-repo", "skills.jsonc");
    writeFileSync(join(pack, "pack", "surface.jsonc"), JSON.stringify({ public: ["work", "stage-plan"] }));

    await skillsCompile(["--pack-dir", pack, "--mattstack-dir", ms, "--manifest", manifest]);

    expect(existsSync(join(pack, "skills", "stage-plan", "SKILL.md"))).toBe(true);
    expect(existsSync(join(pack, "attachments", "stage-plan"))).toBe(false);
    const work = readFileSync(join(pack, "skills", "work", "SKILL.md"), "utf8");
    expect(work).toContain("${CLAUDE_SKILL_DIR}/../../skills/stage-plan");
    expect(work).not.toContain("attachments/stage-plan");
    expect(work).toContain("${CLAUDE_SKILL_DIR}/../../attachments/stage-implement");
  });

  test("rt skills check is clean immediately after compile", async () => {
    const { pack, ms, manifest } = await build();
    process.exitCode = 0;
    await skillsCheck(["--pack-dir", pack, "--mattstack-dir", ms, "--manifest", manifest]);
    expect(process.exitCode).toBe(0);
  });

  test("check --json: an edited include body reports staleBecause include on the stage that pulls it in", async () => {
    const { pack, ms, manifest } = await build();
    const notePath = join(ms, "plugins", "mattstack", "attachments", "gitlab-note", "SKILL.md");
    writeFileSync(notePath, readFileSync(notePath, "utf8").replace("note body", "note body v2"));

    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    try {
      await skillsCheck(["--pack-dir", pack, "--mattstack-dir", ms, "--manifest", manifest, "--json"]);
    } finally {
      logSpy.mockRestore();
    }

    const parsed = JSON.parse(logs.join("\n"));
    const stagePlan = parsed.verbs.find((v: { name: string }) => v.name === "stage-plan");
    expect(stagePlan.status).toBe("stale");
    expect(stagePlan.staleBecause).toEqual(["include"]);
  });

  test("check --json: dropping a fill's {{include}} line reports staleBecause structure", async () => {
    const { pack, ms, manifest } = await build();
    const policyPath = join(pack, "attachments", "plan-policy", "SKILL.md");
    writeFileSync(policyPath, readFileSync(policyPath, "utf8").replace("\n{{include:gitlab-note}}\n", "\n"));

    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    try {
      await skillsCheck(["--pack-dir", pack, "--mattstack-dir", ms, "--manifest", manifest, "--json"]);
    } finally {
      logSpy.mockRestore();
    }

    const parsed = JSON.parse(logs.join("\n"));
    const stagePlan = parsed.verbs.find((v: { name: string }) => v.name === "stage-plan");
    expect(stagePlan.status).toBe("stale");
    expect(stagePlan.staleBecause).toEqual(["structure"]);
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

  test("a fill carrying an illegal placeholder errors with the compiling stage named", async () => {
    const root = mkdtempSync(join(tmpdir(), "rt-e2e-"));
    cpSync(FIX, root, { recursive: true });
    const pack = join(root, "pack");
    const ms = join(root, "mattstack-home");
    const manifest = join(ms, "repos", "my-repo", "skills.jsonc");
    const policyPath = join(pack, "attachments", "plan-policy", "SKILL.md");
    writeFileSync(policyPath, readFileSync(policyPath, "utf8").replace("policy text", "policy text\n{{slot:tiering}}"));

    const { exitCode, errors } = await runExpectingCleanExit(() =>
      skillsCompile(["--pack-dir", pack, "--mattstack-dir", ms, "--manifest", manifest]),
    );
    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain(
      'stage "stage-plan": acme:plan-policy: {{slot:tiering}} -- a fill may carry {{include}}, {{verb.path}} or {{pack.path}} only',
    );
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

const RECEIVE_REVIEW_ENGINE = `---
name: receive-review
description: "receive-review"
type: pipeline-step
---

Read the note, then act on it.

{{include:gitlab-note}}
`;

const CHECKOUT_ENGINE = `---
name: checkout
description: "checkout"
type: pipeline-step
---

Read {{verb.path:receive-review}} first, then {{verb.path:work}}.
`;

/** The fixture plus a public `checkout` verb and an internal `receive-review` verb whose engine vendors an include. */
function buildWithRosterVerbs(): { pack: string; ms: string; manifest: string } {
  const root = mkdtempSync(join(tmpdir(), "rt-e2e-"));
  cpSync(FIX, root, { recursive: true });
  const pack = join(root, "pack");
  const ms = join(root, "mattstack-home");
  const manifest = join(ms, "repos", "my-repo", "skills.jsonc");
  writeFileSync(join(pack, "pack", "stubs.jsonc"), JSON.stringify({
    verbs: {
      work: { engine: "work", description: "Run a unit of work" },
      checkout: { engine: "checkout", description: "Check out the branch" },
      "receive-review": { engine: "receive-review", description: "Act on review feedback" },
    },
  }));
  writeFileSync(join(pack, "pack", "surface.jsonc"), JSON.stringify({ public: ["work", "checkout"] }));
  for (const [name, source] of [["receive-review", RECEIVE_REVIEW_ENGINE], ["checkout", CHECKOUT_ENGINE]] as const) {
    mkdirSync(join(ms, "plugins", "mattstack", "attachments", name), { recursive: true });
    writeFileSync(join(ms, "plugins", "mattstack", "attachments", name, "SKILL.md"), source);
  }
  return { pack, ms, manifest };
}

type CompileRun = { logs: string[]; errors: string[]; exitCode: number | undefined };

/** A failing compile prints through console.error and calls process.exit(1); runExpectingCleanExit turns that into a test failure instead of ending the bun process. */
async function compileCapturingLogs(pack: string, ms: string, manifest: string, extra: string[] = []): Promise<CompileRun> {
  const logs: string[] = [];
  const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  try {
    const { exitCode, errors } = await runExpectingCleanExit(() =>
      skillsCompile(["--pack-dir", pack, "--mattstack-dir", ms, "--manifest", manifest, ...extra]),
    );
    return { logs, errors, exitCode };
  } finally {
    logSpy.mockRestore();
  }
}

describe("internal roster verbs", () => {
  test("an internal verb's vendored include is addressed from its attachments-side host dir and lints clean", async () => {
    const { pack, ms, manifest } = buildWithRosterVerbs();
    const { logs, errors, exitCode } = await compileCapturingLogs(pack, ms, manifest);
    expect(errors).toEqual([]);
    expect(exitCode).toBeUndefined();

    const md = readFileSync(join(pack, "attachments", "receive-review", "SKILL.md"), "utf8");
    expect(md).toContain("${CLAUDE_SKILL_DIR}/../../attachments/receive-review/parts/include-gitlab-note/scripts/note.sh");
    expect(md).not.toContain("${CLAUDE_SKILL_DIR}/parts/");
    expect(existsSync(join(pack, "attachments", "receive-review", "parts", "include-gitlab-note", "scripts", "note.sh"))).toBe(true);
    expect(logs.find((l) => l.startsWith("compiled receive-review"))).toMatch(/0 warnings\)$/);
  });
});

describe("verb.path end to end", () => {
  test("a whole-pack compile renders sibling paths on both sides and lints clean", async () => {
    const { pack, ms, manifest } = buildWithRosterVerbs();
    const { logs, errors, exitCode } = await compileCapturingLogs(pack, ms, manifest);
    expect(errors).toEqual([]);
    expect(exitCode).toBeUndefined();

    const md = readFileSync(join(pack, "skills", "checkout", "SKILL.md"), "utf8");
    expect(md).toContain("Read ../../attachments/receive-review/SKILL.md first, then ../work/SKILL.md.");
    expect(logs.find((l) => l.startsWith("compiled checkout"))).toMatch(/0 warnings\)$/);
  });

  test("a --verb compile still renders a path to a sibling it is not emitting", async () => {
    const { pack, ms, manifest } = buildWithRosterVerbs();
    const { errors, exitCode } = await compileCapturingLogs(pack, ms, manifest, ["--verb", "checkout"]);
    expect(errors).toEqual([]);
    expect(exitCode).toBeUndefined();

    const md = readFileSync(join(pack, "skills", "checkout", "SKILL.md"), "utf8");
    expect(md).toContain("../../attachments/receive-review/SKILL.md");
    expect(md).toContain("../work/SKILL.md");
    expect(existsSync(join(pack, "attachments", "receive-review"))).toBe(false);
  });
});
