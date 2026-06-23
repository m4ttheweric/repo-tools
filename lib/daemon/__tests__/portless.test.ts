import { describe, test, expect } from "bun:test";
import { buildPortlessCommand, portlessAvailable, sanitizeSubdomain, deriveAppName, portlessUrl } from "../portless.ts";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, basename } from "path";

describe("buildPortlessCommand", () => {
  test("wraps an inner command in `portless run`", () => {
    expect(buildPortlessCommand("pnpm run dev")).toBe("portless run pnpm run dev");
  });
  test("leaves the inner command otherwise untouched", () => {
    expect(buildPortlessCommand("vite --mode dev")).toBe("portless run vite --mode dev");
  });
});

describe("portlessAvailable", () => {
  test("true when the resolver finds the binary", () => {
    expect(portlessAvailable(() => "/usr/local/bin/portless")).toBe(true);
  });
  test("false when the resolver finds nothing", () => {
    expect(portlessAvailable(() => null)).toBe(false);
  });
});

describe("sanitizeSubdomain", () => {
  test("lowercases and replaces unsafe chars", () => {
    expect(sanitizeSubdomain("Feature/Auth_2")).toBe("feature-auth-2");
  });
  test("collapses and trims dashes", () => {
    expect(sanitizeSubdomain("--a__b--")).toBe("a-b");
  });
});

describe("deriveAppName", () => {
  test("uses package.json name, last segment, @ stripped, sanitized", () => {
    const d = mkdtempSync(join(tmpdir(), "rt-name-"));
    try {
      writeFileSync(join(d, "package.json"), JSON.stringify({ name: "@acme/Portal_App" }));
      expect(deriveAppName(d)).toBe("portal-app");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test("falls back to the directory basename when no package.json", () => {
    const d = mkdtempSync(join(tmpdir(), "rt-name-"));
    try {
      expect(deriveAppName(d)).toBe(sanitizeSubdomain(basename(d)));
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

describe("portlessUrl", () => {
  test("no branch prefix -> bare name, no port", () => {
    expect(portlessUrl("portal", null)).toBe("https://portal.localhost");
  });
  test("linked worktree -> branch prefixed as subdomain, no port", () => {
    expect(portlessUrl("portal", "parking-lot-2")).toBe("https://parking-lot-2.portal.localhost");
  });
  test("scheme override", () => {
    expect(portlessUrl("portal", null, "http")).toBe("http://portal.localhost");
  });
});

describe("buildPortlessCommand opts", () => {
  test("no opts -> bare portless run (back-compat)", () => {
    expect(buildPortlessCommand("pnpm run dev")).toBe("portless run pnpm run dev");
  });
  test("with name + appPort -> flags before the inner command", () => {
    expect(buildPortlessCommand("vite", { appPort: 10001, name: "portal" }))
      .toBe("portless run --name portal --app-port 10001 vite");
  });
});
