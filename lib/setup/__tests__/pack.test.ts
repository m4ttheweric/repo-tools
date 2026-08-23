import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { updateRepoIndex } from "../../repo-index.ts";
import type { SecretsSeams } from "../../secrets/store.ts";
import type { RelayClient } from "../../team/relay-client.ts";
import type { ApplyContext } from "../apply.ts";
import type { PackRequirements } from "../requirements.ts";
import { fakeProbes } from "./fakes.ts";
import type { Probes } from "../probes.ts";

import { NO_MANIFEST_DETAIL, setupPackFlow } from "../pack.ts";

const fakeSecrets: SecretsSeams = {
  ageKeySeam: { run: async () => ({ code: 0, stdout: "", stderr: "" }) },
  execSeam: {
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
    fileExists: () => false,
    statFile: () => null,
    readFile: () => "",
    writeFile: () => {},
    ensureDir: () => {},
    chmod: () => {},
    fsyncAndRename: () => {},
    removeFile: () => {},
  },
};

const fakeRelay: RelayClient = {
  create: async () => ({ id: "", creatorSecret: "" }),
  fetch: async () => "gone",
  redeem: async () => "already",
  reply: async () => {},
  readReply: async () => "none",
  delete: async () => {},
};

function makeCtx(p: Probes, overrides: Partial<ApplyContext> = {}): ApplyContext {
  return {
    p,
    emit: () => {},
    log: () => {},
    intent: null,
    team: { slug: "", name: "", mode: "none" },
    snapshot: null,
    reqs: [],
    // installPlugins must never hard-fail this flow just because `claude`
    // isn't resolvable in the fake environment.
    nonInteractive: true,
    teamOfOne: false,
    appPath: null,
    ci: false,
    secrets: fakeSecrets,
    teamSecrets: () => fakeSecrets,
    relay: fakeRelay,
    secretPresence: { has: async () => null },
    redact: () => {},
    async need() {
      return "no-app";
    },
    ...overrides,
  };
}

function manifestPath(home: string, repoName: string): string {
  return join(home, ".mattstack", "repos", repoName, "skills.jsonc");
}

function registerRepo(home: string): string {
  const repoDir = mktempRepoDir(home);
  const repoName = basename(repoDir);
  updateRepoIndex(repoName, repoDir);
  return repoName;
}

function mktempRepoDir(home: string): string {
  return mkdtempSync(join(home, "repo-"));
}

describe("setupPackFlow", () => {
  const origHome = process.env.HOME;
  let home: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-pack-home-")));
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(home, { recursive: true, force: true });
  });

  test("every pipeline stage bound -> ok", async () => {
    const repoName = registerRepo(home);
    const manifest = {
      pipelines: { feature: { stages: ["plan", "implement"] } },
      bindings: { plan: "planner", implement: "coder" },
    };
    const p = fakeProbes({ home, env: {}, files: { [manifestPath(home, repoName)]: JSON.stringify(manifest) } });
    const reqs: PackRequirements[] = [{ pack: "acme", tools: [], integrations: [], workType: "feature" }];

    const result = await setupPackFlow(makeCtx(p, { reqs }));
    expect(result).toEqual({ ok: true, detail: `2 stage(s) resolved for "feature"` });
  });

  test("one stage unbound -> stage-unresolved with the stage name", async () => {
    const repoName = registerRepo(home);
    const manifest = {
      pipelines: { feature: { stages: ["plan", "implement"] } },
      bindings: { plan: "planner" },
    };
    const p = fakeProbes({ home, env: {}, files: { [manifestPath(home, repoName)]: JSON.stringify(manifest) } });
    const reqs: PackRequirements[] = [{ pack: "acme", tools: [], integrations: [], workType: "feature" }];

    const result = await setupPackFlow(makeCtx(p, { reqs }));
    expect(result).toEqual({ ok: false, stage: "implement", detail: `stage "implement" is unresolved` });
  });

  test("no per-repo manifest yet -> ok:false, no stage", async () => {
    registerRepo(home);
    const p = fakeProbes({ home, env: {} });

    const result = await setupPackFlow(makeCtx(p));
    expect(result).toEqual({ ok: false, detail: NO_MANIFEST_DETAIL });
  });

  test("no registered repo at all -> same honest no-manifest result", async () => {
    const p = fakeProbes({ home, env: {} });

    const result = await setupPackFlow(makeCtx(p));
    expect(result).toEqual({ ok: false, detail: NO_MANIFEST_DETAIL });
  });

  test("defaults workType to feature when the pack declares none", async () => {
    const repoName = registerRepo(home);
    const manifest = { pipelines: { feature: { stages: ["plan"] } }, bindings: { plan: "planner" } };
    const p = fakeProbes({ home, env: {}, files: { [manifestPath(home, repoName)]: JSON.stringify(manifest) } });

    const result = await setupPackFlow(makeCtx(p));
    expect(result).toEqual({ ok: true, detail: `1 stage(s) resolved for "feature"` });
  });

  test("no pipeline declared for the work type -> vacuously ok, nothing to resolve", async () => {
    const repoName = registerRepo(home);
    const manifest = { pipelines: {}, bindings: {} };
    const p = fakeProbes({ home, env: {}, files: { [manifestPath(home, repoName)]: JSON.stringify(manifest) } });
    const reqs: PackRequirements[] = [{ pack: "acme", tools: [], integrations: [], workType: "chore" }];

    const result = await setupPackFlow(makeCtx(p, { reqs }));
    expect(result).toEqual({ ok: true, detail: `0 stage(s) resolved for "chore"` });
  });

  test("a malformed pack requirements file surfaces its own error, never a misleading stage failure", async () => {
    const repoName = registerRepo(home);
    const manifest = { pipelines: { feature: { stages: ["plan"] } }, bindings: { plan: "planner" } };
    const p = fakeProbes({ home, env: {}, files: { [manifestPath(home, repoName)]: JSON.stringify(manifest) } });
    const reqs: PackRequirements[] = [{ pack: "acme", tools: [], integrations: [], error: "invalid JSON: Unexpected token" }];

    const result = await setupPackFlow(makeCtx(p, { reqs }));
    expect(result).toEqual({ ok: false, detail: "invalid JSON: Unexpected token" });
  });
});
