/**
 * `rt team manage-membership` driven against the COMPILED `dist/rt` binary,
 * one hermetic HOME, no live tray app or daemon.
 *
 * `RT_APP_SOCKET=/nonexistent.sock` mirrors setup.test.ts: it keeps every
 * tray-socket probe failing the same deterministic way regardless of whether
 * this machine happens to have mattstack.app installed and running.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestHome, rt } from "../harness.ts";

describe("rt team manage-membership (e2e, no live app/daemon)", () => {
  let home: string;
  let cleanup: () => void;

  beforeAll(() => {
    ({ path: home, cleanup } = createTestHome());
  });
  afterAll(() => cleanup());

  function run(args: string[]) {
    return rt(args, { home, env: { RT_APP_SOCKET: "/nonexistent.sock" } });
  }

  test("an unknown state is a usage error at exit 2 with the envelope", async () => {
    const res = await run(["team", "manage-membership", "sideways", "--team", "acme", "--json"]);
    expect(res.exitCode).toBe(2);
    expect(JSON.parse(res.stdout.trim()).error.code).toBe("usage");
  }, 15_000);

  test("no local team is a user error, not a crash", async () => {
    const res = await run(["team", "manage-membership", "--json"]);
    expect(res.exitCode).toBe(2);
    expect(JSON.parse(res.stdout.trim()).error.code).toBe("no-team");
  }, 15_000);
});
