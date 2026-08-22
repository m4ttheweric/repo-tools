import { describe, expect, test } from "bun:test";
import { compileSkill } from "../compile.ts";
import type { AttachmentSource, CompiledFile, StepSource, VerbDef } from "../types.ts";

const verb: VerbDef = {
  name: "watch-ci",
  engine: "watch-ci-engine",
  description: "Watch CI until it goes green",
};

const step: StepSource = {
  name: "watch-ci",
  plugin: "mattstack",
  version: "1.2.0",
  dir: "/plugins/mattstack/skills/pipeline/watch-ci",
  body: "Poll the pipeline every 30s and report status. See ${CLAUDE_SKILL_DIR}/scripts/ci-watch.sh for the poller.",
  slots: {
    domain: { contract: "watch-ci-domain@1", required: true },
    forge: { contract: "ci-forge@1", required: true },
  },
  allowedTools: ["Bash(gh:*)", "Read"],
  stepFiles: ["references/polling-notes.md", "scripts/ci-watch.sh"],
};

const domainFill: AttachmentSource = {
  binding: "acme:watch-ci-domain",
  plugin: "acme",
  version: "0.3.0",
  dir: "/plugins/acme/attachments/watch-ci-domain",
  body: "Domain rules live at ${CLAUDE_SKILL_DIR}/ci-config.json for details.",
  provides: "watch-ci-domain@1",
  allowedTools: ["Read(${CLAUDE_SKILL_DIR}/ci-config.json)"],
  extraFiles: ["ci-config.json"],
  registered: false,
};

const forgeFill: AttachmentSource = {
  binding: "mattstack:gitlab-forge",
  plugin: "mattstack",
  version: "1.2.0",
  dir: "/plugins/mattstack/skills/gitlab-forge",
  body: "Talk to GitLab via glab.",
  provides: "ci-forge@1",
  allowedTools: ["Bash(glab:*)", "Read"],
  extraFiles: [],
  registered: false,
};

const registeredForgeFill: AttachmentSource = {
  binding: "mattstack:gitlab-forge",
  plugin: "mattstack",
  version: "1.2.0",
  dir: "/plugins/mattstack/skills/gitlab-forge",
  body: "Talk to GitLab via glab.",
  provides: "ci-forge@1",
  allowedTools: ["Bash(glab:*)", "Read(${CLAUDE_SKILL_DIR}/token.txt)"],
  extraFiles: ["token.txt"],
  registered: true,
};

const roster = new Set(["mattstack:watch-ci", "acme:watch-ci-domain", "mattstack:gitlab-forge"]);

function skillFileContent(files: CompiledFile[]): string {
  const skillFile = files[0];
  if (!skillFile || !("content" in skillFile)) {
    throw new Error("expected files[0] to be a content file");
  }
  return skillFile.content;
}

function toolLinesBetween(content: string): string[] {
  const match = content.match(/allowed-tools:\n([\s\S]*?)\nmetadata:/);
  if (!match) {
    throw new Error("allowed-tools block not found");
  }
  return (match[1] as string).split("\n").map((line) => line.trim());
}

