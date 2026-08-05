import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createTestHome } from "../harness.ts";
import { startInteractive, type TermwrightSession } from "../interactive.ts";

describe("nav live refresh", () => {
  let home: string;
  let cleanup: () => void;
  let session: TermwrightSession | null = null;
  let dir: string;

  beforeAll(() => {
    ({ path: home, cleanup } = createTestHome());
    dir = mkdtempSync(join(tmpdir(), "nav-live-"));
    writeFileSync(join(dir, "seed.txt"), "seed");
  });

  afterEach(async () => {
    if (session) {
      await session.stop();
      session = null;
    }
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    cleanup();
  });

  test("a file created while the picker is open appears in the list", async () => {
    session = await startInteractive({ args: ["nav", dir], home });
    await session.waitForText("seed.txt");

    writeFileSync(join(dir, "appeared.txt"), "new");
    await session.waitForText("appeared.txt", 10_000);

    const screen = await session.screen();
    expect(screen).toContain("appeared.txt");
    expect(screen).toContain("seed.txt");
  });

  test("a file deleted while the picker is open leaves the list", async () => {
    const doomed = join(dir, "doomed.txt");
    writeFileSync(doomed, "x");
    session = await startInteractive({ args: ["nav", dir], home });
    await session.waitForText("doomed.txt");

    rmSync(doomed);
    // waitForText cannot assert absence, so settle then read the screen once.
    await session.waitForIdle(1_000, 10_000);
    const screen = await session.screen();
    expect(screen).not.toContain("doomed.txt");
    expect(screen).toContain("seed.txt");
  });
});
