/**
 * commands/post-install.ts — one-shot legacy migration sweep (MAT-383 §4).
 *
 * `rt --post-install` re-execs on EVERY `rt update` (commands/update.ts) and
 * on every first-run-without-daemon.json path (cli.ts), so the sweep
 * (osascript quit "rt-tray" → pkill fallback → `launchctl bootout
 * gui/$UID/com.rt.daemon` → `rm -rf` each legacyTrayAppPaths() entry) is
 * GUARDED: it must fire only when a legacy rt-tray.app bundle is still on
 * disk. Unguarded, it would boot out com.rt.daemon — the label prod KEEPS —
 * on every routine update, killing the live daemon forever. That guard is
 * the whole point of the first test below.
 *
 * `osascript`/`pkill`/`launchctl`/`rm` (and `xattr`/`open`, so the install
 * step's own calls are visible too) are faked via a PATH-prepended temp bin
 * dir — never the real binaries — same convention as
 * lib/__tests__/dev-mode-handoff.test.ts. Every production spawnSync call in
 * commands/post-install.ts passes `env: process.env` (the Bun PATH-snapshot
 * gotcha: a bare command resolves against the PATH captured at process
 * start unless `env` is passed explicitly), which this test relies on being
 * wired correctly, not just on PATH containing the fakes.
 *
 * These tests drive the real, unmodified `runPostInstall()` end to end (not
 * a carved-out sweep function) so the "sweep runs before the install step"
 * claim is checked against the actual call order in production code, not
 * against test scaffolding. No real bundle exists next to the test's bun
 * binary, so `installTrayApp()` always takes its "not found — skipping"
 * branch — its own osascript/pkill/xattr calls never fire either way, which
 * is exactly what makes the "install step" side of the comparison
 * observable purely through its console output rather than more spawnSync
 * calls.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPostInstall } from "../../commands/post-install.ts";

const HOME = process.env.HOME!;
const LEGACY_APP = join(HOME, "Applications", "rt-tray.app");

let fakeBinDir = "";
let logPath = "";
let originalPath = "";
let originalShell: string | undefined;
let consoleLines: string[] = [];
let originalConsoleLog: typeof console.log;

function writeFake(name: string, body: string): void {
  const p = join(fakeBinDir, name);
  writeFileSync(p, body, { mode: 0o755 });
  chmodSync(p, 0o755);
}

/** One log line per fake-binary invocation, in call order. */
function readLog(): string[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8").split("\n").filter(Boolean);
}

/**
 * Fakes osascript/pkill/launchctl/rm/xattr/open on PATH (all no-ops that
 * just log, except `rm` — which really deletes via the absolute `/bin/rm`
 * so tests can also assert the bundle is actually gone, not just that the
 * call happened; it must use the absolute path or it would recurse into
 * itself through the very PATH prefix that put it there). Also captures
 * every console.log call so ordering can be checked at the log-line level,
 * and neutralizes shell-integration writes the same way
 * dev-mode-handoff.test.ts does (installShellIntegrationStep() runs
 * unconditionally and must never touch the shared test HOME's real rc file).
 */
function setUpFakes(): void {
  fakeBinDir = mkdtempSync(join(tmpdir(), "rt-postinstall-fakebin-"));
  logPath = join(fakeBinDir, "calls.log");

  writeFake("osascript", `#!/bin/sh\necho "osascript $*" >> "${logPath}"\nexit 0\n`);
  writeFake("pkill", `#!/bin/sh\necho "pkill $*" >> "${logPath}"\nexit 0\n`);
  writeFake("launchctl", `#!/bin/sh\necho "launchctl $*" >> "${logPath}"\nexit 0\n`);
  writeFake("rm", `#!/bin/sh\necho "rm $*" >> "${logPath}"\n/bin/rm -rf "$@"\nexit 0\n`);
  writeFake("xattr", `#!/bin/sh\necho "xattr $*" >> "${logPath}"\nexit 0\n`);
  writeFake("open", `#!/bin/sh\necho "open $*" >> "${logPath}"\nexit 0\n`);

  originalPath = process.env.PATH ?? "";
  process.env.PATH = `${fakeBinDir}:${originalPath}`;

  originalShell = process.env.SHELL;
  process.env.SHELL = "/bin/nonexistent-shell-for-tests";

  consoleLines = [];
  originalConsoleLog = console.log;
  console.log = (...args: unknown[]) => { consoleLines.push(args.map(String).join(" ")); };
}