describe("compileSkill", () => {
  test("both slots bound: frontmatter, allowed-tools union, seams, body rewrite", () => {
    const result = compileSkill(verb, step, { domain: domainFill, forge: forgeFill }, roster);

    expect(result.warnings).toEqual([]);

    const skillFile = result.files[0];
    expect(skillFile?.path).toBe("SKILL.md");
    const content = skillFileContent(result.files);

    expect(content).toContain('name: "watch-ci"');
    expect(content).toContain('description: "Watch CI until it goes green"');
    expect(content).toContain(
      'metadata:\n  compiled: "mattstack@1.2.0 + acme:watch-ci-domain@0.3.0 + mattstack:gitlab-forge@1.2.0"',
    );

    expect(toolLinesBetween(content)).toEqual([
      '- "Bash(gh:*)"',
      '- "Read"',
      '- "Read(${CLAUDE_SKILL_DIR}/parts/domain/ci-config.json)"',
      '- "Bash(glab:*)"',
    ]);

    expect(content).toContain(
      "<!-- compiled by rt skills compile from the sources below; slots pre-resolved; edits here are working-tree drift (rt skills promote) -->",
    );
    expect(content).toContain("<!-- part: step source=mattstack:watch-ci version=1.2.0 -->");
    expect(content).toContain(
      "<!-- part: slot:domain binding=acme:watch-ci-domain version=0.3.0 -->",
    );
    expect(content).toContain(
      "<!-- part: slot:forge binding=mattstack:gitlab-forge version=1.2.0 -->",
    );

    expect(content).toContain(
      "Domain rules live at ${CLAUDE_SKILL_DIR}/parts/domain/ci-config.json for details.",
    );
    expect(content).toContain(
      "Poll the pipeline every 30s and report status. See ${CLAUDE_SKILL_DIR}/scripts/ci-watch.sh for the poller.",
    );
  });

  test("optional slot unbound: no seam, no part, no warning", () => {
    const stepWithOptional: StepSource = {
      ...step,
      slots: {
        ...step.slots,
        notify: { contract: "notify@1", required: false },
      },
    };

    const result = compileSkill(
      verb,
      stepWithOptional,
      { domain: domainFill, forge: forgeFill, notify: null },
      roster,
    );

    expect(result.warnings).toEqual([]);
    const content = skillFileContent(result.files);
    expect(content).not.toContain("slot:notify");
    expect(result.files.some((f) => f.path.startsWith("parts/notify/"))).toBe(false);
  });

  test("required slot unbound throws naming verb, slot, contract", () => {
    let error: Error | undefined;
    try {
      compileSkill(verb, step, { domain: null, forge: forgeFill }, roster);
    } catch (e) {
      error = e as Error;
    }
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain("watch-ci");
    expect(error?.message).toContain("domain");
    expect(error?.message).toContain("watch-ci-domain@1");
  });

  test("provides mismatch throws naming expected vs actual", () => {
    const badDomainFill: AttachmentSource = { ...domainFill, provides: "watch-ci-domain@2" };

    let error: Error | undefined;
    try {
      compileSkill(verb, step, { domain: badDomainFill, forge: forgeFill }, roster);
    } catch (e) {
      error = e as Error;
    }
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain("watch-ci");
    expect(error?.message).toContain("domain");
    expect(error?.message).toContain("watch-ci-domain@1");
    expect(error?.message).toContain("watch-ci-domain@2");
    expect(error?.message).toContain("acme:watch-ci-domain");
  });

  test("vendoring: stepFiles and extraFiles map to exact copyFrom paths", () => {
    const result = compileSkill(verb, step, { domain: domainFill, forge: forgeFill }, roster);

    expect(result.files).toContainEqual({
      path: "scripts/ci-watch.sh",
      copyFrom: "/plugins/mattstack/skills/pipeline/watch-ci/scripts/ci-watch.sh",
    });
    expect(result.files).toContainEqual({
      path: "references/polling-notes.md",
      copyFrom: "/plugins/mattstack/skills/pipeline/watch-ci/references/polling-notes.md",
    });
    expect(result.files).toContainEqual({
      path: "parts/domain/ci-config.json",
      copyFrom: "/plugins/acme/attachments/watch-ci-domain/ci-config.json",
    });
    expect(result.files.some((f) => f.path.startsWith("parts/forge/"))).toBe(false);
  });

  test("registered fill: reference line only, no seam/body, but still vendors extraFiles and joins allowed-tools", () => {
    const result = compileSkill(
      verb,
      step,
      { domain: domainFill, forge: registeredForgeFill },
      roster,
    );

    expect(result.warnings).toEqual([]);

    const content = skillFileContent(result.files);

    expect(content).toContain(
      "Slot forge is bound to `mattstack:gitlab-forge` (mattstack:gitlab-forge@1.2.0) -- invoke that skill when this flow needs it.",
    );
    expect(content).not.toContain("<!-- part: slot:forge");
    expect(content).not.toContain("Talk to GitLab via glab.");

    expect(result.files).toContainEqual({
      path: "parts/forge/token.txt",
      copyFrom: "/plugins/mattstack/skills/gitlab-forge/token.txt",
    });

    expect(toolLinesBetween(content)).toEqual([
      '- "Bash(gh:*)"',
      '- "Read"',
      '- "Read(${CLAUDE_SKILL_DIR}/parts/domain/ci-config.json)"',
      '- "Bash(glab:*)"',
      '- "Read(${CLAUDE_SKILL_DIR}/parts/forge/token.txt)"',
    ]);

    expect(content).toContain(
      'metadata:\n  compiled: "mattstack@1.2.0 + acme:watch-ci-domain@0.3.0 + mattstack:gitlab-forge@1.2.0"',
    );
  });

  test("name lint: unregistered token warns, roster member does not", () => {
    const lintStep: StepSource = {
      name: "watch-ci",
      plugin: "mattstack",
      version: "1.0.0",
      dir: "/plugins/mattstack/skills/pipeline/watch-ci",
      body: "This step defers domain judgment to acme:watch-ci-domain and never invokes acme:nonexistent.",
      slots: {},
      allowedTools: [],
      stepFiles: [],
    };
    const lintRoster = new Set(["mattstack:watch-ci", "acme:watch-ci-domain"]);

    const result = compileSkill(verb, lintStep, {}, lintRoster);

    expect(result.warnings).toEqual([
      "body references acme:nonexistent which is not invocable",
    ]);
  });

  test("name lint: a bound fill's own seam comment does not warn even when its binding is unregistered", () => {
    const rosterWithoutDomain = new Set(["mattstack:watch-ci", "mattstack:gitlab-forge"]);

    const result = compileSkill(verb, step, { domain: domainFill, forge: forgeFill }, rosterWithoutDomain);

    expect(result.warnings).toEqual([]);
  });

  test("name lint: the same binding name in author body prose still warns", () => {
    const rosterWithoutDomain = new Set(["mattstack:watch-ci", "mattstack:gitlab-forge"]);
    const stepMentioningBinding: StepSource = {
      ...step,
      body: `${step.body} This step composes with acme:watch-ci-domain for domain rules.`,
    };

    const result = compileSkill(
      verb,
      stepMentioningBinding,
      { domain: domainFill, forge: forgeFill },
      rosterWithoutDomain,
    );

    expect(result.warnings).toEqual([
      "body references acme:watch-ci-domain which is not invocable",
    ]);
  });

  test("path lint: vendored file reference is clean, missing file reference warns", () => {
    const stepWithMissingRef: StepSource = {
      ...step,
      body: `${step.body} Also see \${CLAUDE_SKILL_DIR}/parts/domain/missing.json for details.`,
    };

    const result = compileSkill(
      verb,
      stepWithMissingRef,
      { domain: domainFill, forge: forgeFill },
      roster,
    );

    expect(result.warnings).toEqual([
      "body references ${CLAUDE_SKILL_DIR}/parts/domain/missing.json which is not an emitted file",
    ]);
  });

  test("empty allowed-tools union omits the key entirely", () => {
    const bareStep: StepSource = {
      name: "self-review",
      plugin: "mattstack",
      version: "1.2.0",
      dir: "/plugins/mattstack/skills/review/self-review",
      body: "Review your own diff before shipping.",
      slots: {},
      allowedTools: [],
      stepFiles: [],
    };
    const bareVerb: VerbDef = {
      name: "self-review",
      engine: "self-review",
      description: "Review your own change",
    };

    const result = compileSkill(bareVerb, bareStep, {}, roster);

    expect(result.warnings).toEqual([]);
    const content = skillFileContent(result.files);
    expect(content).not.toContain("allowed-tools");
    expect(content).toContain('description: "Review your own change"\nmetadata:');
  });

  test("determinism: structurally equal inputs produce identical content", () => {
    const verbCopy: VerbDef = JSON.parse(JSON.stringify(verb));
    const stepCopy: StepSource = JSON.parse(JSON.stringify(step));
    const domainFillCopy: AttachmentSource = JSON.parse(JSON.stringify(domainFill));
    const forgeFillCopy: AttachmentSource = JSON.parse(JSON.stringify(forgeFill));
    const rosterCopy = new Set(roster);

    const resultA = compileSkill(verb, step, { domain: domainFill, forge: forgeFill }, roster);
    const resultB = compileSkill(
      verbCopy,
      stepCopy,
      { domain: domainFillCopy, forge: forgeFillCopy },
      rosterCopy,
    );

    expect(skillFileContent(resultB.files)).toBe(skillFileContent(resultA.files));
    expect(resultB.files).toEqual(resultA.files);
    expect(resultB.warnings).toEqual(resultA.warnings);
  });
});
