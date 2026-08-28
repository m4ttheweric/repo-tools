import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { computeRows, decidePaletteAction, skillsSurface } from "../skills.ts";

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function makePackDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "rt-skills-surface-pack-")));
}

function writeStubs(packDir: string, verbs: Record<string, { engine: string; description: string }>): void {
  writeFile(join(packDir, "pack", "stubs.jsonc"), JSON.stringify({ verbs }));
}

/** Trivial no-slot pipeline-step engine + fixture mattstack root, for apply's compile delegation. */
function makeEngineFixture(): { mattstackDir: string; manifestPath: string } {
  const mattstackDir = realpathSync(mkdtempSync(join(tmpdir(), "rt-skills-surface-mattstack-")));
  writeFile(
    join(mattstackDir, "plugins", "mattstack", ".claude-plugin", "plugin.json"),
    JSON.stringify({ version: "1.0.0" }),
  );
  writeFile(
    join(mattstackDir, "plugins", "mattstack", "skills", "pipeline", "my-verb", "SKILL.md"),
    `---\nname: my-verb\ndescription: "Do the thing"\ntype: pipeline-step\n---\n\nDo the thing.\n`,
  );

  const manifestDir = realpathSync(mkdtempSync(join(tmpdir(), "rt-skills-surface-manifest-")));
  const manifestPath = join(manifestDir, "skills.jsonc");
  writeFile(manifestPath, JSON.stringify({ bindings: {} }));

  return { mattstackDir, manifestPath };
}

function stageSkillMd(name: string, stage: string): string {
  return `---
name: ${name}
description: "${stage} stage"
type: pipeline-step
metadata:
  stage: ${stage}
---

${stage}.
`;
}

/** Roster verb (stages need a non-empty roster) plus a manifest pipeline naming one real, loadable stage that this pack has never compiled. */
function makeUncompiledStageFixture(): { mattstackDir: string; manifestPath: string } {
  const mattstackDir = realpathSync(mkdtempSync(join(tmpdir(), "rt-skills-surface-stage-mattstack-")));
  writeFile(
    join(mattstackDir, "plugins", "mattstack", ".claude-plugin", "plugin.json"),
    JSON.stringify({ version: "1.0.0" }),
  );
  writeFile(
    join(mattstackDir, "plugins", "mattstack", "attachments", "pipeline", "work", "SKILL.md"),
    `---\nname: work\ndescription: "Run the pipeline"\ntype: pipeline-step\n---\n\nDo the work.\n`,
  );
  writeFile(
    join(mattstackDir, "plugins", "mattstack", "attachments", "pipeline", "stage-plan", "SKILL.md"),
    stageSkillMd("stage-plan", "plan"),
  );

  const manifestDir = realpathSync(mkdtempSync(join(tmpdir(), "rt-skills-surface-stage-manifest-")));
  const manifestPath = join(manifestDir, "skills.jsonc");
  writeFile(manifestPath, `{\n  "pipelines": { "feature": ["mattstack:stage-plan"] },\n  "bindings": {}\n}\n`);

  return { mattstackDir, manifestPath };
}

