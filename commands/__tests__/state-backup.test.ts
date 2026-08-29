/**
 * commands/state.ts -- rt state backup/restore CLI coverage (R055).
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { DAEMON_SOCK_PATH } from "../../lib/daemon-config.ts";
import { closeStateDb, getStateDb, listStateBackups, stateDbPath } from "../../lib/state/index.ts";
import { stateBackup, stateRestore } from "../state.ts";

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

describe("rt state backup/restore", () => {
  const origHome = process.env.HOME;
  let home: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-state-cmd-home-")));
    process.env.HOME = home;
  });

  afterEach(() => {
    closeStateDb();
    process.env.HOME = origHome;
    rmSync(home, { recursive: true, force: true });
  });

  // bun test never runs with a TTY, so this exercises the same path a real
  // non-interactive/--json caller hits: no picker, the existing usage error.
  test("restore with no positional errors with usage and exit 1, same under --json", async () => {
    const plain = await runCapturingExit(() => stateRestore([]));
    expect(plain.exitCode).toBe(1);
    expect(plain.errors.join("\n")).toContain("usage: rt state restore");

    const json = await runCapturingExit(() => stateRestore(["--json"]));
    expect(json.exitCode).toBe(1);
    expect(json.errors.join("\n")).toContain("usage: rt state restore");
  });

  test("restore with an unknown backup name errors and exits 1", async () => {
    const result = await runCapturingExit(() => stateRestore(["state-does-not-exist.db"]));
    expect(result.exitCode).toBe(1);
    expect(result.errors.join("\n")).toContain("not found");
  });

  test("backup writes a stamped copy under the backups dir", async () => {
    getStateDb(); // create the source db
    const result = await runCapturingExit(() => stateBackup([]));
    expect(result.exitCode).toBeUndefined();
    expect(listStateBackups().length).toBe(1);
  });

  test("backup --json reports the written path as an existing file", async () => {
    getStateDb();
    const result = await runCapturingExit(() => stateBackup(["--json"]));
    expect(result.exitCode).toBeUndefined();
    const payload = JSON.parse(result.logs.at(-1)!);
    expect(payload.ok).toBe(true);
    expect(typeof payload.path).toBe("string");
  });

  test("restore round-trips: reverts a later write back to the backed-up value", async () => {
    const db = getStateDb();
    db.query("INSERT INTO kv (ns, k, v, updated_at) VALUES (?, ?, ?, ?)").run("marker", "value", "\"before\"", Date.now());

    await runCapturingExit(() => stateBackup([]));
    const [name] = listStateBackups();
    expect(name).toBeDefined();

    getStateDb().query("UPDATE kv SET v = ? WHERE ns = ? AND k = ?").run("\"after\"", "marker", "value");

    const restore = await runCapturingExit(() => stateRestore([name!]));
    expect(restore.exitCode).toBeUndefined();

    closeStateDb();
    const restored = getStateDb();
    const row = restored.query("SELECT v FROM kv WHERE ns = ? AND k = ?").get("marker", "value") as { v: string } | null;
    expect(row?.v).toBe("\"before\"");
    expect(stateDbPath()).toContain(home);
  });
});

// DAEMON_SOCK_PATH is baked at module load from the bunfig-preload test HOME
// (see lib/daemon-config.ts), not from this file's per-test HOME swap, so a
// real listening socket there is what isDaemonRunning() actually sees --
// matching the seam lib/__tests__/daemon-client-attribution.test.ts already
// uses to simulate a live daemon.
describe("rt state restore -- live daemon guard", () => {
  const origHome = process.env.HOME;
  let home: string;
  let server: ReturnType<typeof Bun.serve> | undefined;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-state-guard-home-")));
    process.env.HOME = home;
  });

  afterEach(() => {
    server?.stop(true);
    server = undefined;
    closeStateDb();
    process.env.HOME = origHome;
    rmSync(home, { recursive: true, force: true });
  });

  test("refuses to restore while the daemon is running, and --force overrides it", async () => {
    getStateDb();
    await runCapturingExit(() => stateBackup([]));
    const [name] = listStateBackups();
    expect(name).toBeDefined();

    mkdirSync(dirname(DAEMON_SOCK_PATH), { recursive: true });
    server = Bun.serve({
      unix: DAEMON_SOCK_PATH,
      fetch: () => Response.json({ ok: true }),
    });

    const refused = await runCapturingExit(() => stateRestore([name!]));
    expect(refused.exitCode).toBe(1);
    expect(refused.errors.join("\n")).toContain("daemon is running");

    const forced = await runCapturingExit(() => stateRestore([name!, "--force"]));
    expect(forced.exitCode).toBeUndefined();
  });
});
