/**
 * `realResolveLegacyKey` — the default resolver every re-key uses.
 *
 * It looked the legacy name up as an index KEY, but post-cutover the index
 * keys on serialized identities, so a legacy name is not a key at all any
 * more. Every row naming one stayed retained forever: on this machine that was
 * 32 branch_cache rows under "repo-tools", whose checkout is indexed as
 * remote:github.com%2Fm4ttstack%2Frt.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeStateDb, setKvValue } from "../index.ts";
import { realResolveLegacyKey } from "../identity-migrate.ts";

const RT = "remote:github.com%2Fm4ttstack%2Frt";
const SKILLS = "remote:github.com%2Fm4ttheweric%2Fskills";

describe("realResolveLegacyKey", () => {
  const origHome = process.env.HOME;
  let home: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-legacy-resolve-")));
    process.env.HOME = home;
    closeStateDb();
  });

  afterEach(() => {
    process.env.HOME = origHome;
    closeStateDb();
    rmSync(home, { recursive: true, force: true });
  });

  test("resolves a legacy name by the checkout's directory basename", async () => {
    setKvValue("repo-index", RT, "/Users/matt/Documents/GitHub/repo-tools");

    expect(await realResolveLegacyKey("repo-tools")).toBe(RT);
  });

  test("resolves a legacy name by the identity's tail", async () => {
    setKvValue("repo-index", SKILLS, "/repos/matt-skills");

    expect(await realResolveLegacyKey("skills")).toBe(SKILLS);
  });

  test("leaves an ambiguous name unresolved rather than re-keying onto a guess", async () => {
    setKvValue("repo-index", SKILLS, "/repos/a/skills");
    setKvValue("repo-index", "remote:github.com%2Fm4ttstack%2Fskills", "/repos/b/skills");

    expect(await realResolveLegacyKey("skills")).toBeNull();
  });

  test("a name no row carries stays unresolvable", async () => {
    setKvValue("repo-index", RT, "/repos/repo-tools");

    expect(await realResolveLegacyKey("origin")).toBeNull();
  });
});
