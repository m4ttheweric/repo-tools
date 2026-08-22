import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { HELPERS_DIR, RT_BUNDLE_PATH, __test__ as bundleLayoutTest } from "../../bundle-layout.ts";
import { setSetting } from "../../settings/write.ts";
import { fakeProbes } from "../../setup/__tests__/fakes.ts";
import type { Probes } from "../../setup/probes.ts";
import { LINK_TAG, isOurLink, link, linkPath, reconcile, unlink, type LinkSeams } from "../links.ts";

const LOCK = {
  schema: 1,
  arch: "arm64",
  tools: [
    {
      name: "gh", version: "2.0.0", license: "MIT", url: "https://x/gh.tar.gz", sha256: "a".repeat(64),
      archive: "tar.gz", extract: "gh", bundlePath: `${HELPERS_DIR}/gh`, exec: [`${HELPERS_DIR}/gh`],
      exposeByDefault: false, entitlements: "none", status: "bundled", kind: "helper",
    },
    {
      name: "fast-browser", version: "0.1.0", license: "MIT", url: "https://x/fb.tgz", sha256: "b".repeat(64),
      archive: "npm", extract: "package", bundlePath: `${HELPERS_DIR}/fast-browser`,
      exec: [`${HELPERS_DIR}/node/bin/node`, `${HELPERS_DIR}/fast-browser/bin/fast-browser.mjs`],
      exposeByDefault: true, entitlements: "none", status: "bundled", kind: "helper",
    },
  ],
};

