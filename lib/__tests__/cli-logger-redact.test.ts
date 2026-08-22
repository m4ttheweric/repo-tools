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

  describe("secrets set|rotate: anything past <domain> <key> is redacted, defense in depth", () => {
    test("raw argv shape (installCliLogging's seed) — the 'secrets set' prefix is still in the array", () => {
      expect(redactSensitiveArgs(["secrets", "set", "rt", "gitlabToken", "glpat-canary-value"])).toEqual([
        "secrets",
        "set",
        "rt",
        "gitlabToken",
        "[redacted]",
      ]);
    });

    test("raw argv shape: rotate, multiple trailing tokens all redacted", () => {
      expect(redactSensitiveArgs(["secrets", "rotate", "board", "slackToken", "canary-1", "canary-2"])).toEqual([
        "secrets",
        "rotate",
        "board",
        "slackToken",
        "[redacted]",
        "[redacted]",
      ]);
    });

    test("raw argv shape: exactly domain+key, nothing to redact", () => {
      const args = ["secrets", "set", "rt", "gitlabToken"];
      expect(redactSensitiveArgs(args)).toEqual(args);
    });

    test("leaf `rest` shape (logCommand's entry.args) — command carries the 'secrets set' context", () => {
      expect(redactSensitiveArgs(["rt", "gitlabToken", "glpat-canary-value"], "rt secrets set")).toEqual([
        "rt",
        "gitlabToken",
        "[redacted]",
      ]);
    });

    test("leaf `rest` shape: rotate", () => {
      expect(redactSensitiveArgs(["board", "slackToken", "canary-value"], "rt secrets rotate")).toEqual([
        "board",
        "slackToken",
        "[redacted]",
      ]);
    });

    test("a command that merely mentions 'secrets' elsewhere is not treated as a write verb", () => {
      const args = ["rt"];
      expect(redactSensitiveArgs(args, "rt secrets list")).toEqual(args);
    });

    test("unrelated commands are never affected by the secrets-write check", () => {
      const args = ["sdm", "connect", "k"];
      expect(redactSensitiveArgs(args, "rt sdm connect")).toEqual(args);
    });
  });

  describe("a pasted age private key (AGE-SECRET-KEY-1...) is redacted wherever it appears, command-independent", () => {
    test("under the home key import label — the guard it's meant to back up", () => {
      expect(redactSensitiveArgs(["home", "key", "import", "AGE-SECRET-KEY-1QQQ"], "rt home key import")).toEqual([
        "home",
        "key",
        "import",
        "[redacted]",
      ]);
    });

    test("under an arbitrary other command label — not gated on home key import specifically", () => {
      expect(redactSensitiveArgs(["sdm", "connect", "AGE-SECRET-KEY-1QQQ"], "rt sdm connect")).toEqual([
        "sdm",
        "connect",
        "[redacted]",
      ]);
    });
  });
});
