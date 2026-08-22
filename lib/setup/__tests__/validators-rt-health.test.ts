import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { __test__ as bundleLayoutTest } from "../../bundle-layout.ts";
import { DAEMON_CONFIG_PATH } from "../../daemon-config.ts";
import { setSetting } from "../../settings/write.ts";
import { rtHealthRows } from "../validators/rt-health.ts";
import { fakeProbes, ok, missing } from "./fakes.ts";
import type { ExecScript } from "./fakes.ts";
import type { Probes } from "../probes.ts";

// bundle-layout.ts's appBundleRoot() memoizes a successful resolution across
// the whole test process — reset before every test in this file so one
// test's fake bundle can never leak into the next (mirrors
// lib/deps/__tests__/resolve.test.ts's own beforeEach/afterEach).
beforeEach(() => {
  bundleLayoutTest.resetBundleLayoutMemo();
});

// Every test that isn't specifically exercising tool.fzf uses this: the
// REAL resolveFzf() falls back to bundledHelperPath()'s default (real
// existsSync-based) appBundleRoot() lookup, which can find a REAL
// mattstack.app on the machine running these tests and poison
// bundle-layout.ts's process-wide resolution memo for every row after it.
const NOOP_FZF = { resolveFzf: () => null };

const ROW_ORDER = [
  "tool.rt",
  "tool.rt-link",
  "tool.legacy-dirs",
  "tool.intercepts",
  "tool.fzf",
  "tool.app",
  "tool.vsix",
  "tool.extension",
  "tool.shell",
  "tool.daemon",
];

async function pickRow(rowsP: ReturnType<typeof rtHealthRows>, id: string) {
  const rows = await rowsP;
  const r = rows.find((row) => row.id === id);
  if (!r) throw new Error(`no row ${id}`);
  return r;
}

describe("rtHealthRows — row order", () => {
  test("ids match the table order regardless of status", async () => {
    const rows = await rtHealthRows(fakeProbes({ home: "/nonexistent-rt-health-order-fixture" }), { ci: false }, NOOP_FZF);
    expect(rows.map((r) => r.id)).toEqual(ROW_ORDER);
  });
});

describe("rtHealthRows — tool.rt", () => {
  test("rt --version ok -> ready with stdout as detail", async () => {
    const exec: ExecScript = (argv) => (argv[0] === "rt" ? ok("rt 1.2.3\n") : ok());
    const r = await pickRow(rtHealthRows(fakeProbes({ exec }), { ci: false }, NOOP_FZF), "tool.rt");
    expect(r.status).toBe("ready");
    expect(r.detail).toBe("rt 1.2.3");
    expect(r.required).toBe(true);
  });

  test("rt not on PATH -> missing, link-bundled action", async () => {
    const exec: ExecScript = (argv) => (argv[0] === "rt" ? missing("rt") : ok());
    const r = await pickRow(rtHealthRows(fakeProbes({ exec }), { ci: false }, NOOP_FZF), "tool.rt");
    expect(r.status).toBe("missing");
    expect(r.detail).toBe("rt not found on PATH");
    expect(r.action).toEqual({ type: "link-bundled", label: "Use mattstack's", tool: "rt" });
  });
});

/**
 * appBundlePath() ultimately reads the `mattstack.appPath` MACHINE setting
 * via real fs (lib/settings — not a Probes seam), so these rows need a real
 * temp HOME with that setting actually written, mirroring
 * lib/deps/__tests__/resolve.test.ts's established pattern. Everything else
 * about the bundle (does a given path "exist") stays on the fakeProbes
 * seam via the injected `exists` callback.
 */
