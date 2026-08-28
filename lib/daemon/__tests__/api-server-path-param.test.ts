import { describe, test, expect } from "bun:test";
import { pathParam } from "../api-server.ts";

describe("pathParam", () => {
  test("decodes a clean prefix-only param", () => {
    expect(pathParam("/api/cache/main", "/api/cache/")).toBe("main");
  });

  test("decodes a URL-encoded segment", () => {
    expect(pathParam("/api/cache/feature%2Ffoo", "/api/cache/")).toBe("feature/foo");
  });

  test("returns undefined for malformed %-encoding instead of throwing", () => {
    expect(pathParam("/api/cache/%E0%A4%A", "/api/cache/")).toBeUndefined();
  });

  test("returns undefined when the pathname doesn't start with the prefix", () => {
    expect(pathParam("/api/other/main", "/api/cache/")).toBeUndefined();
  });

  test("handles a prefix+suffix pair (hooks repair shape)", () => {
    expect(pathParam("/api/hooks/my-repo/repair", "/api/hooks/", "/repair")).toBe("my-repo");
  });

  test("prefix+suffix: malformed encoding still returns undefined", () => {
    expect(pathParam("/api/hooks/%E0%A4%A/repair", "/api/hooks/", "/repair")).toBeUndefined();
  });

  test("prefix+suffix: wrong suffix returns undefined", () => {
    expect(pathParam("/api/hooks/my-repo/other", "/api/hooks/", "/repair")).toBeUndefined();
  });

  test("an empty captured segment returns undefined", () => {
    expect(pathParam("/api/cache/", "/api/cache/")).toBeUndefined();
  });
});