/** Two declared, loadable stages, neither compiled into the pack yet -- for asserting apply's announcement is per-entry, not per-declared-stage. */
function makeTwoStageFixture(): { mattstackDir: string; manifestPath: string } {
  const mattstackDir = realpathSync(mkdtempSync(join(tmpdir(), "rt-skills-surface-twostage-mattstack-")));
  writeFile(
    join(mattstackDir, "plugins", "mattstack", ".claude-plugin", "plugin.json"),
    JSON.stringify({ version: "1.0.0" }),
  );
  writeFile(
    join(mattstackDir, "plugins", "mattstack", "attachments", "pipeline", "work", "SKILL.md"),
    `---\nname: work\ndescription: "Run the pipeline"\ntype: pipeline-step\n---\n\nDo the work.\n`,
  );
  writeFile(
    join(mattstackDir, "plugins", "mattstack", "attachments", "pipeline", "stage-plan", "SKILL.md"),
    stageSkillMd("stage-plan", "plan"),
  );
  writeFile(
    join(mattstackDir, "plugins", "mattstack", "attachments", "pipeline", "stage-ship", "SKILL.md"),
    stageSkillMd("stage-ship", "ship"),
  );

  const manifestDir = realpathSync(mkdtempSync(join(tmpdir(), "rt-skills-surface-twostage-manifest-")));
  const manifestPath = join(manifestDir, "skills.jsonc");
  writeFile(
    manifestPath,
    `{\n  "pipelines": { "feature": ["mattstack:stage-plan", "mattstack:stage-ship"] },\n  "bindings": {}\n}\n`,
  );

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

describe("skillsSurface list", () => {
  test("no surface.jsonc: infers public/internal from current skills/ + attachments/ + stub verbs", async () => {
    const packDir = makePackDir();
    const { mattstackDir, manifestPath } = makeEngineFixture();
    writeStubs(packDir, { "my-verb": { engine: "my-verb", description: "Do the thing" } });
    writeFile(join(packDir, "skills", "hand-authored-public", "SKILL.md"), "---\nname: x\n---\nbody\n");
    writeFile(join(packDir, "attachments", "hand-authored-internal", "SKILL.md"), "---\nname: y\n---\nbody\n");

    await skillsSurface(["list", "--team", "t", "--pack-dir", packDir, "--mattstack-dir", mattstackDir, "--manifest", manifestPath]);

    const out = logs.join("\n");
    expect(out).toContain("no surface.jsonc");
    expect(out).toMatch(/public.*hand-authored-public/);
    expect(out).toMatch(/internal.*hand-authored-internal/);
    expect(out).toMatch(/public.*compiled.*my-verb/);
  });

  test("with surface.jsonc: statuses reflect the config, not disk placement", async () => {
    const packDir = makePackDir();
    writeStubs(packDir, {});
    writeFile(join(packDir, "skills", "still-under-skills", "SKILL.md"), "---\nname: z\n---\nbody\n");
    writeFile(join(packDir, "pack", "surface.jsonc"), JSON.stringify({ public: [] }));

    await skillsSurface(["list", "--team", "t", "--pack-dir", packDir]);

    const out = logs.join("\n");
    expect(out).toContain("pack/surface.jsonc");
    expect(out).toMatch(/internal.*still-under-skills/);
  });

  test("unrecognized argument: clean one-line error, exit 1", async () => {
    const { exitCode, errors } = await runExpectingCleanExit(() =>
      skillsSurface(["list", "--bogus"]),
    );
    expect(exitCode).toBe(1);
    expect(errors[0]).toStartWith("rt skills: ");
    expect(errors[0]).toContain("--bogus");
  });

  test("--json: rows match the human listing, with pack and packDir", async () => {
    const packDir = makePackDir();
    const { mattstackDir, manifestPath } = makeEngineFixture();
    writeStubs(packDir, { "my-verb": { engine: "my-verb", description: "Do the thing" } });
    writeFile(join(packDir, "skills", "hand-authored-public", "SKILL.md"), "---\nname: x\n---\nbody\n");
    writeFile(join(packDir, "attachments", "hand-authored-internal", "SKILL.md"), "---\nname: y\n---\nbody\n");

    await skillsSurface(["list", "--pack", "acme", "--pack-dir", packDir, "--json", "--mattstack-dir", mattstackDir, "--manifest", manifestPath]);

    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.pack).toBe("acme");
    expect(parsed.packDir).toBe(packDir);
    expect(parsed.rows.map((r: { name: string }) => r.name).sort()).toEqual([
      "hand-authored-internal",
      "hand-authored-public",
      "my-verb",
    ]);
    expect(parsed.rows.find((r: { name: string }) => r.name === "my-verb")).toEqual({
      name: "my-verb",
      kind: "compiled",
      status: "public",
    });
  });

  test("--json prints ONLY json -- no human lines on stdout", async () => {
    const packDir = makePackDir();
    writeStubs(packDir, {});

    await skillsSurface(["list", "--pack-dir", packDir, "--json"]);

    expect(() => JSON.parse(logs.join("\n"))).not.toThrow();
  });

  test("roster pack with no discoverable manifest: list still works, no stage rows", async () => {
    const packDir = makePackDir();
    writeStubs(packDir, { "my-verb": { engine: "my-verb", description: "Do the thing" } });
    const mattstackDir = realpathSync(mkdtempSync(join(tmpdir(), "rt-skills-surface-empty-mattstack-")));

    const { exitCode } = await runExpectingCleanExit(() =>
      skillsSurface(["list", "--team", "t", "--pack-dir", packDir, "--mattstack-dir", mattstackDir]),
    );

    expect(exitCode).toBeUndefined();
    expect(logs.join("\n")).toMatch(/my-verb/);
  });
});