describe("rtHealthRows — rows that resolve the app bundle", () => {
  const origHome = process.env.HOME;
  let home: string;
  let appRoot: string;

  beforeEach(() => {
    bundleLayoutTest.resetBundleLayoutMemo();
    home = mkdtempSync(join(tmpdir(), "rt-health-home-"));
    process.env.HOME = home;
    appRoot = join(home, "Applications", "mattstack.app");
    setSetting("mattstack.appPath", appRoot, "machine");
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(home, { recursive: true, force: true });
    bundleLayoutTest.resetBundleLayoutMemo();
  });

  function bundleProbe(extra: Parameters<typeof fakeProbes>[0] = {}): ReturnType<typeof fakeProbes> {
    return fakeProbes({ home, ...extra, dirs: { [appRoot]: [], ...(extra.dirs ?? {}) } });
  }

  describe("tool.rt-link", () => {
    test("readlink matches the bundle's Contents/MacOS/rt -> ready", async () => {
      const linkedPath = join(home, ".local", "bin", "rt");
      const p = bundleProbe({ links: { [linkedPath]: join(appRoot, "Contents", "MacOS", "rt") } });
      const r = await pickRow(rtHealthRows(p, { ci: false }, NOOP_FZF), "tool.rt-link");
      expect(r.status).toBe("ready");
      expect(r.detail).toBe("linked into the bundle");
      expect(r.required).toBe(false);
    });

    test("readlink points elsewhere -> needs-you", async () => {
      const linkedPath = join(home, ".local", "bin", "rt");
      const p = bundleProbe({ links: { [linkedPath]: "/opt/homebrew/bin/rt" } });
      const r = await pickRow(rtHealthRows(p, { ci: false }, NOOP_FZF), "tool.rt-link");
      expect(r.status).toBe("needs-you");
      expect(r.detail).toContain("not a link into mattstack.app");
    });

    test("dev mode wrapper at ~/.local/bin/rt -> skipped, dev mode owns it", async () => {
      const wrapperDir = join(home, ".local", "bin");
      mkdirSync(wrapperDir, { recursive: true });
      writeFileSync(join(wrapperDir, "rt"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const p = bundleProbe();
      const r = await pickRow(rtHealthRows(p, { ci: false }, NOOP_FZF), "tool.rt-link");
      expect(r.status).toBe("skipped");
      expect(r.detail).toContain("dev mode owns ~/.local/bin/rt");
    });
  });

  describe("tool.fzf", () => {
    test("resolveFzf resolves inside the bundle -> detail says bundled", async () => {
      const fzfPath = join(appRoot, "Contents", "Helpers", "fzf");
      const exec: ExecScript = (argv) => (argv[0] === fzfPath ? ok("0.44.1 (ff457a5)\n") : ok());
      const p = bundleProbe({ exec });
      const r = await pickRow(rtHealthRows(p, { ci: false }, { resolveFzf: () => fzfPath }), "tool.fzf");
      expect(r.status).toBe("ready");
      expect(r.detail).toContain("bundled");
      expect(r.detail).toContain("0.44.1");
    });

    test("resolveFzf resolves outside the bundle -> detail says PATH", async () => {
      const exec: ExecScript = (argv) => (argv[0] === "/opt/homebrew/bin/fzf" ? ok("0.44.1 (ff457a5)\n") : ok());
      const p = bundleProbe({ exec });
      const r = await pickRow(rtHealthRows(p, { ci: false }, { resolveFzf: () => "/opt/homebrew/bin/fzf" }), "tool.fzf");
      expect(r.status).toBe("ready");
      expect(r.detail).toContain("PATH");
      expect(r.detail).not.toContain("bundled");
    });

    test("resolveFzf finds nothing -> missing, link-bundled action", async () => {
      const p = bundleProbe();
      const r = await pickRow(rtHealthRows(p, { ci: false }, { resolveFzf: () => null }), "tool.fzf");
      expect(r.status).toBe("missing");
      expect(r.detail).toBe("fzf not found");
      expect(r.action).toEqual({ type: "link-bundled", label: "Use mattstack's", tool: "fzf" });
      expect(r.required).toBe(true);
    });
  });

  describe("tool.app", () => {
    test("app present -> ready, detail carries path and version", async () => {
      const exec: ExecScript = (argv) => (argv[0] === "/usr/libexec/PlistBuddy" ? ok("1.2.3\n") : ok());
      const p = bundleProbe({ exec });
      const r = await pickRow(rtHealthRows(p, { ci: false }, NOOP_FZF), "tool.app");
      expect(r.status).toBe("ready");
      expect(r.detail).toContain(appRoot);
      expect(r.detail).toContain("1.2.3");
      expect(r.required).toBe(true);
    });

    test("legacy rt-tray.app also present -> detail appends the note", async () => {
      const legacyPath = join(home, "Applications", "rt-tray.app");
      const p = bundleProbe({ dirs: { [legacyPath]: [] } });
      const r = await pickRow(rtHealthRows(p, { ci: false }, NOOP_FZF), "tool.app");
      expect(r.status).toBe("ready");
      expect(r.detail).toContain("legacy rt-tray.app still present");
    });
  });

  describe("tool.vsix", () => {
    test("vsix present in the bundle -> ready", async () => {
      const vsix = join(appRoot, "Contents", "Resources", "rt-context.vsix");
      const p = bundleProbe({ files: { [vsix]: "" } });
      const r = await pickRow(rtHealthRows(p, { ci: false }, NOOP_FZF), "tool.vsix");
      expect(r.status).toBe("ready");
      expect(r.detail).toBe("bundled extension present");
      expect(r.required).toBe(false);
    });

    test("vsix absent from an otherwise-present bundle -> skipped", async () => {
      const p = bundleProbe();
      const r = await pickRow(rtHealthRows(p, { ci: false }, NOOP_FZF), "tool.vsix");
      expect(r.status).toBe("skipped");
      expect(r.detail).toContain("pre-bundle build");
    });
  });
});

describe("rtHealthRows — no app installed", () => {
  test("tool.app -> missing", async () => {
    const p = fakeProbes({ home: "/nonexistent-rt-health-no-app" });
    const r = await pickRow(rtHealthRows(p, { ci: false }, NOOP_FZF), "tool.app");
    expect(r.status).toBe("missing");
    expect(r.detail).toBe("mattstack.app not found in /Applications or ~/Applications");
  });

  test("tool.vsix -> skipped, no app", async () => {
    const p = fakeProbes({ home: "/nonexistent-rt-health-no-app" });
    const r = await pickRow(rtHealthRows(p, { ci: false }, NOOP_FZF), "tool.vsix");
    expect(r.status).toBe("skipped");
    expect(r.detail).toBe("mattstack.app not found");
  });

  test("tool.rt-link -> skipped, no app", async () => {
    const p = fakeProbes({ home: "/nonexistent-rt-health-no-app" });
    const r = await pickRow(rtHealthRows(p, { ci: false }, NOOP_FZF), "tool.rt-link");
    expect(r.status).toBe("skipped");
  });
});

/**
 * legacyDirsPresent()/shimReport()/staleIntercepts()/localBinDir() resolve
 * HOME at call time (mirrors lib/rt-paths.ts's home()), so — like
 * lib/__tests__/rt-paths.test.ts — these rows are testable by overriding
 * process.env.HOME per test.
 */
describe("rtHealthRows — tool.legacy-dirs", () => {
  const origHome = process.env.HOME;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "rt-health-legacy-"));
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(home, { recursive: true, force: true });
  });

  test("no legacy dirs -> ready", async () => {
    const r = await pickRow(rtHealthRows(fakeProbes({ home }), { ci: false }, NOOP_FZF), "tool.legacy-dirs");
    expect(r.status).toBe("ready");
    expect(r.required).toBe(true);
  });

  test("a real ~/.rt dir -> invalid", async () => {
    mkdirSync(join(home, ".rt"), { recursive: true });
    const r = await pickRow(rtHealthRows(fakeProbes({ home }), { ci: false }, NOOP_FZF), "tool.legacy-dirs");
    expect(r.status).toBe("invalid");
    expect(r.detail).toContain("real legacy dir present");
    expect(r.detail).toContain("~/.mattstack/rt");
  });
});

