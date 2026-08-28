import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { HELPERS_DIR, RT_BUNDLE_PATH, __test__ as bundleLayoutTest } from "../../bundle-layout.ts";
import { setSetting } from "../../settings/write.ts";
import { fakeProbes, type FakeProbesOpts } from "../../setup/__tests__/fakes.ts";
import { createRealProbes } from "../../setup/probes.ts";
import { readSetupState } from "../../setup/state.ts";
import { DEFAULT_EXPOSED, LINK_TAG, isOurLink, link, linkPath, reconcile, unlink, type LinkSeams } from "../links.ts";

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
    {
      // F8: exec entries containing shell metacharacters — proves the
      // wrapper escapes them rather than splicing them raw into /bin/sh.
      name: "dangerish", version: "1.0.0", license: "MIT", url: "https://x/d.tgz", sha256: "d".repeat(64),
      archive: "tar.gz", extract: "d", bundlePath: `${HELPERS_DIR}/dangerish`,
      exec: [`${HELPERS_DIR}/dangerish/it's $HOME \`whoami\`/bin`, `${HELPERS_DIR}/dangerish/arg two`],
      exposeByDefault: false, entitlements: "none", status: "bundled", kind: "helper",
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
    mkdirSync(join(appRoot, "Contents", "MacOS"), { recursive: true });
    mkdirSync(join(appRoot, HELPERS_DIR, "node", "bin"), { recursive: true });
    mkdirSync(join(appRoot, HELPERS_DIR, "fast-browser", "bin"), { recursive: true });
    writeFileSync(join(appRoot, "Contents", "Info.plist"), "<plist/>");
    writeFileSync(join(appRoot, "Contents", "Resources", "deps.lock"), JSON.stringify(LOCK));
    writeFileSync(join(appRoot, RT_BUNDLE_PATH), "rt-binary");
    writeFileSync(join(appRoot, HELPERS_DIR, "gh"), "gh-binary");
    writeFileSync(join(appRoot, HELPERS_DIR, "node", "bin", "node"), "node-binary");
    writeFileSync(join(appRoot, HELPERS_DIR, "fast-browser", "bin", "fast-browser.mjs"), "fb-binary");
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

  /** A fakeProbes wired with the bundle's own helper files/dirs already tracked, merged with per-test extras. */
  function bundleProbe(extra: Partial<FakeProbesOpts> = {}): ReturnType<typeof fakeProbes> {
    return fakeProbes({
      home,
      ...extra,
      files: { [ghPath]: "gh-binary", [nodePath]: "node-binary", [fbPath]: "fb-binary", [rtPath]: "rt-binary", ...(extra.files ?? {}) },
      dirs: { [appRoot]: [], [join(appRoot, HELPERS_DIR, "fast-browser")]: ["bin"], ...(extra.dirs ?? {}) },
    });
  }

  test("DEFAULT_EXPOSED is exactly the four tools rt exposes by default (F12)", () => {
    expect(DEFAULT_EXPOSED).toEqual(["rt", "fast-browser", "gitq", "deck"]);
  });

  test("link(gh) creates a symlink targeting the bundled path", () => {
    const p = bundleProbe();
    const outcome = link(p, "gh");
    expect(outcome).toEqual({ ok: true, path: linkPath(home, "gh"), state: "linked" });
    expect(p.calls.symlinks[linkPath(home, "gh")]).toBe(ghPath);
  });

  test("link(rt) goes through the installRtBinary seam, atomically, never a bare symlink", () => {
    const p = bundleProbe();
    const calls: string[] = [];
    const seams: LinkSeams = {
      installRtBinary(src, dest) {
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

  test("link(rt)'s seam receives dest computed from p.home, not real HOME (F10)", () => {
    // p.home deliberately differs from process.env.HOME (which drives the
    // bundle/settings resolution) — proves the seam is handed a dest that
    // honors the injected home rather than silently naming a file that was
    // never written.
    const otherHome = "/other-fake-home";
    const p = { ...bundleProbe(), home: otherHome };
    let seenDest = "";
    const seams: LinkSeams = { installRtBinary: (_src, dest) => { seenDest = dest; return dest; } };

    const outcome = link(p, "rt", {}, seams);
    expect(outcome.ok).toBe(true);
    expect(seenDest).toBe(linkPath(otherHome, "rt"));
  });

  test("link(fast-browser) writes a tagged wrapper (single-quote escaped); isOurLink recognizes it; a second call reports already", () => {
    const p = bundleProbe();
    const outcome = link(p, "fast-browser");
    expect(outcome.ok).toBe(true);

    const path = linkPath(home, "fast-browser");
    const content = p.calls.writes[path]!;
    const lines = content.split("\n");
    expect(lines[1]).toBe(`${LINK_TAG} fast-browser`);
    expect(lines[2]).toBe(`exec '${nodePath}' '${fbPath}' "$@"`);
    expect(p.calls.modes[path]).toBe(0o755);
    expect(isOurLink(p, "fast-browser")).toBe(true);

    const second = link(p, "fast-browser");
    expect(second).toEqual({ ok: true, path, state: "already" });
  });

  test("the wrapper's exec line single-quote-escapes argv entries containing $, backticks, and quotes (F8)", () => {
    const argv0 = join(appRoot, HELPERS_DIR, "dangerish", "it's $HOME `whoami`/bin");
    const argv1 = join(appRoot, HELPERS_DIR, "dangerish", "arg two");
    const p = bundleProbe({ files: { [argv0]: "x", [argv1]: "x" } });

    const outcome = link(p, "dangerish");
    expect(outcome.ok).toBe(true);

    const path = linkPath(home, "dangerish");
    const content = p.calls.writes[path]!;
    const execLine = content.split("\n")[2]!;

    // Single-quoted, with the one embedded quote escaped via '\'' — never a
    // bare double-quoted splice, which $, `, and " would all break out of.
    expect(execLine).toBe(`exec '${argv0.replace(/'/g, `'\\''`)}' '${argv1}' "$@"`);
    expect(execLine).not.toContain(`"${argv0}"`);

    // The escaping is reversible under real /bin/sh single-quote rules: each
    // '\'' splice reconstructs exactly the original embedded quote.
    const quoted = execLine.match(/^exec '((?:[^']|'\\''.)*)'/)![1]!;
    const reconstructed = quoted.split(`'\\''`).join("'");
    expect(reconstructed).toBe(argv0);
  });

  test("link(gh) refuses when a user copy is already on PATH, unless forced", () => {
    const p = bundleProbe({ env: { PATH: "/opt/homebrew/bin" }, files: { "/opt/homebrew/bin/gh": "real-gh-binary" } });

    const refused = link(p, "gh");
    expect(refused).toEqual({ ok: false, reason: "user-copy", detail: expect.any(String) });

    const forced = link(p, "gh", { force: true });
    expect(forced).toEqual({ ok: true, path: linkPath(home, "gh"), state: "linked" });
  });

  test("link(gh) refuses 'occupied' for an unrelated file at the link path, unless forced (F13)", () => {
    const path = linkPath(home, "gh");
    const p = bundleProbe({ files: { [path]: "#!/bin/sh\necho some other script\n" } });

    const refused = link(p, "gh");
    expect(refused).toEqual({ ok: false, reason: "occupied", detail: expect.any(String) });

    const forced = link(p, "gh", { force: true });
    expect(forced).toEqual({ ok: true, path, state: "linked" });
    expect(p.calls.symlinks[path]).toBe(ghPath);
  });

  test("link('does-not-exist') refuses no-bundle (F13)", () => {
    const p = bundleProbe();
    const outcome = link(p, "does-not-exist");
    expect(outcome).toEqual({ ok: false, reason: "no-bundle", detail: expect.any(String) });
  });

  test("link(rt) refuses dev-mode-owns-rt when ~/.local/bin/rt is the dev-mode wrapper script", () => {
    // isDevModeWrapper reads the real fs at `path` (bounded prefix, never
    // through the Probes seam), so this needs a real file on disk -- `home`
    // is a real mkdtempSync'd directory, not a fake one.
    const path = linkPath(home, "rt");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "#!/bin/sh\nexport RT_LAUNCH_CWD=\"$PWD\"\nexec bun run cli.ts \"$@\"\n");
    const p = bundleProbe({ files: { [path]: "#!/bin/sh\nexport RT_LAUNCH_CWD=\"$PWD\"\nexec bun run cli.ts \"$@\"\n" } });

    const outcome = link(p, "rt");
    expect(outcome).toEqual({ ok: false, reason: "dev-mode-owns-rt", detail: expect.any(String) });
  });

  test("unlink removes a symlink form and a tagged-wrapper form, and leaves a user's own file alone", () => {
    const p = bundleProbe();
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

  test("a dangling our-link (target gone) is unlinkable, and link() repairs it in place instead of throwing (F5)", () => {
    const p = bundleProbe();
    const staleTarget = join(appRoot, HELPERS_DIR, "gh-old-location"); // never tracked as a file — simulates a moved/renamed helper
    p.symlink(staleTarget, linkPath(home, "gh"));

    expect(p.exists(linkPath(home, "gh"))).toBe(false); // dangling: readlink succeeds, the target doesn't
    expect(isOurLink(p, "gh")).toBe(true); // still recognized as ours — it points inside the bundle root

    const repaired = link(p, "gh");
    expect(repaired).toEqual({ ok: true, path: linkPath(home, "gh"), state: "linked" });
    expect(p.calls.symlinks[linkPath(home, "gh")]).toBe(ghPath); // repointed at the current, valid bundle path
    expect(p.exists(linkPath(home, "gh"))).toBe(true);
  });

  test("unlink removes a dangling our-link outright", () => {
    const p = bundleProbe();
    const staleTarget = join(appRoot, HELPERS_DIR, "gh-old-location");
    p.symlink(staleTarget, linkPath(home, "gh"));

    expect(unlink(p, "gh")).toEqual({ removed: true });
    expect(p.readlink(linkPath(home, "gh"))).toBeNull();
  });

  test("reconcile removes the gh link once a user copy appears on PATH, and keeps rt", () => {
    const p = bundleProbe();
    link(p, "gh");
    link(p, "rt", {}, { installRtBinary: (src, dest) => { p.symlink(src, dest); return dest; } });

    const before = reconcile(p);
    expect(before).toEqual({ removed: [], kept: ["gh", "rt"] });

    // Mutate the SAME probe (not a fresh one) — reconcile's readDir(~/.local/bin)
    // must see the directory listing symlink() already registered above.
    p.env.PATH = "/opt/homebrew/bin";
    p.writeFile("/opt/homebrew/bin/gh", "real-gh-binary");

    const after = reconcile(p);
    expect(after.removed).toEqual(["gh"]);
    expect(after.kept).toEqual(["rt"]);
  });

  test("a --force'd link survives a reconcile even after a user copy shows up (F7)", () => {
    const p = bundleProbe({ env: { PATH: "/opt/homebrew/bin" }, files: { "/opt/homebrew/bin/gh": "real-gh-binary" } });

    const forced = link(p, "gh", { force: true });
    expect(forced.ok).toBe(true);
    expect(readSetupState(p).forcedLinks).toEqual(["gh"]);

    const result = reconcile(p);
    expect(result).toEqual({ removed: [], kept: ["gh"] });
  });

  test("unlink clears the forced-link memory — a fresh (non-forced) link at the same path reconciles normally (F7)", () => {
    const p = bundleProbe({ env: { PATH: "/opt/homebrew/bin" }, files: { "/opt/homebrew/bin/gh": "real-gh-binary" } });
    link(p, "gh", { force: true });
    expect(readSetupState(p).forcedLinks).toEqual(["gh"]);

    unlink(p, "gh");
    expect(readSetupState(p).forcedLinks).toEqual([]);

    p.symlink(ghPath, linkPath(home, "gh")); // a fresh our-link, placed without going through force this time
    const result = reconcile(p);
    expect(result).toEqual({ removed: ["gh"], kept: [] });
  });

  // S066: a DEFAULT_EXPOSED tool (rt's own product surface, not a vendored
  // third-party tool like "gh") is never auto-unlinked by a same-named PATH
  // collision — an unrelated foreign tool of the same name (e.g. Kong's own
  // "deck") must never shadow-remove mattstack's.
  test("reconcile never auto-unlinks deck/gitq/rt even when a same-named binary appears elsewhere on PATH (S066)", () => {
    const p = bundleProbe({ env: { PATH: "/opt/homebrew/bin" } });
    p.symlink(join(appRoot, HELPERS_DIR, "deck"), linkPath(home, "deck"));
    p.symlink(join(appRoot, HELPERS_DIR, "gitq"), linkPath(home, "gitq"));
    link(p, "rt", {}, { installRtBinary: (src, dest) => { p.symlink(src, dest); return dest; } });

    // An unrelated foreign binary happens to share each name.
    p.writeFile("/opt/homebrew/bin/deck", "kongs-deck-binary");
    p.writeFile("/opt/homebrew/bin/gitq", "some-other-gitq-binary");
    p.writeFile("/opt/homebrew/bin/rt", "some-other-rt-binary");

    const result = reconcile(p);
    expect(result.removed).toEqual([]);
    expect(result.kept.sort()).toEqual(["deck", "gitq", "rt"]);
  });

  test("real-fs repro (F1): after the daemon's boot-time PATH prepend, reconcile removes nothing", () => {
    // Real fs (existsSync/statSync/symlinkSync/readdirSync via createRealProbes)
    // is what actually matters for this proof — the file/directory distinction
    // and the bundle-prefix check only mean something against real inodes.
    // `env` is overridden to a hermetic PATH instead of the real process.env.PATH
    // so this doesn't depend on what happens to be installed on the machine
    // running the suite (e.g. a real /opt/homebrew/bin/gh).
    const probes = { ...createRealProbes(), env: { PATH: "" } as Record<string, string | undefined> };
    const ghLinked = link(probes, "gh");
    const fbLinked = link(probes, "fast-browser");
    expect(ghLinked.ok).toBe(true);
    expect(fbLinked.ok).toBe(true);

    // Mirrors lib/daemon.ts's boot-time PATH prepend exactly: the bundle's
    // own Contents/Helpers dir as PATH entry #0.
    probes.env.PATH = join(appRoot, "Contents", "Helpers");

    const result = reconcile(probes);
    expect(result.removed).toEqual([]);
    expect(result.kept.sort()).toEqual(["fast-browser", "gh"]);
  });
});