describe("skillsSurface set", () => {
  test("--public on an attachments/ dir: bootstraps surface.jsonc, moves it to skills/ via apply (plain rename, no git repo)", async () => {
    const packDir = makePackDir();
    writeStubs(packDir, {});
    writeFile(join(packDir, "attachments", "my-attach", "SKILL.md"), "---\nname: a\n---\nbody\n");
    const { mattstackDir, manifestPath } = makeEngineFixture();

    await skillsSurface([
      "set", "my-attach", "--public",
      "--team", "t", "--pack-dir", packDir, "--mattstack-dir", mattstackDir, "--manifest", manifestPath,
    ]);

    const surfacePath = join(packDir, "pack", "surface.jsonc");
    expect(existsSync(surfacePath)).toBe(true);
    const surface = JSON.parse(readFileSync(surfacePath, "utf8").replace(/^\/\/.*\n/, ""));
    expect(surface.public).toContain("my-attach");

    expect(existsSync(join(packDir, "skills", "my-attach", "SKILL.md"))).toBe(true);
    expect(existsSync(join(packDir, "attachments", "my-attach"))).toBe(false);

    const out = logs.join("\n");
    expect(out).toContain("not a git repo");
  });

  test("--internal on a skills/ dir: bootstraps surface.jsonc, moves it to attachments/ via apply", async () => {
    const packDir = makePackDir();
    writeStubs(packDir, {});
    writeFile(join(packDir, "skills", "my-skill", "SKILL.md"), "---\nname: s\n---\nbody\n");
    const { mattstackDir, manifestPath } = makeEngineFixture();

    await skillsSurface([
      "set", "my-skill", "--internal",
      "--team", "t", "--pack-dir", packDir, "--mattstack-dir", mattstackDir, "--manifest", manifestPath,
    ]);

    expect(existsSync(join(packDir, "attachments", "my-skill", "SKILL.md"))).toBe(true);
    expect(existsSync(join(packDir, "skills", "my-skill"))).toBe(false);

    const surfacePath = join(packDir, "pack", "surface.jsonc");
    const surface = JSON.parse(readFileSync(surfacePath, "utf8").replace(/^\/\/.*\n/, ""));
    expect(surface.public).not.toContain("my-skill");
  });

  test("--internal on a compiled stub verb: surface.jsonc updated, apply recompiles it into attachments/ (never git-mv'd)", async () => {
    const packDir = makePackDir();
    writeStubs(packDir, { "my-verb": { engine: "my-verb", description: "Do the thing" } });
    writeFile(join(packDir, "skills", "my-verb", "SKILL.md"), "---\nname: my-verb\n---\nold compiled content\n");
    const { mattstackDir, manifestPath } = makeEngineFixture();

    await skillsSurface([
      "set", "my-verb", "--internal",
      "--team", "t", "--pack-dir", packDir, "--mattstack-dir", mattstackDir, "--manifest", manifestPath,
    ]);

    expect(existsSync(join(packDir, "skills", "my-verb"))).toBe(false);
    expect(existsSync(join(packDir, "attachments", "my-verb", "SKILL.md"))).toBe(true);

    const out = logs.join("\n");
    expect(out).not.toContain("moved my-verb");
  });

  test("--public on a compiled stub verb (bootstrap default already public): apply compiles it", async () => {
    const packDir = makePackDir();
    writeStubs(packDir, { "my-verb": { engine: "my-verb", description: "Do the thing" } });
    const { mattstackDir, manifestPath } = makeEngineFixture();

    await skillsSurface([
      "set", "my-verb", "--public",
      "--team", "t", "--pack-dir", packDir, "--mattstack-dir", mattstackDir, "--manifest", manifestPath,
    ]);

    const skillMd = readFileSync(join(packDir, "skills", "my-verb", "SKILL.md"), "utf8");
    expect(skillMd).toContain("compiled by rt skills compile");
  });

  test("uses a real git mv when the pack dir is a git repo", async () => {
    const packDir = makePackDir();
    execFileSync("git", ["init", "-q"], { cwd: packDir });
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: packDir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: packDir });
    writeStubs(packDir, {});
    writeFile(join(packDir, "skills", "my-skill", "SKILL.md"), "---\nname: s\n---\nbody\n");
    execFileSync("git", ["add", "-A"], { cwd: packDir });
    const { mattstackDir, manifestPath } = makeEngineFixture();

    await skillsSurface([
      "set", "my-skill", "--internal",
      "--team", "t", "--pack-dir", packDir, "--mattstack-dir", mattstackDir, "--manifest", manifestPath,
    ]);

    expect(existsSync(join(packDir, "attachments", "my-skill", "SKILL.md"))).toBe(true);
    expect(existsSync(join(packDir, "skills", "my-skill"))).toBe(false);
    // git mv on a never-committed add reports as a plain staged add at the new
    // path (git has no prior commit to diff a rename against).
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: packDir, encoding: "utf8" });
    expect(status).toContain("attachments/my-skill");

    const out = logs.join("\n");
    expect(out).not.toContain("not a git repo");
  });

  test("unknown name: clean one-line error, exit 1", async () => {
    const packDir = makePackDir();
    writeStubs(packDir, {});

    const { exitCode, errors } = await runExpectingCleanExit(() =>
      skillsSurface(["set", "no-such-skill", "--public", "--pack-dir", packDir]),
    );

    expect(exitCode).toBe(1);
    expect(errors[0]).toStartWith("rt skills: ");
    expect(errors[0]).toContain("no-such-skill");
  });

  test("missing --public/--internal: clean one-line error, exit 1", async () => {
    const packDir = makePackDir();
    writeStubs(packDir, {});
    writeFile(join(packDir, "skills", "my-skill", "SKILL.md"), "---\nname: s\n---\nbody\n");

    const { exitCode, errors } = await runExpectingCleanExit(() =>
      skillsSurface(["set", "my-skill", "--pack-dir", packDir]),
    );

    expect(exitCode).toBe(1);
    expect(errors[0]).toStartWith("rt skills: ");
  });

  test("missing name: clean one-line error, exit 1", async () => {
    const { exitCode, errors } = await runExpectingCleanExit(() =>
      skillsSurface(["set", "--public"]),
    );

    expect(exitCode).toBe(1);
    expect(errors[0]).toStartWith("rt skills: ");
  });

  test("several names in one call: all move, and surface.jsonc is written once", async () => {
    const packDir = makePackDir();
    writeStubs(packDir, {});
    writeFile(join(packDir, "attachments", "one", "SKILL.md"), "---\nname: one\n---\nbody\n");
    writeFile(join(packDir, "attachments", "two", "SKILL.md"), "---\nname: two\n---\nbody\n");
    writeFile(join(packDir, "attachments", "three", "SKILL.md"), "---\nname: three\n---\nbody\n");
    const { mattstackDir, manifestPath } = makeEngineFixture();

    await skillsSurface([
      "set", "one", "two", "three", "--public",
      "--team", "t", "--pack-dir", packDir, "--mattstack-dir", mattstackDir, "--manifest", manifestPath,
    ]);

    for (const name of ["one", "two", "three"]) {
      expect(existsSync(join(packDir, "skills", name, "SKILL.md"))).toBe(true);
      expect(existsSync(join(packDir, "attachments", name))).toBe(false);
    }

    const surface = JSON.parse(
      readFileSync(join(packDir, "pack", "surface.jsonc"), "utf8").replace(/^\/\/.*\n/, ""),
    );
    expect(surface.public).toEqual(["one", "three", "two"]);
  });

  test("one unknown name in a list writes nothing at all", async () => {
    // The reason a list is one call rather than N: a rejection must not leave
    // the names before it already moved.
    const packDir = makePackDir();
    writeStubs(packDir, {});
    writeFile(join(packDir, "attachments", "one", "SKILL.md"), "---\nname: one\n---\nbody\n");

    const { exitCode, errors } = await runExpectingCleanExit(() =>
      skillsSurface(["set", "one", "no-such-skill", "--public", "--pack-dir", packDir]),
    );

    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("no-such-skill");
    expect(existsSync(join(packDir, "pack", "surface.jsonc"))).toBe(false);
    expect(existsSync(join(packDir, "attachments", "one", "SKILL.md"))).toBe(true);
  });

  test("a name repeated in one call is a usage error, not a silent no-op", async () => {
    const packDir = makePackDir();
    writeStubs(packDir, {});
    writeFile(join(packDir, "attachments", "one", "SKILL.md"), "---\nname: one\n---\nbody\n");

    const { exitCode, errors } = await runExpectingCleanExit(() =>
      skillsSurface(["set", "one", "one", "--public", "--pack-dir", packDir]),
    );

    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("more than once");
  });
});

