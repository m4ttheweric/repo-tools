/**
 * commands/settings.ts — `rt settings dev-mode on|off` flavor handoff
 * (MAT-383 §3).
 *
 * The toggle used to be a daemon-binary swap-in-place; it is now a handoff
 * between two independently-registered tray flavors (mattstack.app /
 * mattstack-dev.app): precondition (incoming bundle exists) → POST
 * /flavor/retire on the outgoing tray's socket → flavor-aware quit
 * (osascript display name + `pkill -x` executable name, both the OUTGOING
 * flavor's own) → poll until gone (CONNECT-probe of the shared tray socket,
 * plus `launchctl list <outgoing label>`) → launch the incoming app.
 *
 * `osascript`/`pkill`/`launchctl`/`open` are faked via a PATH-prepended temp
 * bin dir — never the real binaries, so this never quits/relaunches a real
 * app or touches real launchd state. Bun resolves a bare command against the
 * PATH captured at process start unless `env` is passed explicitly to
 * spawnSync (a real gotcha, confirmed against `commands/settings.ts`'s
 * `spawnSync(..., { env: process.env })` calls) — this test relies on that
 * being wired correctly in the production code, not just on PATH containing
 * the fakes.
 *
 * The tray socket itself is a real `Bun.serve({ unix })` fake bound at the
 * real TRAY_SOCK_PATH (inside the isolated test HOME from bunfig's preload).
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync,
  readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toggleDevMode } from "../../commands/settings.ts";
import { TRAY_SOCK_PATH } from "../daemon-config.ts";
import { devTrayAppPath, trayAppPath } from "../rt-paths.ts";

const HOME = process.env.HOME!;
const WRAPPER_PATH = join(HOME, ".local", "bin", "rt");
const DEV_MODE_CONFIG = join(HOME, ".mattstack", "rt", "dev-mode.json");
const DEV_MODE_PRELOAD = join(HOME, ".mattstack", "rt", "dev-restore-cwd.ts");

let fakeBinDir = "";
let logPath = "";
let goneMarker = "";
let originalPath = "";
let originalShell: string | undefined;
let server: ReturnType<typeof Bun.serve> | null = null;

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
 * Sets up: fake osascript/pkill/launchctl/open on PATH, and a fake tray
 * socket at the real TRAY_SOCK_PATH. `pkill` flips the "gone" marker
 * immediately (synchronous, like a real quit signal); `launchctl list`
 * reports registered until that marker exists. The socket itself closes
 * `closeDelayMs` after /flavor/retire is POSTed, so waitUntilGone() must
 * actually poll more than once before both conditions clear.
 */
function setUpFakes(closeDelayMs = 150): void {
  fakeBinDir = mkdtempSync(join(tmpdir(), "rt-devmode-fakebin-"));
  logPath = join(fakeBinDir, "calls.log");
  goneMarker = join(fakeBinDir, "gone");

  writeFake("osascript", `#!/bin/sh\necho "osascript $*" >> "${logPath}"\nexit 0\n`);
  writeFake("pkill", `#!/bin/sh\necho "pkill $*" >> "${logPath}"\ntouch "${goneMarker}"\nexit 0\n`);
  writeFake("open", `#!/bin/sh\necho "open $*" >> "${logPath}"\nexit 0\n`);
  writeFake(
    "launchctl",
    [
      "#!/bin/sh",
      `echo "launchctl $*" >> "${logPath}"`,
      `if [ -f "${goneMarker}" ]; then`,
      `  echo "Could not find service" 1>&2`,
      `  exit 1`,
      `fi`,
      `echo '{ "PID" = 1; };'`,
      `exit 0`,
      "",
    ].join("\n"),
  );

  originalPath = process.env.PATH ?? "";
  process.env.PATH = `${fakeBinDir}:${originalPath}`;

  // lib/shell-integration.ts resolves HOME via os.homedir() at MODULE LOAD,
  // not process.env.HOME at call time — a pre-existing isolation gap this
  // test must not rely on being safe. Forcing an unrecognised shell makes
  // installShellIntegration() (called unconditionally by the "dev" target
  // path) a guaranteed no-op: shellRcPath() returns null and it never opens
  // any rc file, real HOME or otherwise.
  originalShell = process.env.SHELL;
  process.env.SHELL = "/bin/nonexistent-shell-for-tests";

  mkdirSync(join(HOME, ".mattstack", "rt"), { recursive: true });
  try { rmSync(TRAY_SOCK_PATH); } catch { /* absent */ }

  server = Bun.serve({
    unix: TRAY_SOCK_PATH,
    fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/flavor/retire") {
        appendFileSync(logPath, "retire\n");
        const s = server;
        setTimeout(() => { try { s?.stop(true); } catch { /* already stopped */ } }, closeDelayMs);
        return Response.json({ ok: true });
      }
      if (url.pathname === "/health") {
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    },
  });
}

