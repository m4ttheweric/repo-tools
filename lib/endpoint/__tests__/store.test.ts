import { describe, expect, test } from "bun:test";
import { claimsEpoch, loadClaims, saveClaims } from "../store.ts";

describe("claims store", () => {
  test("load on missing file returns empty and tolerates junk", () => {
    expect(loadClaims("fresh-repo")).toEqual([]);
  });

  test("round-trips claims atomically and bumps the epoch", () => {
    const before = claimsEpoch("r1");
    const claim = { worktree: "/tmp/wt-a", role: "backend", port: 10400, pid: 123, ts: new Date().toISOString() };
    saveClaims("r1", [claim]);
    expect(loadClaims("r1")).toEqual([claim]);
    expect(claimsEpoch("r1")).toBe(before + 1);
  });

  test("epochs are per-repo", () => {
    const r2 = claimsEpoch("r2");
    saveClaims("r3", []);
    expect(claimsEpoch("r2")).toBe(r2);
  });
});
