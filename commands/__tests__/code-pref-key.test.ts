/**
 * The editor pref key. `rt code` keyed on the index row (a serialized
 * identity) while `rt nav` keyed on whatever directory basename it was sitting
 * in, so one repo accumulated several keys and a choice saved through one
 * surface was invisible to the other. Both derive `editorPrefKey` now.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { editorPrefKey, __test__ } from "../code.ts";

describe("editorPrefKey", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "rt-pref-key-")));
    execSync("git init -q", { cwd: repoRoot, stdio: "pipe" });
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  test("a subdirectory keys on the same repo as its root", () => {
    const sub = join(repoRoot, "packages", "thing");
    mkdirSync(sub, { recursive: true });

    expect(editorPrefKey(sub)).toBe(editorPrefKey(repoRoot));
  });

  test("keys a remote-less repo on its path identity, not its basename", () => {
    expect(editorPrefKey(repoRoot)).toBe(`path:${encodeURIComponent(repoRoot)}`);
  });

  test("falls back to the basename outside any repo", () => {
    const bare = realpathSync(mkdtempSync(join(tmpdir(), "rt-pref-key-bare-")));

    expect(editorPrefKey(bare)).toBe(basename(bare));

    rmSync(bare, { recursive: true, force: true });
  });
});

describe("savedEditor", () => {
  const prefs = { editors: { "remote:github.com%2Fa%2Fb": "zed", "old-basename": "cursor" }, workspaces: {} };

  test("prefers the identity key", () => {
    expect(__test__.savedEditor(prefs, "remote:github.com%2Fa%2Fb", ["old-basename"])).toBe("zed");
  });

  test("adopts a pre-cutover key rather than reporting nothing saved", () => {
    expect(__test__.savedEditor(prefs, "path:%2Fsomewhere", ["old-basename"])).toBe("cursor");
  });

  test("reports nothing saved when neither key is present", () => {
    expect(__test__.savedEditor(prefs, "path:%2Fsomewhere", ["unseen"])).toBeUndefined();
  });
});
