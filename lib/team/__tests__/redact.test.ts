import { describe, expect, test } from "bun:test";
import { withoutUrls } from "../redact.ts";

describe("withoutUrls", () => {
  test("redacts a credential-bearing https remote", () => {
    const in_ = "fatal: unable to access 'https://x-access-token:ghp_SECRET123@github.com/a/b.git/': 403";
    expect(withoutUrls(in_)).toBe("fatal: unable to access '<remote> 403");
  });

  test("redacts a bare git@ ssh remote", () => {
    expect(withoutUrls("Permission denied: git@github.com:acme/team.git")).toBe("Permission denied: <remote>");
  });

  test("redacts git's own HTTP Basic rejection wording — a token outside any URL", () => {
    const in_ = "remote: HTTP Basic: Access denied for user 'oauth2' with token glpat-SECRET123abc";
    expect(withoutUrls(in_)).toBe("remote: HTTP Basic: Access denied for user 'oauth2' with token <redacted>");
  });

  test("redacts a token=<value> shape with no surrounding URL", () => {
    expect(withoutUrls("cloning from github.com/a/b using token=ghp_SECRET123")).toBe("cloning from github.com/a/b using token=<redacted>");
  });

  test.each([
    ["ghp_abc123XYZ", "github classic PAT"],
    ["gho_abc123XYZ", "github oauth token"],
    ["ghu_abc123XYZ", "github user token"],
    ["ghs_abc123XYZ", "github server token"],
    ["ghr_abc123XYZ", "github refresh token"],
    ["github_pat_abc123XYZ", "github fine-grained PAT"],
    ["glpat-abc123XYZ", "gitlab PAT"],
    ["xoxb-abc123XYZ", "slack bot token"],
    ["sk-ant-abc123XYZ", "anthropic key"],
  ])("redacts a bare %s (%s) wherever it appears", (token) => {
    expect(withoutUrls(`token in play: ${token} — end`)).toBe("token in play: <redacted> — end");
  });

  test("leaves ordinary text with no credential shape untouched", () => {
    expect(withoutUrls("git push -u origin main failed (exit 1): no upstream configured")).toBe("git push -u origin main failed (exit 1): no upstream configured");
  });

  test("redacts every credential-bearing substring in a message, not just the first", () => {
    const in_ = "https://ghp_ONE@github.com/a/b.git and glpat-TWOSECRET both failed";
    expect(withoutUrls(in_)).toBe("<remote> and <redacted> both failed");
  });
});
