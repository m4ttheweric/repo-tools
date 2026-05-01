import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Pin HOME to a tmpdir BEFORE importing the module under test, since
// daemon-config.ts reads RT_DIR at import time from the user's home.
const tmpHome = mkdtempSync(join(tmpdir(), "rt-doppler-template-"));
process.env.HOME = tmpHome;

const { loadTemplate, saveTemplate, templatePath } =
  await import("../doppler-template.ts");

describe("doppler-template I/O", () => {
  const repo = "test-repo";

  afterEach(() => {
    try { rmSync(join(tmpHome, ".rt", repo), { recursive: true, force: true }); } catch { /* */ }
  });

  test("templatePath is ~/.rt/<repo>/doppler-template.yaml", () => {
    expect(templatePath(repo)).toBe(join(tmpHome, ".rt", repo, "doppler-template.yaml"));
  });

  test("loadTemplate returns null when the file is missing", () => {
    expect(loadTemplate(repo)).toBeNull();
  });

  test("loadTemplate returns null on malformed YAML", () => {
    mkdirSync(join(tmpHome, ".rt", repo), { recursive: true });
    writeFileSync(templatePath(repo), "this: is: not: valid: yaml::");
    expect(loadTemplate(repo)).toBeNull();
  });

  test("saveTemplate then loadTemplate round-trips entries", () => {
    const entries = [
      { path: "apps/backend",  project: "backend",  config: "dev" },
      { path: "apps/frontend", project: "frontend", config: "dev" },
    ];
    saveTemplate(repo, entries);
    expect(loadTemplate(repo)).toEqual(entries);
  });

  test("saveTemplate creates the parent directory if missing", () => {
    saveTemplate(repo, [{ path: "apps/x", project: "x", config: "dev" }]);
    const raw = readFileSync(templatePath(repo), "utf8");
    expect(raw).toContain("project: x");
  });
});