describe("rtHealthRows — tool.intercepts", () => {
  const origHome = process.env.HOME;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "rt-health-intercepts-"));
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(home, { recursive: true, force: true });
  });

  test("no rules declared -> skipped", async () => {
    const r = await pickRow(rtHealthRows(fakeProbes({ home }), { ci: false }, NOOP_FZF), "tool.intercepts");
    expect(r.status).toBe("skipped");
    expect(r.detail).toBe("no intercepts declared");
    expect(r.required).toBe(false);
  });
});

describe("rtHealthRows — tool.shell (fully Probes-driven)", () => {
  test("no SHELL / no rc file -> needs-you", async () => {
    const p = fakeProbes({ home: "/fake-home" });
    const r = await pickRow(rtHealthRows(p, { ci: false }, NOOP_FZF), "tool.shell");
    expect(r.status).toBe("needs-you");
    expect(r.detail).toBe("shell integration missing — Install writes it");
  });

  test("zsh rc file contains rtcd -> ready", async () => {
    const p = fakeProbes({ home: "/fake-home", env: { SHELL: "/bin/zsh" }, files: { "/fake-home/.zshrc": "alias rtcd='rt-cd'\n" } });
    const r = await pickRow(rtHealthRows(p, { ci: false }, NOOP_FZF), "tool.shell");
    expect(r.status).toBe("ready");
    expect(r.detail).toContain(".zshrc");
  });

  test("rc file exists but has no rtcd -> needs-you", async () => {
    const p = fakeProbes({ home: "/fake-home", env: { SHELL: "/bin/zsh" }, files: { "/fake-home/.zshrc": "# nothing here\n" } });
    const r = await pickRow(rtHealthRows(p, { ci: false }, NOOP_FZF), "tool.shell");
    expect(r.status).toBe("needs-you");
  });
});

