/**
 * state.db is created ON DEMAND, never on module load (RT-48, spec test 11).
 *
 * The whole no-module-load-db-access rule of lib/state/db.ts only pays off
 * if it holds in the SHIPPED binary, where every command module is bundled
 * together and a single stray top-level `getStateDb()` — or a store
 * constructed at import time — would open (and migrate) the database for
 * `rt --version`. A unit test cannot see that: it imports one module. So
 * this one spawns the real binary against a fresh HOME and looks at the
 * filesystem.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { createTestHome, rt } from "../harness.ts";

describe("stateless CLI commands create no state.db", () => {
  let home: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ path: home, cleanup } = createTestHome());
  });

  afterEach(() => cleanup());

  const rtDir = () => join(home, ".mattstack", "rt");

  test("rt --version leaves no database behind", async () => {
    const result = await rt(["--version"], { home });
    expect(result.exitCode).toBe(0);

    // Not just the db: no WAL sidecars either — those appear the moment a
    // connection is opened, even one that writes nothing.
    for (const name of ["state.db", "state.db-wal", "state.db-shm"]) {
      expect(existsSync(join(rtDir(), name)), `${name} must not exist`).toBe(false);
    }
  }, 30_000);

  test("rt --help leaves no database behind", async () => {
    const result = await rt(["--help"], { home });
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(rtDir(), "state.db"))).toBe(false);
  }, 30_000);

  test("an unknown command leaves no database behind", async () => {
    const result = await rt(["definitely-not-a-command"], { home });
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(join(rtDir(), "state.db"))).toBe(false);
    // Whatever the rt dir does hold (logs, config), nothing sqlite-shaped.
    const stray = existsSync(rtDir())
      ? readdirSync(rtDir()).filter((f) => f.startsWith("state.db"))
      : [];
    expect(stray).toEqual([]);
  }, 30_000);
});
