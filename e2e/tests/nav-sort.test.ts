import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createTestHome } from "../harness.ts";
import { startInteractive, type TermwrightSession } from "../interactive.ts";

describe("nav sort menu", () => {
  let home: string;
  let cleanup: () => void;
  let session: TermwrightSession | null = null;
  let dir: string;

  beforeAll(() => {
    ({ path: home, cleanup } = createTestHome());
    dir = mkdtempSync(join(tmpdir(), "nav-sort-e2e-"));
    // Name order and size order disagree on purpose: alphabetically aaa comes
    // first, but zzz is the larger file, so a size sort has to move it up.
    writeFileSync(join(dir, "aaa-small.txt"), "x");
    writeFileSync(join(dir, "zzz-large.txt"), "x".repeat(20_000));
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

  test("opens sorted by name, and ctrl-s can switch it to size", async () => {
    session = await startInteractive({ args: ["nav", dir], home });
    await session.waitForText("aaa-small.txt");

    const byName = await session.screen();
    expect(byName.indexOf("aaa-small.txt")).toBeLessThan(byName.indexOf("zzz-large.txt"));
    // Default sort is not announced in the border label.
    expect(byName).not.toContain("largest first");

    // Settle before each ctrl-s: every sort change exits fzf and respawns it,
    // and a key sent into that gap is swallowed rather than delivered.
    await session.waitForIdle(300, 10_000);
    await session.ctrl("s");
    await session.waitForText("Sort by", 15_000);
    await session.type("size");
    await session.press("enter");

    await session.waitForText("largest first", 15_000);
    const bySize = await session.screen();
    // Larger file now above the alphabetically-earlier one.
    expect(bySize.indexOf("zzz-large.txt")).toBeLessThan(bySize.indexOf("aaa-small.txt"));
    expect(bySize).toContain("Size, largest first");
  });

  test("choosing the active sort again reverses it", async () => {
    session = await startInteractive({ args: ["nav", dir], home });
    await session.waitForText("aaa-small.txt");

    // Settle before each ctrl-s: every sort change exits fzf and respawns it,
    // and a key sent into that gap is swallowed rather than delivered.
    await session.waitForIdle(300, 10_000);
    await session.ctrl("s");
    await session.waitForText("Sort by", 15_000);
    await session.type("size");
    await session.press("enter");
    await session.waitForText("largest first", 15_000);

    // Same option a second time flips the direction, Finder column-header style.
    await session.waitForIdle(300, 10_000);
    await session.ctrl("s");
    await session.waitForText("Sort by", 15_000);
    await session.type("size");
    await session.press("enter");

    await session.waitForText("smallest first", 15_000);
    const reversed = await session.screen();
    expect(reversed.indexOf("aaa-small.txt")).toBeLessThan(reversed.indexOf("zzz-large.txt"));
  });
});
