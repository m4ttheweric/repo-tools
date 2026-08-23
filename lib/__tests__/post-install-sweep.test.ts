/**
 * commands/post-install.ts — one-shot legacy migration sweep (MAT-383 §4,
 * A1-ported).
 *
 * `rt --post-install` re-execs on EVERY `rt update` and on every
 * first-run-without-daemon.json path (cli.ts), so the sweep is idempotent by
 * design: `com.rt.daemon` (the pre-app-shell daemon label, fully superseded
 * by `com.mattstack.daemon`) is booted out unconditionally, a leftover
 * rt-tray.app is quit and removed only when one actually exists, and a
 * stale ~/Applications/mattstack.app (the phase-1 install location) is
 * quit/removed only once a DIFFERENT root is the one actually running.
 *
 * `osascript`/`pkill`/`launchctl`/`rm` are faked via a PATH-prepended temp
 * bin dir — never the real binaries — same convention as
 * lib/__tests__/dev-mode-handoff.test.ts. Every production spawnSync call in
 * commands/post-install.ts passes `env: process.env` (the Bun PATH-snapshot
 * gotcha: a bare command resolves against the PATH captured at process
 * start unless `env` is passed explicitly), which this test relies on.
 *
 * `runPostInstall`'s own signature only exposes `bundleRoot` and a
 * test-only `applyDeps` override (never real production surface) — the
 * latter exists so this suite can drive the sweep without spinning up the
 * real 22-step apply engine, touching a real keychain/sops, or calling the
 * real `process.exit`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPostInstall } from "../../commands/post-install.ts";
import type { ApplyDeps } from "../../commands/setup.ts";
import type { StepDef } from "../setup/apply.ts";
import { fakeProbes } from "../setup/__tests__/fakes.ts";
import type { RelayClient } from "../team/relay-client.ts";
import type { SecretsSeams } from "../secrets/store.ts";

const HOME = process.env.HOME!;
const LEGACY_RT_TRAY = join(HOME, "Applications", "rt-tray.app");
const STALE_MATTSTACK = join(HOME, "Applications", "mattstack.app");

let fakeBinDir = "";
let logPath = "";
let originalPath = "";
let stderrLines: string[] = [];
let originalConsoleError: typeof console.error;

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

function setUpFakes(): void {
  fakeBinDir = mkdtempSync(join(tmpdir(), "rt-postinstall-fakebin-"));
  logPath = join(fakeBinDir, "calls.log");

  writeFake("osascript", `#!/bin/sh\necho "osascript $*" >> "${logPath}"\nexit 0\n`);
  writeFake("pkill", `#!/bin/sh\necho "pkill $*" >> "${logPath}"\nexit 0\n`);
  writeFake("launchctl", `#!/bin/sh\necho "launchctl $*" >> "${logPath}"\nexit 0\n`);
  // Really deletes via the absolute /bin/rm so tests can also assert the
  // bundle is actually gone, not just that the call happened.
  writeFake("rm", `#!/bin/sh\necho "rm $*" >> "${logPath}"\n/bin/rm -rf "$@"\nexit 0\n`);

  originalPath = process.env.PATH ?? "";
  process.env.PATH = `${fakeBinDir}:${originalPath}`;

  stderrLines = [];
  originalConsoleError = console.error;
  console.error = (...args: unknown[]) => { stderrLines.push(args.map(String).join(" ")); };
}

function tearDownFakes(): void {
  console.error = originalConsoleError;
  process.env.PATH = originalPath;
  try { rmSync(fakeBinDir, { recursive: true, force: true }); } catch { /* absent */ }
}

afterEach(() => {
  tearDownFakes();
  try { rmSync(LEGACY_RT_TRAY, { recursive: true, force: true }); } catch { /* absent */ }
  try { rmSync(STALE_MATTSTACK, { recursive: true, force: true }); } catch { /* absent */ }
});

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

/** Never spins up a real step — `steps: []` makes `setupApply` a zero-step no-op run that still emits a valid `plan`/`done` pair. */
function fakeApplyDeps(overrides: { steps?: StepDef[] } = {}): ApplyDeps & { exitCodes: number[]; lines: string[] } {
  const exitCodes: number[] = [];
  const lines: string[] = [];
  return {
    probes: fakeProbes(),
    secrets: fakeSecrets,
    relay: fakeRelay,
    secretPresence: { async has() { return null; } },
    print: (s) => lines.push(s),
    exit: (code: number) => {
      exitCodes.push(code);
      throw new Error("exit sentinel");
    },
    isTTY: () => false,
    confirm: async () => true,
    steps: overrides.steps ?? [],
    exitCodes,
    lines,
  };
}

async function runExpectingExit(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    throw new Error("expected the exit sentinel to throw");
  } catch (err) {
    if (err instanceof Error && err.message === "exit sentinel") return;
    throw err;
  }
}