describe("skillsSurface apply", () => {
  test("dry-run prints planned moves and touches nothing", async () => {
    const packDir = makePackDir();
    writeStubs(packDir, {});
    writeFile(join(packDir, "attachments", "my-attach", "SKILL.md"), "---\nname: a\n---\nbody\n");
    writeFile(join(packDir, "pack", "surface.jsonc"), JSON.stringify({ public: ["my-attach"] }));
    const { mattstackDir, manifestPath } = makeEngineFixture();

    await skillsSurface([
      "apply", "--dry-run",
      "--team", "t", "--pack-dir", packDir, "--mattstack-dir", mattstackDir, "--manifest", manifestPath,
    ]);

    expect(existsSync(join(packDir, "attachments", "my-attach"))).toBe(true);
    expect(existsSync(join(packDir, "skills", "my-attach"))).toBe(false);
    expect(logs.some((l) => l.includes("would move") && l.includes("my-attach"))).toBe(true);
  });

  test("no surface.jsonc: no moves, compiles the roster as usual", async () => {
    const packDir = makePackDir();
    writeStubs(packDir, { "my-verb": { engine: "my-verb", description: "Do the thing" } });
    const { mattstackDir, manifestPath } = makeEngineFixture();

    await skillsSurface([
      "apply",
      "--team", "t", "--pack-dir", packDir, "--mattstack-dir", mattstackDir, "--manifest", manifestPath,
    ]);

    expect(logs.some((l) => l.includes("no moves needed"))).toBe(true);
    expect(existsSync(join(packDir, "skills", "my-verb", "SKILL.md"))).toBe(true);
  });

  test("unrecognized argument: clean one-line error, exit 1", async () => {
    const { exitCode, errors } = await runExpectingCleanExit(() =>
      skillsSurface(["apply", "--bogus"]),
    );
    expect(exitCode).toBe(1);
    expect(errors[0]).toStartWith("rt skills: ");
  });
});

