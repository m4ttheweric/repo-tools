import { describe, expect, test } from "bun:test";
import { assertNoPlaceholders, findPlaceholders } from "../placeholders.ts";

describe("findPlaceholders", () => {
  test("finds kind, arg, and 1-indexed line", () => {
    const body = "intro\n{{slot:tiering}}\nmid {{work-type}} tail\n{{include:review-core-body}}";
    expect(findPlaceholders(body)).toEqual([
      { kind: "slot", arg: "tiering", line: 2, raw: "{{slot:tiering}}" },
      { kind: "work-type", arg: null, line: 3, raw: "{{work-type}}" },
      { kind: "include", arg: "review-core-body", line: 4, raw: "{{include:review-core-body}}" },
    ]);
  });

  test("ignores braces that are not placeholders", () => {
    expect(findPlaceholders("json {\"a\":1} and {single}")).toEqual([]);
  });
});

describe("assertNoPlaceholders", () => {
  test("passes a clean body", () => {
    expect(() => assertNoPlaceholders("no braces here", "work")).not.toThrow();
  });

  test("names placeholder, engine, and line", () => {
    expect(() => assertNoPlaceholders("a\nb {{stage.dir}} c", "stage-plan")).toThrow(
      "stage-plan: unfilled placeholder {{stage.dir}} at line 2",
    );
  });
});
