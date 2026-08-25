import { describe, expect, test } from "bun:test";
import { assertNoPlaceholders, findPlaceholders, substitute } from "../placeholders.ts";
import type { AttachmentSource, PlaceholderContext } from "../types.ts";

describe("findPlaceholders", () => {
  test("finds kind, arg, and 1-indexed line", () => {
    const body = "intro\n{{slot:tiering}}\nmid {{work-type}} tail\n{{include:review-core-body}}";
    expect(findPlaceholders(body)).toEqual([
      { kind: "slot", arg: "tiering", line: 2, raw: "{{slot:tiering}}" },
      { kind: "work-type", arg: null, line: 3, raw: "{{work-type}}" },
      { kind: "include", arg: "review-core-body", line: 4, raw: "{{include:review-core-body}}" },
    ]);
  });

  test("ignores braces that are not placeholders", () => {
    expect(findPlaceholders("json {\"a\":1} and {single}")).toEqual([]);
  });
});

describe("assertNoPlaceholders", () => {
  test("passes a clean body", () => {
    expect(() => assertNoPlaceholders("no braces here", "work")).not.toThrow();
  });

  test("names placeholder, engine, and line", () => {
    expect(() => assertNoPlaceholders("a\nb {{stage.dir}} c", "stage-plan")).toThrow(
      "stage-plan: unfilled placeholder {{stage.dir}} at line 2",
    );
  });
});

const fill: AttachmentSource = {
  binding: "acme:plan-policy", plugin: "acme", version: "0.4.0",
  dir: "/p/acme/attachments/plan-policy", srcPath: "attachments/plan-policy/SKILL.md",
  bodyStartLine: 11, body: "line one\nline two\nline three",
  provides: "plan-domain@1", allowedTools: [], extraFiles: [], registered: false,
};
const inc: AttachmentSource = { ...fill, binding: "mattstack:review-core-body", plugin: "mattstack",
  version: "1.0.0", srcPath: "attachments/review-core-body/SKILL.md", bodyStartLine: 6, body: "core A\ncore B", provides: "" };

function ctx(over: Partial<PlaceholderContext> = {}): PlaceholderContext {
  return {
    fills: { domain: fill }, slotMode: { domain: "inline" }, partsPrefix: "${CLAUDE_SKILL_DIR}/parts",
    includes: { "review-core-body": inc },
    pipelines: { feature: [
      { name: "stage-provision", stage: "provision", dir: "${CLAUDE_SKILL_DIR}/../../attachments/stage-provision", consumes: ["ticket", "repo"], produces: ["branch", "worktree"] },
      { name: "stage-plan", stage: "plan", dir: "${CLAUDE_SKILL_DIR}/../../attachments/stage-plan", consumes: ["ticket"], produces: ["approach"] },
    ] },
    repoKey: "my-repo", mattstackSha: "abc1234", mattstackDirty: 0, packSha: "acme=abc1234",
    stageDir: null, stageMeta: null, compiledFrom: "mattstack@1.0.0 + acme:plan-policy@0.4.0",
    ...over,
  };
}