describe("skillsSurface set/apply on a never-compiled pipeline stage", () => {
  test("set --public records the surface change and reports the pending emit instead of erroring", async () => {
    const packDir = makePackDir();
    writeStubs(packDir, { work: { engine: "work", description: "Run the pipeline." } });
    const { mattstackDir, manifestPath } = makeUncompiledStageFixture();

    const { exitCode } = await runExpectingCleanExit(() =>
      skillsSurface([
        "set", "stage-plan", "--public",
        "--team", "t", "--pack-dir", packDir, "--mattstack-dir", mattstackDir, "--manifest", manifestPath,
      ]),
    );

    expect(exitCode).toBeUndefined();
    const surface = JSON.parse(readFileSync(join(packDir, "pack", "surface.jsonc"), "utf8").replace(/^\/\/.*\n/, ""));
    expect(surface.public).toContain("stage-plan");
    expect(logs.join("\n")).toContain("stage-plan: recorded; emitted to skills/ on the next compile");
  });

  test("set --internal on a never-compiled stage is a no-op for reconciliation: surface.jsonc can't record internal, so nothing is announced", async () => {
    const packDir = makePackDir();
    writeStubs(packDir, { work: { engine: "work", description: "Run the pipeline." } });
    const { mattstackDir, manifestPath } = makeUncompiledStageFixture();

    const { exitCode } = await runExpectingCleanExit(() =>
      skillsSurface([
        "set", "stage-plan", "--internal",
        "--team", "t", "--pack-dir", packDir, "--mattstack-dir", mattstackDir, "--manifest", manifestPath,
      ]),
    );

    expect(exitCode).toBeUndefined();
    const surface = JSON.parse(readFileSync(join(packDir, "pack", "surface.jsonc"), "utf8").replace(/^\/\/.*\n/, ""));
    expect(surface.public).not.toContain("stage-plan");
    expect(logs.join("\n")).not.toContain("stage-plan: recorded");
  });

  test("apply announces only the stage surface.jsonc's public list names, not every declared stage", async () => {
    const packDir = makePackDir();
    writeStubs(packDir, { work: { engine: "work", description: "Run the pipeline." } });
    writeFile(join(packDir, "pack", "surface.jsonc"), JSON.stringify({ public: ["work", "stage-plan"] }));
    const { mattstackDir, manifestPath } = makeTwoStageFixture();

    const { exitCode } = await runExpectingCleanExit(() =>
      skillsSurface([
        "apply",
        "--team", "t", "--pack-dir", packDir, "--mattstack-dir", mattstackDir, "--manifest", manifestPath,
      ]),
    );

    expect(exitCode).toBeUndefined();
    const recordedLines = logs.filter((l) => l.includes(": recorded; emitted to"));
    expect(recordedLines).toEqual(["stage-plan: recorded; emitted to skills/ on the next compile"]);
  });

  test("apply alone reports the same pending-emit line for a stage recorded public but never compiled", async () => {
    const packDir = makePackDir();
    writeStubs(packDir, { work: { engine: "work", description: "Run the pipeline." } });
    writeFile(join(packDir, "pack", "surface.jsonc"), JSON.stringify({ public: ["work", "stage-plan"] }));
    const { mattstackDir, manifestPath } = makeUncompiledStageFixture();

    const { exitCode } = await runExpectingCleanExit(() =>
      skillsSurface([
        "apply",
        "--team", "t", "--pack-dir", packDir, "--mattstack-dir", mattstackDir, "--manifest", manifestPath,
      ]),
    );

    expect(exitCode).toBeUndefined();
    expect(logs.join("\n")).toContain("stage-plan: recorded; emitted to skills/ on the next compile");
  });

  test("apply --dry-run says would record, mirroring would move, and writes nothing", async () => {
    const packDir = makePackDir();
    writeStubs(packDir, { work: { engine: "work", description: "Run the pipeline." } });
    writeFile(join(packDir, "pack", "surface.jsonc"), JSON.stringify({ public: ["work", "stage-plan"] }));
    const { mattstackDir, manifestPath } = makeUncompiledStageFixture();

    await skillsSurface([
      "apply", "--dry-run",
      "--team", "t", "--pack-dir", packDir, "--mattstack-dir", mattstackDir, "--manifest", manifestPath,
    ]);

    expect(logs.join("\n")).toContain("stage-plan: would record; emitted to skills/ on the next compile");
    expect(existsSync(join(packDir, "skills", "stage-plan"))).toBe(false);
    expect(existsSync(join(packDir, "attachments", "stage-plan"))).toBe(false);
  });

  test("a non-stage unknown name still errors exactly as before", async () => {
    const packDir = makePackDir();
    writeStubs(packDir, { work: { engine: "work", description: "Run the pipeline." } });
    const { mattstackDir, manifestPath } = makeUncompiledStageFixture();

    const { exitCode, errors } = await runExpectingCleanExit(() =>
      skillsSurface([
        "set", "no-such-skill", "--public",
        "--team", "t", "--pack-dir", packDir, "--mattstack-dir", mattstackDir, "--manifest", manifestPath,
      ]),
    );

    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("no-such-skill");
  });
});

describe("skillsSurface bare invocation (fzf palette)", () => {
  test("non-tty: prints the list and the set-command hint, does not crash or write config", async () => {
    const packDir = makePackDir();
    writeStubs(packDir, {});
    writeFile(join(packDir, "skills", "my-skill", "SKILL.md"), "---\nname: s\n---\nbody\n");

    // bun test inherits stdin from the shell; force the non-tty fallback so this
    // never spawns real fzf on an interactive run.
    const previousIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    try {
      await skillsSurface(["--team", "t", "--pack-dir", packDir]);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: previousIsTTY, configurable: true });
    }

    expect(existsSync(join(packDir, "pack", "surface.jsonc"))).toBe(false);
    const out = logs.join("\n");
    expect(out).toContain("my-skill");
    expect(out).toContain("rt skills surface set");
  });

  test("empty pack: prints a no-skills message instead of crashing", async () => {
    const packDir = makePackDir();
    writeStubs(packDir, {});

    await skillsSurface(["--pack-dir", packDir]);

    expect(logs.some((l) => l.includes("no skills registered"))).toBe(true);
  });

  test("unrecognized subcommand: clean one-line error, exit 1", async () => {
    const { exitCode, errors } = await runExpectingCleanExit(() =>
      skillsSurface(["bogus-mode"]),
    );
    expect(exitCode).toBe(1);
    expect(errors[0]).toStartWith("rt skills: ");
    expect(errors[0]).toContain("bogus-mode");
  });
});

