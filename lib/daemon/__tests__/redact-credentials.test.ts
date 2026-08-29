import { describe, test, expect } from "bun:test";
import { redactCredentials } from "../redact-credentials.ts";

describe("redactCredentials", () => {
  test("redacts userinfo (user:token@) out of an https remote URL", () => {
    const input = "https://oauth2:glpat-XXXXXXXXXXXXXXXXXXXX@gitlab.example.com/g/p.git";
    const out = redactCredentials(input);
    expect(out).not.toContain("glpat-XXXXXXXXXXXXXXXXXXXX");
    expect(out).toContain("gitlab.example.com/g/p.git");
  });

  test("redacts a GitHub PAT embedded in the URL", () => {
    const input = "https://ghp_abcdefghijklmnopqrstuvwxyz012345@github.com/o/r.git";
    const out = redactCredentials(input);
    expect(out).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz012345");
    expect(out).toContain("github.com/o/r.git");
  });

  test("leaves a URL with no embedded credentials unchanged", () => {
    const input = "https://gitlab.example.com/g/p.git";
    expect(redactCredentials(input)).toBe(input);
  });

  test("leaves plain text with no URL unchanged", () => {
    const input = "local branch listing failed";
    expect(redactCredentials(input)).toBe(input);
  });

  test("redacts every match when more than one credential-bearing URL appears in the same string", () => {
    const input = "tried https://oauth2:tok1@a.example/x then https://oauth2:tok2@b.example/y";
    const out = redactCredentials(input);
    expect(out).not.toContain("tok1");
    expect(out).not.toContain("tok2");
  });
});
