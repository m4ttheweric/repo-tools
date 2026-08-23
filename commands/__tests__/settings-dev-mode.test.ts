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
import { afterEach, describe, expect, mock, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toggleDevMode } from "../settings.ts";
import { TRAY_SOCK_PATH } from "../../lib/daemon-config.ts";
import { DEV_TRAY_APP_BUNDLE } from "../../lib/rt-paths.ts";
import { dispatch, type CommandNode } from "../../lib/command-tree.ts";
import * as fsReal from "fs";
import { beforeEach, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { rtDir } from "../../lib/rt-paths.ts";
import { closeStateDb, getStateDb, hasKvValue, setKvValue } from "../../lib/state/index.ts";
import { bunPathForStorage, devModeConfigPath, enableDevMode, readDevModeConfig } from "../settings.ts";

describe("bunPathForStorage", () => {
  test("an absolute path is kept as-is", () => {
    expect(bunPathForStorage("/Users/matt/.bun/bin/bun")).toBe("/Users/matt/.bun/bin/bun");
  });
  test("a bare command name is dropped — the shim never does PATH resolution", () => {
    expect(bunPathForStorage("bun")).toBeUndefined();
  });
  test("a relative path is dropped", () => {
    expect(bunPathForStorage("./bun")).toBeUndefined();
    expect(bunPathForStorage("../bun/bun")).toBeUndefined();
  });
});

// `mock.module` mutates the live "fs" namespace object IN PLACE, so
// `fsReal.existsSync` itself becomes the mock the moment it's installed —
// restoring with `() => fsReal` would restore the mock to itself. Capture
// the real function BEFORE any test in this file calls mock.module("fs", ...).
// Target "fs" specifically (not "node:fs"): settings.ts and rt-paths.ts both
// import from bare "fs", and Bun keys module mocks by exact specifier.
const realExistsSync = fsReal.existsSync;

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
  mock.module("fs", () => ({ ...fsReal, existsSync: realExistsSync })); // undo any per-test existsSync stub
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
    await toggleDevMode(["dev"], {}, isolatedExists);

    expect(existsSync(WRAPPER_PATH)).toBe(true); // the switch actually ran
  }, 15_000);

  test("non-TTY + no Target: exit 2 target-required, never reaches the picker or touches any state", async () => {
    expect(existsSync(WRAPPER_PATH)).toBe(false);

    await toggleDevMode([], {}, isolatedExists);

    expect(process.exitCode).toBe(2);
    expect(existsSync(WRAPPER_PATH)).toBe(false); // no switch attempted
  });
});

// ─── driven through the real dispatch() (MAT-383 crash fix regression) ──────
//
// `dispatch()` always calls leaf handlers as `handler(rest, ctx)` — a plain
// object in the second slot. `toggleDevMode` used to declare that slot as
// its `exists` seam (`(args, exists = existsSync)`), so this exact call
// shape landed `ctx` where the code expected a function and threw
// `ctx is not a function` on the very first `exists(...)` call — every unit
// test called `toggleDevMode` directly and never hit it. Route through
// `dispatch()` here, the same convention cli.ts uses, so a regression trips
// this test instead of shipping silently again.
describe("toggleDevMode — driven through dispatch()", () => {
  test("dispatch's handler(rest, ctx) call switches straight through with no crash", async () => {
    expect(existsSync(WRAPPER_PATH)).toBe(false); // starting mode: prod
    mkdirSync(FAKE_DEV_APP, { recursive: true }); // incoming bundle present
    setUpFakes();

    // Stub existsSync so a real /Applications install on the machine running
    // this test can never be picked up — dispatch() calls the handler with
    // no way to inject the isolatedExists seam directly, so the fs module
    // itself is the only interception point available at this call depth.
    // Must call `realExistsSync`, not the top-level `existsSync` import: "fs"
    // and "node:fs" share one module object, so this stub would recurse into
    // itself the instant a non-/Applications path came through.
    const isolatedExistsViaRealFs = (path: string): boolean =>
      path.startsWith("/Applications/") ? false : realExistsSync(path);
    mock.module("fs", () => ({ ...fsReal, existsSync: isolatedExistsViaRealFs }));

    const tree: Record<string, CommandNode> = {
      "dev-mode": { description: "test", handler: toggleDevMode },
    };
    await dispatch(tree, ["dev-mode", "dev"]);

    expect(existsSync(WRAPPER_PATH)).toBe(true); // the switch actually ran
  }, 15_000);
});


// commands/settings.ts's DEV_MODE_WRAPPER/DEV_MODE_PRELOAD are captured ONCE
// at module-load time (not call-time like rtDir()), so they stay pinned to
// whatever HOME was active when this test file's `import "../settings.ts"`
// first ran — enableDevMode() always writes both, so their parent dirs must
// exist there regardless of which HOME a given test points state.db at, and
// the files themselves must be cleaned up after every test: any other test
// file loaded in this same `bun test` process (no --isolate) resolves the
// same frozen paths and would otherwise see this suite's leftovers.
const WRAPPER_HOME = process.env.HOME!;
const DEVMODE_WRAPPER_PATH = join(WRAPPER_HOME, ".local", "bin", "rt");
const PRELOAD_PATH = join(WRAPPER_HOME, ".mattstack", "rt", "dev-restore-cwd.ts");

