import { describe, expect, test } from "bun:test";
import { failureDetail } from "../steps/home.ts";

describe("failureDetail", () => {
  // The exact shape that reached CI: bun's crash frame arrived first and the
  // real exception was thrown away, so the app showed a source line.
  test("skips bun crash frames and reports the exception", () => {
    const stderr = [
      "79828 |     console.error(`[age-key] ${cmd.join(\" \")}`);",
      "                 ^",
      "error: age-keygen exited 127: command not found",
      "    at run (/$bunfs/root/rt:79828:13)",
    ].join("\n");
    expect(failureDetail(stderr)).toBe("error: age-keygen exited 127: command not found");
  });

  test("a clean single-line failure is unchanged", () => {
    expect(failureDetail("fatal: could not read Username for 'https://github.com'")).toBe(
      "fatal: could not read Username for 'https://github.com'",
    );
  });

  test("falls back to the first non-frame line when nothing names an error", () => {
    expect(failureDetail("12 | x\n    ^\nsomething unusual happened")).toBe("something unusual happened");
  });

  test("empty stderr yields an empty detail rather than throwing", () => {
    expect(failureDetail("   \n  \n")).toBe("");
  });
});
