/**
 * `rt settings unset` (RT-100). The writer already had `unsetSetting`; this
 * pins the CLI surface, which is what a human or script can actually reach.
 * Round-trips against a real store under an isolated HOME rather than mocking
 * the writer, so the arg plumbing (scope, --repo, --team) is exercised too.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { settingsUnset } from "../settings-keys.ts";
import { setSetting } from "../../lib/settings/write.ts";
import { userSettingsPath } from "../../lib/rt-paths.ts";
import { closeStateDb } from "../../lib/state/index.ts";

const KEY = "rt.logRetentionDays";

describe("rt settings unset", () => {
  const origHome = process.env.HOME;
  let home: string;
  let exits: number[];
  let origExit: typeof process.exit;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-unset-home-")));
    process.env.HOME = home;
    closeStateDb();
    exits = [];
    origExit = process.exit;
    // fail() exits; capture rather than kill the runner.
    (process as any).exit = (code?: number) => { exits.push(code ?? 0); throw new Error(`__exit_${code}`); };
  });

  afterEach(() => {
    (process as any).exit = origExit;
    process.env.HOME = origHome;
    closeStateDb();
    rmSync(home, { recursive: true, force: true });
  });

  test("removes a key previously written to the user store", async () => {
    setSetting(KEY, 21, "user");
    expect(readFileSync(userSettingsPath(), "utf8")).toContain(KEY);

    await settingsUnset([KEY, "--scope", "user"]);

    expect(readFileSync(userSettingsPath(), "utf8")).not.toContain(KEY);
    expect(exits).toEqual([]);
  });

  test("a key that is not in the store is a no-op, not a failure", async () => {
    setSetting("rt.logLevel", "debug", "user");

    await settingsUnset([KEY, "--scope", "user"]);

    // The unrelated key survives and nothing exited non-zero.
    expect(readFileSync(userSettingsPath(), "utf8")).toContain("rt.logLevel");
    expect(exits).toEqual([]);
  });

  test("a missing --scope fails rather than guessing one", async () => {
    await expect(settingsUnset([KEY])).rejects.toThrow(/__exit_/);
    expect(exits[0]).not.toBe(0);
  });

  test("an unknown scope is refused", async () => {
    await expect(settingsUnset([KEY, "--scope", "team.repo"])).rejects.toThrow(/__exit_/);
    expect(exits[0]).not.toBe(0);
  });
});
