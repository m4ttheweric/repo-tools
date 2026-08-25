import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { compileSkill } from "../compile.ts";
import type { AttachmentSource, CompiledFile, StepSource, VerbDef } from "../types.ts";

/** The sibling-reference lint reads the working tree, so its cases need a real pack root on disk. */
function tempPackRoot(): string {
  return mkdtempSync(join(tmpdir(), "rt-compile-pack-"));
}

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
  srcPath: "skills/pipeline/watch-ci/SKILL.md",
  bodyStartLine: 8,
  body: "Poll the pipeline every 30s and report status. See ${CLAUDE_SKILL_DIR}/scripts/ci-watch.sh for the poller.",
  slots: {
    domain: { contract: "watch-ci-domain@1", required: true },
    forge: { contract: "ci-forge@1", required: true },
  },
  allowedTools: ["Bash(gh:*)", "Read"],
  stepFiles: ["references/polling-notes.md", "scripts/ci-watch.sh"],
  stageMeta: null,
  description: "",
};

const domainFill: AttachmentSource = {
  binding: "acme:watch-ci-domain",
  plugin: "acme",
  version: "0.3.0",
  dir: "/plugins/acme/attachments/watch-ci-domain",
  srcPath: "attachments/watch-ci-domain/SKILL.md",
  bodyStartLine: 8,
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
  srcPath: "skills/gitlab-forge/SKILL.md",
  bodyStartLine: 8,
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
  srcPath: "skills/gitlab-forge/SKILL.md",
  bodyStartLine: 8,
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
    expect(content).toContain(
      "<!-- part: step source=mattstack:watch-ci version=1.2.0 path=skills/pipeline/watch-ci/SKILL.md lines=8-8 -->",
    );
    expect(content).toContain(
      "<!-- part: slot:domain binding=acme:watch-ci-domain version=0.3.0 path=attachments/watch-ci-domain/SKILL.md lines=8-8 -->",
    );
    expect(content).toContain(
      "<!-- part: slot:forge binding=mattstack:gitlab-forge version=1.2.0 path=skills/gitlab-forge/SKILL.md lines=8-8 -->",
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
      stageMeta: step.stageMeta,
      description: step.description,
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
      srcPath: "skills/pipeline/watch-ci/SKILL.md",
      bodyStartLine: 8,
      body: "This step defers domain judgment to acme:watch-ci-domain and never invokes acme:nonexistent.",
      slots: {},
      allowedTools: [],
      stepFiles: [],
      stageMeta: null,
      description: "",
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
      stageMeta: step.stageMeta,
      description: step.description,
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
      stageMeta: step.stageMeta,
      description: step.description,
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
      srcPath: "skills/review/self-review/SKILL.md",
      bodyStartLine: 8,
      body: "Review your own diff before shipping.",
      slots: {},
      allowedTools: [],
      stepFiles: [],
      stageMeta: null,
      description: "",
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

  test("seams carry the source path and line span", () => {
    const result = compileSkill(verb, step, { domain: domainFill, forge: forgeFill }, new Set<string>());
    const main = result.files.find((f) => f.path.endsWith("SKILL.md"))!;
    const content = (main as { content: string }).content;
    expect(content).toMatch(/<!-- part: step source=mattstack:watch-ci version=1\.2\.0 path=\S+ lines=\d+-\d+ -->/);
    expect(content).toMatch(/<!-- part: slot:domain binding=acme:watch-ci-domain version=0\.3\.0 path=\S+ lines=\d+-\d+ -->/);
    // Relative, never absolute: an absolute path would bake this machine's tmpdir
    // into a committed artifact.
    expect(content).not.toMatch(/path=\//);
  });

  test("compiled output stays byte-deterministic across two compiles", () => {
    const fills = { domain: domainFill, forge: forgeFill };
    const a = compileSkill(verb, step, fills, new Set<string>());
    const b = compileSkill(verb, step, fills, new Set<string>());
    expect(a.files).toEqual(b.files);
  });

  test("an empty-arg placeholder is a compile error, not a silent legacy compile", () => {
    const bad = { ...step, body: "Poll status. {{slot:}}" };
    expect(() => compileSkill(verb, bad, { domain: domainFill, forge: forgeFill }, roster)).toThrow(
      'engine "watch-ci": literal "{{" near line 1 -- "{{" is reserved for compiler placeholders and has no escape, so a compiled body may not contain it',
    );
  });

  test("a placeholder with internal whitespace is a compile error, not a silent legacy compile", () => {
    const bad = { ...step, body: "Poll status. {{ stage.dir }}" };
    expect(() => compileSkill(verb, bad, { domain: domainFill, forge: forgeFill }, roster)).toThrow(
      'engine "watch-ci": literal "{{" near line 1 -- "{{" is reserved for compiler placeholders and has no escape, so a compiled body may not contain it',
    );
  });
});

const placeholderStep: StepSource = {
  ...step,
  name: "stage-watch-ci",
  body: "Run ${CLAUDE_SKILL_DIR}/scripts/ci-watch.sh.\n{{slot:domain}}\n{{stage.fields}}",
  slots: { domain: { contract: "watch-ci-domain@1", required: true } },
  allowedTools: ["Bash(${CLAUDE_SKILL_DIR}/scripts/ci-watch.sh:*)"],
  stageMeta: { stage: "watch-ci", consumes: ["mr", "branch"], produces: ["ci"] },
};

const slotless: StepSource = { ...step, slots: {}, stageMeta: null };

function skillMd(result: { files: CompiledFile[] }): string {
  const f = result.files.find((x) => x.path === "SKILL.md");
  return f && "content" in f ? f.content : "";
}

describe("compileSkill with placeholders", () => {
  test("a fileless fill's tool rule names the same dir its body does", () => {
    const filelessDomain: AttachmentSource = {
      ...domainFill,
      body: "config at ${CLAUDE_SKILL_DIR}/references/polling-notes.md",
      allowedTools: ["Read(${CLAUDE_SKILL_DIR}/references/polling-notes.md)"],
      extraFiles: [],
    };
    const result = compileSkill(verb, placeholderStep, { domain: filelessDomain }, new Set(), {});
    const md = skillMd(result);

    expect(md).toContain('- "Read(${CLAUDE_SKILL_DIR}/references/polling-notes.md)"');
    expect(md).toContain("config at ${CLAUDE_SKILL_DIR}/references/polling-notes.md");
    expect(md).not.toContain("parts/domain");
    expect(result.warnings).toEqual([]);
  });

  test("a fill that vendors files still scopes its tool rules to the parts dir, stage dir and all", () => {
    const md = skillMd(compileSkill(verb, placeholderStep, { domain: domainFill }, new Set(), {
      stageDir: "${CLAUDE_SKILL_DIR}/../../attachments/stage-watch-ci",
    }));
    expect(md).toContain('- "Read(${CLAUDE_SKILL_DIR}/../../attachments/stage-watch-ci/parts/domain/ci-config.json)"');
  });

  test("substitutes in place, emits a slot marker, and appends nothing", () => {
    const md = skillMd(compileSkill(verb, placeholderStep, { domain: domainFill }, new Set(), {
      stageDir: "${CLAUDE_SKILL_DIR}/../../attachments/stage-watch-ci",
    }));
    expect(md).toContain("<!-- part: slot:domain binding=acme:watch-ci-domain version=0.3.0 path=attachments/watch-ci-domain/SKILL.md lines=8-8 -->");
    expect(md).toContain("You consume `mr`, `branch`. You must produce `ci`.");
    expect(md.indexOf("You consume")).toBeGreaterThan(md.indexOf("part: slot:domain"));
    expect(md.split("part: slot:domain").length).toBe(2);
  });

  test("inside a stage, step-owned script references are rewritten to the stage dir", () => {
    const md = skillMd(compileSkill(verb, placeholderStep, { domain: domainFill }, new Set(), {
      stageDir: "${CLAUDE_SKILL_DIR}/../../attachments/stage-watch-ci",
    }));
    expect(md).toContain("Run ${CLAUDE_SKILL_DIR}/../../attachments/stage-watch-ci/scripts/ci-watch.sh.");
  });

  test("a placeholder that cannot be filled is a compile error", () => {
    const bad = { ...placeholderStep, body: "{{slot:domain}}\n{{stage.dir}}" };
    expect(() => compileSkill(verb, bad, { domain: domainFill }, new Set(), {})).toThrow("{{stage.dir}} used outside a stage");
  });

  test("a fill's file references resolve under the stage's parts dir inside a stage", () => {
    const md = skillMd(compileSkill(verb, placeholderStep, { domain: domainFill }, new Set(), {
      stageDir: "${CLAUDE_SKILL_DIR}/../../attachments/stage-watch-ci",
    }));
    expect(md).toContain("${CLAUDE_SKILL_DIR}/../../attachments/stage-watch-ci/parts/domain/ci-config.json");
  });

  test("a bound slot the body never places is warned", () => {
    const orphan = { ...placeholderStep, body: "{{stage.fields}} only" };
    const r = compileSkill(verb, orphan, { domain: domainFill }, new Set(), { stageDir: "x" });
    expect(r.warnings).toContain('slot "domain" is bound but never placed in the body');
  });

  test("a compile-native engine calling the runtime resolver is a compile error", () => {
    const bad = { ...placeholderStep, body: 'run "${CLAUDE_SKILL_DIR}/scripts/resolve-args.sh"\n{{slot:domain}}' };
    expect(() => compileSkill(verb, bad, { domain: domainFill }, new Set(), {}))
      .toThrow("compile-native engine calls the runtime resolver");
  });

  test("a malformed placeholder alongside a valid one is still a compile error", () => {
    const bad = { ...placeholderStep, body: "{{stage.fields}}\n{{slot:}}" };
    expect(() => compileSkill(verb, bad, { domain: domainFill }, new Set(), { stageDir: "x" })).toThrow(
      /engine "stage-watch-ci": literal "\{\{" near line \d+ -- "\{\{" is reserved for compiler placeholders and has no escape, so a compiled body may not contain it/,
    );
  });

  test("an inline (not line-leading) slot placeholder is a compile error", () => {
    const bad = { ...placeholderStep, body: "Prefix {{slot:domain}}" };
    expect(() => compileSkill(verb, bad, { domain: domainFill }, new Set(), { stageDir: "x" })).toThrow(
      "must be alone on its line",
    );
  });

  test("a slot placeholder alone on its line, surrounded by whitespace, is fine", () => {
    const ok = { ...placeholderStep, body: "  {{slot:domain}}  \n{{stage.fields}}" };
    expect(() => compileSkill(verb, ok, { domain: domainFill }, new Set(), { stageDir: "x" })).not.toThrow();
  });

  test("an inline include placeholder is a compile error", () => {
    const bad = {
      ...slotless,
      body: "See {{include:review-core-body}} for details.",
    };
    expect(() =>
      compileSkill(verb, bad, {}, new Set(), {
        includes: {
          "review-core-body": { ...domainFill, binding: "mattstack:review-core-body", provides: "" },
        },
      }),
    ).toThrow("must be alone on its line");
  });

  test("stage allowed-tools union rewrites to the leading-wildcard form", () => {
    const md = skillMd(compileSkill(verb, { ...slotless, body: "{{pipeline.stages}}" }, {}, new Set(), {
      pipelines: { feature: [] },
      stageAllowedTools: ["Bash(${CLAUDE_SKILL_DIR}/scripts/ci-watch.sh:*)", "Bash(*/scripts/ci-forge.sh:*)", "Bash(gh:*)"],
    }));
    expect(md).toContain('  - "Bash(*/scripts/ci-watch.sh:*)"');
    expect(md).toContain('  - "Bash(*/scripts/ci-forge.sh:*)"');
    expect((md.match(/Bash\(gh:\*\)/g) ?? []).length).toBe(1);
  });

  test("emitted sibling dirs are not lint-warned as missing files", () => {
    const r = compileSkill(verb, { ...slotless, body: "read ${CLAUDE_SKILL_DIR}/../../attachments/stage-plan/SKILL.md" }, {}, new Set(), {
      emittedSiblingDirs: ["${CLAUDE_SKILL_DIR}/../../attachments/stage-plan"],
    });
    expect(r.warnings.filter((w) => w.includes("not an emitted file"))).toEqual([]);
  });

  test("a relative read escaping the pack root is a compile error naming verb, path and line", () => {
    const bad = { ...slotless, body: "first line\nread `../../../attachments/self-review/SKILL.md` before starting" };
    expect(() =>
      compileSkill(verb, bad, {}, new Set(), {
        packRoot: "/pack",
        compiledDir: "/pack/attachments/stage-plan",
      }),
    // Line 6 of the compiled body: the header comment, the step seam, and the
    // blank line between each precede the step's own first line.
    ).toThrow('verb "watch-ci": "../../../attachments/self-review/SKILL.md" at compiled body line 6 resolves outside the pack root');
  });

  test("an escaping ${CLAUDE_SKILL_DIR} path is the same compile error", () => {
    const bad = { ...slotless, body: "read ${CLAUDE_SKILL_DIR}/../../../secrets.md" };
    expect(() =>
      compileSkill(verb, bad, {}, new Set(), { packRoot: "/pack", compiledDir: "/pack/skills/work" }),
    ).toThrow("resolves outside the pack root");
  });

  test("a relative read that resolves to nothing the pack has warns instead of erroring", () => {
    const packRoot = tempPackRoot();
    const r = compileSkill(verb, { ...slotless, body: "read `../../attachments/self-review/SKILL.md`" }, {}, new Set(), {
      packRoot,
      compiledDir: join(packRoot, "skills", "work"),
    });
    expect(r.warnings).toEqual(["body references ../../attachments/self-review/SKILL.md which is not an emitted file"]);
  });

  test("a relative read onto a file the pack already carries is silent", () => {
    const packRoot = tempPackRoot();
    mkdirSync(join(packRoot, "attachments", "self-review"), { recursive: true });
    writeFileSync(join(packRoot, "attachments", "self-review", "SKILL.md"), "hand-authored\n");

    const r = compileSkill(verb, { ...slotless, body: "read `../../attachments/self-review/SKILL.md`" }, {}, new Set(), {
      packRoot,
      compiledDir: join(packRoot, "skills", "work"),
    });
    expect(r.warnings).toEqual([]);
  });

  test("a relative read onto another target's output dir is silent before that target is written", () => {
    const packRoot = tempPackRoot();
    const r = compileSkill(verb, { ...slotless, body: "read `../../attachments/stage-plan/SKILL.md`" }, {}, new Set(), {
      packRoot,
      compiledDir: join(packRoot, "skills", "work"),
      emittedTargetDirs: [join(packRoot, "attachments", "stage-plan")],
    });
    expect(r.warnings).toEqual([]);
  });

  test("a shell-composed path whose ../ follows another path is not read as a body reference", () => {
    const r = compileSkill(verb, { ...slotless, body: 'FORGE=$(dirname "$STAGE")/../forge/ci-forge.sh' }, {}, new Set(), {
      packRoot: "/pack",
      compiledDir: "/pack/skills/work",
    });
    expect(r.warnings).toEqual([]);
  });

  test("a bare asset path that this target never emits warns", () => {
    const r = compileSkill(verb, { ...slotless, body: "run scripts/missing.sh, then read references/notes.md" }, {}, new Set(), {});
    expect(r.warnings).toEqual([
      "bare path scripts/missing.sh is not an emitted file",
      "bare path references/notes.md is not an emitted file",
    ]);
  });

  test("a bare asset path the engine vendors does not warn, sentence punctuation and all", () => {
    const r = compileSkill(verb, { ...slotless, body: "run scripts/ci-watch.sh, as documented in references/polling-notes.md." }, {}, new Set(), {});
    expect(r.warnings).toEqual([]);
  });

  test("the pack-root token is not lint-warned as a missing file", () => {
    const r = compileSkill(verb, { ...slotless, body: 'PACK_DIRS="$(cd "${CLAUDE_SKILL_DIR}/../.." && pwd -P)"' }, {}, new Set(), {});
    expect(r.warnings).toEqual([]);
  });

  test("a body with no placeholders still appends fills (backward compatible)", () => {
    const md = skillMd(compileSkill(verb, step, { domain: domainFill, forge: forgeFill }, new Set(), {}));
    expect(md).toContain("part: slot:domain");
    expect(md).toContain("part: slot:forge");
  });
});
