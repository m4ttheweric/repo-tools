import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { HELPERS_DIR, RT_BUNDLE_PATH, __test__ as bundleLayoutTest } from "../../lib/bundle-layout.ts";
import { setSetting } from "../../lib/settings/write.ts";
import { fakeProbes, type FakeProbesOpts } from "../../lib/setup/__tests__/fakes.ts";
import { linkPath } from "../../lib/deps/links.ts";
import { depsLink, depsReconcile, depsResolve, depsUnlink } from "../deps.ts";

const LOCK = {
  schema: 1,
  arch: "arm64",
  tools: [
    {
      name: "gh", version: "2.0.0", license: "MIT", url: "https://x/gh.tar.gz", sha256: "a".repeat(64),
      archive: "tar.gz", extract: "gh", bundlePath: `${HELPERS_DIR}/gh`, exec: [`${HELPERS_DIR}/gh`],
      exposeByDefault: false, entitlements: "none", status: "bundled", kind: "helper",
    },
  ],
};

/**
 * Mocks process.exit to throw a sentinel so the real test process never
 * dies, and reads the spies' recorded calls before mockRestore() (bun's
 * mockRestore() clears .mock.calls). Matches commands/__tests__/runs.test.ts.
 */
async function runCapturingExit(fn: () => Promise<void>): Promise<{ exitCode: number | undefined; logs: string[]; errors: string[] }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const exitSpy = spyOn(process, "exit").mockImplementation(() => {
    throw new Error("process.exit sentinel");
  });
  const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  const errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
  try {
    await fn();
    return { exitCode: undefined, logs, errors };
  } catch {
    const exitCode = exitSpy.mock.calls.at(-1)?.[0] as number | undefined;
    return { exitCode, logs, errors };
  } finally {
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  }
}

describe("rt deps commands", () => {
  const origHome = process.env.HOME;
  let home: string;
  let appRoot: string;
  let ghPath: string;

  beforeEach(() => {
    bundleLayoutTest.resetBundleLayoutMemo();
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-deps-cmd-home-")));
    process.env.HOME = home;

    appRoot = join(realpathSync(mkdtempSync(join(tmpdir(), "rt-deps-cmd-app-"))), "mattstack.app");
    mkdirSync(join(appRoot, "Contents", "Resources"), { recursive: true });
    mkdirSync(join(appRoot, "Contents", "MacOS"), { recursive: true });
    mkdirSync(join(appRoot, HELPERS_DIR), { recursive: true });
    writeFileSync(join(appRoot, "Contents", "Info.plist"), "<plist/>");
    writeFileSync(join(appRoot, "Contents", "Resources", "deps.lock"), JSON.stringify(LOCK));
    writeFileSync(join(appRoot, RT_BUNDLE_PATH), "rt-binary");
    writeFileSync(join(appRoot, HELPERS_DIR, "gh"), "gh-binary");
    setSetting("mattstack.appPath", appRoot, "machine");

    ghPath = join(appRoot, HELPERS_DIR, "gh");
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(home, { recursive: true, force: true });
    bundleLayoutTest.resetBundleLayoutMemo();
  });

  function bundleProbe(extra: Partial<FakeProbesOpts> = {}): ReturnType<typeof fakeProbes> {
    return fakeProbes({
      home,
      ...extra,
      files: { [ghPath]: "gh-binary", ...(extra.files ?? {}) },
      dirs: { [appRoot]: [], ...(extra.dirs ?? {}) },
    });
  }

  test("depsResolve --json prints a contract:1 envelope with the resolved exec array", async () => {
    const { logs } = await runCapturingExit(() => depsResolve(["gh", "--json"], {}, bundleProbe()));
    expect(logs).toHaveLength(1);
    const body = JSON.parse(logs[0]!);
    expect(body.contract).toBe(1);
    expect(typeof body.at).toBe("string");
    expect(body.tool).toBe("gh");
    expect(body.exec).toEqual([ghPath]);
  });

  test("depsResolve (human) prints the resolution without crashing on an unbundled tool", async () => {
    const { logs, exitCode } = await runCapturingExit(() => depsResolve(["nonexistent-tool"], {}, bundleProbe()));
    expect(exitCode).toBeUndefined();
    expect(logs.join("\n")).toContain("not bundled");
  });

  test("depsLink links a bundled tool and prints a success line", async () => {
    const p = bundleProbe();
    const { logs, exitCode } = await runCapturingExit(() => depsLink(["gh"], {}, p));
    expect(exitCode).toBeUndefined();
    expect(logs.join("\n")).toContain("linked gh");
    expect(p.calls.symlinks[linkPath(home, "gh")]).toBe(ghPath);
  });

  test("depsLink exits 2 on a user-actionable refusal in human mode (F13: occupied)", async () => {
    const path = linkPath(home, "gh");
    const p = bundleProbe({ files: { [path]: "#!/bin/sh\necho unrelated\n" } });
    const { exitCode, logs } = await runCapturingExit(() => depsLink(["gh"], {}, p));
    expect(exitCode).toBe(2);
    expect(logs.join("\n")).toContain("exists and is not a mattstack-managed link");
  });

  test("depsLink --json also exits 2 on refusal, with the contract's {error} envelope an app can decode", async () => {
    const path = linkPath(home, "gh");
    const p = bundleProbe({ files: { [path]: "#!/bin/sh\necho unrelated\n" } });
    const { exitCode, logs } = await runCapturingExit(() => depsLink(["gh", "--json"], {}, p));
    expect(exitCode).toBe(2);
    expect(logs).toHaveLength(1);
    const body = JSON.parse(logs[0]!);
    expect(body.error.code).toBe("occupied");
    expect(body.error.message).toContain("exists and is not a mattstack-managed link");
  });

  test("depsLink --force overrides the occupied refusal", async () => {
    const path = linkPath(home, "gh");
    const p = bundleProbe({ files: { [path]: "#!/bin/sh\necho unrelated\n" } });
    const { exitCode, logs } = await runCapturingExit(() => depsLink(["gh", "--force"], {}, p));
    expect(exitCode).toBeUndefined();
    expect(logs.join("\n")).toContain("linked gh");
  });

  test("depsUnlink removes our own link and reports removed:false for a user's file", async () => {
    const p = bundleProbe();
    await runCapturingExit(() => depsLink(["gh"], {}, p));

    const removed = await runCapturingExit(() => depsUnlink(["gh"], {}, p));
    expect(removed.logs.join("\n")).toContain("unlinked gh");

    const userPath = linkPath(home, "deck");
    p.writeFile(userPath, "#!/bin/sh\necho not ours\n");
    const untouched = await runCapturingExit(() => depsUnlink(["deck"], {}, p));
    expect(untouched.logs.join("\n")).toContain("was not one of ours");
  });

  test("depsReconcile reports nothing to reconcile, then reports an auto-unlink once a user copy appears", async () => {
    const p = bundleProbe();
    await runCapturingExit(() => depsLink(["gh"], {}, p));

    const idle = await runCapturingExit(() => depsReconcile([], {}, p));
    expect(idle.logs.join("\n")).toContain("nothing to reconcile");

    p.env.PATH = "/opt/homebrew/bin";
    p.writeFile("/opt/homebrew/bin/gh", "real-gh-binary");

    const active = await runCapturingExit(() => depsReconcile(["--json"], {}, p));
    const body = JSON.parse(active.logs[0]!);
    expect(body.removed).toEqual(["gh"]);
  });
});
