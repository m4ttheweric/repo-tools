/**
 * `tryResolveRepoArg`: `resolveRepoArg` without the exit.
 *
 * Callers that match a resolved identity against rows `getKnownRepos` carries
 * (which include unregistered basename-keyed candidates the index never sees)
 * need the answer plus their own fallback, not a `fail()` that ends the
 * process.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeStateDb, setKvValue } from "../state/index.ts";
import { REPO_INDEX_NS } from "../repo-index.ts";
import { tryResolveRepoArg } from "../repo-arg.ts";

const SKILLS_ID = "remote:github.com%2Fm4ttheweric%2Fskills";
const RT_ID = "remote:github.com%2Fm4ttstack%2Frt";

describe("tryResolveRepoArg", () => {
  const origHome = process.env.HOME;
  let home: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-repo-arg-")));
    process.env.HOME = home;
    closeStateDb();
  });

  afterEach(() => {
    process.env.HOME = origHome;
    closeStateDb();
    rmSync(home, { recursive: true, force: true });
  });

  test("passes a serialized identity through untouched", async () => {
    expect(await tryResolveRepoArg(SKILLS_ID)).toEqual({ kind: "resolved", identity: SKILLS_ID });
  });

  test("resolves the identity tail", async () => {
    setKvValue(REPO_INDEX_NS, SKILLS_ID, "/repos/matt-skills");

    expect(await tryResolveRepoArg("skills")).toEqual({ kind: "resolved", identity: SKILLS_ID });
  });

  test("resolves the checkout's directory basename", async () => {
    setKvValue(REPO_INDEX_NS, SKILLS_ID, "/repos/matt-skills");

    expect(await tryResolveRepoArg("matt-skills")).toEqual({ kind: "resolved", identity: SKILLS_ID });
  });

  // A pre-cutover row is keyed by a plain name whose spelling matches neither
  // an identity tail nor its checkout's basename, so the name lookup cannot
  // see it. Addressing such a row by its own key has to keep working until
  // `rt repos prune` collapses it.
  test("resolves a legacy plain-name row by its own key", async () => {
    setKvValue(REPO_INDEX_NS, "legacy-name", "/tmp/some-other-dirname");

    expect(await tryResolveRepoArg("legacy-name")).toEqual({ kind: "resolved", identity: "legacy-name" });
  });

  // The additive heal leaves a legacy row and its identity row pointing at one
  // directory until `rt repos prune` collapses them, and reverseLookupByName
  // resolves that pair identity-first on purpose. A label lookup must not
  // short-circuit past it and hand back the legacy key: every caller feeds the
  // result to identity-only daemon verbs.
  test("prefers the identity over a legacy row the heal has not collapsed yet", async () => {
    setKvValue(REPO_INDEX_NS, "app", "/repos/app");
    setKvValue(REPO_INDEX_NS, "remote:github.com%2Fowner%2Fapp", "/repos/app");

    expect(await tryResolveRepoArg("app")).toEqual({
      kind: "resolved",
      identity: "remote:github.com%2Fowner%2Fapp",
    });
  });

  test("reports none for a name no row carries", async () => {
    setKvValue(REPO_INDEX_NS, RT_ID, "/repos/repo-tools");

    expect(await tryResolveRepoArg("nope")).toEqual({ kind: "none" });
  });

  test("reports every candidate when one name spans two repos", async () => {
    setKvValue(REPO_INDEX_NS, SKILLS_ID, "/repos/a/skills");
    setKvValue(REPO_INDEX_NS, "remote:github.com%2Fsomeone%2Fskills", "/repos/b/skills");

    const resolution = await tryResolveRepoArg("skills");

    expect(resolution.kind).toBe("ambiguous");
    expect(resolution.kind === "ambiguous" && resolution.matches.length).toBe(2);
  });
});
