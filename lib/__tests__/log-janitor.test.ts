import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pruneLogs } from "../log-janitor.ts";

const DAY = 24 * 60 * 60 * 1000;

function makeLogsDir(): string {
  const root = mkdtempSync(join(tmpdir(), "log-janitor-"));
  const dir = join(root, "rt", "logs");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function touch(dir: string, name: string, mtime: Date): void {
  const path = join(dir, name);
  writeFileSync(path, "x");
  utimesSync(path, mtime, mtime);
}

describe("pruneLogs", () => {
  test("pattern: accepts daemon.YYYY-MM-DD.log and cli.YYYY-MM-DD.N.log", () => {
    const dir = makeLogsDir();
    const now = Date.now();
    const old = new Date(now - 30 * DAY);
    touch(dir, "daemon.2026-08-01.log", old);
    touch(dir, "cli.2026-08-01.2.log", old);

    const { removed } = pruneLogs(dir, 14, now);
    expect(removed.sort()).toEqual(["cli.2026-08-01.2.log", "daemon.2026-08-01.log"]);
  });

  test("pattern: rejects state.db, non-matching names, and a same-named directory", () => {
    const dir = makeLogsDir();
    const now = Date.now();
    const old = new Date(now - 30 * DAY);
    touch(dir, "state.db", old);
    touch(dir, "notalog.txt", old);
    touch(dir, "daemon.log", old); // no date segment
    touch(dir, "DAEMON.2026-08-01.log", old); // surface must be [a-z-]+, not uppercase
    // A directory whose NAME matches the pattern must still be skipped —
    // pruneLogs never touches directories.
    mkdirSync(join(dir, "sub.2026-08-01.log"));

    const { removed } = pruneLogs(dir, 14, now);
    expect(removed).toEqual([]);
  });

  test("cutoff math: keeps a file just inside the retention window, removes one just past it", () => {
    const dir = makeLogsDir();
    const now = Date.now();
    const retentionDays = 14;
    const justInside = new Date(now - (retentionDays * DAY - 60_000));
    const justOutside = new Date(now - (retentionDays * DAY + 60_000));
    touch(dir, "daemon.2026-08-01.log", justInside);
    touch(dir, "daemon.2026-07-01.log", justOutside);

    const { removed } = pruneLogs(dir, retentionDays, now);

    expect(removed).toEqual(["daemon.2026-07-01.log"]);
    expect(existsSync(join(dir, "daemon.2026-08-01.log"))).toBe(true);
    expect(existsSync(join(dir, "daemon.2026-07-01.log"))).toBe(false);
  });

  test("guard: refuses a dir that does not end in rt/logs, deleting nothing", () => {
    const root = mkdtempSync(join(tmpdir(), "log-janitor-wrongdir-"));
    const dir = join(root, "not-the-logs-dir");
    mkdirSync(dir, { recursive: true });
    touch(dir, "daemon.2026-08-01.log", new Date(Date.now() - 30 * DAY));

    expect(() => pruneLogs(dir, 14, Date.now())).toThrow();
    expect(existsSync(join(dir, "daemon.2026-08-01.log"))).toBe(true);
  });

  test("removed list: basenames only, no path prefix", () => {
    const dir = makeLogsDir();
    const now = Date.now();
    touch(dir, "tray.2026-08-01.log", new Date(now - 30 * DAY));

    const { removed } = pruneLogs(dir, 14, now);
    expect(removed).toEqual(["tray.2026-08-01.log"]);
  });

  test("readdir failure reports via onError instead of swallowing", () => {
    const calls: string[] = [];
    const bogus = join("/nonexistent-xyz", "rt", "logs");
    pruneLogs(bogus, 14, Date.now(), (phase) => calls.push(phase));
    expect(calls).toContain("readdir");
  });
});
