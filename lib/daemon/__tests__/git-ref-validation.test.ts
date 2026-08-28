import { describe, test, expect } from "bun:test";
import { isSafeGitRef, validateGitRef } from "../git-ref-validation.ts";

describe("isSafeGitRef", () => {
  test("a normal branch name is safe", () => {
    expect(isSafeGitRef("feature/my-branch")).toBe(true);
  });

  test("a leading dash is unsafe (option injection)", () => {
    expect(isSafeGitRef("--upload-pack=touch /tmp/x")).toBe(false);
  });

  test("a bare dash is unsafe", () => {
    expect(isSafeGitRef("-")).toBe(false);
  });

  test("an empty string is unsafe", () => {
    expect(isSafeGitRef("")).toBe(false);
  });

  test("a branch containing a dash mid-name is safe", () => {
    expect(isSafeGitRef("job/p3-trust-boundary")).toBe(true);
  });
});

describe("validateGitRef", () => {
  test("returns ok:true for a safe ref", () => {
    expect(validateGitRef("main")).toEqual({ ok: true });
  });

  test("returns ok:false with the offending ref named in the error for an unsafe one", () => {
    const result = validateGitRef("--upload-pack=x");
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toContain("--upload-pack=x");
  });
});