describe("runPostInstall — legacy migration sweep", () => {
  test("nothing legacy on disk, root null: only the unconditional com.rt.daemon bootout fires", async () => {
    expect(existsSync(LEGACY_RT_TRAY)).toBe(false);
    expect(existsSync(STALE_MATTSTACK)).toBe(false);
    setUpFakes();

    const deps = fakeApplyDeps();
    await runPostInstall([], { bundleRoot: null, applyDeps: deps });

    const log = readLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toBe(`launchctl bootout gui/${process.getuid?.() ?? 0}/com.rt.daemon`);
    expect(stderrLines.join("\n")).not.toContain("NOTE: notification");
    expect(deps.exitCodes).toEqual([]); // apply ran (a no-op with steps:[]), never refused
  }, 20_000);

  test("legacy rt-tray.app present: quit -> pkill -> rm, after the unconditional bootout, before anything else", async () => {
    mkdirSync(LEGACY_RT_TRAY, { recursive: true });
    setUpFakes();

    await runPostInstall([], { bundleRoot: "/Applications/mattstack.app", applyDeps: fakeApplyDeps() });

    const log = readLog();
    const names = log.map((l) => l.split(" ")[0]);
    expect(names).toEqual(["launchctl", "osascript", "pkill", "rm"]);

    expect(log[0]).toContain("com.rt.daemon");
    expect(log[1]).toContain('"rt-tray"'); // old app's own never-changing name
    expect(log[2]).toBe("pkill -x rt-tray");
    expect(log[3]).toContain(LEGACY_RT_TRAY);
    expect(existsSync(LEGACY_RT_TRAY)).toBe(false); // the fake rm really deletes

    expect(stderrLines.join("\n")).toContain("NOTE: notification + full-disk-access permissions must be re-granted");
  }, 20_000);

  test("stale ~/Applications/mattstack.app, root elsewhere: quit -> bootout com.mattstack.daemon -> rm, no rt-tray leg", async () => {
    mkdirSync(STALE_MATTSTACK, { recursive: true });
    setUpFakes();

    await runPostInstall([], { bundleRoot: "/Applications/mattstack.app", applyDeps: fakeApplyDeps() });

    const log = readLog();
    const bootouts = log.filter((l) => l.startsWith("launchctl"));
    expect(bootouts).toEqual([
      `launchctl bootout gui/${process.getuid?.() ?? 0}/com.rt.daemon`,
      `launchctl bootout gui/${process.getuid?.() ?? 0}/com.mattstack.daemon`,
    ]);
    expect(log.some((l) => l.includes('"mattstack"') && l.startsWith("osascript"))).toBe(true);
    expect(log).toContain("pkill -x mattstack");
    const rmLine = log.find((l) => l.startsWith("rm "))!;
    expect(rmLine).toContain(STALE_MATTSTACK);
    expect(existsSync(STALE_MATTSTACK)).toBe(false);

    // com.mattstack.daemon bootout happens BEFORE the rm, matching the spec
    // order (its BundleProgram points into the bundle about to be deleted).
    const mattstackBootoutIdx = log.findIndex((l) => l.includes("com.mattstack.daemon"));
    const rmIdx = log.findIndex((l) => l.startsWith("rm "));
    expect(mattstackBootoutIdx).toBeLessThan(rmIdx);
  }, 20_000);

  test("root === the stale path itself: nothing stale to sweep, only the unconditional bootout fires", async () => {
    mkdirSync(STALE_MATTSTACK, { recursive: true });
    setUpFakes();

    await runPostInstall([], { bundleRoot: STALE_MATTSTACK, applyDeps: fakeApplyDeps() });

    expect(readLog()).toEqual([`launchctl bootout gui/${process.getuid?.() ?? 0}/com.rt.daemon`]);
    expect(existsSync(STALE_MATTSTACK)).toBe(true); // never removed — it IS the running install
  }, 20_000);
});

describe("runPostInstall — transient app root refusal", () => {
  test("a mounted DMG root: exit 2 with the drag-to-Applications message, apply never runs", async () => {
    setUpFakes();
    const deps = fakeApplyDeps({ steps: [{ id: "home.init", title: "x", kind: "rt", applies: () => true, run: async () => { throw new Error("apply must never run"); } }] });

    await runExpectingExit(() => runPostInstall([], { bundleRoot: "/Volumes/mattstack/mattstack.app", applyDeps: deps }));

    expect(deps.exitCodes).toEqual([2]);
    expect(deps.lines).toEqual([]); // setupApply's own NDJSON/human output never fired
    expect(stderrLines.join("\n")).toContain("drag mattstack.app to /Applications");
  }, 20_000);

  test("a Gatekeeper-translocated root: same refusal", async () => {
    setUpFakes();
    const deps = fakeApplyDeps({ steps: [{ id: "home.init", title: "x", kind: "rt", applies: () => true, run: async () => { throw new Error("apply must never run"); } }] });

    await runExpectingExit(() =>
      runPostInstall([], { bundleRoot: "/private/var/folders/xy/AppTranslocation/abc/d/mattstack.app", applyDeps: deps }),
    );

    expect(deps.exitCodes).toEqual([2]);
  }, 20_000);

  test("root null is never transient: apply runs normally", async () => {
    setUpFakes();
    const deps = fakeApplyDeps();

    await runPostInstall([], { bundleRoot: null, applyDeps: deps });

    expect(deps.exitCodes).toEqual([]);
  }, 20_000);
});

describe("runPostInstall — args forward to setupApply", () => {
  test("--non-interactive --team-of-one are always prepended, and extra args (e.g. --from) pass through", async () => {
    setUpFakes();
    const seenFlags: { nonInteractive: boolean; teamOfOne: boolean }[] = [];
    const homeInit: StepDef = { id: "home.init", title: "x", kind: "rt", applies: () => true, run: async () => { throw new Error("home.init must never run — --from skips it"); } };
    const pathLink: StepDef = {
      id: "path.link",
      title: "x",
      kind: "rt",
      applies: () => true,
      run: async (ctx) => {
        seenFlags.push({ nonInteractive: ctx.nonInteractive, teamOfOne: ctx.teamOfOne });
        return { state: "done" };
      },
    };

    await runPostInstall(["--from", "path.link"], { bundleRoot: null, applyDeps: fakeApplyDeps({ steps: [homeInit, pathLink] }) });

    expect(seenFlags).toEqual([{ nonInteractive: true, teamOfOne: true }]);
  }, 20_000);
});