describe("decidePaletteAction", () => {
  test("zero-marked cursor-row artifact shows as a +1 delta the user can decline", () => {
    // Everything was internal; fzf's default --multi accept on Enter with
    // nothing marked emits the cursor row anyway -- that row now reads
    // "public" in resultRows even though the user meant to uncheck everything.
    const previousPublic = new Set<string>();
    const resultRows = [{ name: "x", status: "public" as const }];

    const action = decidePaletteAction(previousPublic, resultRows, false);

    expect(action.kind).toBe("declined");
    if (action.kind !== "no-changes") {
      expect(action.delta.toPublic).toEqual(["x"]);
      expect(action.delta.toInternal).toEqual([]);
    }
  });

  test("decline writes nothing: the confirmed=false path never yields a write action", () => {
    const previousPublic = new Set<string>();
    const resultRows = [{ name: "x", status: "public" as const }];

    const action = decidePaletteAction(previousPublic, resultRows, false);

    expect(action.kind).not.toBe("write");
  });

  test("confirming a real delta yields a write action carrying it", () => {
    const previousPublic = new Set(["y"]);
    const resultRows = [
      { name: "x", status: "public" as const },
      { name: "y", status: "internal" as const },
    ];

    const action = decidePaletteAction(previousPublic, resultRows, true);

    expect(action.kind).toBe("write");
    if (action.kind === "write") {
      expect(action.delta.toPublic).toEqual(["x"]);
      expect(action.delta.toInternal).toEqual(["y"]);
    }
  });

  test("no changes short-circuits regardless of the confirm answer", () => {
    const previousPublic = new Set(["x"]);
    const resultRows = [{ name: "x", status: "public" as const }];

    expect(decidePaletteAction(previousPublic, resultRows, false).kind).toBe("no-changes");
    expect(decidePaletteAction(previousPublic, resultRows, true).kind).toBe("no-changes");
  });
});

describe("computeRows -- previously-public names absent from skills/, attachments/, stubs.jsonc", () => {
  test("surfaces the orphan as a 'missing' row instead of dropping it", () => {
    const packDir = makePackDir();
    writeStubs(packDir, {});
    writeFile(join(packDir, "skills", "real-skill", "SKILL.md"), "---\nname: real-skill\n---\nbody\n");

    const surface = { public: ["ghost", "real-skill"] };
    const { rows } = computeRows(packDir, new Set(), surface, new Set());

    const ghostRow = rows.find((r) => r.name === "ghost");
    expect(ghostRow).toEqual({ name: "ghost", kind: "missing", status: "public" });
    const realRow = rows.find((r) => r.name === "real-skill");
    expect(realRow?.status).toBe("public");
  });

  test("combined with decidePaletteAction: leaving the missing row untouched yields no delta", () => {
    const packDir = makePackDir();
    writeStubs(packDir, {});

    const surface = { public: ["ghost"] };
    const { rows } = computeRows(packDir, new Set(), surface, new Set());
    const previousPublic = new Set(surface.public);

    // Simulates the palette round trip: the fzf row for "ghost" exists and stays
    // preselected because the user never touched it.
    const resultRows = rows.map((r) => ({ name: r.name, status: r.status }));

    const action = decidePaletteAction(previousPublic, resultRows, false);
    expect(action.kind).toBe("no-changes");
  });

  test("combined with decidePaletteAction: explicitly demoting the missing row surfaces the removal", () => {
    const packDir = makePackDir();
    writeStubs(packDir, {});

    const surface = { public: ["ghost"] };
    const { rows } = computeRows(packDir, new Set(), surface, new Set());
    const previousPublic = new Set(surface.public);

    const resultRows = rows.map((r) => ({ name: r.name, status: "internal" as const }));

    const preview = decidePaletteAction(previousPublic, resultRows, false);
    expect(preview.kind).toBe("declined");
    if (preview.kind !== "no-changes") {
      expect(preview.delta.toInternal).toEqual(["ghost"]);
    }

    const decision = decidePaletteAction(previousPublic, resultRows, true);
    expect(decision.kind).toBe("write");
    if (decision.kind === "write") {
      expect(decision.delta.toInternal).toEqual(["ghost"]);
    }
  });
});

