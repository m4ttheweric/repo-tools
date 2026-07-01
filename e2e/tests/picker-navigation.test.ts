import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { createTestHome } from "../harness.ts";
import { startInteractive, type TermwrightSession } from "../interactive.ts";
import { createFixtureRepo, createMonorepoFixture } from "../fixtures.ts";

describe("picker navigation", () => {
  let home: string;
  let cleanup: () => void;
  let session: TermwrightSession | null = null;
  let monorepoPath: string;

  beforeAll(() => {
    ({ path: home, cleanup } = createTestHome());
    mkdirSync(join(home, ".rt"), { recursive: true });
    writeFileSync(join(home, ".rt", "daemon.json"), "{}");

    ({ path: monorepoPath } = createMonorepoFixture(home, {
      name: "nav-monorepo",
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

    createFixtureRepo(home, {
      name: "nav-simple",
      scripts: { dev: "echo dev", test: "echo test", lint: "echo lint" },
    });
  });

  afterEach(async () => {
    if (session) {
      await session.stop();
      session = null;
    }
  });

  afterAll(() => cleanup());

  test("subcommand picker: ctrl-up exits cleanly", async () => {
    session = await startInteractive({ args: [], home });
    await session.waitForText("filter:", 8000);

    await session.type("git");
    await session.waitForIdle();
    await session.press("Enter");
    await session.waitForText("rebase", 5000);

    await session.ctrl("up");

    const code = await session.exitCode;
    expect(code).toBe(0);
    session = null;
  }, 15_000);

  test("rt run: script picker -> ctrl-up -> package picker", async () => {
    session = await startInteractive({
      args: ["run"],
      home,
      cwd: monorepoPath,
    });
    await session.waitForText("Select package", 8000);

    await session.press("Enter");
    await session.waitForText("Select script", 5000);

    await session.ctrl("up");
    await session.waitForText("Select package", 5000);

    const screen = await session.screen();
    expect(screen).toContain("@test/web");
    expect(screen).toContain("@test/api");
  }, 15_000);

  test("rt run: package picker -> ctrl-up -> re-shows then exits (single worktree)", async () => {
    session = await startInteractive({
      args: ["run"],
      home,
      cwd: monorepoPath,
    });
    await session.waitForText("Select package", 8000);

    // First ctrl-up from the auto-resolved context re-enters via the
    // full picker chain (1 repo, 1 worktree -> both auto-selected)
    // and shows the package picker again.
    await session.ctrl("up");
    await session.waitForText("Select package", 5000);

    // Second ctrl-up propagates through the full chain to process.exit(0).
    await session.ctrl("up");

    const code = await session.exitCode;
    expect(code).toBe(0);
    session = null;
  }, 20_000);

  test("Escape at nested subcommand level exits cleanly", async () => {
    session = await startInteractive({ args: [], home });
    await session.waitForText("filter:", 8000);

    await session.type("git");
    await session.waitForIdle();
    await session.press("Enter");
    await session.waitForText("rebase", 5000);

    await session.press("Escape");

    const code = await session.exitCode;
    expect(code).toBe(0);
    session = null;
  }, 15_000);
});
