/**
 * `rt settings dev-mode` — the non-interactive branches: an explicit Target
 * arg must switch straight through with no prompt (the app's Settings pane
 * calls this exact form, off a TTY), and an omitted Target with no TTY to
 * prompt in must refuse cleanly (exit 2) rather than hang on the picker.
 *
 * The "switches" case drives the real `toggleDevMode` flavor handoff, so it
 * reuses the same fake-bin-dir + fake tray-socket rig as
 * lib/__tests__/dev-mode-handoff.test.ts (see that file's doc comment for
 * why each fake exists) — never the real osascript/pkill/launchctl/open.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toggleDevMode } from "../settings.ts";
import { TRAY_SOCK_PATH } from "../../lib/daemon-config.ts";
import { DEV_TRAY_APP_BUNDLE } from "../../lib/rt-paths.ts";

function isolatedExists(path: string): boolean {
  return path.startsWith("/Applications/") ? false : existsSync(path);
}

const HOME = process.env.HOME!;
const WRAPPER_PATH = join(HOME, ".local", "bin", "rt");
const FAKE_DEV_APP = join(HOME, "Applications", DEV_TRAY_APP_BUNDLE);

let fakeBinDir = "";
let originalPath = "";
let originalShell: string | undefined;
let server: ReturnType<typeof Bun.serve> | null = null;

function writeFake(name: string, body: string): void {
  const p = join(fakeBinDir, name);
  writeFileSync(p, body, { mode: 0o755 });
  chmodSync(p, 0o755);
}

/** Same fixture as dev-mode-handoff.test.ts's setUpFakes, trimmed to what a single prod→dev switch needs. */
function setUpFakes(): void {
  fakeBinDir = mkdtempSync(join(tmpdir(), "rt-devmode-tty-fakebin-"));
  writeFake("osascript", "#!/bin/sh\nexit 0\n");
  writeFake("pkill", `#!/bin/sh\ntouch "${join(fakeBinDir, "gone")}"\nexit 0\n`);
  writeFake("open", "#!/bin/sh\nexit 0\n");
  writeFake(
    "launchctl",
    [
      "#!/bin/sh",
      `if [ -f "${join(fakeBinDir, "gone")}" ]; then echo "Could not find service" 1>&2; exit 1; fi`,
      `echo '{ "PID" = 1; };'`,
      "exit 0",
      "",
    ].join("\n"),
  );

  originalPath = process.env.PATH ?? "";
  process.env.PATH = `${fakeBinDir}:${originalPath}`;
  originalShell = process.env.SHELL;
  process.env.SHELL = "/bin/nonexistent-shell-for-tests"; // makes installShellIntegration() a no-op

  mkdirSync(join(HOME, ".mattstack", "rt"), { recursive: true });
  try { rmSync(TRAY_SOCK_PATH); } catch { /* absent */ }

  server = Bun.serve({
    unix: TRAY_SOCK_PATH,
    fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/flavor/retire") {
        const s = server;
        setTimeout(() => { try { s?.stop(true); } catch { /* already stopped */ } }, 50);
        return Response.json({ ok: true });
      }
      if (url.pathname === "/health") return Response.json({ ok: true });
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

afterEach(() => {
  tearDownFakes();
  process.exitCode = 0; // the target-required test sets this directly; never let it leak into the real test run's exit code
  for (const p of [WRAPPER_PATH]) {
    try { rmSync(p); } catch { /* absent */ }
  }
  try { rmSync(FAKE_DEV_APP, { recursive: true, force: true }); } catch { /* absent */ }
});

describe("toggleDevMode — non-interactive Target handling", () => {
  test("non-TTY + explicit Target: no prompt, switches straight through", async () => {
    expect(existsSync(WRAPPER_PATH)).toBe(false); // starting mode: prod
    mkdirSync(FAKE_DEV_APP, { recursive: true }); // incoming bundle present
    setUpFakes();

    // bun test's own process has no TTY on stdin — this call proves an
    // explicit Target already skips the interactive picker regardless, so
    // it completes rather than hanging on a prompt with nothing to answer it.
    await toggleDevMode(["dev"], isolatedExists);

    expect(existsSync(WRAPPER_PATH)).toBe(true); // the switch actually ran
  }, 15_000);

  test("non-TTY + no Target: exit 2 target-required, never reaches the picker or touches any state", async () => {
    expect(existsSync(WRAPPER_PATH)).toBe(false);

    await toggleDevMode([], isolatedExists);

    expect(process.exitCode).toBe(2);
    expect(existsSync(WRAPPER_PATH)).toBe(false); // no switch attempted
  });
});