describe("dev-mode config (state.db)", () => {
  beforeEach(() => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "rt-devmode-cfg-"));
    closeStateDb();
    mkdirSync(join(WRAPPER_HOME, ".local", "bin"), { recursive: true });
    mkdirSync(join(WRAPPER_HOME, ".mattstack", "rt"), { recursive: true });
  });

  // Other test files in this same `bun test` process (no --isolate) read
  // process.env.HOME at call time via rtDir()/home() and reuse the state.db
  // singleton — leaving HOME pointed at a throwaway per-test dir here would
  // misdirect their state.db reads/writes. Restore both after every test,
  // and remove any wrapper/preload files enableDevMode() wrote to the
  // frozen WRAPPER_HOME location.
  afterEach(() => {
    process.env.HOME = WRAPPER_HOME;
    closeStateDb();
    for (const p of [DEVMODE_WRAPPER_PATH, `${DEVMODE_WRAPPER_PATH}.new`, PRELOAD_PATH]) {
      try { rmSync(p); } catch { /* absent */ }
    }
  });

  test("empty reads as {}", () => {
    expect(readDevModeConfig()).toEqual({});
  });

  test("round-trip via enableDevMode", () => {
    enableDevMode("/tmp/source-repo");
    expect(readDevModeConfig()).toMatchObject({ sourcePath: "/tmp/source-repo" });
    // The shim never does PATH resolution — a stored bunPath must be absolute
    // or absent (bunPathForStorage), never the bare "bun" detectBunPath()'s
    // last resort can return.
    const stored = readDevModeConfig().bunPath;
    if (stored !== undefined) expect(stored.startsWith("/")).toBe(true);
  });

  test("a malformed stored value ({}) reads as {}", () => {
    setKvValue("dev-mode", "config", {});
    expect(readDevModeConfig()).toEqual({});
  });

  test("a malformed stored value (null) reads as {}", () => {
    setKvValue("dev-mode", "config", null);
    expect(readDevModeConfig()).toEqual({});
  });

  test("a non-string sourcePath/bunPath is dropped, not thrown", () => {
    setKvValue("dev-mode", "config", { sourcePath: 42, bunPath: ["x"] });
    expect(readDevModeConfig()).toEqual({});
  });

  test("a pre-existing dev-mode.json is imported on first read", () => {
    const path = devModeConfigPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ sourcePath: "/legacy/source", bunPath: "/legacy/bun" }));
    expect(existsSync(path)).toBe(true);

    expect(readDevModeConfig()).toEqual({ sourcePath: "/legacy/source", bunPath: "/legacy/bun" });
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.migrated`)).toBe(true);

    // A second read sees the store, not a re-import.
    expect(readDevModeConfig()).toEqual({ sourcePath: "/legacy/source", bunPath: "/legacy/bun" });
  });

  test("a corrupt dev-mode.json warns and is left in place; readDevModeConfig reads as {}", () => {
    const path = devModeConfigPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{ not valid json");
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    try {
      expect(readDevModeConfig()).toEqual({});
      expect(existsSync(path)).toBe(true);
      expect(existsSync(`${path}.migrated`)).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("enableDevMode renames (never deletes) a legacy dev-mode.json it supersedes", () => {
    const path = devModeConfigPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ sourcePath: "/legacy/source", bunPath: "/legacy/bun" }));

    enableDevMode("/fresh/source");
    expect(readDevModeConfig()).toMatchObject({ sourcePath: "/fresh/source" });
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.migrated`)).toBe(true);
  });

  test("real contended write: a held write lock during readDevModeConfig's import must NOT rename dev-mode.json — the next read must still see it and retry", () => {
    // Materialize AND KEEP OPEN state.db's singleton first (never
    // closeStateDb() here): readDevModeConfig's own getStateDb() call must
    // reuse this already-migrated connection during the lock window below,
    // or its own open+migrate BEGIN IMMEDIATE would contend with the lock
    // too and throw past MIGRATION_BUSY_TIMEOUT_MS instead of the plain
    // write hitting persistOrWarn's swallow — a different failure than the
    // one this test targets.
    getStateDb();
    const dbPath = join(rtDir(), "state.db");

    const path = devModeConfigPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ sourcePath: "/legacy/source", bunPath: "/legacy/bun" }));

    // A second, real connection holds the write lock past readDevModeConfig's
    // (cli-flavor, 5000ms) busy_timeout — a genuine SQLITE_BUSY, not a mock.
    const blocker = new Database(dbPath);
    blocker.exec("PRAGMA busy_timeout = 0;");
    blocker.exec("BEGIN IMMEDIATE;");

    let config: ReturnType<typeof readDevModeConfig>;
    try {
      config = readDevModeConfig();
    } finally {
      blocker.exec("ROLLBACK;");
      blocker.close();
    }

    // This caller still gets the correctly-parsed config (apply() did run)...
    expect(config).toEqual({ sourcePath: "/legacy/source", bunPath: "/legacy/bun" });
    // ...but the write never landed, so nothing may be destroyed: the file
    // must survive, and the store must still be empty.
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.migrated`)).toBe(false);
    expect(hasKvValue("dev-mode", "config")).toBe(false);

    // The next read (lock released) succeeds for real and renames.
    expect(readDevModeConfig()).toEqual({ sourcePath: "/legacy/source", bunPath: "/legacy/bun" });
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.migrated`)).toBe(true);
  }, 20_000);
});
