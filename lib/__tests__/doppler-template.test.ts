import { describe, expect, test } from "bun:test";
import { loadTemplate } from "../doppler-template.ts";

describe("doppler-template parsing", () => {
  test("returns null when nothing was declared (undefined)", () => {
    expect(loadTemplate(undefined)).toBeNull();
  });

  test("returns null when the value isn't array-shaped", () => {
    expect(loadTemplate({ oops: true })).toBeNull();
  });

  test("parses a valid entry array", () => {
    expect(loadTemplate([
      { path: "apps/backend", project: "backend", config: "dev" },
      { path: "apps/frontend", project: "frontend", config: "dev" },
    ])).toEqual([
      { path: "apps/backend", project: "backend", config: "dev" },
      { path: "apps/frontend", project: "frontend", config: "dev" },
    ]);
  });

  test("filters out entries missing a required field", () => {
    expect(loadTemplate([
      { path: "apps/backend", project: "backend", config: "dev" },
      { path: "apps/broken" },
    ])).toEqual([
      { path: "apps/backend", project: "backend", config: "dev" },
    ]);
  });

  test("an empty array resolves to an empty template, not null", () => {
    expect(loadTemplate([])).toEqual([]);
  });
});