function tearDownFakes(): void {
  console.log = originalConsoleLog;
  process.env.PATH = originalPath;
  if (originalShell === undefined) delete process.env.SHELL;
  else process.env.SHELL = originalShell;
  try { rmSync(fakeBinDir, { recursive: true, force: true }); } catch { /* absent */ }
}

afterEach(() => {
  tearDownFakes();
  try { rmSync(LEGACY_APP, { recursive: true, force: true }); } catch { /* absent */ }
});

describe("runPostInstall — legacy migration sweep guard", () => {
  test("no legacy bundle on disk: zero osascript/pkill/launchctl/rm invocations (every-rt-update regression)", async () => {
    expect(existsSync(LEGACY_APP)).toBe(false);
    setUpFakes();

    await runPostInstall();

    expect(readLog()).toEqual([]);
    expect(consoleLines.join("\n")).not.toContain("NOTE: notification");
  }, 20_000);
});

describe("runPostInstall — legacy migration sweep, guard fires", () => {
  test("quit -> bootout -> rm, in order, all before the install step's own invocations", async () => {
    mkdirSync(LEGACY_APP, { recursive: true });
    setUpFakes();

    await runPostInstall();

    const log = readLog();
    const names = log.map((l) => l.split(" ")[0]);
    // Nothing else on PATH gets invoked in this environment (no real bundle
    // sits next to the test binary, so installTrayApp() never reaches its
    // own osascript/pkill/xattr calls) — the full call sequence IS the
    // sweep, in the exact spec §4 order.
    expect(names).toEqual(["osascript", "pkill", "launchctl", "rm"]);

    const osascriptLine = log.find((l) => l.startsWith("osascript "))!;
    expect(osascriptLine).toContain('"rt-tray"'); // old app's own never-changing name
    const pkillLine = log.find((l) => l.startsWith("pkill "))!;
    expect(pkillLine).toBe("pkill -x rt-tray");
    const bootoutLine = log.find((l) => l.startsWith("launchctl "))!;
    expect(bootoutLine).toContain("bootout gui/");
    expect(bootoutLine).toContain("/com.rt.daemon");
    const rmLine = log.find((l) => l.startsWith("rm "))!;
    expect(rmLine).toContain(LEGACY_APP);

    // The fake `rm` really deletes — confirms the bundle is actually gone,
    // not just that a call was logged.
    expect(existsSync(LEGACY_APP)).toBe(false);

    // The sweep's own "done" line (ok(), not the info() line at its start)
    // only prints once runLegacySweep() — including all four calls above —
    // has fully returned. It must precede the install step's own line
    // (installTrayApp() always logs once for TRAY_APP_BUNDLE, found or not)
    // in the real, unmodified runPostInstall() control flow.
    const sweepDoneIdx = consoleLines.findIndex((l) => l.includes("✓") && l.includes("legacy migration"));
    // installTrayApp()'s own line (distinct from the sweep's "migrating to
    // mattstack.app" info line, which also mentions the bundle name).
    const installLineIdx = consoleLines.findIndex((l) => l.includes("not found alongside binary"));
    expect(sweepDoneIdx).toBeGreaterThanOrEqual(0);
    expect(installLineIdx).toBeGreaterThan(sweepDoneIdx);
  }, 20_000);

  test("permissions note prints exactly when the sweep ran", async () => {
    mkdirSync(LEGACY_APP, { recursive: true });
    setUpFakes();

    await runPostInstall();

    const combined = consoleLines.join("\n");
    expect(combined).toContain("NOTE: notification + full-disk-access permissions must be re-granted");
    expect(combined).toContain("mattstack.app"); // names the bundle whose id changed
  }, 20_000);
});
