import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  END_MARKER,
  installShellIntegration,
  installZshenvPrecedence,
  removeShellIntegration,
  removeZshenvPrecedence,
  ZSHENV_MARKER,
} from "../shell-integration.ts";

describe("shell-integration — install/remove round trip", () => {
  const origHome = process.env.HOME;
  const origShell = process.env.SHELL;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "rt-shell-integration-"));
    process.env.HOME = home;
    process.env.SHELL = "/bin/zsh";
  });

  afterEach(() => {
    process.env.HOME = origHome;
    process.env.SHELL = origShell;
    rmSync(home, { recursive: true, force: true });
  });

  test("installZshenvPrecedence writes the block once; a second call is a no-op (idempotent)", () => {
    const first = installZshenvPrecedence();
    expect(first).toEqual({ alreadyInstalled: false, written: true });

    const zshenvPath = join(home, ".zshenv");
    const afterFirst = readFileSync(zshenvPath, "utf8");
    expect(afterFirst).toContain(ZSHENV_MARKER);
    expect(afterFirst).toContain(END_MARKER);

    const second = installZshenvPrecedence();
    expect(second).toEqual({ alreadyInstalled: true, written: false });
    expect(readFileSync(zshenvPath, "utf8")).toBe(afterFirst); // no duplicate block
  });

  test("removeShellIntegration strips exactly installShellIntegration's block — before/after equality around unrelated content", () => {
    const rcPath = join(home, ".zshrc");
    const before = "# my own zshrc stuff\nexport FOO=bar\n";
    writeFileSync(rcPath, before);

    installShellIntegration();
    const installed = readFileSync(rcPath, "utf8");
    expect(installed).not.toBe(before);
    expect(installed.startsWith(before)).toBe(true);

    const result = removeShellIntegration();
    expect(result).toEqual({ removed: true });
    expect(readFileSync(rcPath, "utf8")).toBe(before);
  });

  test("removeShellIntegration preserves unrelated content appended AFTER the block too", () => {
    const rcPath = join(home, ".zshrc");
    writeFileSync(rcPath, "# prefix\n");
    installShellIntegration();

    const suffix = "\n# a later tool's own block\nexport BAZ=qux\n";
    const withSuffix = readFileSync(rcPath, "utf8") + suffix;
    writeFileSync(rcPath, withSuffix);

    const result = removeShellIntegration();
    expect(result).toEqual({ removed: true });
    expect(readFileSync(rcPath, "utf8")).toBe(`# prefix\n${suffix}`);
  });

  test("removeShellIntegration reports {removed:false, manual:true} for a legacy block with no END marker", () => {
    const rcPath = join(home, ".zshrc");
    const legacy = "# unrelated\n\n# rt — repo tools\nexport PATH=\"$HOME/.local/bin:$PATH\"\n";
    writeFileSync(rcPath, legacy);

    const result = removeShellIntegration();
    expect(result).toEqual({ removed: false, manual: true });
    expect(readFileSync(rcPath, "utf8")).toBe(legacy); // untouched
  });

  test("removeShellIntegration is a no-op when nothing was ever installed", () => {
    expect(removeShellIntegration()).toEqual({ removed: false });
  });

  test("removeZshenvPrecedence strips exactly installZshenvPrecedence's block", () => {
    const zshenvPath = join(home, ".zshenv");
    const before = "# other zshenv content\n";
    writeFileSync(zshenvPath, before);

    installZshenvPrecedence();
    const result = removeZshenvPrecedence();
    expect(result).toEqual({ removed: true });
    expect(readFileSync(zshenvPath, "utf8")).toBe(before);
  });

  test("removeZshenvPrecedence is a no-op when the file doesn't exist", () => {
    expect(removeZshenvPrecedence()).toEqual({ removed: false });
  });
});
