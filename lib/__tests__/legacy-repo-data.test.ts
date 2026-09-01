/**
 * Pre-cutover per-repo files live under the DISPLAY-name data dir, but every
 * one-shot importer probes `repoDataDir(identity)`, so the import could never
 * fire and the files sat on disk invisibly.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeStateDb, setKvValue } from "../state/index.ts";
import { repoDataDir } from "../rt-paths.ts";
import { legacyRepoFile } from "../legacy-repo-data.ts";

const SKILLS = "remote:github.com%2Fm4ttheweric%2Fskills";
const OTHER_SKILLS = "remote:github.com%2Fm4ttstack%2Fskills";
const FILE = "run-history.jsonl";

describe("legacyRepoFile", () => {
  const origHome = process.env.HOME;
  let home: string;

  function seedFile(dirKey: string): string {
    const dir = repoDataDir(dirKey);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, FILE);
    writeFileSync(path, "{}\n");
    return path;
  }

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-legacy-data-")));
    process.env.HOME = home;
    closeStateDb();
    setKvValue("repo-index", SKILLS, "/repos/matt-skills");
  });

  afterEach(() => {
    process.env.HOME = origHome;
    closeStateDb();
    rmSync(home, { recursive: true, force: true });
  });

  test("prefers the identity dir when it holds the file", () => {
    const current = seedFile(SKILLS);
    seedFile("skills");

    expect(legacyRepoFile(SKILLS, FILE)).toBe(current);
  });

  test("falls back to the display-name dir the pre-cutover write left behind", () => {
    const legacy = seedFile("skills");

    expect(legacyRepoFile(SKILLS, FILE)).toBe(legacy);
  });

  test("refuses a label two registered repos both decode to", () => {
    seedFile("skills");
    setKvValue("repo-index", OTHER_SKILLS, "/repos/mattstack-skills");

    expect(legacyRepoFile(SKILLS, FILE)).toBe(join(repoDataDir(SKILLS), FILE));
  });

  // One claimant is not enough: it has to be THIS repo. Otherwise a repo the
  // index has never seen adopts a same-labelled repo's legacy dir, and the
  // importers rename the source file out from under its real owner.
  test("refuses a legacy dir whose only claimant is a different repo", () => {
    seedFile("skills");

    expect(legacyRepoFile(OTHER_SKILLS, FILE)).toBe(join(repoDataDir(OTHER_SKILLS), FILE));
  });

  test("returns the identity path when no legacy file exists", () => {
    expect(legacyRepoFile(SKILLS, FILE)).toBe(join(repoDataDir(SKILLS), FILE));
  });

  test("a non-wire key has no separate legacy dir to consult", () => {
    seedFile("plain-name");

    expect(legacyRepoFile("plain-name", FILE)).toBe(join(repoDataDir("plain-name"), FILE));
  });
});
