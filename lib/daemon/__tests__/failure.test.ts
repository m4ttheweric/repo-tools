import { describe, expect, test } from "bun:test";
import { deriveFailure } from "../failure.ts";

describe("deriveFailure", () => {
  test("an Error with a string .code surfaces that code and message", () => {
    const err = Object.assign(new Error("boom"), { code: "ENOENT" });
    expect(deriveFailure(err)).toEqual({ code: "ENOENT", message: "boom" });
  });

  test("an Error with no .code falls back to handler-threw", () => {
    expect(deriveFailure(new Error("plain failure"))).toEqual({
      code: "handler-threw",
      message: "plain failure",
    });
  });

  test("a non-Error throw is stringified for the message", () => {
    expect(deriveFailure("raw string throw")).toEqual({
      code: "handler-threw",
      message: "raw string throw",
    });
  });

  test("a non-string .code is ignored, not surfaced", () => {
    expect(deriveFailure({ code: 42, message: "ignored" })).toEqual({
      code: "handler-threw",
      message: "[object Object]",
    });
  });
});