describe("grouped packs and pack selection", () => {
  test("list reads grouped layouts (skills/<group>/<name>) and reports the root surface.jsonc", async () => {
    const packDir = makePackDir();
    writeFile(join(packDir, "surface.jsonc"), `{ "public": ["subagent-review-loop"] }\n`);
    writeFile(join(packDir, "skills", "review", "subagent-review-loop", "SKILL.md"), "---\nname: subagent-review-loop\n---\nbody\n");
    writeFile(join(packDir, "attachments", "forge", "checkout", "SKILL.md"), "---\nname: checkout\n---\nbody\n");

    await skillsSurface(["list", "--pack", "mattstack", "--pack-dir", packDir]);

    const joined = logs.join("\n");
    expect(joined).toContain("rt skills surface -- pack mattstack");
    expect(joined).toContain("source: surface.jsonc");
    expect(joined).toMatch(/public {3}hand-authored {2}subagent-review-loop/);
    expect(joined).toMatch(/internal hand-authored {2}checkout/);
  });

  test("set --public on a grouped internal skill moves it keeping its group, and writes the root surface.jsonc", async () => {
    const packDir = makePackDir();
    const { mattstackDir, manifestPath } = makeEngineFixture();
    writeFile(join(packDir, "surface.jsonc"), `{ "public": [] }\n`);
    writeFile(join(packDir, "attachments", "forge", "checkout", "SKILL.md"), "---\nname: checkout\n---\nbody\n");

    await skillsSurface([
      "set", "checkout", "--public",
      "--pack", "mattstack", "--pack-dir", packDir, "--mattstack-dir", mattstackDir, "--manifest", manifestPath,
    ]);

    expect(existsSync(join(packDir, "skills", "forge", "checkout", "SKILL.md"))).toBe(true);
    expect(existsSync(join(packDir, "attachments", "forge", "checkout"))).toBe(false);
    expect(existsSync(join(packDir, "pack", "surface.jsonc"))).toBe(false);
    expect(readFileSync(join(packDir, "surface.jsonc"), "utf8")).toContain('"checkout"');
    expect(logs.join("\n")).toContain("moved checkout: attachments/forge/ -> skills/forge/");
  });

  test("no pack named and no tty: clean error that names the flag instead of guessing", async () => {
    const { mattstackDir } = makeEngineFixture();
    const { exitCode, errors } = await runExpectingCleanExit(() => skillsSurface(["list", "--mattstack-dir", mattstackDir]));
    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("--pack");
  });
});

describe("registered roots and name uniqueness", () => {
  test("plugin.json skills roots are honored: a skill under a second root counts as registered", async () => {
    const packDir = makePackDir();
    writeFile(join(packDir, ".claude-plugin", "plugin.json"), JSON.stringify({ version: "1.0.0", skills: ["./skills/review", "./plugin/skills"] }));
    writeFile(join(packDir, "surface.jsonc"), `{ "public": ["editing-skills", "subagent-review-loop"] }\n`);
    writeFile(join(packDir, "skills", "review", "subagent-review-loop", "SKILL.md"), "---\nname: subagent-review-loop\n---\nbody\n");
    writeFile(join(packDir, "plugin", "skills", "editing-skills", "SKILL.md"), "---\nname: editing-skills\n---\nbody\n");

    await skillsSurface(["list", "--pack", "mattstack", "--pack-dir", packDir]);

    const joined = logs.join("\n");
    expect(joined).toMatch(/public {3}hand-authored {2}editing-skills/);
    expect(joined).not.toContain("(no files on disk)editing-skills");
  });

  test("duplicate leaf names across groups are rejected with a clean error naming both dirs", async () => {
    const packDir = makePackDir();
    writeFile(join(packDir, "surface.jsonc"), `{ "public": [] }\n`);
    writeFile(join(packDir, "attachments", "forge", "sync", "SKILL.md"), "---\nname: sync\n---\nbody\n");
    writeFile(join(packDir, "attachments", "pipeline", "sync", "SKILL.md"), "---\nname: sync\n---\nbody\n");

    const { exitCode, errors } = await runExpectingCleanExit(() => skillsSurface(["list", "--pack", "mattstack", "--pack-dir", packDir]));
    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain('skill name "sync" appears twice');
    expect(errors.join("\n")).toContain("forge/sync");
    expect(errors.join("\n")).toContain("pipeline/sync");
  });
});

describe("registered roots stay inside the pack", () => {
  test("plugin.json skills entries that escape the pack (../ or absolute) are ignored; in-pack roots are kept", async () => {
    const packDir = makePackDir();
    const outside = makePackDir();
    writeFile(join(outside, "stray", "SKILL.md"), "---\nname: stray\n---\nbody\n");
    writeFile(
      join(packDir, ".claude-plugin", "plugin.json"),
      JSON.stringify({ version: "1.0.0", skills: ["./skills", "../" + outside.split("/").pop()!, outside] }),
    );
    writeFile(join(packDir, "surface.jsonc"), `{ "public": ["inside"] }\n`);
    writeFile(join(packDir, "skills", "inside", "SKILL.md"), "---\nname: inside\n---\nbody\n");

    await skillsSurface(["list", "--pack", "p", "--pack-dir", packDir]);

    const joined = logs.join("\n");
    expect(joined).toMatch(/public {3}hand-authored {2}inside/);
    expect(joined).not.toContain("stray");
  });
});

