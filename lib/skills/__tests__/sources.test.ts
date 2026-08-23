import { describe, test, expect, beforeEach, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildPluginRoots,
  invocableRoster,
  loadAttachment,
  loadStepSource,
  readManifestBindings,
  readVerbRoster,
  stripFrontmatter,
  type PluginRoots,
} from "../sources.ts";

function writeFile(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

const WATCH_CI_SKILL_MD = `---
name: watch-ci
description: "Watch CI until it goes green"
type: pipeline-step
allowed-tools:
  - "Bash(gh:*)"
  - "Read"
slots:
  domain: { contract: "watch-ci-domain@1" }
  forge: { contract: "ci-forge@1", required: true }
---

Poll the pipeline every 30s and report status.
`;

const WATCH_CI_SCRIPT = "#!/bin/sh\necho polling\n";

const WATCH_CI_DOMAIN_SKILL_MD = `---
name: watch-ci-domain
description: "Domain rules for watch-ci"
metadata:
  provides: "watch-ci-domain@1"
allowed-tools:
  - "Read(\${CLAUDE_SKILL_DIR}/ci-config.json)"
---

Domain rules live at \${CLAUDE_SKILL_DIR}/ci-config.json for details.
`;

const CI_CONFIG_JSON = `{ "noisy": ["flaky-job"] }\n`;

/**
 * mattstack root: skills/pipeline/watch-ci/SKILL.md (+ scripts/ci-watch.sh),
 * matching the real plugin's group/engine nesting, plus
 * attachments/pipeline/ship/SKILL.md -- an engine already moved out of
 * skills/ (unregistered) that loadStepSource must still resolve.
 * claimview root: attachments/watch-ci-domain/SKILL.md (+ ci-config.json), the
 * unregistered fill; a registered copy also lives under skills/watch-ci-domain
 * so loadAttachment can be exercised against both search roots.
 */
function makeFixtureRoots(): { rootDir: string; roots: PluginRoots } {
  const rootDir = realpathSync(mkdtempSync(join(tmpdir(), "rt-skills-src-")));

  const mattstackDir = join(rootDir, "mattstack");
  writeFile(join(mattstackDir, "skills", "pipeline", "watch-ci", "SKILL.md"), WATCH_CI_SKILL_MD);
  writeFile(join(mattstackDir, "skills", "pipeline", "watch-ci", "scripts", "ci-watch.sh"), WATCH_CI_SCRIPT);
  writeFile(join(mattstackDir, "skills", "pipeline", "watch-ci", "references", "polling-notes.md"), "Polling notes.\n");
  writeFile(join(mattstackDir, "skills", "pipeline", "watch-ci", ".DS_Store"), "junk");
  writeFile(join(mattstackDir, "skills", "pipeline", "watch-ci", "README.md"), "readme");
  writeFile(join(mattstackDir, "skills", "pipeline", "watch-ci", "scripts", ".gitignore"), "*.pyc");
  writeFile(join(mattstackDir, "skills", "pipeline", "watch-ci", "scripts", "__pycache__", "x.pyc"), "pyc");
  writeFile(join(mattstackDir, "skills", "pipeline", "watch-ci", "scripts", "helper.pyc"), "pyc");
  writeFile(join(mattstackDir, "skills", "pipeline", "watch-ci", "scripts", "poll.test.sh"), "test");
  writeFile(join(mattstackDir, "skills", "pipeline", "watch-ci", "tests", "harness.sh"), "test");
  writeFile(join(mattstackDir, ".claude-plugin", "plugin.json"), JSON.stringify({ version: "1.2.0" }));

  const untypedSkillMd = WATCH_CI_SKILL_MD.replace("type: pipeline-step\n", "");
  writeFile(join(mattstackDir, "skills", "pipeline", "untyped-step", "SKILL.md"), untypedSkillMd);

  const shipSkillMd = WATCH_CI_SKILL_MD.replace(/name: watch-ci/, "name: ship").replace(
    "Poll the pipeline every 30s and report status.",
    "Ship it.",
  );
  writeFile(join(mattstackDir, "attachments", "pipeline", "ship", "SKILL.md"), shipSkillMd);

  const claimviewDir = join(rootDir, "claimview");
  writeFile(join(claimviewDir, "attachments", "watch-ci-domain", "SKILL.md"), WATCH_CI_DOMAIN_SKILL_MD);
  writeFile(join(claimviewDir, "attachments", "watch-ci-domain", "ci-config.json"), CI_CONFIG_JSON);
  writeFile(join(claimviewDir, "skills", "cvi-gates", "SKILL.md"), WATCH_CI_DOMAIN_SKILL_MD.replace("watch-ci-domain", "cvi-gates"));
  writeFile(join(claimviewDir, ".claude-plugin", "plugin.json"), JSON.stringify({ version: "0.3.0" }));

  const roots: PluginRoots = {
    byName: {
      mattstack: { dir: mattstackDir, version: "1.2.0" },
      claimview: { dir: claimviewDir, version: "0.3.0" },
    },
  };

  return { rootDir, roots };
}

describe("stripFrontmatter", () => {
  test("round-trips body exactly and parses frontmatter", () => {
    const body = "Line one.\nLine two.\n\nLine four after a blank.";
    const md = `---\nname: foo\nnested:\n  x: 1\n---\n\n${body}\n`;

    const result = stripFrontmatter(md);

    expect(result.body).toBe(body);
    expect(result.frontmatter).toEqual({ name: "foo", nested: { x: 1 } });
  });

  test("no frontmatter block returns the trimmed body and empty frontmatter", () => {
    const result = stripFrontmatter("Just prose, no frontmatter.\n");
    expect(result.body).toBe("Just prose, no frontmatter.");
    expect(result.frontmatter).toEqual({});
  });

  test("reports the line the body starts on", () => {
    const withFm = "---\nname: x\ndescription: y\n---\n\n# Body\n";
    const r = stripFrontmatter(withFm);
    expect(r.body.startsWith("# Body")).toBe(true);
    expect(r.bodyStartLine).toBe(6); // 1-indexed line of "# Body"

    const withoutFm = "# Body\n";
    expect(stripFrontmatter(withoutFm).bodyStartLine).toBe(1);
  });

  test("trailing blank lines after the body do not shift bodyStartLine", () => {
    // body is trimmed at both ends -- a length-difference formula would count
    // these trailing newlines as if they were leading, landing on line 8 instead of 5.
    expect(stripFrontmatter("---\nname: x\n---\n\n# Body\n\n\n\n").bodyStartLine).toBe(5);
  });
});

describe("loadStepSource", () => {
  test("finds the engine under skills/pipeline/, parses slots, lists stepFiles", () => {
    const { roots } = makeFixtureRoots();

    const step = loadStepSource("watch-ci", roots);

    expect(step.name).toBe("watch-ci");
    expect(step.plugin).toBe("mattstack");
    expect(step.version).toBe("1.2.0");
    expect(step.dir.endsWith(join("skills", "pipeline", "watch-ci"))).toBe(true);
    expect(step.body).toBe("Poll the pipeline every 30s and report status.");
    expect(step.slots).toEqual({
      domain: { contract: "watch-ci-domain@1" },
      forge: { contract: "ci-forge@1", required: true },
    });
    expect(step.allowedTools).toEqual(["Bash(gh:*)", "Read"]);
    expect(step.stepFiles).toEqual(["references/polling-notes.md", "scripts/ci-watch.sh"]);
    expect(step.srcPath).toBe(join("skills", "pipeline", "watch-ci", "SKILL.md"));
    expect(step.bodyStartLine).toBe(13);
  });

  test("throws naming the file when the engine has no type: pipeline-step", () => {
    const { roots } = makeFixtureRoots();

    expect(() => loadStepSource("untyped-step", roots)).toThrow(/untyped-step.*SKILL\.md/s);
  });

  test("throws listing searched paths when the engine is absent entirely", () => {
    const { roots } = makeFixtureRoots();
    const expectedSkillsPath = join(
      roots.byName.mattstack!.dir,
      "skills",
      "pipeline",
      "no-such-engine",
      "SKILL.md",
    );
    const expectedAttachmentsFlatPath = join(
      roots.byName.mattstack!.dir,
      "attachments",
      "no-such-engine",
      "SKILL.md",
    );
    const expectedAttachmentsGroupPath = join(
      roots.byName.mattstack!.dir,
      "attachments",
      "pipeline",
      "no-such-engine",
      "SKILL.md",
    );

    let thrown: unknown;
    try {
      loadStepSource("no-such-engine", roots);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain(expectedSkillsPath);
    expect((thrown as Error).message).toContain(expectedAttachmentsFlatPath);
    expect((thrown as Error).message).toContain(expectedAttachmentsGroupPath);
  });

  test("falls back to attachments/<group>/<engine>/SKILL.md for an engine moved out of skills/", () => {
    const { roots } = makeFixtureRoots();

    const step = loadStepSource("ship", roots);

    expect(step.name).toBe("ship");
    expect(step.dir.endsWith(join("attachments", "pipeline", "ship"))).toBe(true);
    expect(step.body).toBe("Ship it.");
  });
});

describe("loadAttachment", () => {
  test("finds a registered skill under skills/", () => {
    const { roots } = makeFixtureRoots();

    const fill = loadAttachment("claimview:cvi-gates", "domain", roots);

    expect(fill.registered).toBe(true);
    expect(fill.binding).toBe("claimview:cvi-gates");
    expect(fill.plugin).toBe("claimview");
    expect(fill.version).toBe("0.3.0");
    expect(fill.provides).toBe("watch-ci-domain@1");
    expect(fill.dir.endsWith(join("skills", "cvi-gates"))).toBe(true);
    expect(fill.srcPath).toBe(join("skills", "cvi-gates", "SKILL.md"));
    expect(fill.bodyStartLine).toBe(10);
  });

  test("finds an unregistered skill under attachments/", () => {
    const { roots } = makeFixtureRoots();

    const fill = loadAttachment("claimview:watch-ci-domain", "domain", roots);

    expect(fill.registered).toBe(false);
    expect(fill.binding).toBe("claimview:watch-ci-domain");
    expect(fill.provides).toBe("watch-ci-domain@1");
    expect(fill.body).toBe("Domain rules live at ${CLAUDE_SKILL_DIR}/ci-config.json for details.");
    expect(fill.allowedTools).toEqual(["Read(${CLAUDE_SKILL_DIR}/ci-config.json)"]);
    expect(fill.dir.endsWith(join("attachments", "watch-ci-domain"))).toBe(true);
    expect(fill.srcPath).toBe(join("attachments", "watch-ci-domain", "SKILL.md"));
    expect(fill.bodyStartLine).toBe(10);
  });

  test("extraFiles excludes SKILL.md and includes nested files", () => {
    const { rootDir, roots } = makeFixtureRoots();
    writeFile(
      join(rootDir, "claimview", "attachments", "watch-ci-domain", "nested", "extra.txt"),
      "extra\n",
    );

    const fill = loadAttachment("claimview:watch-ci-domain", "domain", roots);

    expect(fill.extraFiles.sort()).toEqual(["ci-config.json", "nested/extra.txt"]);
  });

  test("throws naming the slot and binding when neither search root has the skill", () => {
    const { roots } = makeFixtureRoots();
    const claimviewDir = roots.byName.claimview!.dir;
    const expectedSkillsPath = join(claimviewDir, "skills", "no-such-skill", "SKILL.md");
    const expectedAttachmentsPath = join(claimviewDir, "attachments", "no-such-skill", "SKILL.md");

    let thrown: unknown;
    try {
      loadAttachment("claimview:no-such-skill", "domain", roots);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("domain");
    expect(message).toContain("claimview:no-such-skill");
    expect(message).toContain(expectedSkillsPath);
    expect(message).toContain(expectedAttachmentsPath);
  });
});

describe("readVerbRoster", () => {
  test("parses the real stubs.jsonc shape (comment-bearing JSONC)", () => {
    const rootDir = realpathSync(mkdtempSync(join(tmpdir(), "rt-skills-pack-")));
    const stubsJsonc = `// Verb stubs for this pack. generate-stubs.sh renders skills/<verb>/SKILL.md
// from these; regenerate after edits, never hand-edit generated files.
{
  "verbs": {
    "watch-ci": {
      "engine": "watch-ci",
      "description": "Use when watching or triaging CI."
    },
    "ship": {
      "engine": "ship",
      // inline verb comment
      "description": "Use when ready to ship."
    }
  }
}
`;
    writeFile(join(rootDir, "pack", "stubs.jsonc"), stubsJsonc);

    const roster = readVerbRoster(rootDir);

    expect(roster).toEqual([
      { name: "watch-ci", engine: "watch-ci", description: "Use when watching or triaging CI." },
      { name: "ship", engine: "ship", description: "Use when ready to ship." },
    ]);
  });

  test("throws naming the offending key when a verb name is a path breakout", () => {
    const rootDir = realpathSync(mkdtempSync(join(tmpdir(), "rt-skills-pack-")));
    const stubsJsonc = `{
  "verbs": {
    "../evil": {
      "engine": "watch-ci",
      "description": "Use when watching or triaging CI."
    }
  }
}
`;
    writeFile(join(rootDir, "pack", "stubs.jsonc"), stubsJsonc);

    expect(() => readVerbRoster(rootDir)).toThrow(/"\.\.\/evil"/);
  });
});

describe("readManifestBindings", () => {
  test("parses a fixture copied from the real manifest's bindings shape", () => {
    const rootDir = realpathSync(mkdtempSync(join(tmpdir(), "rt-skills-manifest-")));
    const manifestJsonc = `// GENERATED by merge-manifests.sh -- do not hand-edit for keeps;
// the next pack install or merge run rewrites this file.
{
  "version": 1,
  "skills": { "enabled": ["mattstack:watch-ci"] },
  "bindings": {
    "mattstack:watch-ci": {
      "domain": "claimview:watch-ci-domain",
      "forge": "mattstack:ci-forge-gitlab"
    },
    "mattstack:work": {
      "tiering": "mattstack:model-tiering"
    }
  }
}
`;
    const manifestPath = join(rootDir, "skills.jsonc");
    writeFile(manifestPath, manifestJsonc);

    const bindings = readManifestBindings(manifestPath);

    expect(bindings).toEqual({
      "mattstack:watch-ci": {
        domain: "claimview:watch-ci-domain",
        forge: "mattstack:ci-forge-gitlab",
      },
      "mattstack:work": {
        tiering: "mattstack:model-tiering",
      },
    });
  });
});

describe("invocableRoster", () => {
  test("lists plugin:skillDirName for one- and two-level skills/ entries", () => {
    const { roots } = makeFixtureRoots();

    const roster = invocableRoster(roots);

    expect(roster.has("mattstack:watch-ci")).toBe(true);
    expect(roster.has("mattstack:untyped-step")).toBe(true);
    expect(roster.has("claimview:cvi-gates")).toBe(true);
    expect(roster.has("claimview:watch-ci-domain")).toBe(false);
    expect(roster.has("mattstack:ship")).toBe(false);
  });
});

describe("buildPluginRoots", () => {
  test("skips an entry whose installPath does not exist, warns once, and still resolves the rest", () => {
    const rootDir = realpathSync(mkdtempSync(join(tmpdir(), "rt-skills-plugin-roots-")));

    const mattstackDir = join(rootDir, "mattstack");
    writeFile(join(mattstackDir, ".claude-plugin", "plugin.json"), JSON.stringify({ version: "1.2.0" }));

    const claimviewDir = join(rootDir, "claimview");
    writeFile(join(claimviewDir, ".claude-plugin", "plugin.json"), JSON.stringify({ version: "0.3.0" }));

    const staleInstallPath = join(rootDir, "current-time", "0.1.0");

    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    let roots: PluginRoots;
    let callCount: number;
    let warning: string;
    try {
      roots = buildPluginRoots([
        { id: "mattstack@mattstack", installPath: mattstackDir },
        { id: "current-time@mattstack", installPath: staleInstallPath },
        { id: "claimview@assured", installPath: claimviewDir },
      ]);
      // mockRestore() clears .mock.calls (bun, unlike jest), so read it before restoring.
      callCount = errorSpy.mock.calls.length;
      warning = errorSpy.mock.calls[0]?.join(" ") ?? "";
    } finally {
      errorSpy.mockRestore();
    }

    expect(roots.byName.mattstack).toEqual({ dir: mattstackDir, version: "1.2.0" });
    expect(roots.byName.claimview).toEqual({ dir: claimviewDir, version: "0.3.0" });
    expect(roots.byName["current-time"]).toBeUndefined();

    expect(callCount).toBe(1);
    expect(warning).toContain("current-time");
    expect(warning).toContain(staleInstallPath);
  });

  test("no missing entries: every plugin resolves, no warning printed", () => {
    const { roots: fixtureRoots } = makeFixtureRoots();

    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    let roots: PluginRoots;
    let callCount: number;
    try {
      roots = buildPluginRoots([
        { id: "mattstack@mattstack", installPath: fixtureRoots.byName.mattstack!.dir },
        { id: "claimview@assured", installPath: fixtureRoots.byName.claimview!.dir },
      ]);
      callCount = errorSpy.mock.calls.length;
    } finally {
      errorSpy.mockRestore();
    }

    expect(roots.byName.mattstack?.version).toBe("1.2.0");
    expect(roots.byName.claimview?.version).toBe("0.3.0");
    expect(callCount).toBe(0);
  });
});