function tearDownFakes(): void {
  try { server?.stop(true); } catch { /* already stopped */ }
  server = null;
  process.env.PATH = originalPath;
  if (originalShell === undefined) delete process.env.SHELL;
  else process.env.SHELL = originalShell;
  try { rmSync(fakeBinDir, { recursive: true, force: true }); } catch { /* */ }
  try { rmSync(TRAY_SOCK_PATH); } catch { /* absent */ }
}

/** Filters out the (many) polling launchctl lines, keeping call order of
 *  the one-shot steps so assertions read as a clean sequence. */
function oneShotSteps(log: string[]): string[] {
  return log.filter((l) => !l.startsWith("launchctl ")).map((l) => l.split(" ")[0] ?? "");
}

afterEach(() => {
  tearDownFakes();
  for (const p of [WRAPPER_PATH, DEV_MODE_PRELOAD, DEV_MODE_CONFIG]) {
    try { rmSync(p); } catch { /* absent */ }
  }
  for (const p of [trayAppPath(), devTrayAppPath()]) {
    try { rmSync(p, { recursive: true, force: true }); } catch { /* absent */ }
  }
});

describe("toggleDevMode — flavor handoff", () => {
  test("prod → dev: precondition, retire, quit, wait-until-gone, launch — in order", async () => {
    expect(existsSync(WRAPPER_PATH)).toBe(false); // starting mode: prod
    mkdirSync(devTrayAppPath(), { recursive: true }); // incoming bundle present
    setUpFakes();

    await toggleDevMode(["dev"]);

    const log = readLog();
    expect(oneShotSteps(log)).toEqual(["retire", "osascript", "pkill", "open"]);
    // launchctl polled at least once — proves the poll loop actually ran,
    // not just a single fire-and-forget check.
    expect(log.some((l) => l.startsWith("launchctl list com.rt.daemon"))).toBe(true);
    // Launched the INCOMING bundle, not the outgoing one.
    const openLine = log.find((l) => l.startsWith("open "))!;
    expect(openLine).toContain(devTrayAppPath());
    // CLI half still does its own thing (unchanged behavior).
    expect(existsSync(WRAPPER_PATH)).toBe(true);
  }, 15_000);

  test("dev → prod: same order, quits by the DEV flavor's own names", async () => {
    // Start in dev mode: wrapper present.
    mkdirSync(join(HOME, ".local", "bin"), { recursive: true });
    writeFileSync(WRAPPER_PATH, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    mkdirSync(trayAppPath(), { recursive: true }); // incoming (prod) bundle present
    setUpFakes();

    await toggleDevMode(["prod"]);

    const log = readLog();
    expect(oneShotSteps(log)).toEqual(["retire", "osascript", "pkill", "open"]);
    const osascriptLine = log.find((l) => l.startsWith("osascript "))!;
    expect(osascriptLine).toContain("mattstack-dev"); // outgoing = dev flavor's own name
    const pkillLine = log.find((l) => l.startsWith("pkill "))!;
    expect(pkillLine).toContain("-x mattstack-dev");
    const openLine = log.find((l) => l.startsWith("open "))!;
    expect(openLine).toContain(trayAppPath());
    expect(existsSync(WRAPPER_PATH)).toBe(false); // CLI half restored to prod
  }, 15_000);

  test("missing incoming bundle aborts BEFORE any retire/quit call, and before the CLI half is touched", async () => {
    expect(existsSync(WRAPPER_PATH)).toBe(false); // starting mode: prod
    // Deliberately do NOT create devTrayAppPath() — the incoming bundle.
    setUpFakes();

    await toggleDevMode(["dev"]);

    expect(readLog()).toEqual([]); // no retire, no osascript, no pkill, no open
    expect(existsSync(WRAPPER_PATH)).toBe(false); // CLI half never toggled
  }, 15_000);

  test("missing incoming bundle on the prod side leaves an existing dev wrapper untouched", async () => {
    mkdirSync(join(HOME, ".local", "bin"), { recursive: true });
    writeFileSync(WRAPPER_PATH, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    // Deliberately do NOT create trayAppPath() — the incoming (prod) bundle.
    setUpFakes();

    await toggleDevMode(["prod"]);

    expect(readLog()).toEqual([]);
    expect(existsSync(WRAPPER_PATH)).toBe(true); // disableDevMode() never ran
  }, 15_000);
});
