import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { DAEMON_CONFIG_PATH } from "../../daemon-config.ts";
import { LOGIN_ITEMS_SETTINGS_ACTION } from "../permissions.ts";
import { setSetting } from "../../settings/write.ts";
import { rtHealthRows } from "../validators/rt-health.ts";
import { fakeProbes, ok, missing } from "./fakes.ts";
import type { ExecScript } from "./fakes.ts";
import type { Probes } from "../probes.ts";

// Every test that isn't specifically exercising tool.fzf uses this: a real
// resolveFzf() falls back to appBundleRoot()'s zero-arg default, which is
// deliberately out of scope for these Probes-driven rows. (Prior to the
// R-T7-c fix in lib/bundle-layout.ts, appBundleRoot() memoized ANY
// successful resolution — including one derived from an injected `exists` —
// across the whole test process, so a stray real resolveFzf() call here
// could pin a real machine's mattstack.app for every later
// `appBundlePath(p)` call. Now that the memo only ever reads/writes on the
// true default (`exists === existsSync`), an injected-exists call like the
// ones this file's `bundleProbe()` makes can never populate or consult it —
// so the reset ceremony that used to be required here is gone.)
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

  test("rt not on PATH (exit 127) -> missing, link-bundled action", async () => {
    const exec: ExecScript = (argv) => (argv[0] === "rt" ? missing("rt") : ok());
    const r = await pickRow(rtHealthRows(fakeProbes({ exec }), { ci: false }, NOOP_FZF), "tool.rt");
    expect(r.status).toBe("missing");
    expect(r.detail).toBe("rt not found on PATH");
    expect(r.action).toEqual({ type: "link-bundled", label: "Use mattstack's", tool: "rt" });
  });

  test("rt exists but crashes (exit 1) -> error, not missing", async () => {
    const exec: ExecScript = (argv) => (argv[0] === "rt" ? { code: 1, stdout: "", stderr: "boom" } : ok());
    const r = await pickRow(rtHealthRows(fakeProbes({ exec }), { ci: false }, NOOP_FZF), "tool.rt");
    expect(r.status).toBe("error");
    expect(r.detail).toContain("1");
    expect(r.status).not.toBe("missing");
  });

  test("rt exec times out (probe code 124) -> error naming the code", async () => {
    const exec: ExecScript = (argv) => (argv[0] === "rt" ? { code: 124, stdout: "", stderr: "" } : ok());
    const r = await pickRow(rtHealthRows(fakeProbes({ exec }), { ci: false }, NOOP_FZF), "tool.rt");
    expect(r.status).toBe("error");
    expect(r.detail).toContain("124");
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
    home = mkdtempSync(join(tmpdir(), "rt-health-home-"));
    process.env.HOME = home;
    appRoot = join(home, "Applications", "mattstack.app");
    setSetting("mattstack.appPath", appRoot, "machine");
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(home, { recursive: true, force: true });
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
      expect(r.optionalNote).not.toBeNull();
    });

    test("readlink points elsewhere -> needs-you, with a one-shot link-bundled action (never a run through the full apply chain)", async () => {
      const linkedPath = join(home, ".local", "bin", "rt");
      const p = bundleProbe({ links: { [linkedPath]: "/opt/homebrew/bin/rt" } });
      const r = await pickRow(rtHealthRows(p, { ci: false }, NOOP_FZF), "tool.rt-link");
      expect(r.status).toBe("needs-you");
      expect(r.detail).toContain("not a link into mattstack.app");
      expect(r.action).toEqual({ type: "link-bundled", label: "Use mattstack's", tool: "rt" });
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

    test("resolveFzf resolves but the binary won't run (exit 127) -> error, never ready", async () => {
      const fzfPath = join(appRoot, "Contents", "Helpers", "fzf");
      const exec: ExecScript = (argv) => (argv[0] === fzfPath ? missing(fzfPath) : ok());
      const p = bundleProbe({ exec });
      const r = await pickRow(rtHealthRows(p, { ci: false }, { resolveFzf: () => fzfPath }), "tool.fzf");
      expect(r.status).toBe("error");
      expect(r.detail).toContain("127");
      expect(r.status).not.toBe("ready");
    });

    test("resolveFzf resolves but the binary times out (probe code 124) -> error, never ready", async () => {
      const fzfPath = join(appRoot, "Contents", "Helpers", "fzf");
      const exec: ExecScript = (argv) => (argv[0] === fzfPath ? { code: 124, stdout: "", stderr: "" } : ok());
      const p = bundleProbe({ exec });
      const r = await pickRow(rtHealthRows(p, { ci: false }, { resolveFzf: () => fzfPath }), "tool.fzf");
      expect(r.status).toBe("error");
      expect(r.detail).toContain("124");
    });
  });

  describe("tool.app", () => {
    test("app present -> ready, detail carries path and version, recheck on-activate", async () => {
      const exec: ExecScript = (argv) => (argv[0] === "/usr/libexec/PlistBuddy" ? ok("1.2.3\n") : ok());
      const p = bundleProbe({ exec });
      const r = await pickRow(rtHealthRows(p, { ci: false }, NOOP_FZF), "tool.app");
      expect(r.status).toBe("ready");
      expect(r.detail).toContain(appRoot);
      expect(r.detail).toContain("1.2.3");
      expect(r.required).toBe(true);
      expect(r.recheck).toBe("on-activate");
    });

    test("legacy rt-tray.app also present -> detail names the exact hit path(s), like verify does", async () => {
      const legacyPath = join(home, "Applications", "rt-tray.app");
      const p = bundleProbe({ dirs: { [legacyPath]: [] } });
      const r = await pickRow(rtHealthRows(p, { ci: false }, NOOP_FZF), "tool.app");
      expect(r.status).toBe("ready");
      expect(r.detail).toContain("old bundle still present");
      expect(r.detail).toContain(legacyPath);
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
      expect(r.optionalNote).not.toBeNull();
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

  test("tool.rt-link -> skipped for lack of an app, not the dev-mode reason", async () => {
    const p = fakeProbes({ home: "/nonexistent-rt-health-no-app" });
    const r = await pickRow(rtHealthRows(p, { ci: false }, NOOP_FZF), "tool.rt-link");
    expect(r.status).toBe("skipped");
    expect(r.detail).toContain("nothing to link into");
    expect(r.detail).not.toContain("dev mode");
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

  test("a real ~/.rt dir -> invalid, singular phrasing, with a merge-by-hand remedy (R-T7-b)", async () => {
    mkdirSync(join(home, ".rt"), { recursive: true });
    const r = await pickRow(rtHealthRows(fakeProbes({ home }), { ci: false }, NOOP_FZF), "tool.legacy-dirs");
    expect(r.status).toBe("invalid");
    expect(r.detail).toContain("real legacy dir present");
    expect(r.detail).not.toContain("dirs present");
    expect(r.detail).toContain("~/.mattstack/rt");
    // A required row must never be a dead end: an "invalid" verdict here
    // carries an action a person can actually follow.
    expect(r.action).not.toBeNull();
    expect(r.action?.type).toBe("steps");
    if (r.action?.type === "steps") {
      expect(r.action.steps.length).toBeGreaterThan(0);
    }
  });

  test("two real legacy dirs (~/.rt and ~/.shepherdr) -> invalid, plural phrasing", async () => {
    mkdirSync(join(home, ".rt"), { recursive: true });
    mkdirSync(join(home, ".shepherdr"), { recursive: true });
    const r = await pickRow(rtHealthRows(fakeProbes({ home }), { ci: false }, NOOP_FZF), "tool.legacy-dirs");
    expect(r.status).toBe("invalid");
    expect(r.detail).toContain("real legacy dirs present");
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
    expect(r.optionalNote).not.toBeNull();
  });

  test("a broken shim (a directory sitting where a file should be) -> tool.intercepts degrades to an error row, never rejects rtHealthRows() (finding #9)", async () => {
    const { writeInterceptRules } = await import("../../endpoint/shim.ts");
    writeInterceptRules([{ command: "ghosttool", repo: "acme", repoRemote: null, matches: [] }]);
    // shimReport()'s `existsSync(path) ? readFileSync(path,'utf8') : null`
    // (shim.ts) throws EISDIR when `path` exists but is a directory — a
    // real instance of the existsSync-then-readFileSync race the review
    // flagged, reproduced without mocking the shared shim.ts module (which
    // other test files import too — mocking it process-wide was found to
    // race lib/endpoint/__tests__/shim.test.ts when the full suite runs).
    mkdirSync(join(home, ".local", "bin", "ghosttool"), { recursive: true });

    await expect(rtHealthRows(fakeProbes({ home }), { ci: false }, NOOP_FZF)).resolves.toBeTruthy();
    const r = await pickRow(rtHealthRows(fakeProbes({ home }), { ci: false }, NOOP_FZF), "tool.intercepts");
    expect(r.status).toBe("error");
    expect(r.detail).toContain("check failed");
  });
});

describe("rtHealthRows — tool.shell (fully Probes-driven)", () => {
  test("no SHELL set -> needs-you, honest 'can't write automatically' detail (finding #11)", async () => {
    const p = fakeProbes({ home: "/fake-home" });
    const r = await pickRow(rtHealthRows(p, { ci: false }, NOOP_FZF), "tool.shell");
    expect(r.status).toBe("needs-you");
    expect(r.detail).toContain("can't write");
    expect(r.detail).not.toBe("shell integration missing — Install writes it");
    expect(r.optionalNote).not.toBeNull();
  });

  test("an unrecognized shell (e.g. tcsh) -> the same honest 'can't write automatically' detail", async () => {
    const p = fakeProbes({ home: "/fake-home", env: { SHELL: "/bin/tcsh" } });
    const r = await pickRow(rtHealthRows(p, { ci: false }, NOOP_FZF), "tool.shell");
    expect(r.status).toBe("needs-you");
    expect(r.detail).toContain("can't write");
  });

  test("zsh rc file contains rtcd -> ready", async () => {
    const p = fakeProbes({ home: "/fake-home", env: { SHELL: "/bin/zsh" }, files: { "/fake-home/.zshrc": "alias rtcd='rt-cd'\n" } });
    const r = await pickRow(rtHealthRows(p, { ci: false }, NOOP_FZF), "tool.shell");
    expect(r.status).toBe("ready");
    expect(r.detail).toContain(".zshrc");
  });

  test("known shell, rc file exists but has no rtcd -> needs-you, Install-writes-it detail", async () => {
    const p = fakeProbes({ home: "/fake-home", env: { SHELL: "/bin/zsh" }, files: { "/fake-home/.zshrc": "# nothing here\n" } });
    const r = await pickRow(rtHealthRows(p, { ci: false }, NOOP_FZF), "tool.shell");
    expect(r.status).toBe("needs-you");
    expect(r.detail).toBe("shell integration missing — Install writes it");
  });
});

describe("rtHealthRows — tool.extension (checkRtContextExtension over p.home)", () => {
  test("no editor dirs -> skipped", async () => {
    const p = fakeProbes({ home: "/nonexistent-rt-health-extension-fixture" });
    const r = await pickRow(rtHealthRows(p, { ci: false }, NOOP_FZF), "tool.extension");
    expect(r.status).toBe("skipped");
    expect(r.required).toBe(false);
    expect(r.optionalNote).not.toBeNull();
  });
});

/**
 * DAEMON_CONFIG_PATH is a module-load const bound under the shared preload
 * HOME (see lib/daemon-config.ts's own comment on RT_DIR) — the SAME file
 * commands/status/__tests__/status-fallback.test.ts depends on being
 * absent. Save/restore whatever was there before this describe ran (finding
 * #13), rather than just deleting on afterEach, so this file can never leave
 * that fixture in a state a different test file didn't expect.
 */
describe("rtHealthRows — tool.daemon", () => {
  let preExisting: string | null = null;

  beforeAll(() => {
    preExisting = existsSync(DAEMON_CONFIG_PATH) ? readFileSync(DAEMON_CONFIG_PATH, "utf8") : null;
  });

  afterEach(() => {
    rmSync(DAEMON_CONFIG_PATH, { force: true });
    if (preExisting !== null) {
      mkdirSync(dirname(DAEMON_CONFIG_PATH), { recursive: true });
      writeFileSync(DAEMON_CONFIG_PATH, preExisting);
    }
  });

  test("not installed -> missing", async () => {
    rmSync(DAEMON_CONFIG_PATH, { force: true });
    const r = await pickRow(rtHealthRows(fakeProbes(), { ci: false }, NOOP_FZF), "tool.daemon");
    expect(r.status).toBe("missing");
    expect(r.detail).toContain("Install");
    expect(r.required).toBe(true);
    expect(r.recheck).toBe("on-activate");
  });

  function markInstalled(): void {
    mkdirSync(dirname(DAEMON_CONFIG_PATH), { recursive: true });
    writeFileSync(DAEMON_CONFIG_PATH, JSON.stringify({ installed: true, installedAt: new Date().toISOString(), mode: "smappservice" }));
  }

  const readyDaemon: Probes["daemon"] = async (cmd) => {
    if (cmd === "ping") return { ok: true };
    if (cmd === "status") return { ok: true, data: { pid: 4242, uptime: 65_000, watchedRepos: 3 } };
    if (cmd === "worktrees") return { ok: true, data: [] };
    return null;
  };
  const launchdOk: ExecScript = (argv) => (argv[0] === "launchctl" ? ok("PID\tStatus\tLabel\n1\t0\tcom.mattstack.daemon\n") : ok());
  const launchdMissing: ExecScript = (argv) => (argv[0] === "launchctl" ? { code: 0, stdout: "Could not find service", stderr: "" } : ok());

  test("installed, ping unreachable, ci:false -> needs-you, the SAME Login Items action permissions.ts uses (finding #10)", async () => {
    markInstalled();
    const r = await pickRow(rtHealthRows(fakeProbes({ daemon: async () => null }), { ci: false }, NOOP_FZF), "tool.daemon");
    expect(r.status).toBe("needs-you");
    expect(r.detail).toContain("Login Items");
    expect(r.action).toBe(LOGIN_ITEMS_SETTINGS_ACTION);
  });

  test("installed, ping unreachable, ci:true -> needs-you mentioning CI", async () => {
    markInstalled();
    const r = await pickRow(rtHealthRows(fakeProbes({ daemon: async () => null }), { ci: true }, NOOP_FZF), "tool.daemon");
    expect(r.status).toBe("needs-you");
    expect(r.detail).toContain("CI");
  });

  test("installed, ping ok, launchd registered, worktrees responding -> ready, recheck on-activate", async () => {
    markInstalled();
    const r = await pickRow(rtHealthRows(fakeProbes({ daemon: readyDaemon, exec: launchdOk }), { ci: false }, NOOP_FZF), "tool.daemon");
    expect(r.status).toBe("ready");
    expect(r.detail).toContain("pid 4242");
    expect(r.detail).toContain("uptime 65s");
    expect(r.detail).toContain("watching 3 repos");
    expect(r.detail).toContain("registered with launchd");
    expect(r.detail).toContain("worktrees endpoint responding");
    expect(r.recheck).toBe("on-activate");
  });

  test("installed, ping ok, but NOT registered with launchd -> invalid, naming the failing fact (R-T7-a)", async () => {
    markInstalled();
    const r = await pickRow(rtHealthRows(fakeProbes({ daemon: readyDaemon, exec: launchdMissing }), { ci: false }, NOOP_FZF), "tool.daemon");
    expect(r.status).toBe("invalid");
    expect(r.detail).toContain("not registered with launchd");
  });

  test("installed, ping ok, launchd registered, but the worktrees endpoint is down -> error (could not determine), never invalid", async () => {
    // worktrees === null is the daemon-client's own transport-failure
    // sentinel — "the probe never produced an answer", not "the endpoint
    // said no" — so this must read as could-not-determine, not a
    // determined negative.
    markInstalled();
    const daemon: Probes["daemon"] = async (cmd) => {
      if (cmd === "ping") return { ok: true };
      if (cmd === "status") return { ok: true, data: { pid: 1, uptime: 1000, watchedRepos: 0 } };
      if (cmd === "worktrees") return null; // dead endpoint
      return null;
    };
    const r = await pickRow(rtHealthRows(fakeProbes({ daemon, exec: launchdOk }), { ci: false }, NOOP_FZF), "tool.daemon");
    expect(r.status).toBe("error");
    expect(r.detail).toContain("worktrees endpoint check failed");
  });

  test("installed, ping ok, but launchctl itself times out -> error (could not determine), never invalid", async () => {
    markInstalled();
    const daemon: Probes["daemon"] = async (cmd) => {
      if (cmd === "ping") return { ok: true };
      if (cmd === "status") return { ok: true, data: { pid: 1, uptime: 1000, watchedRepos: 0 } };
      if (cmd === "worktrees") return { ok: true };
      return null;
    };
    const r = await pickRow(
      rtHealthRows(fakeProbes({ daemon, exec: async (argv) => (argv[0] === "launchctl" ? { code: 124, stdout: "", stderr: "" } : { code: 0, stdout: "", stderr: "" }) }), { ci: false }, NOOP_FZF),
      "tool.daemon",
    );
    expect(r.status).toBe("error");
    expect(r.detail).toContain("launchctl check failed");
    expect(r.detail).not.toContain("not registered with launchd");
  });
});
