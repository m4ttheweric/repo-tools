import { describe, test, expect } from "bun:test";
import { coerceQueryParams } from "../api-server.ts";

describe("coerceQueryParams", () => {
  test("coerces maxAgeMs to a number (the documented cache:read flag)", () => {
    const out = coerceQueryParams(new URLSearchParams("maxAgeMs=60000"));
    expect(out.maxAgeMs).toBe(60000);
    expect(typeof out.maxAgeMs).toBe("number");
  });

  test("coerces refresh=true to a boolean (the documented ports flag)", () => {
    const out = coerceQueryParams(new URLSearchParams("refresh=true"));
    expect(out.refresh).toBe(true);
  });

  test("coerces refresh=false to a boolean false, not a truthy string", () => {
    const out = coerceQueryParams(new URLSearchParams("refresh=false"));
    expect(out.refresh).toBe(false);
  });

  test("leaves a non-numeric, non-boolean string alone", () => {
    const out = coerceQueryParams(new URLSearchParams("repo=my-repo-name"));
    expect(out.repo).toBe("my-repo-name");
  });

  test("leaves an empty string alone rather than coercing to 0", () => {
    const out = coerceQueryParams(new URLSearchParams("q="));
    expect(out.q).toBe("");
  });

  test("coerces a decimal number too", () => {
    const out = coerceQueryParams(new URLSearchParams("ratio=1.5"));
    expect(out.ratio).toBe(1.5);
  });
});
