import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
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
});
