import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { setSetting } from "../settings/write.ts";
import { machineSettingsPath } from "../rt-paths.ts";
import { loadTemplate } from "../doppler-template.ts";

const IDENTITY = "gitlab.com/acme/test-repo";

describe("doppler-template over the settings resolver", () => {
  const origHome = process.env.HOME;
  let home: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-doppler-template-")));
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(home, { recursive: true, force: true });
  });

  test("loadTemplate returns null when nothing is declared", () => {
    expect(loadTemplate(IDENTITY)).toBeNull();
  });

  test("loadTemplate returns null when no repo identity is available", () => {
    expect(loadTemplate(null)).toBeNull();
  });

  test("a store-seeded array resolves through the loader", () => {
    setSetting(
      "rt.dopplerTemplate",
      [
        { path: "apps/backend", project: "backend", config: "dev" },
        { path: "apps/frontend", project: "frontend", config: "dev" },
      ],
      "machine",
      { repoIdentity: IDENTITY },
    );

    expect(loadTemplate(IDENTITY)).toEqual([
      { path: "apps/backend", project: "backend", config: "dev" },
      { path: "apps/frontend", project: "frontend", config: "dev" },
    ]);
  });

  test("filters out entries missing a required field", () => {
    setSetting(
      "rt.dopplerTemplate",
      [
        { path: "apps/backend", project: "backend", config: "dev" },
        { path: "apps/broken" },
      ],
      "machine",
      { repoIdentity: IDENTITY },
    );

    expect(loadTemplate(IDENTITY)).toEqual([
      { path: "apps/backend", project: "backend", config: "dev" },
    ]);
  });

  test("returns null when the resolved value isn't array-shaped", () => {
    // setSetting refuses a non-array write (registry type is "array"); a
    // hand-edited store can still hold one, and the resolver's own type
    // check degrades it away rather than throwing — loadTemplate must
    // return null for that "nothing usable" case too.
    const path = machineSettingsPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ repos: { [IDENTITY]: { "rt.dopplerTemplate": { oops: true } } } }),
    );

    expect(loadTemplate(IDENTITY)).toBeNull();
  });

  test("an unexpandable ${repoRoot} in a stored value degrades to null instead of throwing", () => {
    setSetting(
      "rt.dopplerTemplate",
      [{ path: "${repoRoot}", project: "backend", config: "dev" }],
      "machine",
      { repoIdentity: IDENTITY },
    );

    // ${repoRoot} has no expand context here, so the resolver throws on
    // expansion — loadTemplate must degrade to null rather than propagate.
    expect(() => loadTemplate(IDENTITY)).not.toThrow();
    expect(loadTemplate(IDENTITY)).toBeNull();
  });
});
