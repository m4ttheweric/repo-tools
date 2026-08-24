import { describe, expect, test } from "bun:test";
import { failureDetail, homeInitRemedy } from "../steps/home.ts";

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

// ─── remedy for a missing binary ─────────────────────────────────────────────

describe("homeInitRemedy: missing executable", () => {
  // The exact stderr that dead-ended every clean-Mac install. The old remedy
  // was "Check the error above, then Retry" — true, and unactionable.
  test("names the tool, and maps age-keygen to the package that provides it", () => {
    const remedy = homeInitRemedy('error: Executable not found in $PATH: "age-keygen"');
    expect(remedy).toContain("age-keygen");
    expect(remedy).toContain("reinstall mattstack.app");
    expect(remedy).toContain("brew install age"); // the formula is `age`, not `age-keygen`
  });

  test("a tool whose name matches its package is not rewritten", () => {
    expect(homeInitRemedy('error: Executable not found in $PATH: "sops"')).toContain("brew install sops");
  });

  // The missing-binary check runs first precisely because this stderr would
  // otherwise fall through to the auth heuristics.
  test("takes precedence over the auth remedy", () => {
    const remedy = homeInitRemedy('error: Executable not found in $PATH: "sops"\npermission denied');
    expect(remedy).not.toContain("gh auth login");
  });

  test("a genuine auth failure still gets the auth remedy", () => {
    expect(homeInitRemedy('fatal: could not read Username for \'https://github.com\'')).toContain("gh auth login");
  });
});
