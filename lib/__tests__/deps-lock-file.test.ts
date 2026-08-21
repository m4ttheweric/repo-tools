import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { parseDepsLock } from "../bundle-layout.ts";

const LOCK_PATH = join(import.meta.dir, "..", "..", "rt-tray", "deps.lock");

describe("rt-tray/deps.lock", () => {
  const lock = parseDepsLock(readFileSync(LOCK_PATH, "utf8"));

  test("parses under the schema", () => {
    expect(lock.schema).toBe(1);
    expect(lock.arch).toBe("arm64");
  });
  test("carries the ruling-8 bundle set, with deck/board/gitq pending until L5", () => {
    const by = Object.fromEntries(lock.tools.map((t) => [t.name, t]));
    for (const n of ["fzf", "jq", "gh", "glab", "bun", "node", "fast-browser"]) expect(by[n]?.status).toBe("bundled");
    for (const n of ["deck", "board", "gitq", "mattstack-proxy-install"]) expect(by[n]?.status).toBe("pending");
    expect(by["sparkle"]?.kind).toBe("buildtool");
  });
  test("default-exposed set is exactly fast-browser, gitq, deck (rt is exposed by the binary link, not a helper)", () => {
    const exposed = lock.tools.filter((t) => t.exposeByDefault).map((t) => t.name).sort();
    expect(exposed).toEqual(["deck", "fast-browser", "gitq"]);
  });
  test("bun-based helpers declare jit entitlements; Go/C helpers declare none", () => {
    const by = Object.fromEntries(lock.tools.map((t) => [t.name, t]));
    expect(by["bun"]!.entitlements).toBe("jit");
    expect(by["node"]!.entitlements).toBe("jit");
    for (const n of ["fzf", "jq", "gh", "glab"]) expect(by[n]!.entitlements).toBe("none");
  });
});
