import { describe, test, expect } from "bun:test";
import { isProbablyUrl } from "../url.ts";

describe("isProbablyUrl", () => {
  test("accepts https and http urls", () => {
    expect(isProbablyUrl("https://x")).toBe(true);
    expect(isProbablyUrl("http://x")).toBe(true);
  });

  test("rejects connector keys and plain strings", () => {
    expect(isProbablyUrl("assured:pgr-qa")).toBe(false);
    expect(isProbablyUrl("assured-pgr-qa")).toBe(false);
    expect(isProbablyUrl("")).toBe(false);
  });
});