describe("substitute", () => {
  test("slot inlines in place with a source-coordinate marker", () => {
    const { body } = substitute("before\n{{slot:domain}}\nafter", ctx(), "stage-plan");
    expect(body).toBe([
      "before",
      "<!-- part: slot:domain binding=acme:plan-policy version=0.4.0 path=attachments/plan-policy/SKILL.md lines=11-13 -->",
      "line one\nline two\nline three",
      "after",
    ].join("\n"));
  });

  test("unbound optional slot substitutes empty", () => {
    const { body } = substitute("a\n{{slot:domain}}\nb", ctx({ fills: { domain: null } }), "x");
    expect(body).toBe("a\n\nb");
  });

  test("a fill's own file references are rewritten under parts/<slot>", () => {
    const withFile = { ...fill, body: "see ${CLAUDE_SKILL_DIR}/ci-config.json", extraFiles: ["ci-config.json"] };
    expect(substitute("{{slot:domain}}", ctx({ fills: { domain: withFile } }), "x").body)
      .toContain("see ${CLAUDE_SKILL_DIR}/parts/domain/ci-config.json");
    const inStage = ctx({ fills: { domain: withFile }, partsPrefix: "${CLAUDE_SKILL_DIR}/../../attachments/stage-plan/parts" });
    expect(substitute("{{slot:domain}}", inStage, "stage-plan").body)
      .toContain("see ${CLAUDE_SKILL_DIR}/../../attachments/stage-plan/parts/domain/ci-config.json");
  });

  test("a fill that vendors no files keeps the host skill's own directory", () => {
    const noFiles = { ...fill, body: "see ${CLAUDE_SKILL_DIR}/notes.md", extraFiles: [] };
    expect(substitute("{{slot:domain}}", ctx({ fills: { domain: noFiles } }), "x").body)
      .toContain("see ${CLAUDE_SKILL_DIR}/notes.md");
    const inStage = ctx({
      fills: { domain: noFiles },
      stageDir: "${CLAUDE_SKILL_DIR}/../../attachments/stage-plan",
      partsPrefix: "${CLAUDE_SKILL_DIR}/../../attachments/stage-plan/parts",
    });
    expect(substitute("{{slot:domain}}", inStage, "stage-plan").body)
      .toContain("see ${CLAUDE_SKILL_DIR}/../../attachments/stage-plan/notes.md");
  });

  test("an include that vendors no files keeps the host skill's own directory", () => {
    const noFiles = { ...inc, body: "shape at ${CLAUDE_SKILL_DIR}/references/adjudicator.md", extraFiles: [] };
    const { body } = substitute("{{include:review-core-body}}", ctx({ includes: { "review-core-body": noFiles } }), "x");
    expect(body).toContain("shape at ${CLAUDE_SKILL_DIR}/references/adjudicator.md");
  });

  test("a registered public fill is referenced, not inlined", () => {
    const pub = { ...fill, registered: true };
    const { body } = substitute("{{slot:domain}}", ctx({ fills: { domain: pub }, slotMode: { domain: "reference" } }), "x");
    expect(body).toBe("Slot domain is bound to `acme:plan-policy` (acme:plan-policy@0.4.0) -- invoke that skill when this flow needs it.");
    expect(body).not.toContain("part: slot:");
  });

  test("an include's own file references are rewritten under parts/include-<name>", () => {
    const withRef = { ...inc, body: "shape at ${CLAUDE_SKILL_DIR}/references/adjudicator.md", extraFiles: ["references/adjudicator.md"] };
    const { body } = substitute("{{include:review-core-body}}", ctx({ includes: { "review-core-body": withRef } }), "x");
    expect(body).toContain("shape at ${CLAUDE_SKILL_DIR}/parts/include-review-core-body/references/adjudicator.md");
  });

  test("include inlines with an include marker using source=", () => {
    const { body } = substitute("{{include:review-core-body}}", ctx(), "review");
    expect(body).toBe(
      "<!-- part: include:review-core-body source=mattstack:review-core-body version=1.0.0 path=attachments/review-core-body/SKILL.md lines=6-7 -->\ncore A\ncore B",
    );
  });

  test("include target that is not loaded is an error", () => {
    expect(() => substitute("{{include:nope}}", ctx(), "review")).toThrow('review: include "nope" is not a loaded attachment');
  });

  test("work-type: single type states it; several give a menu", () => {
    expect(substitute("{{work-type}}", ctx(), "work").body).toBe("The work type is `feature`. Continue.");
    const two = ctx({ pipelines: { ...ctx().pipelines, bugfix: [] } });
    const body = substitute("{{work-type}}", two, "work").body;
    expect(body).toContain("- `feature`");
    expect(body).toContain("- `bugfix`");
    expect(body).toContain("Ask one structured question");
  });

  test("work-type with no pipelines is an error", () => {
    const none = ctx({ pipelines: {} });
    expect(() => substitute("{{work-type}}", none, "work")).toThrow(
      "work: {{work-type}} cannot be filled -- the manifest declares no pipelines",
    );
  });

  test("pipeline.stages emits a fenced JSON block keyed by work type", () => {
    const body = substitute("{{pipeline.stages}}", ctx(), "work").body;
    const json = JSON.parse(body.replace(/^```json\n/, "").replace(/\n```$/, ""));
    expect(json.feature[1]).toEqual({
      name: "stage-plan", stage: "plan", dir: "${CLAUDE_SKILL_DIR}/../../attachments/stage-plan",
      consumes: ["ticket"], produces: ["approach"],
    });
  });

  test("run-start.flags is keyed by work type and carries the baked mattstack and pack facts", () => {
    const body = substitute("{{run-start.flags}}", ctx(), "work").body;
    const json = JSON.parse(body.replace(/^```json\n/, "").replace(/\n```$/, ""));
    expect(json.feature).toBe("--repo my-repo --work-type feature --pipeline feature --mattstack-sha abc1234 --mattstack-dirty 0 --pack-sha acme=abc1234");
  });

  test("run-start.flags omits --mattstack-sha when no sha is known", () => {
    const body = substitute("{{run-start.flags}}", ctx({ mattstackSha: "" }), "work").body;
    const json = JSON.parse(body.replace(/^```json\n/, "").replace(/\n```$/, ""));
    expect(json.feature).toBe("--repo my-repo --work-type feature --pipeline feature --mattstack-dirty 0 --pack-sha acme=abc1234");
  });

  test("run-start.flags omits --pack-sha when no pack sha is known", () => {
    const body = substitute("{{run-start.flags}}", ctx({ packSha: "" }), "work").body;
    const json = JSON.parse(body.replace(/^```json\n/, "").replace(/\n```$/, ""));
    expect(json.feature).toBe("--repo my-repo --work-type feature --pipeline feature --mattstack-sha abc1234 --mattstack-dirty 0");
  });

  test("stage.dir and stage.fields need a stage context", () => {
    const stage = ctx({ stageDir: "${CLAUDE_SKILL_DIR}/../../attachments/stage-plan",
      stageMeta: { stage: "plan", consumes: ["ticket"], produces: ["approach", "evidence-plan"] } });
    expect(substitute("{{stage.dir}}", stage, "stage-plan").body).toBe("${CLAUDE_SKILL_DIR}/../../attachments/stage-plan");
    expect(substitute("{{stage.fields}}", stage, "stage-plan").body)
      .toBe("You consume `ticket`. You must produce `approach`, `evidence-plan`.");
    expect(() => substitute("{{stage.dir}}", ctx(), "work")).toThrow("work: {{stage.dir}} used outside a stage");
  });

  test("compiled-from substitutes the provenance string", () => {
    expect(substitute("{{compiled-from}}", ctx(), "work").body).toBe("mattstack@1.0.0 + acme:plan-policy@0.4.0");
  });

  test("unknown kind is an error", () => {
    expect(() => substitute("{{bogus}}", ctx(), "work")).toThrow("work: unknown placeholder {{bogus}} at line 1");
  });
});
