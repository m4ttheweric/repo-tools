import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { createTestHome } from "../harness.ts";
import { startInteractive, type TermwrightSession } from "../interactive.ts";

describe("picker basics", () => {
  let home: string;
  let cleanup: () => void;
  let session: TermwrightSession | null = null;

  beforeAll(() => {
    ({ path: home, cleanup } = createTestHome());
    mkdirSync(join(home, ".mattstack", "rt"), { recursive: true });
    writeFileSync(join(home, ".mattstack", "rt", "daemon.json"), "{}");
  });

  afterEach(async () => {
    if (session) {
      await session.stop();
      session = null;
    }
  });

  afterAll(() => cleanup());

  test("top-level picker renders with all commands", async () => {
    session = await startInteractive({ args: [], home });
    await session.waitForText("filter:", 8000);

    const screen = await session.screen();
    expect(screen).toContain("git");
    expect(screen).toContain("run");
    expect(screen).toContain("commit");
    expect(screen).toContain("cd");
    expect(screen).toContain("version");
  }, 15_000);

  test("Down + Enter selects non-first item", async () => {
    session = await startInteractive({ args: [], home });
    await session.waitForText("filter:", 8000);

    // First item is "git" (index 0). "daemon" sits at index 22 and is a
    // pure branch node (subcommands, no top-level fn), so Enter opens its
    // subpicker instead of dispatching a command.
    for (let i = 0; i < 22; i++) await session.press("Down");
    await session.waitForIdle();
    await session.press("Enter");

    await session.waitForText("logs", 5000);
    const screen = await session.screen();
    expect(screen).toContain("status");
    expect(screen).not.toContain("version");
  }, 15_000);

  test("filter narrows options", async () => {
    session = await startInteractive({ args: [], home });
    await session.waitForText("filter:", 8000);

    await session.type("ver");
    await session.waitForIdle();

    const screen = await session.screen();
    expect(screen).toContain("version");
    expect(screen).not.toContain("git");
  }, 15_000);

  test("filter + Enter dispatches selected command", async () => {
    session = await startInteractive({ args: [], home });
    await session.waitForText("filter:", 8000);

    await session.type("vers");
    await session.waitForIdle();
    await session.press("Enter");

    await session.waitForText("rt ", 5000);
  }, 15_000);

  test("Escape exits cleanly", async () => {
    session = await startInteractive({ args: [], home });
    await session.waitForText("filter:", 8000);

    await session.press("Escape");

    const code = await session.exitCode;
    expect(code).toBe(0);
    session = null;
  }, 15_000);
});
