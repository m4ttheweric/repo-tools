/**
 * checkRtContextExtension — the rt-context vsix presence check (MAT-383 §5).
 *
 * Pure directory reads against a fixture `home`, no subprocess and no
 * version comparison. The rest of `rt verify` is covered by
 * e2e/tests/verify.test.ts (it needs a real compiled binary + daemon).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { checkRtContextExtension } from "../verify.ts";

const fixtureDirs: string[] = [];

function fixtureHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "rt-verify-vsix-"));
  fixtureDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (fixtureDirs.length > 0) {
    rmSync(fixtureDirs.pop()!, { recursive: true, force: true });
  }
});

describe("checkRtContextExtension", () => {
  test("extension present in one editor's extensions dir → pass, naming that editor", () => {
    const home = fixtureHome();
    mkdirSync(join(home, ".vscode", "extensions", "local.rt-context-0.1.0"), { recursive: true });

    const result = checkRtContextExtension(home);

    expect(result.status).toBe("pass");
    expect(result.detail).toContain("VS Code");
    expect(result.detail).not.toContain("Cursor");
  });

  test("extension present under Cursor's extensions dir → pass, naming Cursor", () => {
    const home = fixtureHome();
    mkdirSync(join(home, ".cursor", "extensions", "local.rt-context-0.1.0"), { recursive: true });

    const result = checkRtContextExtension(home);

    expect(result.status).toBe("pass");
    expect(result.detail).toContain("Cursor");
  });

  test("editor extensions dir present but no rt-context entry → warn", () => {
    const home = fixtureHome();
    mkdirSync(join(home, ".vscode", "extensions", "some.other-extension-1.0.0"), { recursive: true });

    const result = checkRtContextExtension(home);

    expect(result.status).toBe("warn");
    expect(result.detail).toContain("VS Code");
    expect(result.detail).toContain("rt settings extension");
  });

  test("no editor extensions dirs at all → skip", () => {
    const home = fixtureHome();

    const result = checkRtContextExtension(home);

    expect(result.status).toBe("skip");
  });

  test("extension present in one editor while the other's dir is missing entirely → still pass", () => {
    const home = fixtureHome();
    mkdirSync(join(home, ".vscode", "extensions", "local.rt-context-0.1.0"), { recursive: true });
    // No ~/.cursor at all — must not count as a "dir present, not installed" warn.

    const result = checkRtContextExtension(home);

    expect(result.status).toBe("pass");
  });
});