describe("registered roots are canonicalized", () => {
  test("a symlinked root inside the pack that points outside it is ignored", async () => {
    const packDir = makePackDir();
    const outside = makePackDir();
    writeFile(join(outside, "stray", "SKILL.md"), "---\nname: stray\n---\nbody\n");
    mkdirSync(join(packDir, "skills"), { recursive: true });
    symlinkSync(outside, join(packDir, "linked-root"));
    writeFile(join(packDir, ".claude-plugin", "plugin.json"), JSON.stringify({ version: "1.0.0", skills: ["./skills", "./linked-root"] }));
    writeFile(join(packDir, "surface.jsonc"), `{ "public": ["inside"] }\n`);
    writeFile(join(packDir, "skills", "inside", "SKILL.md"), "---\nname: inside\n---\nbody\n");

    await skillsSurface(["list", "--pack", "p", "--pack-dir", packDir]);

    const joined = logs.join("\n");
    expect(joined).toMatch(/public {3}hand-authored {2}inside/);
    expect(joined).not.toContain("stray");
  });
});

describe("registered roots may start with dots without escaping", () => {
  test("a directory literally named ..skills inside the pack is accepted as a root", async () => {
    const packDir = makePackDir();
    writeFile(
      join(packDir, ".claude-plugin", "plugin.json"),
      JSON.stringify({ version: "1.0.0", skills: ["./skills", "./..skills"] }),
    );
    writeFile(join(packDir, "surface.jsonc"), `{ "public": ["inside", "dotty"] }\n`);
    writeFile(join(packDir, "skills", "inside", "SKILL.md"), "---\nname: inside\n---\nbody\n");
    writeFile(join(packDir, "..skills", "dotty", "SKILL.md"), "---\nname: dotty\n---\nbody\n");

    await skillsSurface(["list", "--pack", "p", "--pack-dir", packDir]);

    const joined = logs.join("\n");
    expect(joined).toMatch(/public {3}hand-authored {2}inside/);
    expect(joined).toContain("dotty");
  });
});

describe("registered roots must be directories", () => {
  test("a plugin.json skills entry pointing at a regular file is ignored", async () => {
    const packDir = makePackDir();
    writeFile(join(packDir, "notes.md"), "not a skills root\n");
    writeFile(
      join(packDir, ".claude-plugin", "plugin.json"),
      JSON.stringify({ version: "1.0.0", skills: ["./skills", "./notes.md", "./missing"] }),
    );
    writeFile(join(packDir, "surface.jsonc"), `{ "public": ["inside"] }\n`);
    writeFile(join(packDir, "skills", "inside", "SKILL.md"), "---\nname: inside\n---\nbody\n");

    await skillsSurface(["list", "--pack", "p", "--pack-dir", packDir]);

    const joined = logs.join("\n");
    expect(joined).toMatch(/public {3}hand-authored {2}inside/);
  });
});

describe("apply on packs with plugin.json skills roots", () => {
  test("set --internal moves a skill that lives under a second registered root (plugin/skills/) to attachments/", async () => {
    const packDir = makePackDir();
    writeFile(join(packDir, ".claude-plugin", "plugin.json"), JSON.stringify({ version: "1.0.0", skills: ["./skills/review", "./plugin/skills"] }));
    writeFile(join(packDir, "surface.jsonc"), `{ "public": ["helper"] }\n`);
    writeFile(join(packDir, "plugin", "skills", "helper", "SKILL.md"), "---\nname: helper\n---\nbody\n");

    await skillsSurface(["set", "helper", "--internal", "--pack", "p", "--pack-dir", packDir]);

    expect(existsSync(join(packDir, "attachments", "helper", "SKILL.md"))).toBe(true);
    expect(existsSync(join(packDir, "plugin", "skills", "helper"))).toBe(false);
    expect(logs.join("\n")).toContain("moved helper: plugin/skills/ -> attachments/");
  });

  test("--dry-run names the same real source root the move would use", async () => {
    const packDir = makePackDir();
    writeFile(join(packDir, ".claude-plugin", "plugin.json"), JSON.stringify({ version: "1.0.0", skills: ["./skills/review", "./plugin/skills"] }));
    writeFile(join(packDir, "surface.jsonc"), `{ "public": ["helper"] }\n`);
    writeFile(join(packDir, "plugin", "skills", "helper", "SKILL.md"), "---\nname: helper\n---\nbody\n");

    await skillsSurface(["set", "helper", "--internal", "--dry-run", "--pack", "p", "--pack-dir", packDir]);

    expect(logs.join("\n")).toContain("would move helper: plugin/skills/ -> attachments/");
    expect(existsSync(join(packDir, "plugin", "skills", "helper", "SKILL.md"))).toBe(true);
  });

  test("set rewrites surface.jsonc without dropping its leading comment block", async () => {
    const packDir = makePackDir();
    const header = "// surface.jsonc -- names this pack's public skills.\n// Ratified 2026-08-21 (surface-ratchet amendment).\n";
    writeFile(join(packDir, "surface.jsonc"), `${header}{ "public": [] }\n`);
    writeFile(join(packDir, "attachments", "checkout", "SKILL.md"), "---\nname: checkout\n---\nbody\n");

    await skillsSurface(["set", "checkout", "--public", "--pack", "p", "--pack-dir", packDir]);

    const written = readFileSync(join(packDir, "surface.jsonc"), "utf8");
    expect(written.startsWith(header)).toBe(true);
    expect(written).toContain('"checkout"');
  });
});