describe("tagged PATH links", () => {
  const origHome = process.env.HOME;
  let home: string;
  let appRoot: string;
  let ghPath: string;
  let nodePath: string;
  let fbPath: string;
  let rtPath: string;

  beforeEach(() => {
    bundleLayoutTest.resetBundleLayoutMemo();
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-deps-links-home-")));
    process.env.HOME = home;

    appRoot = join(realpathSync(mkdtempSync(join(tmpdir(), "rt-deps-links-app-"))), "mattstack.app");
    mkdirSync(join(appRoot, "Contents", "Resources"), { recursive: true });
    writeFileSync(join(appRoot, "Contents", "Info.plist"), "<plist/>");
    writeFileSync(join(appRoot, "Contents", "Resources", "deps.lock"), JSON.stringify(LOCK));

    setSetting("mattstack.appPath", appRoot, "machine");

    ghPath = join(appRoot, HELPERS_DIR, "gh");
    nodePath = join(appRoot, HELPERS_DIR, "node", "bin", "node");
    fbPath = join(appRoot, HELPERS_DIR, "fast-browser", "bin", "fast-browser.mjs");
    rtPath = join(appRoot, RT_BUNDLE_PATH);
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(home, { recursive: true, force: true });
    bundleLayoutTest.resetBundleLayoutMemo();
  });

  function probeWith(overrides: Partial<ReturnType<typeof fakeProbes>> = {}): Probes & ReturnType<typeof fakeProbes> {
    const base = fakeProbes({ home });
    const known = new Set([appRoot, ghPath, nodePath, fbPath, rtPath]);
    return { ...base, exists: (p: string) => known.has(p) || base.exists(p), ...overrides };
  }

  test("link(gh) creates a symlink targeting the bundled path", () => {
    const p = probeWith();
    const outcome = link(p, "gh");
    expect(outcome).toEqual({ ok: true, path: linkPath(home, "gh"), state: "linked" });
    expect(p.calls.symlinks[linkPath(home, "gh")]).toBe(ghPath);
  });

  test("link(rt) goes through the installRtBinary seam, atomically, never a bare symlink", () => {
    const p = probeWith();
    const calls: string[] = [];
    const seams: LinkSeams = {
      installRtBinary(src) {
        const dest = linkPath(home, "rt");
        calls.push(`symlink ${dest}.new -> ${src}`);
        calls.push(`rename ${dest}.new -> ${dest}`);
        return dest;
      },
    };

    const outcome = link(p, "rt", {}, seams);

    expect(outcome).toEqual({ ok: true, path: linkPath(home, "rt"), state: "linked" });
    expect(calls).toEqual([
      `symlink ${linkPath(home, "rt")}.new -> ${rtPath}`,
      `rename ${linkPath(home, "rt")}.new -> ${linkPath(home, "rt")}`,
    ]);
    expect(p.calls.symlinks[linkPath(home, "rt")]).toBeUndefined();
  });

  test("link(fast-browser) writes a tagged wrapper; isOurLink recognizes it; a second call reports already", () => {
    const p = probeWith();
    const outcome = link(p, "fast-browser");
    expect(outcome.ok).toBe(true);

    const path = linkPath(home, "fast-browser");
    const content = p.calls.writes[path]!;
    const lines = content.split("\n");
    expect(lines[1]).toBe(`${LINK_TAG} fast-browser`);
    expect(lines[2]).toBe(`exec "${nodePath}" "${fbPath}" "$@"`);
    expect(p.calls.modes[path]).toBe(0o755);
    expect(isOurLink(p, "fast-browser")).toBe(true);

    const second = link(p, "fast-browser");
    expect(second).toEqual({ ok: true, path, state: "already" });
  });

  test("link(gh) refuses when a user copy is already on PATH, unless forced", () => {
    const p = probeWith({ env: { PATH: "/opt/homebrew/bin" }, exists: (path: string) => path === "/opt/homebrew/bin/gh" || path === appRoot || path === ghPath });

    const refused = link(p, "gh");
    expect(refused).toEqual({ ok: false, reason: "user-copy", detail: expect.any(String) });

    const forced = link(p, "gh", { force: true });
    expect(forced).toEqual({ ok: true, path: linkPath(home, "gh"), state: "linked" });
  });

  test("link(rt) refuses dev-mode-owns-rt when ~/.local/bin/rt is the dev-mode wrapper script", () => {
    const path = linkPath(home, "rt");
    const p = probeWith({
      exists: (candidate: string) => candidate === path || candidate === appRoot || candidate === rtPath,
      readFile: (candidate: string) => (candidate === path ? "#!/bin/sh\nexec bun run cli.ts \"$@\"\n" : null),
    });

    const outcome = link(p, "rt");
    expect(outcome).toEqual({ ok: false, reason: "dev-mode-owns-rt", detail: expect.any(String) });
  });

  test("unlink removes a symlink form and a tagged-wrapper form, and leaves a user's own file alone", () => {
    const p = probeWith();
    link(p, "gh");
    expect(unlink(p, "gh")).toEqual({ removed: true });
    expect(p.exists(linkPath(home, "gh"))).toBe(false);

    link(p, "fast-browser");
    expect(unlink(p, "fast-browser")).toEqual({ removed: true });
    expect(p.exists(linkPath(home, "fast-browser"))).toBe(false);

    const userPath = linkPath(home, "deck");
    p.writeFile(userPath, "#!/bin/sh\necho not ours\n");
    expect(unlink(p, "deck")).toEqual({ removed: false });
    expect(p.exists(userPath)).toBe(true);
  });

  test("reconcile removes the gh link once a user copy appears on PATH, and keeps rt", () => {
    const p = probeWith();
    link(p, "gh");
    link(p, "rt", {}, {
      installRtBinary: (src) => {
        p.symlink(src, linkPath(home, "rt"));
        return linkPath(home, "rt");
      },
    });

    const before = reconcile(p);
    expect(before).toEqual({ removed: [], kept: ["gh", "rt"] });

    const withUserGh = (candidate: string) =>
      candidate === "/opt/homebrew/bin/gh" ||
      candidate === linkPath(home, "gh") ||
      candidate === linkPath(home, "rt") ||
      candidate === appRoot ||
      candidate === rtPath;
    const p2 = { ...p, env: { PATH: "/opt/homebrew/bin" }, exists: withUserGh };

    const after = reconcile(p2);
    expect(after.removed).toEqual(["gh"]);
    expect(after.kept).toEqual(["rt"]);
  });
});
