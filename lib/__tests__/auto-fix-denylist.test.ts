import { describe, expect, test } from "bun:test";
import {
  DEFAULT_DENYLIST,
  matchesDenylist,
  enforceScopeCaps,
} from "../auto-fix-denylist.ts";

describe("matchesDenylist", () => {
  test("matches exact filename", () => {
    expect(matchesDenylist("package.json", ["package.json"])).toBe(true);
  });

  test("matches glob with **", () => {
    expect(matchesDenylist("infra/k8s/deploy.yaml", ["infra/**"])).toBe(true);
  });

  test("does not match unrelated path", () => {
    expect(matchesDenylist("apps/backend/src/index.ts", ["infra/**"])).toBe(false);
  });

  test("matches lockfiles", () => {
    expect(matchesDenylist("bun.lock", ["bun.lock"])).toBe(true);
    expect(matchesDenylist("yarn.lock", ["yarn.lock"])).toBe(true);
  });

  test("multiple patterns: any match wins", () => {
    expect(matchesDenylist(".env.production", ["package.json", ".env*"])).toBe(true);
  });

  test("DEFAULT_DENYLIST blocks lockfiles, migrations, CI configs, env files", () => {
    expect(matchesDenylist("bun.lock", DEFAULT_DENYLIST)).toBe(true);
    expect(matchesDenylist("migrations/001_init.sql", DEFAULT_DENYLIST)).toBe(true);
    expect(matchesDenylist(".gitlab-ci.yml", DEFAULT_DENYLIST)).toBe(true);
    expect(matchesDenylist("Dockerfile", DEFAULT_DENYLIST)).toBe(true);
    expect(matchesDenylist("infra/terraform/main.tf", DEFAULT_DENYLIST)).toBe(true);
    expect(matchesDenylist(".env", DEFAULT_DENYLIST)).toBe(true);
    expect(matchesDenylist(".env.local", DEFAULT_DENYLIST)).toBe(true);
  });

  test("DEFAULT_DENYLIST allows ordinary source files", () => {
    expect(matchesDenylist("apps/backend/src/index.ts", DEFAULT_DENYLIST)).toBe(false);
    expect(matchesDenylist("packages/sidekick/lib/foo.ts", DEFAULT_DENYLIST)).toBe(false);
  });
});

describe("enforceScopeCaps", () => {
  test("returns null (no violation) when within caps", () => {
    expect(enforceScopeCaps({ files: 3, lines: 50, fileCap: 5, lineCap: 200 })).toBeNull();
  });

  test("returns 'files' violation when fileCap exceeded", () => {
    expect(enforceScopeCaps({ files: 6, lines: 50, fileCap: 5, lineCap: 200 }))
      .toEqual({ kind: "files", actual: 6, cap: 5 });
  });

  test("returns 'lines' violation when lineCap exceeded", () => {
    expect(enforceScopeCaps({ files: 3, lines: 250, fileCap: 5, lineCap: 200 }))
      .toEqual({ kind: "lines", actual: 250, cap: 200 });
  });

  test("returns first violation (files) when both exceeded", () => {
    expect(enforceScopeCaps({ files: 10, lines: 500, fileCap: 5, lineCap: 200 }))
      .toEqual({ kind: "files", actual: 10, cap: 5 });
  });
});
