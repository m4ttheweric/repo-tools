import { test, expect } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { redactCredentials } from "../redact-credentials.ts";

const src = readFileSync(resolve(import.meta.dir, "..", "freshness.ts"), "utf8");

test("S050: every log/error interpolation of a remote URL runs it through redactCredentials", () => {
  expect(src).toMatch(/log\.info\(`remote "\$\{redactCredentials\(remoteUrl\)\}" for \$\{repoName\}/);
  expect(src).toMatch(/log\.info\(`could not parse remote "\$\{redactCredentials\(remoteUrl\)\}"/);
  expect(src).toMatch(/throw new Error\(`could not parse remote URL "\$\{redactCredentials\(remoteUrl\)\}"`\)/);
});

test("S050: no remaining bare ${remoteUrl} interpolation in freshness.ts", () => {
  expect(src).not.toMatch(/\$\{remoteUrl\}/);
});

test("redactCredentials strips userinfo from a credentialed URL", () => {
  expect(redactCredentials("https://oauth2:glpat-XXXX@gitlab.example.com/a/b.git")).toBe(
    "https://[redacted]@gitlab.example.com/a/b.git",
  );
});
