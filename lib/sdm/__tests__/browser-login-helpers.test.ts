import { describe, test, expect } from "bun:test";
import {
  detectChrome,
  extractLoginUrl,
  classifyLoginNav,
  CHROME_CANDIDATES,
} from "../browser-login.ts";

describe("detectChrome", () => {
  test("prefers Google Chrome when present", () => {
    const found = detectChrome(() => true);
    expect(found?.name).toBe("Google Chrome");
  });

  test("falls through to the next candidate when Chrome is absent", () => {
    const chromePath = CHROME_CANDIDATES[0]!.path;
    const found = detectChrome(p => p !== chromePath);
    expect(found).not.toBeNull();
    expect(found?.name).not.toBe("Google Chrome");
  });

  test("returns null when no candidate exists", () => {
    expect(detectChrome(() => false)).toBeNull();
  });
});

describe("extractLoginUrl", () => {
  test("pulls the auth-confirm-native URL from the sdm line", () => {
    const line = "Please complete logging in at: https://app.strongdm.com/auth-confirm-native/abc123";
    expect(extractLoginUrl(line)).toBe("https://app.strongdm.com/auth-confirm-native/abc123");
  });

  test("returns null for unrelated lines", () => {
    expect(extractLoginUrl("authentication successful")).toBeNull();
    expect(extractLoginUrl("")).toBeNull();
  });
});

describe("classifyLoginNav", () => {
  test.each<[string, string]>([
    ["https://app.strongdm.com/app/auth/complete/", "complete"],
    ["https://app.rippling.com/sign-in/identity-verification/select", "needs-user"],
    ["https://app.rippling.com/sign-in", "needs-user"],
    ["https://www.rippling.com/api/platform/sso/sp-initiated/xyz", "progressing"],
    ["https://app.rippling.com/apps_sso_direct/Custom_1_abc", "progressing"],
    ["https://app.strongdm.com/auth-confirm-native/abc", "progressing"],
  ])("%s -> %s", (url, expected) => {
    expect(classifyLoginNav(url)).toBe(expected as any);
  });
});