describe("rtHealthRows — tool.extension (checkRtContextExtension over p.home)", () => {
  test("no editor dirs -> skipped", async () => {
    const p = fakeProbes({ home: "/nonexistent-rt-health-extension-fixture" });
    const r = await pickRow(rtHealthRows(p, { ci: false }, NOOP_FZF), "tool.extension");
    expect(r.status).toBe("skipped");
    expect(r.required).toBe(false);
  });
});

describe("rtHealthRows — tool.daemon", () => {
  afterEach(() => {
    rmSync(DAEMON_CONFIG_PATH, { force: true });
  });

  test("not installed -> missing", async () => {
    rmSync(DAEMON_CONFIG_PATH, { force: true });
    const r = await pickRow(rtHealthRows(fakeProbes(), { ci: false }, NOOP_FZF), "tool.daemon");
    expect(r.status).toBe("missing");
    expect(r.detail).toContain("Install");
    expect(r.required).toBe(true);
  });

  function markInstalled(): void {
    mkdirSync(join(DAEMON_CONFIG_PATH, ".."), { recursive: true });
    writeFileSync(DAEMON_CONFIG_PATH, JSON.stringify({ installed: true, installedAt: new Date().toISOString(), mode: "smappservice" }));
  }

  test("installed, ping unreachable, ci:false -> needs-you, Login Items action", async () => {
    markInstalled();
    const r = await pickRow(rtHealthRows(fakeProbes({ daemon: async () => null }), { ci: false }, NOOP_FZF), "tool.daemon");
    expect(r.status).toBe("needs-you");
    expect(r.detail).toContain("Login Items");
    expect(r.action).toEqual({ type: "open-settings", label: "Open Login Items…", target: "login-items" });
  });

  test("installed, ping unreachable, ci:true -> needs-you mentioning CI", async () => {
    markInstalled();
    const r = await pickRow(rtHealthRows(fakeProbes({ daemon: async () => null }), { ci: true }, NOOP_FZF), "tool.daemon");
    expect(r.status).toBe("needs-you");
    expect(r.detail).toContain("CI");
  });

  test("installed, ping ok -> ready, detail folds in status/launchd/worktrees", async () => {
    markInstalled();
    const daemon: Probes["daemon"] = async (cmd) => {
      if (cmd === "ping") return { ok: true };
      if (cmd === "status") return { ok: true, data: { pid: 4242, uptime: 65_000, watchedRepos: 3 } };
      if (cmd === "worktrees") return { ok: true, data: [] };
      return null;
    };
    const exec: ExecScript = (argv) => (argv[0] === "launchctl" ? ok("PID\tStatus\tLabel\n1\t0\tcom.mattstack.daemon\n") : ok());
    const r = await pickRow(rtHealthRows(fakeProbes({ daemon, exec }), { ci: false }, NOOP_FZF), "tool.daemon");
    expect(r.status).toBe("ready");
    expect(r.detail).toContain("pid 4242");
    expect(r.detail).toContain("uptime 65s");
    expect(r.detail).toContain("watching 3 repos");
    expect(r.detail).toContain("registered with launchd");
    expect(r.detail).toContain("worktrees endpoint responding");
  });
});
