import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { machineSettingsPath } from "../../lib/rt-paths.ts";
import { getSetting } from "../../lib/settings/resolve.ts";
import { setSetting } from "../../lib/settings/write.ts";
import { __test__ } from "../code.ts";

describe("workspace prefs through the settings resolver", () => {
  const origHome = process.env.HOME;
  let home: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-code-prefs-")));
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(home, { recursive: true, force: true });
  });

  test("empty store: defaults to empty editors/workspaces", () => {
    expect(__test__.loadPrefs()).toEqual({ editors: {}, workspaces: {} });
  });

  test("a store-seeded value resolves through the loader", () => {
    setSetting("rt.workspacePrefs", { editors: { myrepo: "code" } }, "machine");

    expect(__test__.loadPrefs().editors.myrepo).toBe("code");
  });

  test("legacy 'entries' alias still resolves as workspaces", () => {
    setSetting("rt.workspacePrefs", { entries: { "/some/dir": "x.code-workspace" } }, "machine");

    expect(__test__.loadPrefs().workspaces["/some/dir"]).toBe("x.code-workspace");
  });

  test("savePrefs lands in the machine store", () => {
    __test__.savePrefs({ editors: { myrepo: "cursor" }, workspaces: {} });

    const stored = getSetting<{ editors: Record<string, string> }>("rt.workspacePrefs").value;
    expect(stored.editors.myrepo).toBe("cursor");
    const raw = JSON.parse(readFileSync(machineSettingsPath(), "utf8").replace(/^\/\/.*\n/, ""));
    expect(raw["rt.workspacePrefs"].editors.myrepo).toBe("cursor");
  });

  test("an unexpandable ${repoRoot} in a stored value degrades to empty prefs instead of throwing", () => {
    setSetting("rt.workspacePrefs", { editors: { myrepo: "${repoRoot}" } }, "machine");

    expect(() => __test__.loadPrefs()).not.toThrow();
    expect(__test__.loadPrefs()).toEqual({ editors: {}, workspaces: {} });
  });

  test("savePrefs warns and does not throw when the machine store is malformed (duplicate key anywhere in the document)", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const path = machineSettingsPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `{\n  "rt.other": { "x": 1 },\n  "rt.other": { "x": 2 }\n}\n`);

    expect(() => __test__.savePrefs({ editors: { myrepo: "cursor" }, workspaces: {} })).not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("rt: could not save workspace prefs");

    warnSpy.mockRestore();
  });
});
