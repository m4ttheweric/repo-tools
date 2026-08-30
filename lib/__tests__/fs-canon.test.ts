import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { canon } from "../fs-canon.ts";

describe("canon", () => {
  test("an existing path canonicalizes via realpath", () => {
    const dir = mkdtempSync(join(tmpdir(), "rt-fs-canon-"));
    expect(canon(dir)).toBe(realpathSync(dir));
  });

  // Chosen semantics: realpath when it resolves, else the input path
  // UNCHANGED. This is deliberately NOT a parent-walk (resolve the deepest
  // existing ancestor and reattach the missing tail) -- a parent-walking
  // canon would canonicalize a missing path's existing prefix (e.g. macOS's
  // /var -> /private/var) while every other caller compares the literal
  // input, producing a mismatched match set between canon's callers. One
  // shared canon() must behave the same for all of them, so a missing path
  // returns exactly what was passed in.
  test("a missing path returns unchanged, not parent-walked", () => {
    const dir = mkdtempSync(join(tmpdir(), "rt-fs-canon-"));
    const missing = join(dir, "does", "not", "exist");
    expect(canon(missing)).toBe(missing);
  });
});
