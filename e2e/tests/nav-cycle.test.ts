import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createTestHome } from "../harness.ts";
import { startInteractive, type TermwrightSession } from "../interactive.ts";

describe("nav cyclic scroll", () => {
  let home: string;
  let cleanup: () => void;
  let session: TermwrightSession | null = null;
  let dir: string;

  beforeAll(() => {
    ({ path: home, cleanup } = createTestHome());
    dir = mkdtempSync(join(tmpdir(), "nav-cycle-"));
    // Folders, not files: enter on a folder descends into it, and the border
    // label then shows which one, revealing where the cursor was. Enter on a
    // FILE would shell out to `open` and launch a real application, so this
    // suite never does that.
    for (const name of ["aaa", "mmm", "zzz"]) {
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, "inside.txt"), "x");
    }
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

  test("up arrow at the top of the list wraps to the bottom", async () => {
    session = await startInteractive({ args: ["nav", dir], home });
    await session.waitForText("aaa");
    await session.waitForIdle(300, 10_000);

    // Cursor opens on the first row (aaa). One press up wraps to the last (zzz).
    await session.press("up");
    await session.waitForIdle(300, 10_000);
    await session.press("enter");

    // Descending shows the entered directory in the border label.
    await session.waitForText("inside.txt", 10_000);
    const screen = await session.screen();
    expect(screen).toContain("zzz");
    expect(screen).not.toContain("mmm");
  });

  test("down arrow at the bottom of the list wraps to the top", async () => {
    session = await startInteractive({ args: ["nav", dir], home });
    await session.waitForText("zzz");
    await session.waitForIdle(300, 10_000);

    // Walk to the last row, then one more down wraps back to the first (aaa).
    await session.press("down");
    await session.press("down");
    await session.waitForIdle(300, 10_000);
    await session.press("down");
    await session.waitForIdle(300, 10_000);
    await session.press("enter");

    await session.waitForText("inside.txt", 10_000);
    const screen = await session.screen();
    expect(screen).toContain("aaa");
    expect(screen).not.toContain("mmm");
  });
});
