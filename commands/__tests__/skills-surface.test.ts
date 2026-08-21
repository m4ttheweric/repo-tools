import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "fs";
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
    writeStubs(packDir, { "my-verb": { engine: "my-verb", description: "Do the thing" } });
    writeFile(join(packDir, "skills", "hand-authored-public", "SKILL.md"), "---\nname: x\n---\nbody\n");
    writeFile(join(packDir, "attachments", "hand-authored-internal", "SKILL.md"), "---\nname: y\n---\nbody\n");

    await skillsSurface(["list", "--team", "t", "--pack-dir", packDir]);

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

  test("--internal on a compiled stub verb: surface.jsonc updated, apply removes the compiled dir (never git-mv'd)", async () => {
    const packDir = makePackDir();
    writeStubs(packDir, { "my-verb": { engine: "my-verb", description: "Do the thing" } });
    writeFile(join(packDir, "skills", "my-verb", "SKILL.md"), "---\nname: my-verb\n---\nold compiled content\n");
    const { mattstackDir, manifestPath } = makeEngineFixture();

    await skillsSurface([
      "set", "my-verb", "--internal",
      "--team", "t", "--pack-dir", packDir, "--mattstack-dir", mattstackDir, "--manifest", manifestPath,
    ]);

    expect(existsSync(join(packDir, "skills", "my-verb"))).toBe(false);
    expect(existsSync(join(packDir, "attachments", "my-verb"))).toBe(false);

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
    const { rows } = computeRows(packDir, new Set(), surface);

    const ghostRow = rows.find((r) => r.name === "ghost");
    expect(ghostRow).toEqual({ name: "ghost", kind: "missing", status: "public" });
    const realRow = rows.find((r) => r.name === "real-skill");
    expect(realRow?.status).toBe("public");
  });

  test("combined with decidePaletteAction: leaving the missing row untouched yields no delta", () => {
    const packDir = makePackDir();
    writeStubs(packDir, {});

    const surface = { public: ["ghost"] };
    const { rows } = computeRows(packDir, new Set(), surface);
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
    const { rows } = computeRows(packDir, new Set(), surface);
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
