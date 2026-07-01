import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { createTestHome } from "../harness.ts";
import { startInteractive, type TermwrightSession } from "../interactive.ts";
import { createMonorepoFixture } from "../fixtures.ts";

describe("picker separators", () => {
  let home: string;
  let cleanup: () => void;
  let session: TermwrightSession | null = null;
  let monorepoPath: string;

  beforeAll(() => {
    ({ path: home, cleanup } = createTestHome());
    mkdirSync(join(home, ".rt"), { recursive: true });
    writeFileSync(join(home, ".rt", "daemon.json"), "{}");

    ({ path: monorepoPath } = createMonorepoFixture(home, {
      name: "sep-monorepo",
      packages: [
        {
          name: "@test/web",
          path: "packages/web",
          scripts: { dev: "echo web-dev", test: "echo web-test" },
        },
        {
          name: "@test/api",
          path: "packages/api",
          scripts: { dev: "echo api-dev", test: "echo api-test" },
        },
      ],
    }));
  });

  afterEach(async () => {
    if (session) {
      await session.stop();
      session = null;
    }
  });

  afterAll(() => cleanup());

  // Queue a script by selecting a package, then pressing Tab at the
  // script picker. Returns with the package picker re-shown, now
  // containing queued items + separator + package list.
  async function queueOneScript(s: TermwrightSession): Promise<void> {
    await s.waitForText("Select package", 8000);
    await s.press("Enter");
    await s.waitForText("Select script", 5000);
    await s.press("Tab");
    await s.waitForText("Launch all", 5000);
  }

  test("Down arrow skips separator", async () => {
    session = await startInteractive({
      args: ["run"],
      home,
      cwd: monorepoPath,
    });
    await queueOneScript(session);

    // Package picker now shows:
    //   queued-item-row         (pos 1)
    //   Launch all (1 queued)   (pos 2)
    //   ──────────────          (pos 3, separator)
    //   @test/web               (pos 4, cursor starts here)
    //   @test/api               (pos 5)
    //
    // Move up to "Launch all", then down. Down should skip the
    // separator and land on @test/web.
    await session.press("Up");
    await session.waitForIdle();
    await session.press("Down");
    await session.waitForIdle();

    // Verify by pressing Enter. If we landed on @test/web, we see
    // the script picker. If we landed on the separator, the picker
    // re-shows (separator selection is a no-op).
    await session.press("Enter");
    await session.waitForText("Select script", 5000);

    const screen = await session.screen();
    expect(screen).toContain("dev");
    expect(screen).toContain("test");
  }, 20_000);

  test("Up arrow skips separator", async () => {
    session = await startInteractive({
      args: ["run"],
      home,
      cwd: monorepoPath,
    });
    await queueOneScript(session);

    // Cursor starts on @test/web (pos 4). Move down to @test/api,
    // then up twice: first to @test/web, then should skip separator
    // to "Launch all".
    await session.press("Down");
    await session.waitForIdle();
    await session.press("Up");
    await session.waitForIdle();
    await session.press("Up");
    await session.waitForIdle();

    // Press Enter. If on "Launch all", rt launches the queued script
    // (echo web-dev), which runs and exits. If on the separator, the
    // picker re-shows and the process stays alive.
    await session.press("Enter");

    // If "Launch all" was selected, the process exits after running
    // the queued script. A clean exit proves the separator was skipped.
    const code = await session.exitCode;
    expect(code).toBeDefined();
    session = null;
  }, 20_000);

  test("rapid navigation through separator zone survives", async () => {
    session = await startInteractive({
      args: ["run"],
      home,
      cwd: monorepoPath,
    });
    await queueOneScript(session);

    // Navigate rapidly through the separator zone
    for (let i = 0; i < 6; i++) {
      await session.press(i % 2 === 0 ? "Down" : "Up");
      await session.waitForIdle(200, 3000);
    }

    // Picker is still alive and responsive
    const screen = await session.screen();
    expect(screen).toContain("Select package");
  }, 20_000);
});
