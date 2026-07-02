import { describe, expect, test } from "bun:test";
import { redactSensitiveArgs } from "../cli-logger.ts";

describe("redactSensitiveArgs", () => {
  test("redacts the value following --reason", () => {
    expect(redactSensitiveArgs(["sdm", "connect", "k", "--reason", "secret text"])).toEqual([
      "sdm",
      "connect",
      "k",
      "--reason",
      "[redacted]",
    ]);
  });

  test("redacts the --reason=value form", () => {
    expect(redactSensitiveArgs(["sdm", "connect", "k", "--reason=secret"])).toEqual([
      "sdm",
      "connect",
      "k",
      "--reason=[redacted]",
    ]);
  });

  test("leaves other args untouched", () => {
    const args = ["sdm", "connect", "k", "--duration", "8h"];
    expect(redactSensitiveArgs(args)).toEqual(args);
  });

  test("handles a trailing --reason with no value without throwing", () => {
    expect(() => redactSensitiveArgs(["sdm", "connect", "k", "--reason"])).not.toThrow();
    expect(redactSensitiveArgs(["sdm", "connect", "k", "--reason"])).toEqual([
      "sdm",
      "connect",
      "k",
      "--reason",
    ]);
  });

  test("does not mutate the input array", () => {
    const args = ["--reason", "secret"];
    redactSensitiveArgs(args);
    expect(args).toEqual(["--reason", "secret"]);
  });
});
